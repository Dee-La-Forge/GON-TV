"use strict";

/* SCORE V3 — Jalon M1 : dataset builder + PORTE DE REPRODUCTION (bloquante).
 * Cf. SCORE_V3_PROTOCOL.md §3-§5.
 *  1. Reconstruit les 12 features v2 depuis archive + klines (footprint depuis
 *     l'archive ; contexte directionnel/ATR/anatomie depuis les klines).
 *  2. PORTE : reapplique le modele v2 GELE -> le score reconstruit doit etre
 *     a +/-1 pt du score stocke sur >=95% du corpus strict. Echec = pipeline
 *     faux, on s'arrete.
 *  3. Ecrit le dataset M2 (features + birthDist + climaxRel + label doctrinal
 *     + split purge) dans tools/v3-dataset.json (regenerable, non versionne).
 * Lancer : node g-on/tools/v3-m1-dataset.js
 */

global.window = global;
require("../poi/poi-score-model.js");
const B = global.BiquettePoi;

const fs = require("fs");
const path = require("path");
const { politeFetch } = require("./http");
const TF = 15 * 60 * 1000, FAPI = "https://fapi.binance.com";
const FORWARD_WINDOW = 12, REACTION_ATR = 1, STOP_ATR = 1, ATR_PERIOD = 14;
const HISTORY_CANDLES = 192, DIRECTIONAL_PCT = 55;
const TRAIN_END = Date.parse("2026-04-18T16:15:00Z");
const VAL_END = Date.parse("2026-06-05T01:15:00Z");

async function fetchAllKlines(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const res = await politeFetch(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&startTime=${cursor}&limit=1500`);
    if (!res.ok) throw Error(`klines HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) out.push({
      ts: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4],
      volume: +r[5], takerBuy: +r[9]
    });
    const last = +rows[rows.length - 1][0];
    if (last <= cursor) break;
    cursor = last + TF;
  }
  return out;
}

// Percentile "nearest" (Polars), identique au detecteur.
function percentile(values, pct) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.round(Math.max(0, Math.min(1, pct / 100)) * (sorted.length - 1));
  return sorted[index];
}

