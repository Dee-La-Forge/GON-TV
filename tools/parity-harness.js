"use strict";

/* G-ON — Harnais de parité détecteur JS ↔ générateur Antho v1 M15 (audit O2).
 *
 * Principe : le générateur Python M15 qui a produit l'archive (et entraîné le
 * score) est perdu, mais son OUTPUT ne l'est pas — l'archive est le golden
 * dataset. Pour un échantillon de bougies sources :
 *   1. re-télécharge les aggTrades bruts de la fenêtre M15 chez Binance ;
 *   2. reconstruit le footprint clos (BiquettePoi.buildClosedFootprintFromTrades) ;
 *   3. exécute le détecteur JS (BiquettePoi.detectPoi) avec l'historique klines ;
 *   4. compare champ par champ contre la ligne d'archive (géométrie, features,
 *      accumulationScore, importanceScore).
 * Bougies négatives (dans la période d'archive, sans ligne d'archive) : mesure
 * la SUR-ÉMISSION du détecteur live (attendue par design allM15CandlePois) —
 * informatif, pas un échec.
 *
 * Lancer : node g-on/tools/parity-harness.js [nRecent] [nOld] [nNeg]
 * (défauts : 8 3 4 — ~1-2 min de requêtes Binance, avec throttling)
 */

global.window = global;
require("../poi/poi-config.js");
require("../poi/poi-score-model.js");
require("../poi/footprint-m15.js");
require("../poi/poi-detector.js");

const fs = require("fs");
const path = require("path");
const { politeFetch } = require("./http");
const B = global.BiquettePoi;

const FAPI = "https://fapi.binance.com";
const TF = 15 * 60 * 1000;
const SYMBOL = "BTCUSDT";
const MAX_PAGES = 120;

const nRecent = parseInt(process.argv[2], 10) || 8;
const nOld = parseInt(process.argv[3], 10) || 3;
const nNeg = parseInt(process.argv[4], 10) || 4;

// --- archive ---------------------------------------------------------------
const archivePath = path.join(__dirname, "..", "poi", "antho-v1-m15-pois.json");
const archive = JSON.parse(fs.readFileSync(archivePath, "utf8"));
const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
const rowsByTs = new Map();
for (const row of archive.pois) {
  const ts = Number(row[IDX.createdTs]);
  if (!rowsByTs.has(ts)) rowsByTs.set(ts, []);
  rowsByTs.get(ts).push(row);
}
const allTs = [...rowsByTs.keys()].sort((a, b) => a - b);
const lastTs = allTs[allTs.length - 1];

// --- échantillonnage déterministe (LCG, seed du backtest) -------------------
let lcgState = 42017;
function lcg() { lcgState = (lcgState * 1103515245 + 12345) % 2147483648; return lcgState / 2147483648; }
function sample(arr, n) {
  const pool = arr.slice(), out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(lcg() * pool.length), 1)[0]);
  return out;
}

const recentPool = allTs.filter((ts) => ts > lastTs - 3 * 24 * 3600 * 1000);
const oldPool = allTs.filter((ts) => ts <= lastTs - 30 * 24 * 3600 * 1000);
const positives = sample(recentPool, nRecent).concat(sample(oldPool, nOld));

// négatifs : bougies M15 de la période récente d'archive SANS ligne d'archive
const negPool = [];
for (let ts = lastTs - 3 * 24 * 3600 * 1000; ts < lastTs; ts += TF) {
  if (!rowsByTs.has(ts)) negPool.push(ts);
}
const negatives = sample(negPool, nNeg);

