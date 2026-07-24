"use strict";

/* G-ON — Publication quotidienne vers GitHub (Pages s'auto-alimente).
 * `node publish-daily.js` — dernière étape de regen-daily.cmd.
 *
 * Committe et pousse les données régénérées : archives POI (poi/*.json) et
 * fichiers-jour secondes (poi/sec/). La liaison montante de la machine ne
 * passe pas les gros packs (constaté 2026-07-24 : ~1-2 Mo max par push,
 * timeouts au-delà) → UN COMMIT PAR FICHIER, poussé immédiatement, 5 essais
 * espacés de 30 s chacun. Idempotent : rien de modifié = rien à faire.
 * Sort en code 1 si un push a définitivement échoué (visible Task Scheduler) ;
 * les commits locaux restent, le run suivant reprend où on s'est arrêté. */

const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function pushRetry() {
  for (let t = 1; t <= 5; t++) {
    try { git("push", "-q", "origin", "main"); return true; }
    catch (_) {
      // attente via un enfant Node : `timeout /t` exige une console interactive
      // et PLANTAIT sous le Task Scheduler (constaté au premier run réel) —
      // le crash interrompait toute la publication sur un simple aléa réseau.
      if (t < 5) try { execFileSync(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { stdio: "ignore" }); } catch (_) {}
    }
  }
  return false;
}

(() => {
  // fichiers de données modifiés/nouveaux uniquement — jamais le code
  const status = git("status", "--porcelain", "--", "poi").split("\n").filter(Boolean);
  const files = status.map((l) => l.slice(3).trim().replace(/^"|"$/g, "")).filter((f) => f.endsWith(".json"));
  if (!files.length) { console.log("Publication : rien de nouveau."); return; }
  console.log(`Publication : ${files.length} fichier(s) de données.`);
  let fails = 0;
  for (const f of files) {
    try {
      git("add", "--", f);
      git("commit", "-q", "-m", `data: ${path.basename(f)} (publication quotidienne)`);
    } catch (_) { continue; }   // rien à committer (déjà pris) : suivant
    if (pushRetry()) console.log(`  push OK  ${f}`);
    else { console.log(`  push KO  ${f} — le commit local reste, reprise au prochain run`); fails += 1; break; }
  }
  process.exit(fails ? 1 : 0);
})();
