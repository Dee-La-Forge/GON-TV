"use strict";

/* Backfill du flag CLIMAX dans l'archive (idempotent, rejouable).
 * Regle validee empiriquement (climax-test.js) : une bougie dont le volume
 * depasse toutes les 30 precedentes est un climax de volume ; les POI qui y
 * naissent reagissent mieux (61.7% vs 53.8%). Ajoute/actualise une colonne
 * `climax` (0/1) pour chaque ligne, calculee depuis les volumes klines.
 * Lancer : node g-on/tools/backfill-climax.js
 */

const fs = require("fs");
const { acquire, writeArchiveAtomic } = require("./lock");
const { politeFetch } = require("./http");
const path = require("path");
const TF = 15 * 60 * 1000, FAPI = "https://fapi.binance.com", N = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchAllKlines(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const res = await politeFetch(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=15m&startTime=${cursor}&limit=1500`);
    if (!res.ok) throw Error(`klines HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) out.push({ ts: +r[0], volume: +r[5] });
    const last = +rows[rows.length - 1][0];
    if (last <= cursor) break;
    cursor = last + TF;
  }
  return out;
}

(async () => {
  acquire();
  const p = path.join(__dirname, "..", "poi", "antho-v1-m15-pois.json");
  const archive = JSON.parse(fs.readFileSync(p, "utf8"));
  let IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  if (!("climax" in IDX)) {
    archive.columns.push("climax");
    for (const row of archive.pois) row.push(null);
    IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  }

  const firstTs = Math.min(...archive.pois.map((r) => Number(r[IDX.createdTs])));
  const candles = await fetchAllKlines(firstTs - (N + 10) * TF, Date.now());
  console.log(`klines: ${candles.length}`);
  const climaxByTs = new Map();
  for (let i = N; i < candles.length; i++) {
    let m = 0;
    for (let k = i - N; k < i; k++) if (candles[k].volume > m) m = candles[k].volume;
    climaxByTs.set(candles[i].ts, candles[i].volume > m);
  }

  let flagged = 0, unknown = 0;
  for (const row of archive.pois) {
    const c = climaxByTs.get(Number(row[IDX.createdTs]));
    if (c === undefined) { row[IDX.climax] = 0; unknown++; continue; }
    row[IDX.climax] = c ? 1 : 0;
    if (c) flagged++;
  }
  writeArchiveAtomic(p, JSON.stringify(archive) + "\n");
  console.log(`Backfill: ${flagged} POI climax / ${archive.pois.length} (${(100 * flagged / archive.pois.length).toFixed(1)}%), ${unknown} bougies inconnues -> 0`);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
