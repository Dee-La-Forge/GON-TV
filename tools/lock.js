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
  try {
    fs.mkdirSync(LOCK);
  } catch (_) {
    let stale = false;
    try { stale = Date.now() - fs.statSync(LOCK).mtimeMs > maxAgeMs; } catch (_) { stale = true; }
    if (!stale) {
      throw Error("archive verrouillee par un autre processus (poi/.archive.lock) — reessayer plus tard");
    }
    fs.rmSync(LOCK, { recursive: true, force: true });
    fs.mkdirSync(LOCK);
  }
  const release = () => { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_) {} };
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
