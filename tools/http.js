"use strict";

/* Fetch POLI pour le REST fapi : budget de poids par IP (~2400/min) partage
 * par tous les outils — le depasser escalade 429 puis 418 (ban d'IP
 * temporaire, constate le 2026-07-19 pendant la generation multi-symboles).
 * - espacement minimal global entre appels (module unique = cadence unique) ;
 * - 429/418 : pause selon Retry-After (defaut 60 s) puis nouvel essai.
 * Binance Vision (data.binance.vision) est un CDN sans quota : inutile ici. */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_INTERVAL_MS = 400;
let lastCallAt = 0;

async function politeFetch(url, opts) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const res = await fetch(url, opts);
    if (res.status !== 429 && res.status !== 418) return res;
    const retryAfter = Number(res.headers.get("retry-after"));
    const pauseS = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
    console.log(`  [rate-limit ${res.status}] pause ${pauseS}s (essai ${attempt}/6)`);
    await sleep(pauseS * 1000 + 1000);
  }
  throw Error(`rate-limit persistant: ${url}`);
}

module.exports = { politeFetch };
