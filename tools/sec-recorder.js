"use strict";

/* G-ON — ENREGISTREUR LOCAL du jour en cours (TF secondes, zéro poids Binance).
 * `node sec-recorder.js` — tourne en continu sur la machine des écrans.
 *
 * Vision ne publie les dumps qu'à J+1 : la journée EN COURS était le seul
 * passé qui se payait en REST (budget IP, bandeau « Binance en pause »).
 * Ce démon capte les aggTrades des 28 symboles en WebSocket (gratuit, comme
 * le sonar), les agrège en seaux 3 s (mêmes règles que gen-sec-archive.js),
 * et les sert au chart sur http://127.0.0.1:8787/sec/<SYMBOL> — le chart
 * l'utilise s'il répond, sinon il retombe silencieusement sur le REST.
 *
 * Honnêteté des trous : toute coupure de flux > 10 s marque un TROU ; seul le
 * suffixe contigu APRÈS le dernier trou est servi (jamais de faux « pas de
 * trades »). Au démarrage, le trou d'arrêt est recousu par REST via le
 * curseur d'id sauvegardé (≤ 20 pages/symbole, politeFetch) ; au-delà, on
 * repart proprement du direct. Mémoire bornée à 48 h par symbole ;
 * sauvegarde disque chaque minute (%LOCALAPPDATA%/gon-sec-recorder).
 *
 * Installation permanente (session ouverte) :
 *   schtasks /Create /TN "GON-SecRecorder" /SC ONLOGON /TR "node C:\...\tools\sec-recorder.js"
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { politeFetch } = require("./http");

const PORT = 8787;
const SEC_TF = 3;
const KEEP_MS = 48 * 3600e3;
const HOLE_MS = 10e3;             // silence de flux > 10 s = trou (les 28 symboles cumulés tradent en continu)
const CATCHUP_PAGES = 20;         // recouture REST max au démarrage, par symbole (comme fillGapSec)
// COPIE SYNCHRONISÉE du sélecteur SYMBOLS d'index.html / gen-sec-archive.js.
const SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "DOTUSDT", "TRXUSDT", "LTCUSDT", "BCHUSDT", "NEARUSDT", "ATOMUSDT", "UNIUSDT",
  "APTUSDT", "ARBUSDT", "OPUSDT", "SUIUSDT", "FILUSDT", "INJUSDT", "ETCUSDT", "AAVEUSDT",
  "WLDUSDT", "TIAUSDT", "1000PEPEUSDT", "1000SHIBUSDT"
];
const DATA_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), "gon-sec-recorder");
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---- état par symbole : bars [t,o,h,l,c,v], la (dernier id), lastHoleSec ---- */
const S = {};
for (const sym of SYMBOLS) S[sym] = { bars: [], la: 0, lastHoleSec: 0, dirty: false };

function addTrade(sym, price, qty, tMs, aggId) {
  const st = S[sym];
  if (aggId <= st.la) return;                       // idempotent (recouture + live concurrents)
  const bt = Math.floor(tMs / 1000 / SEC_TF) * SEC_TF;
  const bars = st.bars, last = bars[bars.length - 1];
  if (last && last[0] === bt) {
    if (price > last[2]) last[2] = price;
    if (price < last[3]) last[3] = price;
    last[4] = price; last[5] += qty;
  } else if (!last || bt > last[0]) {
    bars.push([bt, price, price, price, price, qty]);
  } else return;                                    // trade en retard sous le seau de tête : ignoré (jamais vu en pratique)
  st.la = aggId; st.dirty = true;
}

function pruneAll() {
  const cut = Math.floor((Date.now() - KEEP_MS) / 1000 / SEC_TF) * SEC_TF;
  for (const sym of SYMBOLS) {
    const st = S[sym];
    let i = 0; while (i < st.bars.length && st.bars[i][0] < cut) i++;
    if (i > 0) { st.bars.splice(0, i); st.dirty = true; }
  }
}

/* ---- persistance : un fichier par symbole, écrit chaque minute si changé ---- */
const fileOf = (sym) => path.join(DATA_DIR, sym + ".json");
function saveAll() {
  for (const sym of SYMBOLS) {
    const st = S[sym];
    if (!st.dirty) continue;
    try {
      const tmp = fileOf(sym) + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, tf: SEC_TF, savedAt: Date.now(), la: st.la, lastHoleSec: st.lastHoleSec, bars: st.bars }));
      fs.renameSync(tmp, fileOf(sym));
      st.dirty = false;
    } catch (_) {}
  }
}
function loadAll() {
  for (const sym of SYMBOLS) {
    try {
      const o = JSON.parse(fs.readFileSync(fileOf(sym), "utf8"));
      if (o && o.v === 1 && Array.isArray(o.bars) && Number.isFinite(o.la)) {
        S[sym].bars = o.bars; S[sym].la = o.la; S[sym].lastHoleSec = o.lastHoleSec || 0;
      }
    } catch (_) {}
  }
}

