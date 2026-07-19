"use strict";

/* Validation de robustesse de l'effet PROFIL D'APPROCHE (near-miss-test.js) :
 * arrivee violente (jamais < 2 ATR avant le touch) -> 29% de reaction, vs
 * sweet spot (0.25-2 ATR) -> 66-77%. Avant toute exploitation, verifier que
 * l'effet est STABLE par periode, symetrique par direction, et qu'il n'est
 * pas un artefact de regime de volatilite.
 * Lancer : node g-on/tools/approach-validation.js [SYMBOL]
 * (splits temporels : frontieres du backtest pour BTC ; moities de la fenetre
 *  pour les autres symboles. Verifie aussi la coherence de la colonne
 *  approachAtr stockee vs recalcul independant.)
 */

const fs = require("fs");
const path = require("path");
const TF = 15 * 60 * 1000, FAPI = "https://fapi.binance.com";
const FORWARD_WINDOW = 12, REACTION_ATR = 1, STOP_ATR = 1, ATR_PERIOD = 14;
const MIN_GAP_CANDLES = 2;
const SYMBOL = (process.argv[2] || "BTCUSDT").toUpperCase();
const ARCHIVE_FILE = SYMBOL === "BTCUSDT" ? "antho-v1-m15-pois.json" : `archive-${SYMBOL}-m15.json`;
const TRAIN_END = Date.parse("2026-04-18T16:15:00Z");
const VAL_END = Date.parse("2026-06-05T01:15:00Z");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllKlines(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    await sleep(150);
    const res = await fetch(`${FAPI}/fapi/v1/klines?symbol=${SYMBOL}&interval=15m&startTime=${cursor}&limit=1500`);
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
  const extFrom = Number(archive.extension && archive.extension.extendedFromTs) || Infinity;
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
    const approach = startIdx >= retestIdx ? -1   // retest immediat
      : minApproachAtr(direction, Number(r[IDX.zoneLow]), Number(r[IDX.zoneHigh]), startIdx, retestIdx);
    rows.push({
      createdTs, direction, label: l, approach,
      relAtr: (atr[retestIdx] || 0) / candles[retestIdx].close,   // regime de vol au retest
      isExtension: createdTs > extFrom,
      stored: IDX.approachAtr != null ? r[IDX.approachAtr] : undefined
    });
  }
  console.log(`POI labellises: ${rows.length}`);

  // Verification de coherence : colonne approachAtr stockee vs recalcul.
  const checkable = rows.filter((r) => typeof r.stored === "number");
  if (checkable.length) {
    const mismatch = checkable.filter((r) => {
      const recomputed = r.approach < 0 ? -1 : Math.round(r.approach * 1000) / 1000;
      return Number.isFinite(recomputed) && Math.abs(recomputed - r.stored) > 0.001;
    });
    console.log(`Coherence backfill: ${checkable.length - mismatch.length}/${checkable.length} approachAtr stockes identiques au recalcul (${mismatch.length} ecarts)`);
  }

  const hit = (rs) => rs.length ? rs.filter((r) => r.label).length / rs.length : NaN;
  const pct = (x) => Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "—";
  const band = (r) => r.approach < 0 ? "immediat"
    : r.approach <= 0.25 ? "colle(0-.25)"
    : r.approach <= 2 ? "sweet(.25-2)"
    : "violent(>2)";

  function report(name, rs) {
    if (!rs.length) { console.log(`  ${name}: (vide)`); return; }
    const g = {};
    for (const r of rs) (g[band(r)] = g[band(r)] || []).push(r);
    const cells = ["immediat", "colle(0-.25)", "sweet(.25-2)", "violent(>2)"]
      .map((b) => `${b}: n=${(g[b] || []).length} ${pct(hit(g[b] || []))}`).join("  |  ");
    const delta = hit(g["sweet(.25-2)"] || []) - hit(g["violent(>2)"] || []);
    console.log(`  ${name.padEnd(26)} ${cells}   [sweet-violent: ${Number.isFinite(delta) ? (100 * delta).toFixed(1) + " pts" : "—"}]`);
  }

  console.log("\n=== PAR PERIODE (stabilite temporelle) ===");
  if (SYMBOL === "BTCUSDT") {
    report("train (jan->18 avr)", rows.filter((r) => r.createdTs < TRAIN_END));
    report("valid (avr->5 juin)", rows.filter((r) => r.createdTs >= TRAIN_END && r.createdTs < VAL_END));
    report("test  (5 juin->16 juil)", rows.filter((r) => r.createdTs >= VAL_END && !r.isExtension));
  } else {
    // Fenetre courte (archive generee) : split en deux moities temporelles.
    const ts = rows.map((r) => r.createdTs).sort((a, b) => a - b);
    const mid = ts[Math.floor(ts.length / 2)];
    report("1re moitie de la fenetre", rows.filter((r) => r.createdTs < mid));
    report("2e moitie de la fenetre", rows.filter((r) => r.createdTs >= mid));
  }

  console.log("\n=== PAR DIRECTION (symetrie) ===");
  report("long", rows.filter((r) => r.direction === "long"));
  report("short", rows.filter((r) => r.direction === "short"));

  console.log("\n=== CONTROLE DE REGIME (l'effet survit-il A REGIME FIXE ?) ===");
  const rels = rows.map((r) => r.relAtr).sort((a, b) => a - b);
  const medRel = rels[Math.floor(rels.length / 2)];
  report(`vol basse (relATR<med)`, rows.filter((r) => r.relAtr < medRel));
  report(`vol haute (relATR>=med)`, rows.filter((r) => r.relAtr >= medRel));
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
