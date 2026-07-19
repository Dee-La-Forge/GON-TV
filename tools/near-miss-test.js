"use strict";

/* Test empirique de l'hypothese "near-miss" (collegue quant) : un niveau que
 * le prix a FROLE (approche < epsilon ATR sans toucher, apres eligibilite,
 * avant le premier vrai touch) devrait reagir moins bien — les stops qui
 * font la valeur du niveau auraient ete deplaces/consommes.
 * Compare le taux de reaction (label doctrinal, cf. score-relevance-audit.js)
 * des POI "froles" vs "approche propre", a plusieurs seuils d'epsilon.
 * Lancer : node g-on/tools/near-miss-test.js
 */

const fs = require("fs");
const path = require("path");
const TF = 15 * 60 * 1000, FAPI = "https://fapi.binance.com";
const FORWARD_WINDOW = 12, REACTION_ATR = 1, STOP_ATR = 1, ATR_PERIOD = 14;
const MIN_GAP_CANDLES = 2;                       // eligibilite (minRetestGapCandles)
const EPSILONS = [0.1, 0.25, 0.5];               // seuils de frolage, en ATR
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
    for (const r of rows) out.push({ ts: +r[0], high: +r[2], low: +r[3], close: +r[4] });
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

  // Distance minimale d'approche (en ATR de la bougie) AVANT le retest, apres
  // eligibilite. Une distance <= 0 serait un touch — exclue par construction
  // (la fenetre s'arrete a la bougie de retest, premiere qui chevauche).
  function minApproachAtr(direction, zoneLow, zoneHigh, startIdx, retestIdx) {
    let best = Infinity;
    for (let i = startIdx; i < retestIdx; i++) {
      const a = atr[i] || 0; if (a <= 0) continue;
      const d = direction === "long" ? (candles[i].low - zoneHigh) / a : (zoneLow - candles[i].high) / a;
      if (d > 0 && d < best) best = d;
    }
    return best;
  }

  const rows = [];
  for (const r of touched) {
    const createdTs = Number(r[IDX.createdTs]);
    const retestIdx = idxOf.get(Math.floor(Number(r[IDX.retestTs]) / TF) * TF);
    const createdIdx = idxOf.get(createdTs);
    if (retestIdx == null || createdIdx == null) continue;
    const direction = r[IDX.direction] === "L" ? "long" : "short";
    const l = label(direction, Number(r[IDX.entryPrice]), retestIdx);
    if (l == null) continue;
    const startIdx = createdIdx + 1 + MIN_GAP_CANDLES;
    if (startIdx >= retestIdx) {   // retest immediat : aucune fenetre d'approche
      rows.push({ label: l, approach: Infinity, score: Number(r[IDX.importanceScore]), immediate: true });
      continue;
    }
    rows.push({
      label: l,
      approach: minApproachAtr(direction, Number(r[IDX.zoneLow]), Number(r[IDX.zoneHigh]), startIdx, retestIdx),
      score: Number(r[IDX.importanceScore]),
      immediate: false
    });
  }
  const hit = (rs) => rs.length ? rs.filter((r) => r.label).length / rs.length : NaN;
  const pct = (x) => (100 * x).toFixed(1) + "%";
  console.log(`\nPOI labellises: ${rows.length} | base: ${pct(hit(rows))}`);
  const immediate = rows.filter((r) => r.immediate);
  console.log(`Retest immediat (aucune fenetre d'approche): n=${immediate.length} hit=${pct(hit(immediate))}`);

  console.log("\n=== HYPOTHESE NEAR-MISS : niveaux FROLES vs APPROCHE PROPRE ===");
  const windowed = rows.filter((r) => !r.immediate);
  for (const eps of EPSILONS) {
    const grazed = windowed.filter((r) => r.approach <= eps);
    const clean = windowed.filter((r) => r.approach > eps);
    console.log(`  eps=${eps} ATR : FROLE n=${String(grazed.length).padStart(5)} hit=${pct(hit(grazed))}  |  PROPRE n=${String(clean.length).padStart(5)} hit=${pct(hit(clean))}  (delta ${(100 * (hit(grazed) - hit(clean))).toFixed(1)} pts)`);
  }

  console.log("\n=== CROISEMENT AVEC LE SCORE (eps=0.25 ATR) ===");
  for (const t of [0, 50, 80]) {
    const g = windowed.filter((r) => r.approach <= 0.25 && r.score >= t);
    const c = windowed.filter((r) => r.approach > 0.25 && r.score >= t);
    console.log(`  S>=${t} : FROLE n=${String(g.length).padStart(5)} hit=${pct(hit(g))}  |  PROPRE n=${String(c.length).padStart(5)} hit=${pct(hit(c))}`);
  }

  // Courbe par tranche de distance d'approche (diagnostic complet)
  console.log("\n=== HIT PAR TRANCHE DE DISTANCE MINIMALE D'APPROCHE (ATR) ===");
  const bands = [[0, 0.1], [0.1, 0.25], [0.25, 0.5], [0.5, 1], [1, 2], [2, Infinity]];
  for (const [lo, hi] of bands) {
    const rs = windowed.filter((r) => r.approach > lo && r.approach <= hi);
    if (rs.length) console.log(`  ]${lo}, ${hi === Infinity ? "inf" : hi}] : n=${String(rs.length).padStart(5)} hit=${pct(hit(rs))}`);
  }
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
