"use strict";

/* G-ON — Archives de bougies SECONDES pré-construites depuis Binance Vision.
 * `node gen-sec-archive.js [ALL|SYMBOL] [days=7]`
 *
 * Pour chaque symbole et chacun des N derniers jours UTC RÉVOLUS, produit
 * poi/sec/<SYMBOL>/3s-<YYYY-MM-DD>.json : les seaux de 3 s du jour, reconstruits
 * depuis le dump quotidien aggTrades (data.binance.vision, CDN sans quota —
 * légitimement hors politeFetch, cf. tools/http.js). 3 s est la BASE : les TF
 * client 15/30/45 s s'en déduisent par rollup exact (3 | 15 | 30 | 45 | 86400).
 *
 * Un fichier-jour est IMMUABLE : s'il existe, il n'est jamais réécrit (le
 * dépôt ne grossit que des jours nouveaux). Rétention : les fichiers au-delà
 * de N jours sont supprimés du working tree. poi/sec/index.json (atomique)
 * liste les jours disponibles par symbole — c'est lui que le client lit.
 *
 * Cache des dumps partagé avec regen-archive.js (%TMP%/gon-vision-cache,
 * marqueur .ok) : aucun double téléchargement pour les 20 symboles POI.
 * Sortie : code 0 si tout est passé, 1 si au moins un symbole/jour a échoué
 * (les autres continuent — même philosophie que regen-daily.cmd).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const SEC_TF = 3;                    // seau de base (secondes)
const RETENTION = Math.max(1, parseInt(process.argv[3], 10) || 7);
// COPIE SYNCHRONISÉE du sélecteur SYMBOLS d'index.html (les 28 de l'app) —
// toute modification doit être faite dans LES DEUX fichiers.
const ALL_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "DOTUSDT", "TRXUSDT", "LTCUSDT", "BCHUSDT", "NEARUSDT", "ATOMUSDT", "UNIUSDT",
  "APTUSDT", "ARBUSDT", "OPUSDT", "SUIUSDT", "FILUSDT", "INJUSDT", "ETCUSDT", "AAVEUSDT",
  "WLDUSDT", "TIAUSDT", "1000PEPEUSDT", "1000SHIBUSDT"
];
const ARG = (process.argv[2] || "ALL").toUpperCase();
const SYMBOLS = ARG === "ALL" ? ALL_SYMBOLS : [ARG];

const CACHE = path.join(os.tmpdir(), "gon-vision-cache");
const OUT_ROOT = path.join(__dirname, "..", "poi", "sec");
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw Error(`HTTP ${res.status} sur ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
function unzip(zipPath, outDir) {
  execFileSync("python", ["-c",
    "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
    zipPath, outDir], { stdio: "inherit" });
}
async function ensureDayCsv(symbol, day) {
  fs.mkdirSync(CACHE, { recursive: true });
  const csv = path.join(CACHE, `${symbol}-aggTrades-${day}.csv`);
  const okMarker = csv + ".ok";
  if (fs.existsSync(csv) && fs.existsSync(okMarker)) return csv;   // .ok = extraction complète (même contrat que regen-archive)
  try { fs.rmSync(csv, { force: true }); } catch (_) {}
  const zip = path.join(CACHE, `${symbol}-aggTrades-${day}.zip`);
  if (!fs.existsSync(zip)) {
    console.log(`  téléchargement ${symbol} ${day}…`);
    await download(`https://data.binance.vision/data/futures/um/daily/aggTrades/${symbol}/${symbol}-aggTrades-${day}.zip`, zip);
  }
  try { unzip(zip, CACHE); }
  catch (error) { try { fs.rmSync(zip, { force: true }); } catch (_) {} throw error; }
  if (!fs.existsSync(csv)) { try { fs.rmSync(zip, { force: true }); } catch (_) {} throw Error(`CSV absent après extraction: ${csv}`); }
  fs.writeFileSync(okMarker, "");
  return csv;
}

/* Seaux 3 s d'un jour depuis le CSV — même validation de vraisemblance des
 * timestamps que regen-archive.js (échec bruyant si Vision migre d'unité). */