/* ---- recouture du trou d'arrêt : REST fromId, bornée ; échec = trou marqué ---- */
async function catchup(sym) {
  const st = S[sym];
  if (!st.la) return;
  for (let page = 0; page < CATCHUP_PAGES; page++) {
    let tr;
    try {
      const r = await politeFetch(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${sym}&fromId=${st.la + 1}&limit=1000`);
      if (!r.ok) throw Error("HTTP " + r.status);
      tr = await r.json();
    } catch (e) { st.lastHoleSec = Math.ceil(Date.now() / 1000); console.log(`${sym}: recouture échouée (${e.message}) — trou marqué`); return; }
    if (!Array.isArray(tr) || !tr.length) return;   // à jour
    for (const t of tr) addTrade(sym, +t.p, +t.q, +t.T, +t.a);
    if (tr.length < 1000) return;                   // direct rejoint : contigu
  }
  // gap > 20 000 trades : trop cher — on repart du direct, le passé pré-arrêt est coupé par le trou
  st.lastHoleSec = Math.ceil(Date.now() / 1000);
  console.log(`${sym}: trou d'arrêt trop grand — reprise depuis le direct`);
}

/* ---- flux WebSocket combiné (mêmes chemins routés que l'app) ---- */
let ws = null, lastMsgAt = 0, attempt = 0;
function connect() {
  // chemin ROUTÉ obligatoire (invariant README, carte dans BINANCE_WS_ENDPOINTS.md) :
  // /stream nu se connecte mais reste MUET — constaté au premier démarrage.
  const url = "wss://fstream.binance.com/market/stream?streams=" + SYMBOLS.map((s) => s.toLowerCase() + "@aggTrade").join("/");
  ws = new WebSocket(url);
  ws.onopen = () => { attempt = 0; lastMsgAt = Date.now(); console.log(`[${new Date().toISOString().slice(11, 19)}] WS connecté (${SYMBOLS.length} flux)`); };
  ws.onmessage = (ev) => {
    lastMsgAt = Date.now();
    try {
      const d = JSON.parse(ev.data).data;
      if (d && d.e === "aggTrade") addTrade(d.s, +d.p, +d.q, +d.T, +d.a);
    } catch (_) {}
  };
  ws.onclose = () => {
    const delay = Math.min(30000, 1000 * 2 ** attempt++);
    setTimeout(connect, delay);
  };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
setInterval(() => {
  // watchdog demi-ouvert + marquage de TROU : silence global > 10 s sur 28
  // perps = flux mort — tout ce qui précède la reprise n'est plus contigu.
  if (lastMsgAt && Date.now() - lastMsgAt > HOLE_MS) {
    const holeSec = Math.ceil(Date.now() / 1000);
    for (const sym of SYMBOLS) S[sym].lastHoleSec = holeSec;
    lastMsgAt = 0;
    console.log(`[${new Date().toISOString().slice(11, 19)}] silence > ${HOLE_MS / 1000}s — trou marqué, reconnexion`);
    try { ws.close(); } catch (_) {}
  }
}, 5000);

/* ---- serveur HTTP local : suffixe contigu après le dernier trou ---- */
http.createServer((req, res) => {
  const m = /^\/sec\/([A-Z0-9]+)$/.exec(req.url || "");
  // Access-Control-Allow-Private-Network : Chrome (Private Network Access)
  // exige cette approbation au préflight pour qu'une page HTTPS publique
  // (github.io) puisse interroger 127.0.0.1 — constaté bloqué sans elle.
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Private-Network": "true",
    "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  if (!m || !S[m[1]]) { res.writeHead(404, cors); res.end("{}"); return; }
  const st = S[m[1]];
  const from = st.lastHoleSec || 0;
  let i = 0; while (i < st.bars.length && st.bars[i][0] < from) i++;
  res.writeHead(200, cors);
  res.end(JSON.stringify({ v: 1, tf: SEC_TF, symbol: m[1], liveMs: lastMsgAt, bars: i ? st.bars.slice(i) : st.bars }));
}).listen(PORT, "127.0.0.1", () => console.log(`Serveur local : http://127.0.0.1:${PORT}/sec/<SYMBOL>`));

/* ---- démarrage ---- */
(async () => {
  loadAll();
  connect();                                       // le live capte PENDANT la recouture (addTrade idempotent par id)
  for (const sym of SYMBOLS) await catchup(sym);   // séquentiel, politeFetch : budget respecté
  console.log("Recouture terminée — enregistrement en continu.");
  setInterval(saveAll, 60e3);
  setInterval(pruneAll, 10 * 60e3);
  process.on("SIGINT", () => { saveAll(); process.exit(0); });
})();
