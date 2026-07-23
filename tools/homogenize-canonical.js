"use strict";

/* G-ON — Homogénéisation du corpus BTCUSDT (décision D1, AUDIT_SCORING_2026-07-23).
 * `node homogenize-canonical.js [--preview]`
 *
 * L'archive BTC collait deux régimes d'émission : corpus canonique Antho v1
 * SÉLECTIF (~49 POI/jour, 2026-01-01 -> 2026-07-16) entre deux segments
 * détecteur JS SATURÉ (96/jour : backfill 2025 et extension quotidienne).
 * Ce script régénère la fenêtre canonique avec LE MÊME détecteur JS que le
 * reste (footprints M15 depuis Binance Vision) et REMPLACE les lignes
 * canoniques — une seule population, une seule logique, partout.
 * L'ancien corpus canonique reste dans l'historique git.
 *
 * Fenêtre : [2026-01-01T00:00Z, floor(extension.extendedFromTs / M15)) —
 * la bougie-couture 14:30 du 16 juillet est déjà une ligne JS (dédupliquée
 * par regen-archive), elle est conservée telle quelle. Préfixe 2025 et
 * suffixe extension quotidienne : STRICTEMENT intacts, frontière avant
 * (sourceStats.lastAggTradeMs) intacte.
 *
 * IMPORTANT — un POI de fenêtre encore "A" à sa fin doit vieillir jusqu'à
 * maintenant : TOUJOURS enchaîner backfill-invalidation puis
 * backfill-approach puis backfill-outcome avant de publier.
 *
 * Hygiène disque : zip+csv purgés après chaque jour traité. Checkpoint
 * tous les 20 jours — un run interrompu reprend au jour suivant.
 * --preview : écrit <archive>.preview.json au lieu de l'archive réelle.
 */

global.window = global;
require("../poi/poi-config.js");
require("../poi/poi-score-model.js");
require("../poi/footprint-m15.js");
require("../poi/poi-detector.js");
require("../poi/poi-lifecycle.js");

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");
const { acquire, writeArchiveAtomic } = require("./lock");
const { politeFetch } = require("./http");
const B = global.BiquettePoi;

const TF = 15 * 60 * 1000;
const PREVIEW = process.argv.includes("--preview");
const SYMBOL = "BTCUSDT"; // seul symbole ayant un segment canonique
const START_MS = Date.UTC(2026, 0, 1);

