"use strict";

/* G-ON — Régénération/extension d'archive POI depuis Binance Vision.
 * Multi-symbole : `node regen-archive.js [SYMBOL] [initDays]`
 *   - BTCUSDT (défaut) : étend l'archive canonique Antho v1 existante ;
 *   - autre symbole (ex. ETHUSDT) : si l'archive n'existe pas, un squelette
 *     est initialisé sur `initDays` jours (défaut 30) puis rempli — population
 *     100% détecteur JS (prouvé par tools/parity-harness.js), AUCUN corpus
 *     canonique d'origine (tracé dans meta.extension).
 * À chaque run : corpus existant intact, trou comblé jusqu'au dernier jour
 * publié, statuts re-vieillis, flag CLIMAX maintenu (volume > max des 30
 * bougies précédentes), frontières sourceStats avancées. Idempotent.
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
const SYMBOL = (process.argv[2] || "BTCUSDT").toUpperCase();
const INIT_DAYS = parseInt(process.argv[3], 10) || 30;
// binSize par symbole = 10^(floor(log10(prix)) - 3), FIGE a la creation de
// l'archive (prix du 2026-07-19) pour ne pas deriver si le prix change de
// decade. COPIE SYNCHRONISEE de POI_SYMBOL_CONFIG dans poi/poi-feature.js —
// toute modification doit etre faite dans LES DEUX fichiers.
const BIN_SIZE = {
  BTCUSDT: 10, ETHUSDT: 1,
  BNBUSDT: 0.1, SOLUSDT: 0.01, AAVEUSDT: 0.01,
  XRPUSDT: 0.001, LINKUSDT: 0.001, INJUSDT: 0.001, ETCUSDT: 0.001,
  ADAUSDT: 1e-4, APTUSDT: 1e-4, SUIUSDT: 1e-4, FILUSDT: 1e-4, WLDUSDT: 1e-4, TIAUSDT: 1e-4,
  DOGEUSDT: 1e-5, ARBUSDT: 1e-5, OPUSDT: 1e-5,
  "1000PEPEUSDT": 1e-6, "1000SHIBUSDT": 1e-6
};
const VISION = `https://data.binance.vision/data/futures/um/daily/aggTrades/${SYMBOL}`;
const CACHE = path.join(os.tmpdir(), "gon-vision-cache");
const ARCHIVE_PATH = path.join(__dirname, "..", "poi",
  SYMBOL === "BTCUSDT" ? "antho-v1-m15-pois.json" : `archive-${SYMBOL}-m15.json`);
const COLUMNS = [
  "createdTs", "direction", "zoneLow", "zoneHigh", "entryPrice", "clusterLow", "clusterHigh",
  "imbalance", "zoneVolume", "zoneVolumeShare", "fpTimeStart", "fpTimeEnd", "fpTimeShare",
  "clusterBins", "originZone", "fallbackZone", "accumulationScore", "strategyScore",
  "importanceScore", "poiChargeScore", "status", "retestTs", "climax"
];

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
  // Un CSV sans marqueur .ok = extraction interrompue (kill en plein
  // extractall) : le reutiliser corromprait silencieusement le corpus pour
  // toujours (la frontiere avance au-dela du jour). On repart de zero.
  if (fs.existsSync(csv) && fs.existsSync(okMarker)) return csv;
  try { fs.rmSync(csv, { force: true }); } catch (_) {}
  const zip = path.join(CACHE, `${SYMBOL}-aggTrades-${day}.zip`);
  if (!fs.existsSync(zip)) {
    console.log(`  téléchargement ${SYMBOL} ${day}…`);
    await download(`${VISION}/${SYMBOL}-aggTrades-${day}.zip`, zip);
  }
  try {
    unzip(zip, CACHE);
  } catch (error) {
    // zip corrompu/tronque : purger, sinon chaque run quotidien echoue au
    // meme jour pour toujours (frontiere figee en silence).
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
    // Vraisemblance du timestamp : Binance a deja migre des dumps Vision en
    // MICROSECONDES sans changer les colonnes — floor(us/TF) propulserait la
    // frontiere des siecles en avant, silencieusement. Echec bruyant exige.
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

function skeleton(startMs) {
  return {
    schemaVersion: 2, symbol: SYMBOL, timeframe: "15m", timeframeMs: TF,
    binSize: BIN_SIZE[SYMBOL] || 10,
    source: "BINANCE_FUTURES_AGGTRADE_ARCHIVE",
    detectorVersion: "fp-m15-importance-v2", scoreModelVersion: "poi-importance-v2",
    capturedAt: new Date().toISOString(),
    sourceStats: {
      totalPois: 0, activePois: 0, retestedPois: 0,
      lastPoiCreatedTs: null, lastAggTradeMs: startMs, lastPoiCloseMs: null
    },
    columns: COLUMNS.slice(),
    pois: []
  };
}

(async () => {
  acquire();   // verrou inter-process : un backfill manuel concurrent attendra
  // --- 1. archive existante ou squelette d'initialisation ------------------
  let archive;
  if (fs.existsSync(ARCHIVE_PATH)) {
    archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  } else {
    const startMs = Math.floor((Date.now() - INIT_DAYS * 24 * 3600 * 1000) / TF) * TF;
    archive = skeleton(startMs);
    console.log(`Aucune archive ${SYMBOL} : initialisation sur ${INIT_DAYS} jours (depuis ${fmt(startMs)})`);
  }
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const config = B.createPoiConfig({ symbol: SYMBOL, binSize: archive.binSize });
  const oldValidAfter = Number(archive.sourceStats.lastAggTradeMs) || 0;
  const firstNewCandle = Math.floor(oldValidAfter / TF) * TF;
  console.log(`Archive ${SYMBOL}: ${archive.pois.length} POI, frontière ${fmt(oldValidAfter)}`);

  const days = [];
  const todayUtc = dayOf(Date.now());
  for (let d = new Date(dayOf(firstNewCandle) + "T00:00:00Z"); dayOf(d.getTime()) < todayUtc; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(dayOf(d.getTime()));
  }
  if (!days.length) { console.log("Rien à combler (archive déjà à jour vs Vision)."); process.exit(0); }
  console.log(`Jours Vision: ${days[0]} -> ${days[days.length - 1]} (${days.length}) — bougies à partir de ${fmt(firstNewCandle)}`);

  // --- 2. footprints M15 du trou depuis les dumps --------------------------
  let bucket = null;
  const footprints = [];
  const rollover = (trade) => {
    const startTs = Math.floor(trade.timestamp / TF) * TF;
    if (startTs < firstNewCandle) return;
    if (bucket && trade.timestamp >= bucket.endTs) {
      const fp = B.finalizeFootprintBucket(bucket);
      if (fp && fp.startTs >= firstNewCandle) footprints.push(fp);
      bucket = null;
    }
    if (!bucket) bucket = B.createFootprintBucket(trade.timestamp, TF, true);
    B.accumulateFootprintTrade(bucket, trade, config.binSize);
  };
  for (const day of days) {
    let csv;
    try { csv = await ensureDayCsv(day); }
    catch (error) { console.log(`  ${day}: indisponible (${error.message}) — arret ici`); break; }
    const n = await streamDay(csv, rollover);
    console.log(`  ${day}: ${n} trades`);
  }
  if (bucket) {
    const fp = B.finalizeFootprintBucket(bucket);
    if (fp && fp.endTs <= new Date(days[days.length - 1] + "T23:59:59Z").getTime() + 1000) footprints.push(fp);
    bucket = null;
  }
  console.log(`Footprints M15 reconstruits: ${footprints.length}`);
  if (!footprints.length) {
    console.log("Aucune bougie nouvelle disponible — archive inchangée.");
    process.exit(0);
  }

  // --- 3. détection (flag climax maintenu) ---------------------------------
  const isClimax = (volume, prior) => {
    const w = prior.slice(-30);
    if (w.length < 10 || !(volume > 0)) return false;
    let m = 0; for (const c of w) if (c.volume > m) m = c.volume;
    return volume > m;
  };
  let history = await fetchHistory(firstNewCandle);
  const newPois = [];
  for (const fp of footprints) {
    const poi = B.detectPoi(fp, history, config, fp.availableAt);
    if (poi) newPois.push(Object.freeze(Object.assign({}, poi, { climax: isClimax(fp.volume, history) })));
    history = history.concat(fp).slice(-config.historyCandles);
  }
  console.log(`Nouveaux POI détectés: ${newPois.length} (dont climax: ${newPois.filter((p) => p.climax).length})`);

  // --- 4. vieillissement de TOUS les POI à travers les bougies du trou -----
  const toRuntime = (row) => {
    const direction = row[IDX.direction] === "L" ? "long" : "short";
    const createdTs = Number(row[IDX.createdTs]);
    const active = row[IDX.status] === "A";
    const rawRetest = row[IDX.retestTs];
    const retestTs = rawRetest === null || rawRetest === undefined ? null : Number(rawRetest);
    return {
      row, createdTs, direction,
      availableAt: createdTs + TF,
      zoneLow: Number(row[IDX.zoneLow]), zoneHigh: Number(row[IDX.zoneHigh]),
      clusterLow: Number(row[IDX.clusterLow]), clusterHigh: Number(row[IDX.clusterHigh]),
      // "I" -> INVALIDATED (terminal : le vieillissement n'y touche plus).
      // Le relire comme TOUCHED detruisait les invalidations des backfills.
      status: active ? "ACTIVE_UNTOUCHED" : (row[IDX.status] === "I" ? "INVALIDATED" : "TOUCHED"),
      firstTouchTs: active || !Number.isFinite(retestTs) || retestTs <= 0 ? null : retestTs,
      touchCount: active ? 0 : 1, maxPenetrationPct: 0,
      lastLifecycleCandleTs: null,
      statusChangedTs: active ? createdTs + TF : retestTs,
      lifecycleValidAfterTs: oldValidAfter
    };
  };
  const gapCandles = footprints.map((fp) => ({ timestamp: fp.startTs, high: fp.high, low: fp.low, close: fp.close }));
  const age = (poi) => {
    let p = poi;
    for (const c of gapCandles) p = B.updatePoiLifecycle(p, c, config);
    return p;
  };
  const agedOld = archive.pois.map((row) => age(toRuntime(row)));
  // Dedup a la jointure : une frontiere heritee mi-bougie (premier export
  // canonique) re-genere la bougie frontiere deja couverte par le corpus.
  const existingCreated = new Set(archive.pois.map((r) => Number(r[IDX.createdTs])));
  const agedNew = newPois.filter((poi) => !existingCreated.has(poi.createdTs)).map((poi) => age(poi));

  // --- 5. réécriture --------------------------------------------------------
  // A = actif ; I = invalide (cassure/balayage — un ECHEC du niveau) ;
  // T = retest par chevauchement (touch/mitigation — le niveau a SERVI).
  // Ecraser "I" en "T" enregistrait chaque cassure comme un retest reussi :
  // corpus corrompu et dataset approchAtr pollue, de facon cumulative.
  const statusChar = (p) => p.status === "ACTIVE_UNTOUCHED" ? "A"
    : (p.status === "INVALIDATED" ? "I" : "T");
  const retestOf = (p) => (p.status === "ACTIVE_UNTOUCHED" ? null : (p.firstTouchTs ?? p.statusChangedTs ?? null));
  const oldRows = agedOld.map((p) => {
    const row = p.row.slice();
    const sc = statusChar(p);
    row[IDX.status] = sc;
    row[IDX.retestTs] = sc === "A" ? p.row[IDX.retestTs] : (retestOf(p) ?? p.row[IDX.retestTs]);
    // Un verdict `win` ne vaut QUE pour une ligne encore "T" (retest servi) :
    // si un retest est ensuite re-vieilli en "I" (cluster casse apres coup),
    // son verdict n'a plus de sens -> null, pour ne pas polluer les stats.
    if ("win" in IDX && sc !== "T" && row[IDX.win] !== null && row[IDX.win] !== undefined) {
      row[IDX.win] = null;
    }
    return row;
  });
  const newRows = agedNew.map((p) => {
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

  const lastFp = footprints[footprints.length - 1];
  const allRows = oldRows.concat(newRows);
  const activeCount = allRows.filter((r) => r[IDX.status] === "A").length;
  const extendedFromTs = (archive.extension && Number(archive.extension.extendedFromTs)) || oldValidAfter;
  const out = Object.assign({}, archive, {
    capturedAt: new Date().toISOString(),
    sourceStats: {
      totalPois: allRows.length,
      activePois: activeCount,
      retestedPois: allRows.length - activeCount,
      lastPoiCreatedTs: newRows.length ? newRows[newRows.length - 1][IDX.createdTs] : archive.sourceStats.lastPoiCreatedTs,
      lastAggTradeMs: lastFp ? lastFp.endTs : archive.sourceStats.lastAggTradeMs,
      lastPoiCloseMs: newRows.length ? newRows[newRows.length - 1][IDX.createdTs] : archive.sourceStats.lastPoiCloseMs
    },
    extension: {
      note: SYMBOL === "BTCUSDT"
        ? "Corpus original (strict, generateur Antho v1) jusqu'a extendedFromTs ; au-dela, extension par le detecteur JS live (parite prouvee par tools/parity-harness.js)."
        : "Archive 100% detecteur JS live (aucun corpus canonique d'origine pour ce symbole) ; parite du detecteur prouvee sur BTCUSDT par tools/parity-harness.js.",
      extendedFromTs,
      extendedToTs: lastFp ? lastFp.endTs : oldValidAfter,
      extendedRows: (archive.extension ? Number(archive.extension.extendedRows) || 0 : 0) + newRows.length,
      source: "data.binance.vision daily aggTrades",
      regeneratedAt: new Date().toISOString()
    },
    pois: allRows
  });
  writeArchiveAtomic(ARCHIVE_PATH, JSON.stringify(out) + "\n");
  const iCount = allRows.filter((r) => r[IDX.status] === "I").length;
  console.log(`\nArchive ${SYMBOL} régénérée: ${allRows.length} POI (${activeCount} A / ${allRows.length - activeCount - iCount} T / ${iCount} I)`);
  console.log(`Frontière: ${fmt(out.sourceStats.lastAggTradeMs)} (avant: ${fmt(oldValidAfter)})`);
  console.log(`Fichier: ${ARCHIVE_PATH} (${(fs.statSync(ARCHIVE_PATH).size / 1024 / 1024).toFixed(2)} Mo)`);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