async function buildDayBars(csvPath, dayStartMs) {
  const dayEndMs = dayStartMs + 86400e3;
  const bars = [];
  const rl = readline.createInterface({ input: fs.createReadStream(csvPath), crlfDelay: Infinity });
  let n = 0, bad = 0;
  const tsMin = Date.UTC(2019, 0, 1), tsMax = Date.now() + 24 * 3600e3;
  for await (const line of rl) {
    if (!line || line.startsWith("agg_trade_id")) continue;
    const c = line.split(",");
    const price = Number(c[1]), q = Number(c[2]), ts = Number(c[5]);
    const sellerAggr = c[6] === "true" || c[6] === "True";   // isBuyerMaker -> le preneur VEND
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(q) || q <= 0 || !Number.isFinite(ts)) continue;
    if (ts < tsMin || ts > tsMax) { bad += 1; continue; }
    if (ts < dayStartMs || ts >= dayEndMs) continue;   // le dump ne déborde pas en pratique, ceinture
    const bt = Math.floor(ts / 1000 / SEC_TF) * SEC_TF;
    const dq = sellerAggr ? -q : q;   // delta agresseur (feature delta 2026-07-24)
    const last = bars[bars.length - 1];
    if (last && last[0] === bt) {
      if (price > last[2]) last[2] = price;
      if (price < last[3]) last[3] = price;
      last[4] = price; last[5] += q; last[6] += dq;
    } else bars.push([bt, price, price, price, price, q, dq]);
    n += 1;
  }
  if (bad > 0 && bad >= n) throw Error(`timestamps invraisemblables dans ${path.basename(csvPath)} (${bad} rejetés) — format Vision changé ?`);
  for (const b of bars) { b[5] = Math.round(b[5] * 1e3) / 1e3; b[6] = Math.round(b[6] * 1e3) / 1e3; }   // volume/delta à 3 décimales (taille fichier)
  return { bars, trades: n };
}

function writeAtomic(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

(async () => {
  // jours UTC RÉVOLUS : d'hier en remontant RETENTION jours
  const days = [];
  for (let d = 1; d <= RETENTION; d++) days.push(dayOf(Date.now() - d * 86400e3));
  const keep = new Set(days);
  let worst = 0;
  const index = { v: 1, tf: SEC_TF, retentionDays: RETENTION, updatedAt: new Date().toISOString(), days: {} };

  for (const symbol of SYMBOLS) {
    const dir = path.join(OUT_ROOT, symbol);
    fs.mkdirSync(dir, { recursive: true });
    for (const day of days) {
      const out = path.join(dir, `3s-${day}.json`);
      if (fs.existsSync(out)) continue;   // immuable : jamais réécrit
      try {
        const csv = await ensureDayCsv(symbol, day);
        const dayStartMs = Date.parse(day + "T00:00:00Z");
        const { bars, trades } = await buildDayBars(csv, dayStartMs);
        if (!bars.length) throw Error("0 seau construit");
        writeAtomic(out, JSON.stringify({ v: 1, symbol, tf: SEC_TF, day, bars }) + "\n");
        console.log(`${symbol} ${day}: ${bars.length} seaux 3 s (${trades} trades, ${(fs.statSync(out).size / 1024).toFixed(0)} Ko)`);
      } catch (error) {
        // 404 = dump pas (encore) publié par Vision — normal pour J-1 tôt dans
        // la journée, ou symbole listé après la fenêtre : pas un échec.
        if (/HTTP 404/.test(error.message)) console.log(`${symbol} ${day}: pas encore publié (404)`);
        else { console.log(`${symbol} ${day}: ÉCHEC (${error.message})`); worst = 1; }
      }
    }
    // rétention : les jours hors fenêtre quittent le working tree
    for (const f of fs.readdirSync(dir)) {
      const m = /^3s-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m && !keep.has(m[1])) {
        try { fs.rmSync(path.join(dir, f)); console.log(`${symbol}: purge ${m[1]}`); } catch (_) {}
      }
    }
  }

  // Index reconstruit en scannant TOUS les répertoires présents — jamais les
  // seuls symboles traités : un run mono-symbole (rattrapage) écraserait
  // sinon l'index global avec ce seul symbole.
  for (const symbol of ALL_SYMBOLS) {
    const dir = path.join(OUT_ROOT, symbol);
    if (!fs.existsSync(dir)) continue;
    const have = [];
    for (const f of fs.readdirSync(dir)) {
      const m = /^3s-(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m) have.push(m[1]);
    }
    have.sort();
    if (have.length) index.days[symbol] = have;
  }

  // purge du cache Vision au-delà de la rétention (+2 j de marge pour regen-archive)
  try {
    const cutoff = dayOf(Date.now() - (RETENTION + 2) * 86400e3);
    for (const f of fs.readdirSync(CACHE)) {
      const m = /-aggTrades-(\d{4}-\d{2}-\d{2})\.(csv|zip|csv\.ok)$/.exec(f);
      if (m && m[1] < cutoff) { try { fs.rmSync(path.join(CACHE, f), { force: true }); } catch (_) {} }
    }
  } catch (_) {}

  writeAtomic(path.join(OUT_ROOT, "index.json"), JSON.stringify(index) + "\n");
  const nDays = Object.values(index.days).reduce((a, d) => a + d.length, 0);
  console.log(`\nindex.json : ${Object.keys(index.days).length} symboles, ${nDays} fichiers-jour, rétention ${RETENTION} j.`);
  process.exit(worst);
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