const VISION = `https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
const CACHE = path.join(os.tmpdir(), "gon-vision-cache");
const ARCHIVE_PATH = path.join(__dirname, "..", "poi", "antho-v1-m15-pois.json");
const STATE_PATH = path.join(CACHE, `homog-state-${SYMBOL}.json`);
const CHECKPOINT_EVERY = 20; // jours

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw Error(`HTTP ${res.status} sur ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function unzip(zipPath, outDir) {
  execFileSync("python", ["-c",
    "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    zipPath, outDir], { stdio: "inherit" });
}

async function ensureDayCsv(day) {
  fs.mkdirSync(CACHE, { recursive: true });
  const csv = path.join(CACHE, `${SYMBOL}-aggTrades-${day}.csv`);
  const okMarker = csv + ".ok";
  if (fs.existsSync(csv) && fs.existsSync(okMarker)) return csv;
  try { fs.rmSync(csv, { force: true }); } catch (_) {}
  const zip = path.join(CACHE, `${SYMBOL}-aggTrades-${day}.zip`);
  if (!fs.existsSync(zip)) {
    await download(`${VISION}/${SYMBOL}-aggTrades-${day}.zip`, zip);
  }
  try {
    unzip(zip, CACHE);
  } catch (error) {
    try { fs.rmSync(zip, { force: true }); } catch (_) {}
    throw error;
  }
  if (!fs.existsSync(csv)) {
    try { fs.rmSync(zip, { force: true }); } catch (_) {}
    throw Error(`CSV absent après extraction: ${csv}`);
  }
  fs.writeFileSync(okMarker, "");
  return csv;
}

function purgeDay(day) {
  for (const suff of [".zip", ".csv", ".csv.ok"]) {
    try { fs.rmSync(path.join(CACHE, `${SYMBOL}-aggTrades-${day}${suff}`), { force: true }); } catch (_) {}
  }
}

async function streamDay(csvPath, onTrade) {
  const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
  let n = 0, bad = 0;
  const tsMin = Date.UTC(2019, 0, 1), tsMax = Date.now() + 24 * 3600 * 1000;
  for await (const line of rl) {
    if (!line || line.startsWith("agg_trade_id")) continue;
    const c = line.split(",");
    const trade = {
      tradeId: Number(c[0]), price: Number(c[1]), quantity: Number(c[2]),
      timestamp: Number(c[5]), isBuyerMaker: c[6] === "true" || c[6] === "True"
    };
    if (!Number.isFinite(trade.price) || trade.price <= 0 ||
        !Number.isFinite(trade.quantity) || trade.quantity <= 0 ||
        !Number.isFinite(trade.timestamp)) continue;
    if (trade.timestamp < tsMin || trade.timestamp > tsMax) { bad += 1; continue; }
    onTrade(trade);
    n += 1;
  }
  if (bad > 0 && bad >= n) {
    throw Error(`timestamps invraisemblables dans ${path.basename(csvPath)} (${bad} rejetes) — format Vision change ?`);
  }
  return n;
}

async function fetchHistory(beforeTs) {
  const res = await politeFetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}&interval=15m&endTime=${beforeTs - 1}&limit=192`);
  if (!res.ok) throw Error(`klines HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map((row) => {
    const volume = Number(row[5]), longVolume = Number(row[9]);
    return {
      startTs: Number(row[0]), endTs: Number(row[6]) + 1, availableAt: Number(row[6]) + 1,
      open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
      volume, longVolume, shortVolume: Math.max(0, volume - longVolume), bins: []
    };
  }).filter((r) => Number.isFinite(r.volume) && r.volume > 0 && r.endTs <= beforeTs);
}

(async () => {
  acquire();
  if (!fs.existsSync(ARCHIVE_PATH)) { console.error("Pas d'archive BTCUSDT."); process.exit(1); }
  const archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const config = B.createPoiConfig({ symbol: SYMBOL, binSize: archive.binSize });

  // --- fenêtre canonique = [2026-01-01, floor(extendedFromTs)) ------------
  const endMs = Math.floor(Number(archive.extension && archive.extension.extendedFromTs) / TF) * TF;
  if (!Number.isFinite(endMs) || endMs <= START_MS) { console.error("extendedFromTs introuvable/incohérent."); process.exit(1); }
  const canonical = archive.pois.filter((r) => {
    const t = Number(r[IDX.createdTs]);
    return t >= START_MS && t < endMs;
  });
  if (!canonical.length) { console.log("Aucune ligne canonique dans la fenêtre — déjà homogénéisé ?"); process.exit(0); }

  // --- liste des jours (le jour contenant endMs inclus si endMs mi-jour) --
  const days = [];
  const lastDay = dayOf(endMs - 1);
  for (let d = new Date(dayOf(START_MS) + "T00:00:00Z"); dayOf(d.getTime()) <= lastDay; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(dayOf(d.getTime()));
  }
  console.log(`Homogénéisation ${SYMBOL}: ${days[0]} -> ${days[days.length - 1]} (${days.length} jours), ${canonical.length} lignes canoniques à remplacer, fin exclusive ${fmt(endMs)}${PREVIEW ? " [PREVIEW]" : ""}`);

  // --- état (checkpoint ou frais) -----------------------------------------
  let state = null;
  if (fs.existsSync(STATE_PATH)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      if (s.startMs === START_MS && s.endMs === endMs) state = s;
      else console.log("Checkpoint ignoré (bornes différentes).");
    } catch (_) { /* checkpoint corrompu -> frais */ }
  }
  let history, newPois, gapCandles, startIdx;
  if (state) {
    history = state.history; newPois = state.newPois; gapCandles = state.gapCandles;
    startIdx = days.indexOf(state.nextDay);
    if (startIdx < 0) { console.error(`Checkpoint incohérent (nextDay ${state.nextDay} hors liste) — supprimer ${STATE_PATH}`); process.exit(1); }
    console.log(`Reprise du checkpoint: jour ${state.nextDay} (${startIdx}/${days.length}), ${newPois.length} POI déjà détectés`);
  } else {
    history = await fetchHistory(START_MS); // graine : 192 bougies fapi avant la fenêtre
    newPois = []; gapCandles = []; startIdx = 0;
    console.log(`Graine d'historique: ${history.length} bougies fapi avant ${dayOf(START_MS)}`);
  }

  const isClimax = (volume, prior) => {
    const w = prior.slice(-30);
    if (w.length < 10 || !(volume > 0)) return false;
    let m = 0; for (const c of w) if (c.volume > m) m = c.volume;
    return volume > m;
  };

  // --- streaming jour par jour : fp -> détection immédiate, bins jetés ----
  let bucket = null;
  const closeBucket = () => {
    if (!bucket) return;
    const fp = B.finalizeFootprintBucket(bucket);
    bucket = null;
    if (!fp || fp.startTs < START_MS || fp.startTs >= endMs) return;
    const poi = B.detectPoi(fp, history, config, fp.availableAt);
    if (poi) newPois.push(Object.assign({}, poi, { climax: isClimax(fp.volume, history) }));
    history = history.concat(fp).slice(-config.historyCandles);
    gapCandles.push({ timestamp: fp.startTs, high: fp.high, low: fp.low, close: fp.close });
  };
  const rollover = (trade) => {
    if (trade.timestamp < START_MS || trade.timestamp >= endMs) return;
    if (bucket && trade.timestamp >= bucket.endTs) closeBucket();
    if (!bucket) bucket = B.createFootprintBucket(trade.timestamp, TF, true);
    B.accumulateFootprintTrade(bucket, trade, config.binSize);
  };

  const t0 = Date.now();
  for (let i = startIdx; i < days.length; i++) {
    const day = days[i];
    let csv;
    try { csv = await ensureDayCsv(day); }
    catch (error) { console.error(`  ${day}: indisponible (${error.message}) — arrêt (checkpoint conservé)`); process.exit(1); }
    const n = await streamDay(csv, rollover);
    purgeDay(day);
    const el = (Date.now() - t0) / 1000, doneN = i - startIdx + 1;
    const eta = Math.round(el / doneN * (days.length - i - 1) / 60);
    console.log(`  ${day}: ${n} trades — ${newPois.length} POI cumulés (${i + 1}/${days.length}, ETA ~${eta} min)`);
    if ((i + 1) % CHECKPOINT_EVERY === 0 && i + 1 < days.length) {
      // Fermer le bucket courant avant de sérialiser : sans danger, une
      // bougie M15 ne chevauche jamais minuit (900 s divise 86 400) — le
      // bucket ouvert en fin de jour a déjà reçu tous ses trades.
      closeBucket();
      const tmp = STATE_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ startMs: START_MS, endMs, nextDay: days[i + 1], history, newPois, gapCandles }));
      fs.renameSync(tmp, STATE_PATH);
    }
  }
  closeBucket();
  console.log(`Footprints M15 traités: ${gapCandles.length} ; POI détectés: ${newPois.length} (dont climax: ${newPois.filter((p) => p.climax).length})`);

  // --- vieillissement des nouveaux POI à travers la fenêtre construite ----
  // Vieillissement optimisé, sémantique IDENTIQUE à updatePoiLifecycle :
  // - départ à la bougie de création (les antérieures sont des no-ops prouvés :
  //   candleTs < availableAt -> return poi inchangé) ;
  // - arrêt au statut TERMINAL (INVALIDATED/MITIGATED : la fonction elle-même
  //   court-circuite `TERMINAL.has(status) -> return poi`, poi-lifecycle.js:30).
  // Sans cela : 35 k POI × 35 k bougies = ~1,2 Md d'appels avec allocation
  // d'un objet gelé par bougie éligible (constaté : >1 h de GC sur BTC 2025).
  const age = (poi) => {
    let p = poi;
    let lo = 0, hi = gapCandles.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (gapCandles[m].timestamp < p.createdTs) lo = m + 1; else hi = m; }
    for (let i = lo; i < gapCandles.length; i++) {
      p = B.updatePoiLifecycle(p, gapCandles[i], config);
      if (p.status === "INVALIDATED" || p.status === "MITIGATED") break;
    }
    return p;
  };
  // dédup contre les lignes CONSERVÉES (préfixe 2025 + suffixe extension)
  const keptTs = new Set(archive.pois
    .filter((r) => { const t = Number(r[IDX.createdTs]); return t < START_MS || t >= endMs; })
    .map((r) => Number(r[IDX.createdTs])));
  const aged = newPois.filter((p) => !keptTs.has(p.createdTs)).map(age);

  // --- lignes (mêmes règles que regen-archive.js) -------------------------
  const statusChar = (p) => p.status === "ACTIVE_UNTOUCHED" ? "A"
    : (p.status === "INVALIDATED" ? "I" : "T");
  const retestOf = (p) => (p.status === "ACTIVE_UNTOUCHED" ? null : (p.firstTouchTs ?? p.statusChangedTs ?? null));
  const newRows = aged.map((p) => {
    const row = new Array(archive.columns.length).fill(null);
    row[IDX.createdTs] = p.createdTs;
    row[IDX.direction] = p.direction === "long" ? "L" : "S";
    row[IDX.zoneLow] = p.zoneLow; row[IDX.zoneHigh] = p.zoneHigh;
    row[IDX.entryPrice] = p.entryPrice;
    row[IDX.clusterLow] = p.clusterLow; row[IDX.clusterHigh] = p.clusterHigh;
    row[IDX.imbalance] = p.imbalance; row[IDX.zoneVolume] = p.zoneVolume;
    row[IDX.zoneVolumeShare] = p.zoneVolumeShare;
    row[IDX.fpTimeStart] = p.fpTimeStart; row[IDX.fpTimeEnd] = p.fpTimeEnd;
    row[IDX.fpTimeShare] = p.fpTimeShare; row[IDX.clusterBins] = p.clusterBins;
    row[IDX.originZone] = p.originZone ? 1 : 0; row[IDX.fallbackZone] = p.fallbackZone ? 1 : 0;
    row[IDX.accumulationScore] = p.accumulationScore;
    row[IDX.strategyScore] = null;
    row[IDX.importanceScore] = p.importanceScore; row[IDX.poiChargeScore] = p.importanceScore;
    row[IDX.status] = statusChar(p); row[IDX.retestTs] = retestOf(p);
    if (IDX.climax != null) row[IDX.climax] = p.climax ? 1 : 0;
    return row;
  });

  // --- REMPLACEMENT : préfixe 2025 + fenêtre JS + suffixe extension -------
  const prefix = archive.pois.filter((r) => Number(r[IDX.createdTs]) < START_MS);
  const suffix = archive.pois.filter((r) => Number(r[IDX.createdTs]) >= endMs);
  const allRows = prefix.concat(newRows, suffix);
  const activeCount = allRows.filter((r) => r[IDX.status] === "A").length;
  const iCount = allRows.filter((r) => r[IDX.status] === "I").length;
  const out = Object.assign({}, archive, {
    capturedAt: new Date().toISOString(),
    sourceStats: Object.assign({}, archive.sourceStats, {
      totalPois: allRows.length,
      activePois: activeCount,
      retestedPois: allRows.length - activeCount
    }),
    extension: Object.assign({}, archive.extension, {
      note: "Archive 100% détecteur JS live (corpus canonique Antho v1 2026-01->07 REMPLACÉ pour homogénéiser le régime d'émission — décision D1, AUDIT_SCORING_2026-07-23 ; l'original reste dans git). Parité par-POI conditionnelle (zones/scores) vérifiée par tools/parity-harness.js."
    }),
    homogenized: {
      note: "Fenêtre canonique régénérée au détecteur JS (même moteur que backfill 2025 et extension quotidienne).",
      windowStartMs: START_MS,
      windowEndMs: endMs,
      replacedRows: canonical.length,
      newRows: newRows.length,
      generatedAt: new Date().toISOString()
    },
    pois: allRows
  });
  const target = PREVIEW ? ARCHIVE_PATH + ".preview.json" : ARCHIVE_PATH;
  writeArchiveAtomic(target, JSON.stringify(out) + "\n");
  try { fs.rmSync(STATE_PATH, { force: true }); } catch (_) {}
  console.log(`\nArchive homogénéisée: ${canonical.length} lignes canoniques -> ${newRows.length} lignes JS ; total ${allRows.length} (${activeCount} A / ${allRows.length - activeCount - iCount} T / ${iCount} I)`);
  console.log(`Fichier: ${target} (${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} Mo)`);
  if (!PREVIEW) console.log("⚠ Enchaîner: node backfill-invalidation.js BTCUSDT && node backfill-approach.js BTCUSDT && node backfill-outcome.js BTCUSDT");
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
