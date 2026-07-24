"use strict";

/* Analyse POUR L'OUTIL de l'effet "retest immediat" (~37-49% de tenue) :
 *  1. notre score le capture-t-il deja ? (croisement score x immediat)
 *  2. est-il previsible A LA NAISSANCE via la proximite zone<->cloture ?
 *     (si oui -> feature candidate score v3, dans notre UI existante)
 * Lancer : node g-on/tools/immediate-analysis.js [SYMBOL]
 */

const fs = require("fs");
const path = require("path");
const { politeFetch } = require("./http");
const TF = 15 * 60 * 1000, FAPI = "https://fapi.binance.com";
const FORWARD_WINDOW = 12, REACTION_ATR = 1, STOP_ATR = 1, ATR_PERIOD = 14;
const SYMBOL = (process.argv[2] || "BTCUSDT").toUpperCase();
const ARCHIVE_FILE = SYMBOL === "BTCUSDT" ? "antho-v1-m15-pois.json" : `archive-${SYMBOL}-m15.json`;

async function fetchAllKlines(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const res = await politeFetch(`${FAPI}/fapi/v1/klines?symbol=${SYMBOL}&interval=15m&startTime=${cursor}&limit=1500`);
    if (!res.ok) throw Error(`klines HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) out.push({ ts: +r[0], high: +r[2], low: +r[3], close: +r[4] });
    const last = +rows[rows.length - 1][0];
    if (last <= cursor) break;
    cursor = last + TF;
  }
  return out;
}

(async () => {
  const archive = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "poi", ARCHIVE_FILE), "utf8"));
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const touched = archive.pois.filter((r) => r[IDX.status] === "T" && Number(r[IDX.retestTs]) > 0 && r[IDX.approachAtr] !== null);
  const firstTs = Math.min(...touched.map((r) => Number(r[IDX.createdTs])));
  const candles = await fetchAllKlines(firstTs - 60 * TF, Date.now());
  const atr = []; let v = null, pc = null;
  for (const c of candles) {
    const tr = pc == null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    v = v == null ? tr : v + (tr - v) / ATR_PERIOD; atr.push(v); pc = c.close;
  }
  const idxOf = new Map(candles.map((c, i) => [c.ts, i]));

  function label(direction, ref, ri) {
    const a = atr[ri] || 0; if (a <= 0) return null;
    const end = Math.min(ri + FORWARD_WINDOW + 1, candles.length);
    if (end - ri < FORWARD_WINDOW + 1) return null;
    for (let i = ri; i < end; i++) {
      const fav = direction === "short" ? (ref - candles[i].low) / a : (candles[i].high - ref) / a;
      const adv = direction === "short" ? (candles[i].high - ref) / a : (ref - candles[i].low) / a;
      if (adv >= STOP_ATR) return false;
      if (fav >= REACTION_ATR) return true;
    }
    return false;
  }

  const rows = [];
  for (const r of touched) {
    const createdIdx = idxOf.get(Number(r[IDX.createdTs]));
    const retestIdx = idxOf.get(Math.floor(Number(r[IDX.retestTs]) / TF) * TF);
    if (createdIdx == null || retestIdx == null) continue;
    const direction = r[IDX.direction] === "L" ? "long" : "short";
    const l = label(direction, Number(r[IDX.entryPrice]), retestIdx);
    if (l == null) continue;
    const a0 = atr[createdIdx] || 0;
    if (a0 <= 0) continue;
    // proximite CAUSALE : distance cloture de la bougie source -> bord d'entree
    const close0 = candles[createdIdx].close;
    const birthDist = Math.abs(close0 - Number(r[IDX.entryPrice])) / a0;
    rows.push({
      label: l, score: Number(r[IDX.importanceScore]),
      immediate: r[IDX.approachAtr] === -1, birthDist
    });
  }
  const hit = (rs) => rs.length ? rs.filter((r) => r.label).length / rs.length : NaN;
  const pct = (x) => Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "—";
  console.log(`${SYMBOL}: ${rows.length} POI labellises, dont immediats ${rows.filter((r) => r.immediate).length}`);

  console.log("\n=== 1. LE SCORE CAPTURE-T-IL DEJA L'EFFET ? (hit par palier x immediat) ===");
  const buckets = [[0, 50], [50, 80], [80, 101]];
  for (const [lo, hi] of buckets) {
    const im = rows.filter((r) => r.immediate && r.score >= lo && r.score < hi);
    const wi = rows.filter((r) => !r.immediate && r.score >= lo && r.score < hi);
    console.log(`  S[${lo}-${hi === 101 ? "100" : hi}) : immediat n=${String(im.length).padStart(5)} ${pct(hit(im))}  |  fenetre n=${String(wi.length).padStart(5)} ${pct(hit(wi))}  (delta ${Number.isFinite(hit(wi) - hit(im)) ? (100 * (hit(wi) - hit(im))).toFixed(1) : "—"} pts)`);
  }
  const scoreOfIm = rows.filter((r) => r.immediate).map((r) => r.score);
  const scoreOfWi = rows.filter((r) => !r.immediate).map((r) => r.score);
  const avg = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
  console.log(`  score moyen: immediat ${avg(scoreOfIm).toFixed(1)} vs fenetre ${avg(scoreOfWi).toFixed(1)}`);

  console.log("\n=== 2. PREVISIBLE A LA NAISSANCE ? (proximite cloture->zone, en ATR) ===");
  const bands = [[0, 0.25], [0.25, 0.5], [0.5, 1], [1, 2], [2, Infinity]];
  for (const [lo, hi] of bands) {
    const rs = rows.filter((r) => r.birthDist >= lo && r.birthDist < hi);
    if (!rs.length) continue;
    const pImm = rs.filter((r) => r.immediate).length / rs.length;
    console.log(`  dist [${lo}-${hi === Infinity ? "inf" : hi}) : n=${String(rs.length).padStart(5)}  P(immediat)=${pct(pImm)}  hit global=${pct(hit(rs))}`);
  }
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
