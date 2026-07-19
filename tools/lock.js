"use strict";

/* Verrou inter-process des archives POI : regen quotidien et backfills
 * manuels font tous du read-modify-write complet du meme fichier — sans
 * verrou, un run manuel a 16:58 ecrase silencieusement le regen de 17:00
 * (lost update constate possible dans les logs). mkdir est atomique sous
 * Windows/NTFS ; un verrou plus vieux que maxAge est repute orphelin
 * (process tue) et vole. */

const fs = require("fs");
const path = require("path");
const LOCK = path.join(__dirname, "..", "poi", ".archive.lock");

function acquire(maxAgeMs = 30 * 60 * 1000) {
  const PID_FILE = path.join(LOCK, "pid");
  const mkLock = () => { fs.mkdirSync(LOCK); fs.writeFileSync(PID_FILE, String(process.pid)); };
  try {
    mkLock();
  } catch (_) {
    let stale = false;
    try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > maxAgeMs; } catch (_) { stale = true; }
    if (!stale) {
      throw Error("archive verrouillee par un autre processus (poi/.archive.lock) — reessayer plus tard");
    }
    fs.rmSync(LOCK, { recursive: true, force: true });
    mkLock();
  }
  // HEARTBEAT : rafraichit le mtime toutes les 5 min — un run legitime long
  // (init d'un symbole, rattrapage) n'est plus repute orphelin a 30 min.
  const beat = setInterval(() => {
    try { const now = new Date(); fs.utimesSync(LOCK, now, now); } catch (_) {}
  }, 5 * 60 * 1000);
  if (beat.unref) beat.unref();
  const release = () => {
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
  return release;
}

/* Ecriture ATOMIQUE : fichier temporaire puis rename — un kill en plein
 * write laisse l'archive precedente intacte au lieu d'un JSON tronque qui
 * casserait le navigateur ET tous les runs suivants. */
function writeArchiveAtomic(archivePath, data) {
  const tmp = archivePath + ".tmp";
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, archivePath);
}

module.exports = { acquire, writeArchiveAtomic };
