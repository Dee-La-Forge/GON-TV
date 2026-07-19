"use strict";

/* Backfill de la colonne `win` (regle de Meddy, 19/07/2026, sans notion de
 * score) : retest d'un niveau -> position dans le sens du niveau a l'entry,
 * SL 0.15 %, VALIDE (win=1) si +1 % atteint avant le SL. Resolution en
 * bougies 1 MINUTE ; bougie ambigue (SL et cible) = perdant (conservateur) ;
 * non resolu en 7 j ou 1m indisponible = null. REJET exige : la bougie de
 * touch doit ARRIVER du bon cote (par-dessus pour un long, par-dessous pour
 * un short) — sinon win=-1 (non eligible, exclu des stats). Idempotent : ne
 * recalcule que les lignes T sans verdict. Calibre BTC (pourcentages fixes).
 * Lancer : node g-on/tools/backfill-outcome.js [SYMBOL] [--rejudge]
 */

const fs = require("fs");
const path = require("path");
const { acquire, writeArchiveAtomic } = require("./lock");
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
    for (const k of rows) out.push({ t: +k[0], o: +k[1], h: +k[2], l: +k[3] });
    const last = +rows[rows.length - 1][0];
    if (last <= cursor) break;
    cursor = last + 60000;
  }
  return out;
}

(async () => {
  acquire();
  if (!fs.existsSync(ARCHIVE_PATH)) { console.log(`Pas d'archive ${SYMBOL}.`); process.exit(0); }
  const archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  let IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  if (!("win" in IDX)) {
    archive.columns.push("win");
    for (const row of archive.pois) row.push(null);
    IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  }
  if (process.argv.includes("--rejudge")) {
    for (const row of archive.pois) row[IDX.win] = null;
    console.log("re-jugement complet (regle modifiee)");
  }
  const todo = archive.pois.filter((r) => r[IDX.status] === "T" &&
    Number(r[IDX.retestTs]) > 0 && (r[IDX.win] === null || r[IDX.win] === undefined));
  if (!todo.length) { console.log(`${SYMBOL}: verdicts a jour.`); process.exit(0); }

  const t0 = Math.min(...todo.map((r) => Number(r[IDX.retestTs])));
  const t1 = Math.min(Date.now(), Math.max(...todo.map((r) => Number(r[IDX.retestTs]))) + MAX_HOLD_MS);
  console.log(`${SYMBOL}: ${todo.length} retests a juger, 1m ${new Date(t0).toISOString().slice(0, 10)} -> ${new Date(t1).toISOString().slice(0, 10)}`);
  const m1 = await fetch1m(t0, t1);
  const idxAt = new Map(m1.map((c, i) => [c.t, i]));
  const floor1m = (ms) => Math.floor(ms / 60000) * 60000;

  let win = 0, loss = 0, open = 0;
  for (const r of todo) {
    const dir = r[IDX.direction] === "L" ? 1 : -1;
    const entry = Number(r[IDX.entryPrice]);
    const tTouch = Number(r[IDX.retestTs]);
    if (!(entry > 0)) continue;
    const sl = entry * (1 - dir * SL_PCT), tp = entry * (1 + dir * TP_PCT);
    const i0 = idxAt.get(floor1m(tTouch));
    if (i0 == null) continue;
    let started = -1;
    for (let k = i0; k < Math.min(i0 + 15, m1.length); k++) {
      if (m1[k].l <= entry && m1[k].h >= entry) { started = k; break; }
    }
    if (started < 0) continue;
    // REJET : la bougie de touch doit arriver du bon cote du niveau —
    // par-DESSUS pour un long, par-DESSOUS pour un short. Sinon le prix
    // traverse sans setup de rejet : non eligible.
    const cT = m1[started];
    if (!(dir > 0 ? cT.o > entry : cT.o < entry)) { r[IDX.win] = -1; continue; }
    let verdict = null;
    for (let k = started; k < m1.length; k++) {
      const c = m1[k];
      if (c.t - m1[started].t > MAX_HOLD_MS) break;
      const hitSL = dir > 0 ? c.l <= sl : c.h >= sl;
      const hitTP = dir > 0 ? c.h >= tp : c.l <= tp;
      if (hitSL) { verdict = 0; break; }        // ambigu inclus : perdant
      if (hitTP) { verdict = 1; break; }
    }
    // touche trop recente encore sans verdict : laisser null (re-jugee demain)
    if (verdict === null && Date.now() - tTouch < MAX_HOLD_MS) { open++; continue; }
    r[IDX.win] = verdict === 1 ? 1 : 0;
    if (verdict === 1) win++; else loss++;
  }
  writeArchiveAtomic(ARCHIVE_PATH, JSON.stringify(archive) + "\n");
  const totalW = archive.pois.filter((r) => r[IDX.win] === 1).length;
  const totalL = archive.pois.filter((r) => r[IDX.win] === 0).length;
  const totalX = archive.pois.filter((r) => r[IDX.win] === -1).length;
  console.log(`${SYMBOL}: +${win} valides / +${loss} perdus (en cours: ${open}) — archive: ${totalW} valides / ${totalL} perdus / ${totalX} non eligibles (${(100 * totalW / (totalW + totalL)).toFixed(1)}% des eligibles)`);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
