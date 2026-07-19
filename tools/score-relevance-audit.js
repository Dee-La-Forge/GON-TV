"use strict";

/* G-ON — Audit de PERTINENCE du score d'importance (independant du backtest).
 *
 * Question : le score PREDIT-il reellement la reaction au retest, ou n'est-il
 * qu'un chiffre bien calcule ? Methode :
 *   1. reconstruire les LABELS depuis les klines brutes Binance, avec la
 *      recette doctrinale exacte de poi_detect.py::evaluate() — ATR(14 Wilder)
 *      a la bougie de retest, ref = bord d'entree (= entryPrice en M15),
 *      fenetre de 13 bougies incluant le retest, ordre CONSERVATEUR (l'adverse
 *      compte d'abord dans une meme bougie), succes = +1 ATR avant -1 ATR ;
 *   2. mesurer AUC (Mann-Whitney avec ties), hit-rate par palier S, lift des
 *      top 20%/10%, splits par periode (train/val/test du backtest + extension
 *      post-archive) et par direction ;
 *   3. CONTROLE DE VALIDITE : l'accumulationScore doit ressortir ~0.49 (comme
 *      le backtest) — sinon notre reconstruction de label est fausse.
 *
 * Lancer : node g-on/tools/score-relevance-audit.js
 */

const fs = require("fs");
const path = require("path");

