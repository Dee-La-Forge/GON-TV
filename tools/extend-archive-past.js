"use strict";

/* G-ON — Extension ARRIÈRE d'archive POI depuis Binance Vision.
 * `node extend-archive-past.js [SYMBOL] [startDay=2025-01-01] [--preview]`
 *
 * Complément de regen-archive.js (qui n'avance que la frontière AVANT) :
 * reconstruit les footprints M15 depuis `startDay` jusqu'au DÉBUT de la
 * couverture existante, détecte les POI avec le même détecteur JS (parité
 * prouvée par tools/parity-harness.js), les vieillit à travers la fenêtre
 * construite, puis les PRÉFIXE aux lignes existantes. Le corpus canonique
 * et la frontière avant (sourceStats.lastAggTradeMs, extension.*) restent
 * STRICTEMENT intacts — le regen quotidien continue tel quel.
 *
 * Bornes de fin (exclusives) :
 *   - archive.coverageStartMs si présent (ré-extension encore plus loin) ;
 *   - BTCUSDT : 2026-01-01T00:00Z (début du corpus canonique Antho v1) ;
 *   - autres : extension.extendedFromTs (début du squelette initial).
 *
 * IMPORTANT — un POI 2025 encore "A" en fin de fenêtre est un zombie tant
 * que backfill-invalidation.js n'a pas re-vieilli les actifs à travers
 * 2026 : TOUJOURS enchaîner `node backfill-invalidation.js SYMBOL` puis
 * `node backfill-approach.js SYMBOL` (et backfill-outcome.js pour BTC)
 * avant de publier.
 *
 * Hygiène disque : zip+csv purgés après chaque jour traité (l'année
 * complète ne tient pas dans %TMP%). Checkpoint tous les 20 jours dans le
 * cache — un run interrompu reprend au jour suivant le checkpoint.
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
const args = process.argv.slice(2).filter((a) => a !== "--preview");
const PREVIEW = process.argv.includes("--preview");
const SYMBOL = (args[0] || "BTCUSDT").toUpperCase();
const START_DAY = args[1] || "2025-01-01";
if (!/^\d{4}-\d{2}-\d{2}$/.test(START_DAY)) { console.error(`startDay invalide: ${START_DAY}`); process.exit(1); }
const START_MS = Date.parse(START_DAY + "T00:00:00Z");

const VISION = `https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
const CACHE = path.join(os.tmpdir(), "gon-vision-cache");
const ARCHIVE_PATH = path.join(__dirname, "..", "poi",
  SYMBOL === "BTCUSDT" ? "antho-v1-m15-pois.json" : `archive-${SYMBOL}-m15.json`);
const STATE_PATH = path.join(CACHE, `extend-state-${SYMBOL}.json`);
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
  if (!fs.existsSync(ARCHIVE_PATH)) { console.error(`Pas d'archive ${SYMBOL} — l'extension arrière exige une archive existante.`); process.exit(1); }
  const archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const config = B.createPoiConfig({ symbol: SYMBOL, binSize: archive.binSize });

  // --- borne de fin exclusive = début de la couverture existante ----------
  let endMs;
  if (Number.isFinite(Number(archive.coverageStartMs))) {
    endMs = Number(archive.coverageStartMs);
  } else if (SYMBOL === "BTCUSDT") {
    endMs = Date.UTC(2026, 0, 1); // début du corpus canonique Antho v1
  } else {
    endMs = Number(archive.extension && archive.extension.extendedFromTs);
  }
  if (!Number.isFinite(endMs) || endMs <= 0) { console.error("Borne de fin introuvable (coverageStartMs/extendedFromTs)."); process.exit(1); }
  endMs = Math.floor(endMs / TF) * TF;
  if (START_MS >= endMs) { console.log(`Rien à étendre : couverture commence déjà à ${fmt(endMs)} (start ${START_DAY}).`); process.exit(0); }

  // --- liste des jours (le jour contenant endMs inclus si endMs mi-jour) --
  const days = [];
  const lastDay = dayOf(endMs - 1);
  for (let d = new Date(START_DAY + "T00:00:00Z"); dayOf(d.getTime()) <= lastDay; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(dayOf(d.getTime()));
  }
  console.log(`Extension ${SYMBOL}: ${days[0]} -> ${days[days.length - 1]} (${days.length} jours), fin exclusive ${fmt(endMs)}${PREVIEW ? " [PREVIEW]" : ""}`);

  // --- état (checkpoint ou frais) -----------------------------------------
  let state = null;
  if (fs.existsSync(STATE_PATH)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      if (s.symbol === SYMBOL && s.startDay === START_DAY && s.endMs === endMs) state = s;
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
    history = await fetchHistory(START_MS); // graine : 192 bougies fapi avant startDay
    newPois = []; gapCandles = []; startIdx = 0;
    console.log(`Graine d'historique: ${history.length} bougies fapi avant ${START_DAY}`);
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
      fs.writeFileSync(tmp, JSON.stringify({ symbol: SYMBOL, startDay: START_DAY, endMs, nextDay: days[i + 1], history, newPois, gapCandles }));
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
  const existingCreated = new Set(archive.pois.map((r) => Number(r[IDX.createdTs])));
  const aged = newPois.filter((p) => !existingCreated.has(p.createdTs)).map(age);

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

  // --- PRÉFIXE : frontière avant et corpus existant STRICTEMENT intacts ---
  const allRows = newRows.concat(archive.pois);
  const activeCount = allRows.filter((r) => r[IDX.status] === "A").length;
  const iCount = allRows.filter((r) => r[IDX.status] === "I").length;
  const out = Object.assign({}, archive, {
    capturedAt: new Date().toISOString(),
    coverageStartMs: START_MS,
    sourceStats: Object.assign({}, archive.sourceStats, {
      totalPois: allRows.length,
      activePois: activeCount,
      retestedPois: allRows.length - activeCount
    }),
    backfillPast: {
      note: "Extension ARRIÈRE par le détecteur JS live (parité prouvée par tools/parity-harness.js) ; corpus original et frontière avant intacts. Enchaîner backfill-invalidation avant publication (zombies 2025).",
      coverageStartMs: START_MS,
      builtToTs: endMs,
      addedRows: ((archive.backfillPast && Number(archive.backfillPast.addedRows)) || 0) + newRows.length,
      source: "data.binance.vision daily aggTrades",
      generatedAt: new Date().toISOString()
    },
    pois: allRows
  });
  const target = PREVIEW ? ARCHIVE_PATH + ".preview.json" : ARCHIVE_PATH;
  writeArchiveAtomic(target, JSON.stringify(out) + "\n");
  try { fs.rmSync(STATE_PATH, { force: true }); } catch (_) {}
  console.log(`\nArchive ${SYMBOL} étendue: +${newRows.length} POI 2025 -> ${allRows.length} total (${activeCount} A / ${allRows.length - activeCount - iCount} T / ${iCount} I)`);
  console.log(`Couverture: ${fmt(START_MS)} -> ${fmt(out.sourceStats.lastAggTradeMs)} ; fichier: ${target} (${(fs.statSync(target).size / 1024 / 1024).toFixed(2)} Mo)`);
  if (activeCount && !PREVIEW) console.log(`⚠ Enchaîner: node backfill-invalidation.js ${SYMBOL} && node backfill-approach.js ${SYMBOL}${SYMBOL === "BTCUSDT" ? " && node backfill-outcome.js BTCUSDT" : ""}`);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
