"use strict";

/* Verrou inter-process des archives POI : regen quotidien et backfills
 * manuels font tous du read-modify-write complet du meme fichier — sans
 * verrou, un run manuel a 16:58 ecrase silencieusement le regen de 17:00
 * (lost update constate possible dans les logs). mkdir est atomique sous
 * Windows/NTFS ; un verrou plus vieux que maxAge est repute orphelin
 * (process tue) et vole. Heartbeat sur le mtime pour les runs longs, PID
 * pour ne jamais supprimer le verrou d'un autre, handlers signaux pour
 * liberer sur Ctrl+C / arret Task Scheduler. */

const fs = require("fs");
const path = require("path");
const LOCK = path.join(__dirname, "..", "poi", ".archive.lock");
const PID_FILE = path.join(LOCK, "pid");

function acquire(maxAgeMs = 30 * 60 * 1000) {
  const mkLock = () => { fs.mkdirSync(LOCK); fs.writeFileSync(PID_FILE, String(process.pid)); };
  try {
    mkLock();
  } catch (_) {
    let stale = false;
    try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > maxAgeMs; } catch (_) { stale = true; }
    if (!stale) {
      throw Error("archive verrouillee par un autre processus (poi/.archive.lock) — reessayer plus tard");
    }
    // Vol d'un verrou orphelin. mkdirSync est atomique : si DEUX processus
    // volent en meme temps, un seul mkLock reussit, l'autre echoue -> traite
    // comme "verrouille" au lieu de crasher (course de vol du finding).
    try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_) {}
    try { mkLock(); }
    catch (_) { throw Error("archive verrouillee (course de vol) — reessayer plus tard"); }
  }
  // HEARTBEAT : rafraichit le mtime toutes les 5 min — un run legitime long
  // (init d'un symbole, rattrapage) n'est plus repute orphelin a 30 min.
  const beat = setInterval(() => {
    try { const now = new Date(); fs.utimesSync(LOCK, now, now); } catch (_) {}
  }, 5 * 60 * 1000);
  if (beat.unref) beat.unref();
  let released = false;
  const release = () => {
    if (released) return; released = true;
    clearInterval(beat);
    // ne supprime QUE son propre verrou : si un voleur legitime (stale) l'a
    // remplace, notre exit ne doit pas detruire le verrou du voleur.
    try {
      if (fs.readFileSync(PID_FILE, "utf8") === String(process.pid)) {
        fs.rmSync(LOCK, { recursive: true, force: true });
      }
    } catch (_) {}
  };
  process.on("exit", release);
  // Ctrl+C / arret du Task Scheduler n'emettent pas "exit" : liberer puis
  // re-propager pour un code de sortie correct.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try { process.on(sig, () => { release(); process.exit(130); }); } catch (_) {}
  }
  return release;
}

/* Ecriture ATOMIQUE : fichier temporaire, FSYNC, puis rename — le fsync
 * garantit que les octets sont sur le disque avant le rename, sinon une
 * coupure secteur peut committer le rename avant les donnees (archive de 0
 * octet au reboot, JSON.parse casse partout). */
function writeArchiveAtomic(archivePath, data) {
  const tmp = archivePath + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, data, 0, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, archivePath);
}

module.exports = { acquire, writeArchiveAtomic };
