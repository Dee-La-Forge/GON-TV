"use strict";

/* Backfill d'INVALIDATION des statuts "A" du corpus canonique.
 * Cause : le generateur Antho v1 n'avait pas de concept d'invalidation — "A"
 * signifie "jamais reteste par chevauchement", PAS "jamais casse". Un short
 * dont le prix a CLOTURE au-dessus du cluster (ou un long en-dessous) apres
 * son eligibilite est un niveau zombie : mort selon nos regles de lifecycle,
 * mais affiche actif. Ce backfill re-evalue chaque ligne "A" sur les klines
 * completes et ecrit "I" (invalide) + retestTs = bougie fautive.
 * Idempotent. Lancer : node g-on/tools/backfill-invalidation.js [SYMBOL]
 */

const fs = require("fs");
const path = require("path");
const { acquire, writeArchiveAtomic } = require("./lock");
const { politeFetch } = require("./http");
const TF = 15 * 60 * 1000, FAPI = "https://fapi.binance.com";
const MIN_GAP_CANDLES = 2;
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
    for (const r of rows) {
      // bougie EN COURS exclue : evaluer une cloture non finale peut ecrire
      // un "I" irreversible sur un simple spike intrabar (doctrine violee).
      if (+r[6] >= Date.now()) continue;
      out.push({ ts: +r[0], high: +r[2], low: +r[3], close: +r[4] });
    }
    const last = +rows[rows.length - 1][0];
    if (last <= cursor) break;
    cursor = last + TF;
  }
  return out;
}

(async () => {
  acquire();
  if (!fs.existsSync(ARCHIVE_PATH)) { console.log(`Pas d'archive ${SYMBOL}.`); process.exit(0); }
  const archive = JSON.parse(fs.readFileSync(ARCHIVE_PATH, "utf8"));
  const IDX = Object.fromEntries(archive.columns.map((c, i) => [c, i]));
  const actives = archive.pois.filter((r) => r[IDX.status] === "A");
  if (!actives.length) { console.log(`${SYMBOL}: aucun actif.`); process.exit(0); }

  const firstTs = Math.min(...actives.map((r) => Number(r[IDX.createdTs])));
  const candles = await fetchAllKlines(firstTs, Date.now());
  const idxOf = new Map(candles.map((c, i) => [c.ts, i]));
  console.log(`${SYMBOL}: ${actives.length} actifs a re-evaluer, klines ${candles.length}`);

  let invalidated = 0, touched = 0;
  for (const r of actives) {
    const createdIdx = idxOf.get(Number(r[IDX.createdTs]));
    if (createdIdx == null) continue;
    const direction = r[IDX.direction] === "L" ? "long" : "short";
    const zl = Number(r[IDX.zoneLow]), zh = Number(r[IDX.zoneHigh]);
    const cl = Number(r[IDX.clusterLow]), ch = Number(r[IDX.clusterHigh]);
    // Cassure (cloture au-dela du cluster) : des la bougie SUIVANTE — le gap
    // doctrinal ne concerne que le retest. Pendant le gap, une MECHE au-dela
    // du cluster entier (balayage) tue aussi. Overlap-retest : apres le gap.
    // NB : copies offline des predicats B.clusterBroken/clusterSwept de
    // poi-lifecycle.js — a garder synchronises.
    for (let i = createdIdx + 1; i < candles.length; i++) {
      const c = candles[i];
      const eligible = i >= createdIdx + 1 + MIN_GAP_CANDLES;
      const overlap = eligible && c.low <= zh && c.high >= zl;
      const swept = !eligible && (direction === "short" ? c.high > ch : c.low < cl);
      const broken = direction === "short" ? c.close > ch : c.close < cl;
      if (overlap) {
        // vrai retest manque (rare : divergence de timing generateur) -> T
        r[IDX.status] = "T"; r[IDX.retestTs] = c.ts; touched++;
        break;
      }
      if (broken || swept) {
        r[IDX.status] = "I"; r[IDX.retestTs] = c.ts; invalidated++;
        break;
      }
    }
  }
  const A = archive.pois.filter((r) => r[IDX.status] === "A").length;
  archive.sourceStats.activePois = A;
  archive.sourceStats.retestedPois = archive.pois.length - A;
  writeArchiveAtomic(ARCHIVE_PATH, JSON.stringify(archive) + "\n");
  console.log(`${SYMBOL}: ${invalidated} zombies invalides ("I"), ${touched} retests manques ("T"), actifs restants ${A}`);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