const TF = 15 * 60 * 1000;
const SYMBOL = "BTCUSDT";
const FAPI = "https://fapi.binance.com";
const FORWARD_WINDOW = 12;          // doctrine : 12 bougies apres le retest (fenetre inclusive)
const REACTION_ATR = 1.0, STOP_ATR = 1.0;
const ATR_PERIOD = 14;
// Frontieres du backtest (POI_SCORE_BACKTEST_V2.md)
const TRAIN_END = Date.parse("2026-04-18T16:15:00Z");
const VAL_END = Date.parse("2026-06-05T01:15:00Z");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllKlines(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    await sleep(150);
    const url = `${FAPI}/fapi/v1/klines?symbol=${SYMBOL}&interval=15m&startTime=${cursor}&limit=1500`;
    const res = await fetch(url);
    if (!res.ok) throw Error(`klines HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) out.push({ ts: Number(r[0]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) });
    const last = Number(rows[rows.length - 1][0]);
    if (last <= cursor) break;
    cursor = last + TF;
    process.stdout.write(`\r  klines: ${out.length}…`);
  }
  process.stdout.write("\n");
  return out;
}

function wilderAtr(candles) {
  const atr = new Array(candles.length).fill(0);
  let value = null, prevClose = null;
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close } = candles[i];
    const tr = prevClose == null ? high - low
      : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    value = value == null ? tr : value + (tr - value) / ATR_PERIOD;
    atr[i] = value;
    prevClose = close;
  }
  return atr;
}

// Label doctrinal (poi_detect.py::evaluate) — conservateur.
function labelPoi(direction, ref, retestIdx, candles, atrSeries) {
  const atr = atrSeries[retestIdx] || 0;
  if (atr <= 0) return null;
  const end = Math.min(retestIdx + FORWARD_WINDOW + 1, candles.length);
  if (end - retestIdx < FORWARD_WINDOW + 1) return null;   // fenetre incomplete
  for (let i = retestIdx; i < end; i++) {
    const { high, low } = candles[i];
    const fav = direction === "short" ? (ref - low) / atr : (high - ref) / atr;
    const adv = direction === "short" ? (high - ref) / atr : (ref - low) / atr;
    if (adv >= STOP_ATR) return false;                     // adverse d'abord (conservateur)
    if (fav >= REACTION_ATR) return true;
  }
  return false;
}

// AUC Mann-Whitney avec gestion des ex-aequo (rangs moyens)
function auc(scoresPos, scoresNeg) {
  const all = scoresPos.map((s) => [s, 1]).concat(scoresNeg.map((s) => [s, 0]));
  all.sort((a, b) => a[0] - b[0]);
  let i = 0, rankSumPos = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avgRank = (i + j + 1) / 2;                        // rangs 1-bases, moyens sur ties
    for (let k = i; k < j; k++) if (all[k][1] === 1) rankSumPos += avgRank;
    i = j;
  }
  const n1 = scoresPos.length, n0 = scoresNeg.length;
  if (!n1 || !n0) return NaN;
  return (rankSumPos - n1 * (n1 + 1) / 2) / (n1 * n0);
}

function stats(rows, scoreKey) {
  const pos = rows.filter((r) => r.label).map((r) => r[scoreKey]);
  const neg = rows.filter((r) => !r.label).map((r) => r[scoreKey]);
  const base = pos.length / rows.length;
  const sorted = rows.slice().sort((a, b) => b[scoreKey] - a[scoreKey]);
  const top = (frac) => {
    const n = Math.max(1, Math.floor(rows.length * frac));
    const slice = sorted.slice(0, n);
    return { n, rate: slice.filter((r) => r.label).length / n };
  };
  return { n: rows.length, base, auc: auc(pos, neg), top20: top(0.2), top10: top(0.1) };
}

function bucketOf(s) { return s < 35 ? "S0-34" : s < 50 ? "S35-49" : s < 70 ? "S50-69" : s < 80 ? "S70-79" : "S80+"; }
const pct = (x) => (100 * x).toFixed(1) + "%";

(async () => {
  const archive = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "poi", "antho-v1-m15-pois.json"), "utf8"));
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const extFrom = Number(archive.extension && archive.extension.extendedFromTs) || Infinity;

  const touched = archive.pois.filter((r) => r[IDX.status] === "T" && Number(r[IDX.retestTs]) > 0);
  console.log(`Archive: ${archive.pois.length} POI, ${touched.length} retestes a labelliser`);

  const firstTs = Math.min(...touched.map((r) => Number(r[IDX.createdTs])));
  console.log("Telechargement klines M15 (warmup ATR inclus)…");
  const candles = await fetchAllKlines(firstTs - 60 * TF, Date.now());
  const atrSeries = wilderAtr(candles);
  const idxOf = new Map(candles.map((c, i) => [c.ts, i]));

  const rows = [];
  let skippedNoCandle = 0, skippedWindow = 0;
  for (const r of touched) {
    const retestTs = Math.floor(Number(r[IDX.retestTs]) / TF) * TF;
    const retestIdx = idxOf.get(retestTs);
    if (retestIdx == null) { skippedNoCandle++; continue; }
    const direction = r[IDX.direction] === "L" ? "long" : "short";
    const label = labelPoi(direction, Number(r[IDX.entryPrice]), retestIdx, candles, atrSeries);
    if (label == null) { skippedWindow++; continue; }
    rows.push({
      createdTs: Number(r[IDX.createdTs]), direction, label,
      importance: Number(r[IDX.importanceScore]),
      accumulation: Number(r[IDX.accumulationScore]),
      isExtension: Number(r[IDX.createdTs]) > extFrom
    });
  }
  console.log(`Labels reconstruits: ${rows.length} (ignores: ${skippedNoCandle} sans bougie, ${skippedWindow} fenetre/ATR)`);

  // --- CONTROLE DE VALIDITE : accumulationScore doit ~0.49 comme le backtest --
  const ctrl = stats(rows, "accumulation");
  // --- Pertinence du score d'importance ---------------------------------------
  const overall = stats(rows, "importance");
  console.log("\n=== GLOBAL (tous POI retestes labellises) ===");
  console.log(`Base rate: ${pct(overall.base)} | AUC importance: ${overall.auc.toFixed(3)} | AUC accumulation (controle, attendu ~0.49): ${ctrl.auc.toFixed(3)}`);
  console.log(`Top 20% par score: ${pct(overall.top20.rate)} (n=${overall.top20.n}, lift ${(100 * (overall.top20.rate - overall.base)).toFixed(1)} pts)`);
  console.log(`Top 10% par score: ${pct(overall.top10.rate)} (n=${overall.top10.n}, lift ${(100 * (overall.top10.rate - overall.base)).toFixed(1)} pts)`);

  console.log("\n=== HIT-RATE PAR PALIER (monotonie attendue si pertinent) ===");
  const buckets = {};
  for (const r of rows) { const b = bucketOf(r.importance); (buckets[b] = buckets[b] || []).push(r); }
  for (const b of ["S0-34", "S35-49", "S50-69", "S70-79", "S80+"]) {
    const rs = buckets[b] || [];
    if (rs.length) console.log(`  ${b.padEnd(7)} n=${String(rs.length).padStart(5)}  hit=${pct(rs.filter((r) => r.label).length / rs.length)}`);
  }

  console.log("\n=== PAR PERIODE (les frontieres du backtest) ===");
  const periods = [
    ["train  (jan->18 avr)", rows.filter((r) => r.createdTs < TRAIN_END)],
    ["valid  (avr->5 juin)", rows.filter((r) => r.createdTs >= TRAIN_END && r.createdTs < VAL_END)],
    ["test   (5 juin->16 juil)", rows.filter((r) => r.createdTs >= VAL_END && !r.isExtension)],
    ["EXTENSION (post-archive, detecteur live)", rows.filter((r) => r.isExtension)]
  ];
  for (const [name, rs] of periods) {
    if (!rs.length) { console.log(`  ${name}: (vide)`); continue; }
    const s = stats(rs, "importance");
    console.log(`  ${name.padEnd(40)} n=${String(s.n).padStart(5)} base=${pct(s.base)} AUC=${s.auc.toFixed(3)} top20=${pct(s.top20.rate)} (lift ${(100 * (s.top20.rate - s.base)).toFixed(1)} pts)`);
  }

  console.log("\n=== PAR DIRECTION ===");
  for (const d of ["long", "short"]) {
    const rs = rows.filter((r) => r.direction === d);
    const s = stats(rs, "importance");
    console.log(`  ${d.padEnd(6)} n=${String(s.n).padStart(5)} base=${pct(s.base)} AUC=${s.auc.toFixed(3)} top20=${pct(s.top20.rate)} (lift ${(100 * (s.top20.rate - s.base)).toFixed(1)} pts)`);
  }

  fs.writeFileSync(path.join(__dirname, "score-relevance-report.json"), JSON.stringify({
    ranAt: new Date().toISOString(), labelled: rows.length,
    control_accumulation_auc: ctrl.auc, overall,
    periods: Object.fromEntries(periods.map(([n, rs]) => [n, rs.length ? stats(rs, "importance") : null])),
    buckets: Object.fromEntries(Object.entries(buckets).map(([b, rs]) => [b, { n: rs.length, hit: rs.filter((r) => r.label).length / rs.length }]))
  }, null, 2));
  console.log("\nRapport: g-on/tools/score-relevance-report.json");
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
