"use strict";

/* Test empirique de la regle "volume climax" (methode Coinglass/mentor) :
 * une bougie dont le volume depasse TOUTES les N precedentes (N=30) est un
 * POI de base important. Question : les POI de l'archive crees sur ces
 * bougies climax reagissent-ils mieux que les autres ?
 * Reutilise la recette de label doctrinale (score-relevance-audit.js).
 * Lancer : node g-on/tools/climax-test.js [N=30]
 */

const fs = require("fs");
const path = require("path");
const TF = 15 * 60 * 1000, FAPI = "https://fapi.binance.com";
const N = parseInt(process.argv[2], 10) || 30;
const FORWARD_WINDOW = 12, REACTION_ATR = 1, STOP_ATR = 1, ATR_PERIOD = 14;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllKlines(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    await sleep(150);
    const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&startTime=${cursor}&limit=1500`);
    if (!res.ok) throw Error(`klines HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) out.push({ ts: +r[0], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
    const last = +rows[rows.length - 1][0];
    if (last <= cursor) break;
    cursor = last + TF;
  }
  return out;
}

(async () => {
  const archive = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "poi", "antho-v1-m15-pois.json"), "utf8"));
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const touched = archive.pois.filter((r) => r[IDX.status] === "T" && Number(r[IDX.retestTs]) > 0);
  const firstTs = Math.min(...touched.map((r) => Number(r[IDX.createdTs])));
  const candles = await fetchAllKlines(firstTs - 60 * TF, Date.now());
  console.log(`klines: ${candles.length}`);

  // ATR Wilder
  const atr = []; let v = null, pc = null;
  for (const c of candles) {
    const tr = pc == null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    v = v == null ? tr : v + (tr - v) / ATR_PERIOD; atr.push(v); pc = c.close;
  }
  // Climax : volume > max des N precedentes
  const climax = new Set();
  for (let i = N; i < candles.length; i++) {
    let m = 0;
    for (let k = i - N; k < i; k++) if (candles[k].volume > m) m = candles[k].volume;
    if (candles[i].volume > m) climax.add(candles[i].ts);
  }
  console.log(`Bougies climax (vol > max des ${N} precedentes): ${climax.size} / ${candles.length} (${(100 * climax.size / candles.length).toFixed(1)}% — 1 toutes les ${(candles.length / climax.size).toFixed(0)} bougies)`);

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
    const ri = idxOf.get(Math.floor(Number(r[IDX.retestTs]) / TF) * TF);
    if (ri == null) continue;
    const l = label(r[IDX.direction] === "L" ? "long" : "short", Number(r[IDX.entryPrice]), ri);
    if (l == null) continue;
    rows.push({ label: l, score: Number(r[IDX.importanceScore]), isClimax: climax.has(Number(r[IDX.createdTs])) });
  }
  const hit = (rs) => rs.length ? rs.filter((r) => r.label).length / rs.length : NaN;
  const cx = rows.filter((r) => r.isClimax), ncx = rows.filter((r) => !r.isClimax);
  console.log(`\nPOI labellises: ${rows.length} | base rate: ${(100 * hit(rows)).toFixed(1)}%`);
  console.log(`POI sur bougie CLIMAX     : n=${cx.length}  hit=${(100 * hit(cx)).toFixed(1)}%`);
  console.log(`POI sur bougie non-climax : n=${ncx.length} hit=${(100 * hit(ncx)).toFixed(1)}%`);
  const hi = (rs, t) => rs.filter((r) => r.score >= t);
  for (const t of [50, 70, 80]) {
    console.log(`  S>=${t} : climax n=${hi(cx, t).length} hit=${(100 * hit(hi(cx, t))).toFixed(1)}%  |  non-climax n=${hi(ncx, t).length} hit=${(100 * hit(hi(ncx, t))).toFixed(1)}%`);
  }
  // score moyen des climax vs non
  const avg = (rs) => rs.length ? rs.reduce((s, r) => s + r.score, 0) / rs.length : NaN;
  console.log(`\nScore moyen: climax ${avg(cx).toFixed(1)} vs non-climax ${avg(ncx).toFixed(1)} (le modele "voit"-il deja le climax ?)`);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
