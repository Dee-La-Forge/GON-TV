"use strict";

/* Backfill du champ APPROACH_ATR (profil d'approche avant premier touch) —
 * effet valide par approach-validation.js : sweet spot (0.25-2 ATR) ~71% de
 * reaction vs arrivee violente (>2 ATR) ~29%, stable par periode, direction
 * et regime. Champ de DONNEES pour la recherche/validation forward — aucune
 * expression UI (decision d'altitude : mesurer et persister, pas decorer).
 *
 * Valeurs : distance minimale d'approche en ATR avant le premier touch ;
 *   -1 = retest immediat (aucune fenetre d'approche) ; null = non calculable
 *   (POI actif, ou donnees insuffisantes). Idempotent : ne remplit que les
 *   null des lignes retestees.
 * Lancer : node g-on/tools/backfill-approach.js [SYMBOL]
 */

const fs = require("fs");
const { acquire, writeArchiveAtomic } = require("./lock");
const { politeFetch } = require("./http");
const path = require("path");
const TF = 15 * 60 * 1000, FAPI = "https://fapi.binance.com";
const ATR_PERIOD = 14, MIN_GAP_CANDLES = 2;
const SYMBOL = (process.argv[2] || "BTCUSDT").toUpperCase();
const ARCHIVE_PATH = path.join(__dirname, "..", "poi",
  SYMBOL === "BTCUSDT" ? "antho-v1-m15-pois.json" : `archive-${SYMBOL}-m15.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  acquire();
  if (!fs.existsSync(ARCHIVE_PATH)) { console.log(`Pas d'archive ${SYMBOL} — rien a faire.`); process.exit(0); }
  const archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  let IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  if (!("approachAtr" in IDX)) {
    archive.columns.push("approachAtr");
    for (const row of archive.pois) row.push(null);
    IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  }

  const todo = archive.pois.filter((r) =>
    r[IDX.status] === "T" && Number(r[IDX.retestTs]) > 0 && r[IDX.approachAtr] === null);
  if (!todo.length) { console.log(`${SYMBOL}: aucun approachAtr a remplir (deja a jour).`); process.exit(0); }

  const firstTs = Math.min(...todo.map((r) => Number(r[IDX.createdTs])));
  const candles = await fetchAllKlines(firstTs - 60 * TF, Date.now());
  console.log(`${SYMBOL}: klines ${candles.length}, lignes a remplir ${todo.length}`);
  const atr = []; let v = null, pc = null;
  for (const c of candles) {
    const tr = pc == null ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    v = v == null ? tr : v + (tr - v) / ATR_PERIOD; atr.push(v); pc = c.close;
  }
  const idxOf = new Map(candles.map((c, i) => [c.ts, i]));

  let filled = 0, immediate = 0, skipped = 0;
  for (const r of todo) {
    const createdIdx = idxOf.get(Number(r[IDX.createdTs]));
    const retestIdx = idxOf.get(Math.floor(Number(r[IDX.retestTs]) / TF) * TF);
    if (createdIdx == null || retestIdx == null) { skipped++; continue; }
    const startIdx = createdIdx + 1 + MIN_GAP_CANDLES;
    if (startIdx >= retestIdx) { r[IDX.approachAtr] = -1; immediate++; filled++; continue; }
    const direction = r[IDX.direction] === "L" ? "long" : "short";
    const zl = Number(r[IDX.zoneLow]), zh = Number(r[IDX.zoneHigh]);
    let best = Infinity;
    for (let i = startIdx; i < retestIdx; i++) {
      const a = atr[i] || 0; if (a <= 0) continue;
      const d = direction === "long" ? (candles[i].low - zh) / a : (zl - candles[i].high) / a;
      if (d > 0 && d < best) best = d;
    }
    if (!Number.isFinite(best)) { skipped++; continue; }
    r[IDX.approachAtr] = Math.round(best * 1000) / 1000;
    filled++;
  }
  writeArchiveAtomic(ARCHIVE_PATH, JSON.stringify(archive) + "\n");
  console.log(`${SYMBOL}: ${filled} remplis (dont ${immediate} retests immediats = -1), ${skipped} non calculables`);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
