"use strict";

/* Backtest de la regle de Meddy (19/07/2026) sur les retests de l'archive :
 *   POI long touche  -> long  @ entry, SL -0.15 %, VALIDE a +1 %
 *   POI short touche -> short @ entry, SL +0.15 %, VALIDE a -1 %
 * Resolution en bougies 1 MINUTE (le SL est dans le bruit M15) ; une bougie
 * 1m qui contient a la fois SL et cible = PERDANT (convention conservatrice
 * — le chiffre ne peut pas etre accuse d'optimisme). Non resolu en 7 j =
 * exclu. Lecture seule de l'archive ; rapport JSON + synthese console.
 * Lancer : node g-on/tools/backtest-touch.js [SYMBOL]
 */

const fs = require("fs");
const path = require("path");
const { politeFetch } = require("./http");
const SL_PCT = 0.0015, TP_PCT = 0.01, MAX_HOLD_MS = 7 * 24 * 3600e3;
const SYMBOL = (process.argv[2] || "BTCUSDT").toUpperCase();
const ARCHIVE_PATH = path.join(__dirname, "..", "poi",
  SYMBOL === "BTCUSDT" ? "antho-v1-m15-pois.json" : `archive-${SYMBOL}-m15.json`);

async function fetch1m(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const r = await politeFetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${SYMBOL}` +
      `&interval=1m&startTime=${cursor}&limit=1500`);
    if (!r.ok) throw Error(`klines HTTP ${r.status}`);
    const rows = await r.json();
    if (!rows.length) break;
    for (const k of rows) out.push({ t: +k[0], h: +k[2], l: +k[3] });
    const last = +rows[rows.length - 1][0];
    if (last <= cursor) break;
    cursor = last + 60000;
    if (out.length % 15000 < 1500) process.stdout.write(`  1m: ${out.length}\r`);
  }
  return out;
}

(async () => {
  const archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const touched = archive.pois.filter((r) => r[IDX.status] === "T" && Number(r[IDX.retestTs]) > 0);
  if (!touched.length) { console.log("aucun retest"); return; }
  const t0 = Math.min(...touched.map((r) => Number(r[IDX.retestTs])));
  const t1 = Math.min(Date.now(), Math.max(...touched.map((r) => Number(r[IDX.retestTs]))) + MAX_HOLD_MS);
  console.log(`${SYMBOL}: ${touched.length} retests, 1m de ${new Date(t0).toISOString().slice(0, 10)} a ${new Date(t1).toISOString().slice(0, 10)}`);
  const m1 = await fetch1m(t0, t1);
  console.log(`\n1m charges: ${m1.length}`);
  const idxAt = new Map(m1.map((c, i) => [c.t, i]));
  const floor1m = (ms) => Math.floor(ms / 60000) * 60000;

  let win = 0, loss = 0, ambiguous = 0, unresolved = 0, skipped = 0;
  const bands = { "S<40": { w: 0, l: 0 }, "S40-69": { w: 0, l: 0 }, "S>=70": { w: 0, l: 0 } };
  const events = [];
  for (const r of touched) {
    const dir = r[IDX.direction] === "L" ? 1 : -1;
    const entry = Number(r[IDX.entryPrice]);
    const score = Number(r[IDX.importanceScore]);
    const tTouch = Number(r[IDX.retestTs]);
    if (!(entry > 0)) { skipped++; continue; }
    const sl = entry * (1 - dir * SL_PCT), tp = entry * (1 + dir * TP_PCT);
    // premiere bougie 1m DANS la fenetre M15 du touch qui atteint l'entry
    let i = idxAt.get(floor1m(tTouch));
    if (i == null) { skipped++; continue; }
    let started = -1;
    for (let k = i; k < Math.min(i + 15, m1.length); k++) {
      if (m1[k].l <= entry && m1[k].h >= entry) { started = k; break; }
    }
    if (started < 0) { skipped++; continue; }
    let verdict = null;
    for (let k = started; k < m1.length; k++) {
      const c = m1[k];
      if (c.t - m1[started].t > MAX_HOLD_MS) break;
      const hitSL = dir > 0 ? c.l <= sl : c.h >= sl;
      const hitTP = dir > 0 ? c.h >= tp : c.l <= tp;
      if (hitSL && hitTP) { verdict = "ambiguous"; break; }   // -> perdant (conservateur)
      if (hitSL) { verdict = "loss"; break; }
      if (hitTP) { verdict = "win"; break; }
    }
    const band = score >= 70 ? "S>=70" : score >= 40 ? "S40-69" : "S<40";
    if (verdict === "win") { win++; bands[band].w++; events.push({ ts: tTouch, entry, dir, score, ok: 1 }); }
    else if (verdict === "loss" || verdict === "ambiguous") {
      loss++; if (verdict === "ambiguous") ambiguous++;
      bands[band].l++; events.push({ ts: tTouch, entry, dir, score, ok: 0 });
    } else unresolved++;
  }

  const total = win + loss;
  console.log(`\n=== REGLE : touch -> SL ${SL_PCT * 100}% / TP ${TP_PCT * 100}% (1m, ambigu=perdant) ===`);
  console.log(`Trades resolus : ${total}  |  gagnes ${win} (${(100 * win / total).toFixed(1)}%)  |  perdus ${loss} (dont ${ambiguous} ambigus)  |  non resolus ${unresolved}, ignores ${skipped}`);
  for (const [k, b] of Object.entries(bands)) {
    const n = b.w + b.l;
    console.log(`  ${k.padEnd(7)} : ${n ? (100 * b.w / n).toFixed(1) : "-"}% de valides sur ${n}`);
  }
  fs.writeFileSync(path.join(__dirname, `backtest-touch-${SYMBOL}.json`),
    JSON.stringify({ ranAt: new Date().toISOString(), rule: { slPct: SL_PCT, tpPct: TP_PCT }, win, loss, ambiguous, unresolved, skipped, bands, events }) + "\n");
  console.log(`Rapport : g-on/tools/backtest-touch-${SYMBOL}.json`);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