(async () => {
  const archive = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "poi", "antho-v1-m15-pois.json"), "utf8"));
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const extFrom = Number(archive.extension && archive.extension.extendedFromTs) || Infinity;
  const strict = archive.pois.filter((r) => Number(r[IDX.createdTs]) < extFrom);
  console.log(`Corpus strict: ${strict.length} POI (extension exclue)`);

  const firstTs = Math.min(...strict.map((r) => Number(r[IDX.createdTs])));
  const candles = await fetchAllKlines(firstTs - (HISTORY_CANDLES + 40) * TF, Date.now());
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

  // --- Reconstruction des features + porte de reproduction -------------------
  const rows = [];
  let reproduced = 0, comparable = 0;
  const deviations = [];
  for (const r of strict) {
    const createdTs = Number(r[IDX.createdTs]);
    const i0 = idxOf.get(createdTs);
    if (i0 == null || i0 < 40) continue;
    const src = candles[i0];
    const direction = r[IDX.direction] === "L" ? "long" : "short";
    // contexte directionnel : 192 bougies precedentes (volume>0, comme le seed)
    const hist = [];
    for (let k = Math.max(0, i0 - HISTORY_CANDLES); k < i0; k++) {
      if (candles[k].volume > 0) hist.push(candles[k]);
    }
    const dirVol = direction === "long" ? src.takerBuy : Math.max(0, src.volume - src.takerBuy);
    const histDir = hist.map((c) => direction === "long" ? c.takerBuy : Math.max(0, c.volume - c.takerBuy));
    const gate = percentile(histDir, DIRECTIONAL_PCT) || dirVol || 1;
    const range = Math.max(0, src.high - src.low);
    const a0 = atr[i0] || 0;
    const input = {
      zoneVolume: Number(r[IDX.zoneVolume]),
      zoneVolumeShare: Number(r[IDX.zoneVolumeShare]),
      imbalance: Number(r[IDX.imbalance]),
      fpTimeShare: Number(r[IDX.fpTimeShare]),
      clusterBins: Number(r[IDX.clusterBins]),
      directionalVolumeShare: src.volume > 0 ? dirVol / src.volume : 0,
      directionalVsGate: dirVol / Math.max(gate, Number.EPSILON),
      bodyFraction: range > 0 ? Math.abs(src.close - src.open) / range : 0,
      rangeAtr: a0 > 0 ? range / a0 : 0,
      originZone: r[IDX.originZone] === 1,
      fallbackZone: r[IDX.fallbackZone] === 1,
      direction
    };
    const rebuilt = B.computePoiImportanceScore(input);
    const stored = Number(r[IDX.importanceScore]);
    if (Number.isFinite(stored)) {
      comparable++;
      const dev = Math.abs(rebuilt - stored);
      deviations.push(dev);
      if (dev <= 1) reproduced++;
    }
    // features v3 candidates
    const entryPrice = Number(r[IDX.entryPrice]);
    const birthDist = a0 > 0 ? Math.abs(src.close - entryPrice) / a0 : null;
    let priorMax = 0;
    for (let k = Math.max(0, i0 - 30); k < i0; k++) if (candles[k].volume > priorMax) priorMax = candles[k].volume;
    const climaxRel = priorMax > 0 ? src.volume / priorMax : null;
    // label + split (purge aux frontieres)
    const retestTs = Number(r[IDX.retestTs]);
    let y = null, retestIdx = null;
    if (r[IDX.status] !== "A" && retestTs > 0) {
      retestIdx = idxOf.get(Math.floor(retestTs / TF) * TF);
      if (retestIdx != null) y = label(direction, entryPrice, retestIdx);
    }
    let split = createdTs < TRAIN_END ? "train" : createdTs < VAL_END ? "valid" : "compare";
    if (y != null && retestIdx != null) {
      const windowEnd = candles[Math.min(retestIdx + FORWARD_WINDOW, candles.length - 1)].ts;
      const boundary = split === "train" ? TRAIN_END : split === "valid" ? VAL_END : extFrom;
      if (windowEnd >= boundary) { y = null; }   // purge : la fenetre croise la frontiere
    }
    rows.push({ createdTs, direction, split, y, stored, rebuilt, input, birthDist, climaxRel });
  }

  // --- Verdict de la porte ---------------------------------------------------
  deviations.sort((a, b) => a - b);
  const rate = reproduced / comparable;
  const q = (p) => deviations[Math.min(deviations.length - 1, Math.floor(p * deviations.length))];
  console.log(`\n=== PORTE DE REPRODUCTION v2 ===`);
  console.log(`Comparables: ${comparable} | a +/-1 pt: ${reproduced} (${(100 * rate).toFixed(2)}%)`);
  console.log(`Deviations: med=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${deviations[deviations.length - 1]}`);
  const labelled = rows.filter((r) => r.y != null);
  console.log(`\nDataset: ${rows.length} lignes, ${labelled.length} labellisees apres purge`);
  for (const s of ["train", "valid", "compare"]) {
    const rs = labelled.filter((r) => r.split === s);
    console.log(`  ${s}: n=${rs.length}, base=${(100 * rs.filter((r) => r.y).length / rs.length).toFixed(1)}%`);
  }
  fs.writeFileSync(path.join(__dirname, "v3-dataset.json"), JSON.stringify({ builtAt: new Date().toISOString(), rows }), "utf8");
  console.log(`\nDataset ecrit: tools/v3-dataset.json (${(fs.statSync(path.join(__dirname, "v3-dataset.json")).size / 1024 / 1024).toFixed(1)} Mo)`);
  console.log(rate >= 0.95 ? "PORTE: PASSEE — GO M2" : "PORTE: ECHEC — pipeline a corriger avant M2");
  process.exit(rate >= 0.95 ? 0 : 1);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