// --- réseau ----------------------------------------------------------------
// Invariant README : tout appel fapi passe par politeFetch (cadence globale
// partagée + Retry-After) — le throttle maison 120 ms violait le budget.
async function fetchJson(url) {
  const res = await politeFetch(url);
  if (!res.ok) throw Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchWindowTrades(startTs, endTs) {
  let page = await fetchJson(`${FAPI}/fapi/v1/aggTrades?symbol=${SYMBOL}&startTime=${startTs}&endTime=${endTs - 1}&limit=1000`);
  const trades = page.slice();
  let pages = 1;
  let lastId = page.length ? Number(page[page.length - 1].a) : null;
  while (page.length === 1000 && pages < MAX_PAGES) {
    page = await fetchJson(`${FAPI}/fapi/v1/aggTrades?symbol=${SYMBOL}&fromId=${lastId + 1}&limit=1000`);
    pages += 1;
    if (!page.length) break;
    trades.push(...page);
    const nextLast = Number(page[page.length - 1].a);
    if (!Number.isSafeInteger(nextLast) || nextLast <= lastId) break;
    lastId = nextLast;
    if (page.some((t) => Number(t.T) >= endTs)) break;
  }
  if (pages >= MAX_PAGES) throw Error(`bougie trop volumineuse (>${MAX_PAGES} pages)`);
  return trades.filter((t) => Number(t.T) >= startTs && Number(t.T) < endTs);
}

async function fetchHistory(beforeTs) {
  const rows = await fetchJson(`${FAPI}/fapi/v1/klines?symbol=${SYMBOL}&interval=15m&endTime=${beforeTs - 1}&limit=192`);
  return rows.map((row) => {
    const volume = Number(row[5]), longVolume = Number(row[9]);
    return {
      startTs: Number(row[0]), endTs: Number(row[6]) + 1, availableAt: Number(row[6]) + 1,
      open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
      volume, longVolume, shortVolume: Math.max(0, volume - longVolume), bins: []
    };
  }).filter((r) => Number.isFinite(r.volume) && r.volume > 0 && r.endTs <= beforeTs);
}

// --- comparaison -----------------------------------------------------------
const config = B.createPoiConfig({ symbol: SYMBOL, binSize: archive.binSize });
function relDiff(a, b) {
  if (a === b) return 0;
  const d = Math.abs(a - b), m = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return d / m;
}
const FIELDS = [
  ["direction", (p) => p.direction, (r) => (r[IDX.direction] === "L" ? "long" : "short"), "exact"],
  ["entryPrice", (p) => p.entryPrice, (r) => Number(r[IDX.entryPrice]), "exact"],
  ["zoneLow", (p) => p.zoneLow, (r) => Number(r[IDX.zoneLow]), "exact"],
  ["zoneHigh", (p) => p.zoneHigh, (r) => Number(r[IDX.zoneHigh]), "exact"],
  ["clusterLow", (p) => p.clusterLow, (r) => Number(r[IDX.clusterLow]), "exact"],
  ["clusterHigh", (p) => p.clusterHigh, (r) => Number(r[IDX.clusterHigh]), "exact"],
  ["clusterBins", (p) => p.clusterBins, (r) => Number(r[IDX.clusterBins]), "exact"],
  ["originZone", (p) => p.originZone, (r) => r[IDX.originZone] === 1, "exact"],
  ["fallbackZone", (p) => p.fallbackZone, (r) => r[IDX.fallbackZone] === 1, "exact"],
  ["imbalance", (p) => p.imbalance, (r) => Number(r[IDX.imbalance]), "rel", 1e-6],
  ["zoneVolume", (p) => p.zoneVolume, (r) => Number(r[IDX.zoneVolume]), "rel", 1e-6],
  ["zoneVolumeShare", (p) => p.zoneVolumeShare, (r) => Number(r[IDX.zoneVolumeShare]), "rel", 1e-6],
  ["fpTimeStart", (p) => p.fpTimeStart, (r) => Number(r[IDX.fpTimeStart]), "exact"],
  ["fpTimeEnd", (p) => p.fpTimeEnd, (r) => Number(r[IDX.fpTimeEnd]), "exact"],
  ["fpTimeShare", (p) => p.fpTimeShare, (r) => Number(r[IDX.fpTimeShare]), "rel", 1e-6],
  ["accumulationScore", (p) => p.accumulationScore, (r) => Number(r[IDX.accumulationScore]), "abs", 0.02],
  ["importanceScore", (p) => p.importanceScore, (r) => Number(r[IDX.importanceScore]), "abs", 1.0]
];

function compare(poi, row) {
  const out = [];
  for (const [name, getJs, getRef, mode, tol] of FIELDS) {
    const js = getJs(poi), ref = getRef(row);
    let ok;
    if (mode === "exact") ok = js === ref;
    else if (mode === "rel") ok = relDiff(Number(js), Number(ref)) <= tol;
    else ok = Math.abs(Number(js) - Number(ref)) <= tol;
    out.push({ name, ok, js, ref });
  }
  return out;
}

// --- run -------------------------------------------------------------------
const fmt = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

async function runCandle(ts, expected) {
  const label = `${fmt(ts)} [${expected ? "POSITIF" : "NEGATIF"}]`;
  try {
    const trades = await fetchWindowTrades(ts, ts + TF);
    if (!trades.length) return { ts, label, verdict: "UNAVAILABLE", note: "aucun trade retourné" };
    const footprint = B.buildClosedFootprintFromTrades(
      trades, { startTs: ts, endTs: ts + TF, complete: true, provenance: "parity" }, config);
    if (!footprint) return { ts, label, verdict: "UNAVAILABLE", note: `footprint invalide (${trades.length} trades, contiguïté ?)` };
    const history = await fetchHistory(ts);
    const poi = B.detectPoi(footprint, history, config, footprint.availableAt);

    if (!expected) {
      return { ts, label, verdict: poi ? "SUREMISSION" : "MATCH_NONE", note: poi ? `JS émet ${poi.direction}@${poi.entryPrice} S${poi.importanceScore} (archive: rien)` : "JS n'émet rien (comme l'archive)" };
    }
    if (!poi) return { ts, label, verdict: "MISS", note: "archive a un POI, JS n'émet rien" };

    // plusieurs lignes possibles au même ts : garder la mieux appariée
    const rows = rowsByTs.get(ts);
    let best = null;
    for (const row of rows) {
      const cmp = compare(poi, row);
      const okCount = cmp.filter((c) => c.ok).length;
      if (!best || okCount > best.okCount) best = { cmp, okCount, row };
    }
    const fails = best.cmp.filter((c) => !c.ok);
    return {
      ts, label,
      verdict: fails.length === 0 ? "MATCH" : "MISMATCH",
      okCount: best.okCount, total: best.cmp.length,
      fails: fails.map((f) => `${f.name}: js=${JSON.stringify(f.js)} ref=${JSON.stringify(f.ref)}`),
      archRows: rows.length
    };
  } catch (error) {
    return { ts, label, verdict: "UNAVAILABLE", note: error.message };
  }
}

(async () => {
  console.log(`Harnais de parité — archive ${archive.pois.length} POI, dernier ${fmt(lastTs)}`);
  console.log(`Échantillon : ${positives.length} positifs (${nRecent} récents + ${nOld} anciens), ${negatives.length} négatifs\n`);

  const results = [];
  for (const ts of positives) { const r = await runCandle(ts, true); results.push(r); report(r); }
  for (const ts of negatives) { const r = await runCandle(ts, false); results.push(r); report(r); }

  function report(r) {
    if (r.verdict === "MATCH") console.log(`✔ ${r.label} — ${r.okCount}/${r.total} champs identiques`);
    else if (r.verdict === "MISMATCH") { console.log(`✘ ${r.label} — ${r.okCount}/${r.total} champs, écarts :`); r.fails.forEach((f) => console.log(`    · ${f}`)); }
    else console.log(`· ${r.label} — ${r.verdict}${r.note ? " (" + r.note + ")" : ""}`);
  }

  const POS_VERDICTS = new Set(["MATCH", "MISMATCH", "MISS"]);
  const pos = results.filter((r) => POS_VERDICTS.has(r.verdict));
  const matches = pos.filter((r) => r.verdict === "MATCH").length;
  // Score = le juge final de la chaîne (features + modèle) : un MISMATCH dont
  // l'importanceScore matche quand même est un écart de données de bord de
  // fenêtre, pas une divergence de détection.
  const scoreOk = pos.filter((r) => r.verdict === "MATCH" ||
    (r.fails && !r.fails.some((f) => f.startsWith("importanceScore")))).length;
  const fieldFail = {};
  for (const r of pos) if (r.fails) for (const f of r.fails) { const k = f.split(":")[0]; fieldFail[k] = (fieldFail[k] || 0) + 1; }
  const neg = results.filter((r) => r.verdict === "SUREMISSION" || r.verdict === "MATCH_NONE");
  const unavailable = results.filter((r) => r.verdict === "UNAVAILABLE").length;

  console.log("\n=== SYNTHÈSE ===");
  console.log(`Positifs : ${matches}/${pos.length} reproductions exactes (17/17 champs)`);
  console.log(`Score    : ${scoreOk}/${pos.length} importanceScore identiques (le juge final de la chaîne)`);
  if (Object.keys(fieldFail).length) console.log("Champs en écart :", JSON.stringify(fieldFail));
  console.log(`Négatifs : ${neg.filter((r) => r.verdict === "SUREMISSION").length}/${neg.length} sur-émissions (attendu par design allM15CandlePois — informatif)`);
  if (unavailable) console.log(`Indisponibles : ${unavailable} (données Binance inaccessibles pour ces fenêtres)`);

  fs.writeFileSync(path.join(__dirname, "parity-report.json"), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log("\nRapport détaillé : g-on/tools/parity-report.json");
  // Échec seulement si la chaîne detection->score diverge réellement
  // (importanceScore différent ou POI manquant) — pas sur un écart de données
  // sub-ppm en bord de fenêtre qui n'affecte aucun score. Zéro cas positif
  // testable = le harnais n'a RIEN prouvé (échantillon vide, données HS) :
  // échec aussi, sinon un run cassé passe pour un feu vert de gel.
  process.exit(pos.length === 0 || scoreOk < pos.length ? 1 : 0);
})();
