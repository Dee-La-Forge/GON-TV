/* G-ON — feature POI : ingestion live Binance Futures aggTrade -> footprint M15
 * -> detection -> lifecycle, dessine via GonPoiRender sur le chart de G-Bot.
 * Portage du chemin live eprouve de Biquette. Non inclus dans cette tranche
 * (ajoutables plus tard) : archive canonique Antho v1, persistance localStorage.
 * Fiabilite conservee : dedup, rejet du desordre, gap recovery, backoff borne. */
(function () {
  "use strict";

  const FUTURES_KLINES = "https://fapi.binance.com/fapi/v1/klines";
  const FUTURES_AGG_TRADES = "https://fapi.binance.com/fapi/v1/aggTrades";
  const FUTURES_WS = "wss://fstream.binance.com/market/ws/";
  // binSize FIGE par symbole (10^(floor(log10(prix))-3) au prix du 2026-07-19) :
  // doit rester IDENTIQUE au binSize embarque dans l'archive du symbole, sinon
  // les POI live et archives seraient binnes sur deux grilles differentes.
  // COPIE SYNCHRONISEE de BIN_SIZE dans tools/regen-archive.js — toute
  // modification doit etre faite dans LES DEUX fichiers. binSizeForPrice ne
  // sert que de filet pour un symbole hors liste (sans archive).
  const POI_SYMBOL_CONFIG = {
    BTCUSDT: { binSize: 10 }, ETHUSDT: { binSize: 1 },
    BNBUSDT: { binSize: 0.1 }, SOLUSDT: { binSize: 0.01 }, AAVEUSDT: { binSize: 0.01 },
    XRPUSDT: { binSize: 0.001 }, LINKUSDT: { binSize: 0.001 }, INJUSDT: { binSize: 0.001 }, ETCUSDT: { binSize: 0.001 },
    ADAUSDT: { binSize: 1e-4 }, APTUSDT: { binSize: 1e-4 }, SUIUSDT: { binSize: 1e-4 },
    FILUSDT: { binSize: 1e-4 }, WLDUSDT: { binSize: 1e-4 }, TIAUSDT: { binSize: 1e-4 },
    DOGEUSDT: { binSize: 1e-5 }, ARBUSDT: { binSize: 1e-5 }, OPUSDT: { binSize: 1e-5 },
    "1000PEPEUSDT": { binSize: 1e-6 }, "1000SHIBUSDT": { binSize: 1e-6 }
  };
  const POI_BOOTSTRAP_MAX_CANDLES = 96, POI_BOOTSTRAP_MAX_PAGES = 40;
  const POI_RAW_WINDOW = 23 * 60 * 60 * 1000, POI_BUFFER_LIMIT = 20000;
  // Archive par symbole : BTC = corpus canonique Antho v1 (nom historique) ;
  // autres symboles = archives generees par le detecteur JS (regen-archive.js).
  const archivePathFor = (ticker) => ticker === "BTCUSDT"
    ? "poi/antho-v1-m15-pois.json"
    : `poi/archive-${ticker}-m15.json`;

  const B = window.BiquettePoi, S = window.BiquetteStream;

  let gon = null, render = null;
  let poiConfig = null, poiAccumulator = null, pois = [], poiHistory = [];
  let poiTicker = "", poiLastTradeId = null;
  let poiHistoricalCutoff = 0, poiCanonicalValidAfter = 0;
  let poiSubscription = 0, poiAttempt = 0;
  let poiSocket = null, poiTimer = null, poiRecovering = false, poiBuffer = [];
  let poiTouchWindow = null, poiTouchTimer = null, poiBootstrapController = null;

  function refresh() { render?.setPois(pois.slice()); }
  function log(state, extra) { /* hook statut leger */ if (window.__GON_POI_DEBUG) console.log("[POI]", state, extra || ""); }

  // Budget de poids fapi PARTAGE par IP : le bootstrap pagine des milliers de
  // requetes aggTrades (poids 20). Sans garde, un demarrage a froid crevait le
  // budget -> 429 puis ban 418 (escaladant), et le catch du bootstrap faisait
  // `continue` -> martelage qui prolongeait le ban pour TOUS les collegues
  // derriere le meme NAT. Cette fenetre de cooldown, honoree avant chaque
  // appel fapi du module, respecte le Retry-After annonce par Binance.
  let poiApiCoolUntil = 0;
  async function fapiFetch(url, signal) {
    // Retry sur TOUT echec transitoire (429/418 rate-limit, coupure reseau, 5xx)
    // avec backoff : les niveaux LIVE (seed / bootstrap / aggTrades) ne doivent
    // pas manquer silencieusement a cause d'un hoquet reseau ou serveur.
    let lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const wait = poiApiCoolUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 60000)));
      if (signal && signal.aborted) { const e = Error("aborted"); e.name = "AbortError"; throw e; }
      let response;
      try {
        response = await fetch(url, { signal });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = e;   // erreur reseau : backoff + retry
        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * Math.pow(2, attempt))));
        continue;
      }
      if (response.status === 429 || response.status === 418) {
        const ra = Number(response.headers.get("retry-after"));
        poiApiCoolUntil = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60000) + 1000;
        continue;
      }
      if (response.status >= 500) {   // 5xx transitoire : backoff + retry
        lastErr = Error(`Binance Futures ${response.status}`);
        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * Math.pow(2, attempt))));
        continue;
      }
      return response;   // 2xx, ou 4xx non-retryable (erreur reelle)
    }
    throw (lastErr || Error("Binance Futures rate-limit persistant"));
  }

  async function fetchAggTrades(ticker, params, signal) {
    const q = new URLSearchParams({ symbol: ticker, limit: String(Math.min(1000, params.limit || 1000)) });
    for (const key of ["fromId", "startTime", "endTime"]) if (Number.isFinite(params[key])) q.set(key, String(Math.floor(params[key])));
    const response = await fapiFetch(`${FUTURES_AGG_TRADES}?${q}`, signal);
    if (!response.ok) throw Error(`Binance Futures aggTrades ${response.status}`);
    return response.json();
  }

  function mergePois(existing, incoming) {
    const merged = new Map((existing || []).map((p) => [p.id, p]));
    (incoming || []).forEach((p) => merged.set(p.id, p));
    return [...merged.values()].sort((a, b) => a.createdTs - b.createdTs);
  }

  // Archive canonique Antho v1 (BTCUSDT uniquement) : ~9399 POI figes jusqu'a la
  // frontiere d'export. Le live comble entre cette frontiere et maintenant.
  async function loadAnthoV1Archive(ticker, signal) {
    // Capture timeframeMs MAINTENANT : poiConfig peut passer a null si l'user
    // change de symbole pendant les retries -> deref null sinon (POI perdus).
    const tfMs = (poiConfig && poiConfig.timeframeMs) || 15 * 60 * 1000;
    // RETRY avec backoff : un echec transitoire (429/418/coupure reseau/CDN en
    // propagation) ne doit PAS laisser le chart silencieusement incomplet (seuls
    // les niveaux live). Le PARSE JSON est DANS la boucle : un 200 au corps
    // tronque (CDN en propagation) leve une SyntaxError -> on retente aussi.
    let data = null, lastErr = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (signal && signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      try {
        const response = await fetch(archivePathFor(ticker), { signal, cache: "no-store" });
        if (response.ok) {
          const parsed = await response.json();   // corps tronque -> SyntaxError -> retry
          if (parsed && Array.isArray(parsed.pois) && Array.isArray(parsed.columns)) { data = parsed; break; }
          lastErr = Error("Archive POI corps invalide/partiel");
        } else {
          lastErr = Error(`Archive POI ${ticker} ${response.status}`);
        }
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastErr = e;   // reseau OU SyntaxError (corps partiel) -> retry
      }
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * Math.pow(2, attempt))));   // 1,2,4,8,15,15 s
    }
    if (!data) throw (lastErr || Error(`Archive POI ${ticker} indisponible`));
    const columns = data.columns;
    const index = Object.fromEntries(columns.map((name, i) => [name, i]));
    if (data.schemaVersion !== 2 || data.symbol !== ticker || data.timeframe !== "15m" || !Array.isArray(data.pois)) {
      throw Error("Archive POI Antho v1 M15 invalide");
    }
    const lifecycleValidAfterTs = Number(data.sourceStats && data.sourceStats.lastAggTradeMs) || 0;
    const cutoff = Number(data.sourceStats && data.sourceStats.lastPoiCreatedTs) || 0;
    const archivePois = data.pois.map((row) => {
      const direction = row[index.direction] === "L" ? "long" : "short";
      const zoneLowNum = Number(row[index.zoneLow]), zoneHighNum = Number(row[index.zoneHigh]);
      // Robustesse : cluster absent/NaN -> repli sur la zone. Un NaN rendrait
      // cassure et balayage a jamais faux (close > NaN === false) : le POI
      // deviendrait un zombie definitivement intuable.
      const rawClusterLow = Number(row[index.clusterLow]), rawClusterHigh = Number(row[index.clusterHigh]);
      const clusterLow = Number.isFinite(rawClusterLow) ? rawClusterLow : zoneLowNum;
      const clusterHigh = Number.isFinite(rawClusterHigh) ? rawClusterHigh : zoneHighNum;
      const lowBin = Math.round(clusterLow / data.binSize), highBin = Math.round(clusterHigh / data.binSize) - 1;
      const createdTs = Number(row[index.createdTs]);
      const active = row[index.status] === "A";
      const rawRetestTs = row[index.retestTs];
      const retestTs = rawRetestTs === null || rawRetestTs === undefined ? null : Number(rawRetestTs);
      const importanceScore = Number(row[index.importanceScore] ?? row[index.poiChargeScore] ?? row[index.accumulationScore]);
      return {
        id: `${ticker}-${createdTs}-${direction}-${lowBin}-${highBin}`, symbol: ticker, timeframe: data.timeframe,
        source: data.source, method: "FP_IMBALANCE_FULL_CANDLE", detectorVersion: data.detectorVersion,
        createdTs, availableAt: createdTs + tfMs, direction,
        zoneLow: zoneLowNum, zoneHigh: zoneHighNum, entryPrice: Number(row[index.entryPrice]),
        clusterLow, clusterHigh, imbalance: Number(row[index.imbalance]), zoneVolume: Number(row[index.zoneVolume]),
        zoneVolumeShare: Number(row[index.zoneVolumeShare]), fpTimeStart: Number(row[index.fpTimeStart]),
        fpTimeEnd: Number(row[index.fpTimeEnd]), fpTimeShare: Number(row[index.fpTimeShare]), clusterBins: Number(row[index.clusterBins]),
        originZone: row[index.originZone] === 1, fallbackZone: row[index.fallbackZone] === 1,
        accumulationScore: Number(row[index.accumulationScore]), strategyScore: Number(row[index.strategyScore]),
        importanceScore, poiChargeScore: importanceScore, score: importanceScore,
        status: active ? "ACTIVE_UNTOUCHED" : (row[index.status] === "I" ? "INVALIDATED" : "TOUCHED"),
        firstTouchTs: active || !Number.isFinite(retestTs) ? null : retestTs,
        touchCount: active ? 0 : 1, maxPenetrationPct: 0, lastLifecycleCandleTs: null,
        statusChangedTs: active ? createdTs + tfMs : retestTs,
        lifecycleValidAfterTs, provenance: "antho_v1_canonical",
        climax: index.climax != null ? row[index.climax] === 1 : false,
        // Verdict de la regle de retest (SL 0.15% / TP 1%, backfill-outcome) :
        // 1 = valide (✦), 0 = perdu, -1 = non eligible/non resolu (exclu),
        // null = actif / non juge / touch trop recent.
        win: index.win != null && row[index.win] !== null && row[index.win] !== undefined
          ? Number(row[index.win]) : null,
        // Profil d'approche avant premier touch (champ de recherche, pas d'UI) :
        // distance min en ATR ; -1 = retest immediat ; null = non calcule/actif.
        approachAtr: index.approachAtr != null && row[index.approachAtr] !== null && row[index.approachAtr] !== undefined
          ? Number(row[index.approachAtr]) : null
      };
    }).filter((p) => Number.isFinite(p.createdTs) && Number.isFinite(p.zoneLow) && Number.isFinite(p.zoneHigh) && p.zoneHigh > p.zoneLow
      && Number.isFinite(p.score));   // score NaN -> POI jamais affiche (NaN>=min faux) : on l'exclut proprement
    // Audit 2026-07-22 : en panne GitHub le service worker sert la DERNIERE
    // archive encachee sans aucun signal — si elle date, le trou entre son
    // cutoff et la fenetre de bootstrap (24-48 h) est invisible. On alerte.
    if (lifecycleValidAfterTs && Date.now() - lifecycleValidAfterTs > 48 * 3600e3)   // 48 h : la regen est QUOTIDIENNE, 24 h sonnait chaque matin
      console.warn("[POI] archive possiblement perimee (cache hors-panne ?)", ticker,
        new Date(lifecycleValidAfterTs).toISOString());
    return { pois: archivePois, cutoff, lifecycleValidAfterTs };
  }

  async function seedPoiHistory(ticker, signal) {
    const q = new URLSearchParams({ symbol: ticker, interval: "15m", limit: String(poiConfig.historyCandles) });
    const response = await fapiFetch(`${FUTURES_KLINES}?${q}`, signal);
    if (!response.ok) throw Error(`Binance Futures REST ${response.status}`);
    const rows = await response.json();
    // GARDE AVANT TOUTE MUTATION GLOBALE : un changement de symbole pendant le
    // fetch a aborte ce signal. Sans ce garde, on ecraserait `poiHistory` (et
    // l'accumulateur) du NOUVEAU symbole avec les bougies de l'ANCIEN -> OHLC du
    // mauvais symbole, detection/vieillissement faux, POI zombies. (l'ancien
    // garde etait APRES la mutation = trop tard.)
    if (signal && signal.aborted) { const e = Error("aborted"); e.name = "AbortError"; throw e; }
    const currentStart = poiAccumulator?.getCurrent()?.startTs ?? Infinity;
    const seeded = rows.slice(0, -1).map((row) => {
      const volume = Number(row[5]), longVolume = Number(row[9]);
      return {
        startTs: Number(row[0]), endTs: Number(row[6]) + 1, availableAt: Number(row[6]) + 1,
        open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
        volume, longVolume, shortVolume: Math.max(0, volume - longVolume), bins: []
      };
    }).filter((row) => Number.isFinite(row.volume) && row.volume > 0 && row.startTs < currentStart);
    // FUSION avec l'etat local (pas de remplacement sec) : une bougie close
    // par le flux PENDANT le fetch serait absente de l'instantane REST et
    // perdue a jamais (historique prior ampute, vieillissement incomplet).
    const seededTs = new Set(seeded.map((c) => c.startTs));
    const kept = poiHistory.filter((c) => !seededTs.has(c.startTs) && c.startTs < currentStart);
    poiHistory = seeded.concat(kept).sort((a, b) => a.startTs - b.startTs);
    trimPoiHistory();
    if (signal?.aborted) { const e = Error("aborted"); e.name = "AbortError"; throw e; }
    // Vieillit les POI au-dela de la frontiere de validite. Pre-filtre de
    // cout (le rejeu updatePoiLifecycle derriere decide seul) : la zone doit
    // croiser la plage rejouee, OU une meche a depasse le cluster — la meche
    // englobant la cloture (high >= close >= low), B.clusterSwept couvre
    // aussi les invalidations par cloture (ex-audit O1). Early-return sur les
    // POI terminaux : le rejeu reste borne malgre les ~9400 canoniques.
    const ageCandles = poiHistory.filter((c) => c.startTs > poiCanonicalValidAfter);
    if (ageCandles.length) {
      const seedLo = Math.min.apply(null, ageCandles.map((c) => c.low));
      const seedHi = Math.max.apply(null, ageCandles.map((c) => c.high));
      pois = pois.map((poi) => {
        const touchable = !(poi.zoneLow > seedHi || poi.zoneHigh < seedLo);
        if (!touchable && !B.clusterSwept(poi, seedHi, seedLo)) return poi;
        let p = poi;
        for (const c of ageCandles) p = B.updatePoiLifecycle(p, { timestamp: c.startTs, high: c.high, low: c.low, close: c.close }, poiConfig);
        return p;
      });
    }
    refresh();
    return poiHistory;
  }

  function trimPoiHistory() {
    if (poiHistory.length > poiConfig.historyCandles) poiHistory.splice(0, poiHistory.length - poiConfig.historyCandles);
  }

  function isPoiBootstrapCandidate(candle) {
    const direction = B.getPoiCandidateDirection(candle, poiConfig);
    return !!direction && Number.isFinite(candle.volume) && candle.volume > 0;
  }

  // CLIMAX de volume (regle validee par climax-test.js : 61.7% vs 53.8%) :
  // la bougie depasse en volume toutes les 30 precedentes.
  function isClimaxCandle(volume, priorCandles) {
    const window = (priorCandles || []).slice(-30);
    if (window.length < 10 || !(volume > 0)) return false;
    let max = 0;
    for (const c of window) if (c.volume > max) max = c.volume;
    return volume > max;
  }
  function decorateClimax(poi, footprint, priorHistory) {
    return Object.freeze(Object.assign({}, poi, { climax: isClimaxCandle(footprint.volume, priorHistory) }));
  }

  async function fetchPoiBootstrapFootprint(ticker, candle, id, signal) {
    const abort = () => { if (signal.aborted || id !== poiSubscription) { const e = Error("aborted"); e.name = "AbortError"; throw e; } };
    abort();
    let page = await fetchAggTrades(ticker, { startTime: candle.startTs, endTime: candle.endTs - 1, limit: 1000 }, signal);
    let pages = 1, trades = page.slice(), complete = page.length < 1000;
    if (!page.length) return { complete: true, footprint: null, pages };
    let lastId = Number(page[page.length - 1].a);
    if (!Number.isSafeInteger(lastId)) return { complete: false, footprint: null, pages };
    while (!complete && pages < POI_BOOTSTRAP_MAX_PAGES) {
      abort();
      await new Promise((r) => setTimeout(r, 75));
      page = await fetchAggTrades(ticker, { fromId: lastId + 1, limit: 1000 }, signal); pages += 1;
      if (!page.length) { complete = true; break; }
      const nextLastId = Number(page[page.length - 1].a);
      if (!Number.isSafeInteger(nextLastId) || nextLastId <= lastId) break;
      trades.push(...page.filter((t) => Number(t.T) >= candle.startTs && Number(t.T) < candle.endTs));
      if (page.some((t) => Number(t.T) >= candle.endTs) || page.length < 1000) complete = true;
      lastId = nextLastId;
    }
    if (!complete) return { complete: false, footprint: null, pages };
    return { complete: true, pages, footprint: B.buildClosedFootprintFromTrades(trades, { startTs: candle.startTs, endTs: candle.endTs, complete: true, provenance: "historical_raw" }, poiConfig) };
  }

  function replayHistoricalPoi(poi, fromTs) {
    let current = poi;
    for (const candle of poiHistory) { if (candle.startTs < fromTs) continue; current = B.updatePoiLifecycle(current, { timestamp: candle.startTs, high: candle.high, low: candle.low, close: candle.close }, poiConfig); }
    return current;
  }

  // Cache persistant du bootstrap : chaque bougie n'est telechargee qu'UNE fois
  // dans la vie de l'app (entree = POI detecte, ou null si aucun). Le lifecycle
  // n'est PAS cache (il depend des bougies suivantes) : il est rejoue au load.
  const poiBootCacheKey = (ticker) => `gon.poi.bootcache.${ticker}`;
  function loadBootCacheLS(ticker) {
    try {
      const raw = JSON.parse(localStorage.getItem(poiBootCacheKey(ticker)) || "null");
      if (!raw || raw.version !== 2 || raw.binSize !== poiConfig.binSize) return {};   // v2 : entrees avec flag climax
      return raw.entries || {};
    } catch (_) { return {}; }
  }
  async function loadBootCache(ticker) {
    // Tiroir IndexedDB d'abord (quota ~100x, plus de purges croisees entre
    // symboles) ; migration naturelle : lecture localStorage en repli.
    const kv = gon.idbKV;
    if (kv) {
      try {
        const raw = await kv.get("poi.bootcache." + ticker);
        if (raw && raw.version === 2 && poiConfig && raw.binSize === poiConfig.binSize) return raw.entries || {};
      } catch (_) {}
    }
    return loadBootCacheLS(ticker);
  }
  function saveBootCache(ticker, entries) {
    // Une continuation ABORTEE (changement de symbole pendant un await) peut
    // arriver ici alors que poiConfig est deja celui du NOUVEAU symbole : le
    // cache de l'ancien serait serialise avec le mauvais binSize et jete au
    // prochain chargement. On ne sauve que si la config correspond au ticker.
    if (!poiConfig || poiConfig.symbol !== ticker) return;
    // prune : garde 3 jours max, et seulement au-dela de la frontiere d'archive
    const minTs = Math.max(poiHistoricalCutoff + 1, Date.now() - 3 * 24 * 3600 * 1000);
    const pruned = {};
    for (const [k, v] of Object.entries(entries)) if (Number(k) >= minTs) pruned[k] = v;
    const rec = { version: 2, binSize: poiConfig.binSize, entries: pruned };
    const kv = gon.idbKV;
    if (kv) {
      // IndexedDB : ecriture riche asynchrone ; succes -> on libere la vieille
      // copie localStorage (migration), echec -> repli localStorage ci-dessous.
      kv.put("poi.bootcache." + ticker, rec).then(ok => {
        if (ok !== undefined) { try { localStorage.removeItem(poiBootCacheKey(ticker)); } catch (_) {} }
        else saveBootCacheLS(ticker, rec);
      }).catch(() => saveBootCacheLS(ticker, rec));
      return;
    }
    saveBootCacheLS(ticker, rec);
  }
  function saveBootCacheLS(ticker, rec) {
    try {
      localStorage.setItem(poiBootCacheKey(ticker), JSON.stringify(rec));
    } catch (error) {
      // quota plein (20 bootcaches x plusieurs symboles + dessins G-Bot) : on
      // libere les bootcaches des AUTRES symboles avant de re-tenter — sinon
      // chaque rechargement re-telechargeait tout le bootstrap (cf. 429).
      if (error && error.name === "QuotaExceededError") {
        try {
          for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key && key.startsWith("gon.poi.bootcache.") && key !== poiBootCacheKey(ticker)) {
              localStorage.removeItem(key);
            }
          }
          localStorage.setItem(poiBootCacheKey(ticker), JSON.stringify({ version: 2, binSize: poiConfig.binSize, entries: {} }));
        } catch (_) {}
      }
    }
  }

  async function bootstrapRecentPois(ticker, id, signal) {
    // Bootstrap DEPUIS LA FRONTIERE DE L'ARCHIVE (plus de cap arbitraire a 12) :
    // couverture complete archive -> maintenant. Le cache rend les rechargements
    // gratuits ; POI_BOOTSTRAP_MAX_CANDLES n'est qu'un garde-fou (24h).
    const fromTs = poiHistoricalCutoff > 0 ? poiHistoricalCutoff + 1 : Date.now() - POI_RAW_WINDOW;
    const cache = await loadBootCache(ticker);
    if (signal && signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });   // garde post-await (IDB)
    const existingStarts = new Set(pois.map((p) => Number(p.createdTs)));
    const candidates = poiHistory
      .filter((c) => c.startTs >= fromTs && !existingStarts.has(c.startTs) && isPoiBootstrapCandidate(c))
      .slice(-POI_BOOTSTRAP_MAX_CANDLES).reverse();
    let hits = 0, fetched = 0, curSnap = null;
    for (const candle of candidates) {
      const key = String(candle.startTs);
      let detected;
      if (key in cache) {
        detected = cache[key];                              // hit : zero requete
        hits += 1;
      } else {
        try {
          await new Promise((r) => setTimeout(r, 60));      // espacement anti rate-limit
          const raw = await fetchPoiBootstrapFootprint(ticker, candle, id, signal);
          curSnap = null;   // du temps a passe : re-snapshotter la bougie en cours
          if (!raw.complete || !raw.footprint) continue;    // retentera au prochain load
          const prior = poiHistory.filter((c) => c.startTs < candle.startTs);
          detected = B.detectPoi(raw.footprint, prior, poiConfig, Date.now());
          if (detected) detected = decorateClimax(detected, raw.footprint, prior);
          cache[key] = detected || null;
          fetched += 1;
          if (fetched % 4 === 0) saveBootCache(ticker, cache);
        } catch (error) {
          if (error.name === "AbortError") { saveBootCache(ticker, cache); throw error; }
          continue;
        }
      }
      if (detected) {
        let aged = replayHistoricalPoi(detected, candle.endTs);
        // Rattrapage intrabar A L'AJOUT : les extremes de la bougie EN COURS
        // deja realises (balayage de cluster) sont invisibles aux flushes
        // passes (le POI n'existait pas encore). Snapshot pris une fois par
        // segment synchrone (getCurrent clone tous les bins — inutile de le
        // refaire pour ~96 candidats en cache), rafraichi apres chaque fetch.
        if (!curSnap && poiAccumulator) curSnap = poiAccumulator.getCurrent();
        if (curSnap && Number.isFinite(curSnap.high) && Number.isFinite(curSnap.low)) {
          aged = B.updatePoiTouch(aged, { timestamp: curSnap.startTs, high: curSnap.high, low: curSnap.low }, poiConfig);
        }
        const pos = pois.findIndex((p) => p.id === aged.id);
        if (pos >= 0) pois[pos] = aged; else pois.push(aged);
        refresh();
      }
    }
    saveBootCache(ticker, cache);
    log("bootstrap", `${candidates.length} candidats (${hits} cache, ${fetched} telecharges)`);
    // Comble la course seed/bootstrap : toute bougie M15 close PENDANT le
    // bootstrap est passee par processClosedFootprint AVANT l'ajout des POI
    // bootstrap (jamais rejouee sur eux, et un footprint partiel n'entre pas
    // dans poiHistory). Re-seed + re-vieillissement : les POI en retard
    // rattrapent les bougies manquees (gates lastLifecycleCandleTs = no-op
    // pour les POI deja a jour), puis reconciliation intrabar.
    try { await seedPoiHistory(ticker, signal); } catch (error) {
      if (error.name === "AbortError") throw error;
      log("bootstrap", `re-seed post-bootstrap impossible: ${error.message}`);
    }
    catchUpIntrabar();
  }

  // Reconciliation intrabar : applique les extremes deja realises de la
  // bougie EN COURS a toute la liste (no-op pour les POI a jour grace aux
  // gates par POI). Appelee a chaque transition de couverture : fin de
  // recovery, fin de bootstrap — le re-seed ne couvre que les bougies closes.
  function catchUpIntrabar() {
    const cur = poiAccumulator ? poiAccumulator.getCurrent() : null;
    if (!cur || !Number.isFinite(cur.high) || !Number.isFinite(cur.low)) return;
    const updated = B.updatePoiTouches(pois, { timestamp: cur.startTs, high: cur.high, low: cur.low }, poiConfig);
    if (updated.some((item, i) => item !== pois[i])) { pois = updated; refresh(); }
  }

  function processClosedFootprint(footprint) {
    if (!footprint) return;
    // Cloture REELLE confirmee (premier trade du bucket suivant) : le
    // provisoire disparait AVANT le definitif calcule sur footprint complete.
    clearPoiProvisional();
    pois = B.updatePoiList(pois, { timestamp: footprint.startTs, high: footprint.high, low: footprint.low, close: footprint.close }, poiConfig);
    const priorHistory = poiHistory.filter((c) => c.startTs !== footprint.startTs);
    const skipPartial = !isFullyCovered(footprint);
    // Propage le flag corrige (bucket amorce mais contiguite de flux fausse) :
    // le gate interne de detectPoi et l'entree d'historique doivent voir la
    // bougie amorcee comme complete.
    const finalFp = !skipPartial && footprint.complete !== true
      ? Object.assign({}, footprint, { complete: true }) : footprint;
    if (!skipPartial && finalFp.startTs > poiHistoricalCutoff) {
      const detected = B.detectPoi(finalFp, priorHistory, poiConfig, Date.now());
      if (detected && !pois.some((p) => p.id === detected.id)) pois.push(decorateClimax(detected, finalFp, priorHistory));
    }
    poiHistory = (skipPartial ? priorHistory : priorHistory.concat(finalFp)).sort((a, b) => a.startTs - b.startTs);
    trimPoiHistory();
    refresh();
  }

  function flushPoiTouches() {
    clearTimeout(poiTouchTimer); poiTouchTimer = null;
    if (!poiTouchWindow || !poiConfig) return;
    const range = poiTouchWindow; poiTouchWindow = null;
    const updated = B.updatePoiTouches(pois, range, poiConfig);
    if (updated.some((item, i) => item !== pois[i])) { pois = updated; refresh(); }
    refreshPoiProvisional();   // cadence par les trades, throttle 750 ms interne
  }

  function schedulePoiTouch(trade) {
    const bucket = Math.floor(trade.timestamp / poiConfig.timeframeMs) * poiConfig.timeframeMs;
    if (poiTouchWindow && poiTouchWindow.bucket !== bucket) flushPoiTouches();
    const next = { bucket, timestamp: trade.timestamp, high: trade.price, low: trade.price };
    if (!poiTouchWindow) poiTouchWindow = next;
    else { poiTouchWindow.timestamp = Math.max(poiTouchWindow.timestamp, next.timestamp); poiTouchWindow.high = Math.max(poiTouchWindow.high, next.high); poiTouchWindow.low = Math.min(poiTouchWindow.low, next.low); }
    if (!poiTouchTimer) poiTouchTimer = setTimeout(flushPoiTouches, 250);
  }

  // --- POI PROVISOIRE de la bougie EN COURS --------------------------------
  // Meme moteur de detection et meme score que les definitifs, appliques a un
  // instantane IMMUABLE de la footprint ouverte (elle ne contient que des
  // trades deja recus : zero lookahead, zero information future). Seul
  // availableAt est ouvert sur la copie : la garde anti-lookahead du detecteur
  // vise les bougies closes, or on evalue ici la bougie courante par intention.
  // Jamais insere dans `pois` : lifecycle et touches intrabar ne peuvent donc
  // JAMAIS le considerer touche par sa propre bougie. Un seul slot : le
  // candidat est remplace/deplace, jamais empile. Detruit des que le candidat
  // ne passe plus les regles, et a la cloture REELLE (premier trade du bucket
  // M15 suivant, via processClosedFootprint).
  const POI_PROVISIONAL_THROTTLE_MS = 750;
  let poiProvisional = null, poiProvisionalTickAt = 0;
  // startTs du bucket ouvert AMORCE depuis son premier trade (REST) : la
  // couverture est alors totale meme si le flag `complete` de l'accumulateur
  // (qui ne connait que la contiguite de flux) reste false.
  let poiProvisionalSeedTs = 0;
  // Fraicheur du flux : readyState===1 ne detecte pas une socket
  // silencieusement morte (veille machine, TCP half-open) — seul l'age du
  // dernier message recu fait foi avant de finaliser un bucket par flush.
  let poiLastMessageAt = 0;
  const POI_STREAM_STALL_MS = 10000;
  // Empreinte du dernier calcul : aucun trade nouveau + meme bucket =>
  // resultat garanti identique, on evite clone des bins + detection + repaint.
  let poiProvisionalSeenTrade, poiProvisionalSeenBucket = 0;

  // Seuil de silence adaptatif : 10 s pour BTC/ETH (flux continu garanti),
  // 60 s pour les symboles generalises par binSizeForPrice — un altcoin calme
  // passe >10 s sans trade et le watchdog recyclerait une socket SAINE en
  // boucle (churn reseau + provisoire detruit a tort).
  const stallLimitMs = () => POI_SYMBOL_CONFIG[poiTicker] ? POI_STREAM_STALL_MS : 60000;
  const isStreamLive = () => !!(poiSocket && poiSocket.readyState === 1
    && poiLastMessageAt && (Date.now() - poiLastMessageAt) < stallLimitMs());

  // Couverture TOTALE d'un bucket (source unique du predicat) : contiguite de
  // flux, OU amorcage REST depuis son premier trade.
  const isFullyCovered = (fp) => fp.complete === true || fp.startTs === poiProvisionalSeedTs;

  function clearPoiProvisional() {
    if (!poiProvisional) return;
    poiProvisional = null;
    if (render) render.setProvisional(null);
  }

  function refreshPoiProvisional() {
    if (!poiAccumulator || !poiConfig || !render) return;
    // Auto-gouverne : recovery en cours (buckets passes rejoues) ou flux
    // mort/gele -> le slot se detruit lui-meme ; les appelants n'ont aucun
    // contrat a respecter, ils appellent quand quelque chose a pu changer.
    if (poiRecovering || !isStreamLive()) { clearPoiProvisional(); return; }
    const nowTs = Date.now();
    if (nowTs - poiProvisionalTickAt < POI_PROVISIONAL_THROTTLE_MS) return;
    poiProvisionalTickAt = nowTs;
    // Seule la bougie HORLOGE courante est provisoire : un bucket en retard
    // (rejeu, donnees gelees) efface le slot au lieu de l'alimenter.
    const clockBucket = B.bucketStart(nowTs, poiConfig.timeframeMs);
    if (poiLastTradeId === poiProvisionalSeenTrade && clockBucket === poiProvisionalSeenBucket) return;
    poiProvisionalSeenTrade = poiLastTradeId; poiProvisionalSeenBucket = clockBucket;
    const cur = poiAccumulator.getCurrent();   // instantane immuable (copie)
    const fullCoverage = cur && cur.startTs === clockBucket && isFullyCovered(cur);
    if (!fullCoverage) { clearPoiProvisional(); return; }
    const snap = Object.assign({}, cur, { availableAt: nowTs, complete: true });
    const detected = B.detectPoi(snap, poiHistory, poiConfig, nowTs);
    if (!detected) { clearPoiProvisional(); return; }
    const provPoi = Object.assign({}, decorateClimax(detected, cur, poiHistory), { provisional: true });
    // GARDE anti-croisement : un provisoire est HORS lifecycle (il ne meurt
    // jamais). Si le prix de sa PROPRE bougie en cours encadre la ligne d'entree
    // dessinee (low < entry < high), cette ligne serait tracee EN TRAVERS du
    // corps des bougies : le "niveau live tape par les bougies mais pas mort"
    // que le trader rejette. On ne montre le provisoire que quand le prix a
    // DEGAGE le niveau (entierement d'un cote). high/low d'une footprint ouverte
    // ne font que s'ecarter -> une fois masque il reste masque jusqu'a la
    // cloture (aucun flicker). A la cloture, le POI DEFINITIF prend le relais
    // avec son lifecycle complet et son trait qui demarre apres le gap. Garde
    // VISUELLE pure : n'ecrit rien dans le corpus ni le moteur.
    const provEntry = provPoi.entry ?? provPoi.entryPrice;
    if (provEntry != null && cur.low < provEntry && provEntry < cur.high) {
      clearPoiProvisional(); return;
    }
    poiProvisional = provPoi;
    render.setProvisional(poiProvisional);
  }

  function processPoiTrade(message) {
    const normalized = B.normalizeAggTrade(message);
    if (!normalized) return;
    if (normalized.tradeId != null && poiLastTradeId != null && normalized.tradeId <= poiLastTradeId) return;
    const result = poiAccumulator.ingest(message);
    result.closed.forEach(processClosedFootprint);
    if (result.accepted && normalized.tradeId != null) poiLastTradeId = normalized.tradeId;
    if (result.accepted) schedulePoiTouch(normalized);
  }

  async function recoverPoiGap(ticker, id, signal, isCurrent) {
    if (poiLastTradeId == null) return;
    const stale = () => id !== poiSubscription || !poiAccumulator || !isCurrent();
    let nextId = poiLastTradeId + 1, caughtUp = false;
    for (let page = 0; page < 50; page++) {
      if (stale()) return;
      // Espacement anti-rafale (audit) : 50 pages d'un coup = jusqu'a 1000 de
      // poids sans pause au reveil machine, en simultane avec fillGap et les
      // reconnexions — on provoque le 429 au lieu de l'eviter. Meme cadence
      // que le bootstrap (~75 ms).
      if (page > 0) await new Promise((r) => setTimeout(r, 75));
      const trades = await fetchAggTrades(ticker, { fromId: nextId, limit: 1000 }, signal);
      // Re-check APRES l'await : un changement de symbole (ou une socket
      // remplacee — deux recovery concurrentes pagineraient le meme range en
      // rafale, risque de rate-limit) injecterait sinon des trades perimes.
      if (stale()) return;
      if (!trades.length) { caughtUp = true; break; }
      trades.sort((a, b) => Number(a.a) - Number(b.a)).forEach(processPoiTrade);
      const lastId = Number(trades[trades.length - 1].a);
      if (!Number.isSafeInteger(lastId) || lastId < nextId) break;
      nextId = lastId + 1; if (trades.length < 1000) { caughtUp = true; break; }
    }
    if (!caughtUp) throw Error("POI gap recovery limit reached");
  }

  function stopPoiStream() {
    poiBootstrapController?.abort(); poiBootstrapController = null;
    clearTimeout(poiTimer); poiTimer = null;
    clearTimeout(poiTouchTimer); poiTouchTimer = null; poiTouchWindow = null;
    if (poiSocket) { poiSocket.onclose = null; poiSocket.close(); poiSocket = null; }
    poiRecovering = false; poiBuffer = [];
    clearPoiProvisional(); poiProvisionalSeedTs = 0; poiLastMessageAt = 0;
    poiProvisionalSeenTrade = undefined; poiProvisionalSeenBucket = 0;
    poiAccumulator?.reset(); poiAccumulator = null;
    poiTicker = ""; poiLastTradeId = null; poiHistoricalCutoff = 0; poiCanonicalValidAfter = 0;
    pois = []; poiHistory = []; refresh();
  }

  // BTC~64000 -> 10, ETH~3000 -> 1, SOL~140 -> 0.1, DOGE~0.1 -> 1e-4. Generalise
  // le binSize a n'importe quel symbole au lieu de forcer 10 hors BTC/ETH.
  function binSizeForPrice(price) {
    if (!Number.isFinite(price) || price <= 0) return 10;
    return Math.pow(10, Math.floor(Math.log10(price)) - 3);
  }
  async function fetchLastPrice(ticker, signal) {
    const q = new URLSearchParams({ symbol: ticker, interval: "1m", limit: "1" });
    const r = await fapiFetch(`${FUTURES_KLINES}?${q}`, signal);
    if (!r.ok) throw Error(`Binance price ${r.status}`);
    const rows = await r.json();
    return Number(rows[rows.length - 1] && rows[rows.length - 1][4]);
  }

  async function startPoiStream(ticker) {
    stopPoiStream();
    const id = ++poiSubscription; poiTicker = ticker;
    poiBootstrapController = new AbortController();
    const signal = poiBootstrapController.signal;
    log("loading", ticker);

    let binSize = POI_SYMBOL_CONFIG[ticker] && POI_SYMBOL_CONFIG[ticker].binSize;
    if (binSize == null) {
      try { binSize = binSizeForPrice(await fetchLastPrice(ticker, signal)); }
      catch (error) { if (error.name === "AbortError") return; binSize = 10; }
      if (id !== poiSubscription) return;   // symbole change pendant le fetch
    }
    poiConfig = B.createPoiConfig({ symbol: ticker, binSize });
    poiAccumulator = B.createM15Accumulator(poiConfig);
    poiLastTradeId = null; poiHistoricalCutoff = 0; poiCanonicalValidAfter = 0;

    const archivePromise = loadAnthoV1Archive(ticker, signal).then((archive) => {
      if (id !== poiSubscription || !archive) return;
      poiHistoricalCutoff = archive.cutoff;
      poiCanonicalValidAfter = archive.lifecycleValidAfterTs;
      const liveAfterCutoff = pois.filter((p) => Number(p.createdTs) > poiHistoricalCutoff);
      pois = mergePois(liveAfterCutoff, archive.pois);
      refresh();
    }).catch((error) => { if (error.name !== "AbortError") console.warn("Archive Antho v1 indisponible", error); });

    const seedPromise = archivePromise
      .then(() => seedPoiHistory(ticker, signal))
      .catch((error) => { if (error.name !== "AbortError") console.warn("POI seed indisponible", error); });
    // Bootstrap en TACHE DE FOND : inclus dans seedPromise, il durait des
    // minutes (aggTrades pagines) et bloquait le passage en live du onopen —
    // l'affichage restait fige (aucun trade traite, aucun statut applique,
    // niveaux traverses affiches actifs pendant tout le chargement). Ses POI
    // rattrapent les bougies closes manquees (re-seed final) et la bougie EN
    // COURS (vieillissement intrabar final) dans bootstrapRecentPois.
    seedPromise.then(() => bootstrapRecentPois(ticker, id, signal))
      .catch((error) => { if (error.name !== "AbortError") console.warn("POI bootstrap indisponible", error); });

    const connect = () => {
      if (id !== poiSubscription || !poiAccumulator) return;
      // Socket capturee localement : les handlers d'une socket OBSOLETE (apres
      // changement de symbole) ne doivent ni ingerer dans le nouvel etat, ni
      // fermer la nouvelle socket (audit O4).
      const socket = new WebSocket(`${FUTURES_WS}${ticker.toLowerCase()}@aggTrade`);
      poiSocket = socket;
      // Buffer conserve quand poiLastTradeId est null : sans point de reprise,
      // recoverPoiGap ne peut pas re-telecharger ces trades — les jeter
      // perdrait leurs extremes intrabar (balayages de cluster invisibles).
      poiRecovering = true; if (poiLastTradeId != null) poiBuffer = [];
      socket.onopen = async () => {
        // Identite de socket : la continuation d'un onopen OBSOLETE (socket
        // fermee/remplacee pendant un await) ne doit ni paginer en double, ni
        // voler le buffer de la nouvelle socket, ni remettre le backoff a zero.
        const current = () => poiSocket === socket;
        poiLastMessageAt = Date.now();   // demarre l'horloge du watchdog
        try {
          await seedPromise;
          if (!current()) return;
          // Amorce du bucket OUVERT au premier branchement : sans point de
          // reprise (poiLastTradeId null), les trades deja ecoules de la
          // bougie en cours seraient perdus -> footprint partielle, pas de
          // POI provisoire avant la bougie suivante. On ancre poiLastTradeId
          // juste avant le premier trade du bucket courant : la recovery
          // standard rejoue alors TOUT le bucket (meme source, dedup/ordre
          // garantis par l'accumulateur, abort-safe).
          if (poiLastTradeId == null && poiConfig) {
            const openBucketTs = B.bucketStart(Date.now(), poiConfig.timeframeMs);
            try {
              const first = await fetchAggTrades(ticker, { startTime: openBucketTs, limit: 1 }, signal);
              if (id !== poiSubscription || !poiAccumulator || !current()) return;
              if (first.length && Number.isSafeInteger(Number(first[0].a))) {
                poiLastTradeId = Number(first[0].a) - 1;
                // Ancre sur le bucket du trade REELLEMENT retourne, pas sur
                // l'horloge : en course de frontiere (ou bucket vide), le
                // premier trade peut appartenir au bucket suivant — c'est LUI
                // qui est couvert depuis son premier trade.
                const firstTs = Number(first[0].T);
                poiProvisionalSeedTs = Number.isFinite(firstTs)
                  ? B.bucketStart(firstTs, poiConfig.timeframeMs)
                  : openBucketTs;
              }
            } catch (error) { if (error.name === "AbortError") throw error; /* amorce facultative */ }
          }
          await recoverPoiGap(ticker, id, signal, current);
          if (id !== poiSubscription || !poiAccumulator || !current()) return;
          const buffered = poiBuffer.splice(0).sort((a, b) => Number(a.a) - Number(b.a));
          poiRecovering = false; buffered.forEach(processPoiTrade);
          catchUpIntrabar();   // la bougie en cours est complete (anchor+recovery+buffer)
          // Backoff remis a zero SEULEMENT apres catch-up complet : une recovery
          // qui echoue en boucle doit continuer a monter en backoff (audit O3).
          poiAttempt = 0;
          log("live", `${pois.length} POI`);
        } catch (error) { console.warn("POI gap recovery failed", error); socket.close(); }
      };
      socket.onmessage = (event) => {
        if (id !== poiSubscription || !poiAccumulator) return;
        poiLastMessageAt = Date.now();
        try {
          const message = JSON.parse(event.data);
          if (poiRecovering) { if (poiBuffer.length >= POI_BUFFER_LIMIT) { socket.close(); return; } poiBuffer.push(message); }
          else processPoiTrade(message);
        } catch (error) { /* message ignore */ }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (id !== poiSubscription || !poiAccumulator) return;
        poiRecovering = false; if (poiLastTradeId != null) poiBuffer = [];
        poiTimer = setTimeout(connect, S.reconnectDelayMs(poiAttempt++));
      };
    };
    connect();
  }

  function boot() {
    gon = window.__gon;
    if (!gon || !window.GonPoiRender || !B || !S) { console.warn("[POI] dependances absentes"); return; }
    render = window.GonPoiRender.create(gon);

    // Controles POI integres a la BARRE DE MENU G-Bot (pro & sobre) : un groupe
    // compact aligne sur la charte topbar (var(--gold)/var(--border)), insere
    // entre REPLAY et le statut prix. La topbar garde sa charte or quel que
    // soit le theme du chart : aucun restyle dynamique necessaire.
    if (!document.getElementById("gon-poi-style")) {
      const css = document.createElement("style");
      css.id = "gon-poi-style";
      css.textContent = [
        "#gonPoiCtl{display:flex;align-items:center;gap:8px;height:28px;padding:0 10px;border:1px solid var(--border);border-radius:4px;white-space:nowrap}",
        "#gonPoiCtl:hover{border-color:var(--gold-d)}",
        "#gonPoiCtl .gp-toggle{display:flex;align-items:center;gap:6px;background:none;border:none;cursor:pointer;padding:0;color:var(--gold);font:700 10px 'Segoe UI',Arial;letter-spacing:1.5px}",
        "#gonPoiCtl .gp-toggle:hover{color:var(--gold-b)}",
        "#gonPoiCtl .gp-toggle svg{display:block}",
        "#gonPoiCtl .gp-sep{width:1px;height:14px;background:var(--border)}",
        "#gonPoiCtl .gp-ico{display:flex;align-items:center;color:var(--gold)}",
        "#gonPoiCtl .gp-ico svg{display:block}",
        "#gonPoiCtl .gp-val{color:var(--gold-b);font:600 10px Consolas,monospace;min-width:20px;text-align:right}",
        ".gon-poi-range{-webkit-appearance:none;appearance:none;height:12px;width:86px;background:transparent;cursor:pointer}",
        ".gon-poi-range::-webkit-slider-runnable-track{height:2px;background:rgba(217,182,77,.30)}",
        ".gon-poi-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:10px;height:10px;border-radius:2px;margin-top:-4px;background:var(--gold);border:1px solid #080704}",
        /* Filigrane logo au-dessus de tous les calques (POI z4, dessins z5) */
        "#watermark{z-index:7 !important}"
      ].join("\n");
      document.head.appendChild(css);
    }

    // Vue POI a 3 ETATS (cycle sur le picto oeil, demande Meddy) :
    //   fort   -> vivants + morts forts (plancher 80 sur les morts)
    //   vivant -> vivants uniquement, tous scores
    //   none   -> tout masque
    // Le plancher FORT s'ajoute au curseur de score (qui reste le reglage fin :
    // score effectif = max(curseur, plancher du mode)).
    const VIEW_KEY = "gon.poi.view";
    const VIEW_CYCLE = ["fort", "vivant", "none"];
    const FORT_FLOOR = 80;
    let viewMode = "fort";
    try {
      let saved = localStorage.getItem(VIEW_KEY);
      // migration des anciens libelles (live/all/fortvivant) vers les nouveaux
      if (saved === "live") saved = "vivant";
      else if (saved === "all") saved = "fort";
      else if (saved === "fortvivant") saved = "vivant";   // etat supprime du cycle
      viewMode = saved || (localStorage.getItem("gon.poi.showConsumed") === "1" ? "fort" : "vivant");
      if (!VIEW_CYCLE.includes(viewMode)) viewMode = "fort";
      localStorage.removeItem("gon.poi.showConsumed");   // cle de migration morte : nettoyee une fois lue
    } catch (_) {}
    const SCORE_KEY = "gon.poi.minScore";
    // Defaut ELEGANT : seuls les niveaux d'importance moyenne+ (S>=50) — la
    // couverture etant totale, sans seuil la lecture est noyee.
    let minScore = 50;
    try { const v = parseInt(localStorage.getItem(SCORE_KEY), 10); if (Number.isFinite(v)) minScore = Math.min(100, Math.max(0, v)); } catch (_) {}

    const group = document.createElement("div");
    group.id = "gonPoiCtl";
    // Picto oeil : ouvert = TOUS (tout visible), barre = VIVANTS (consommes
    // masques). SVG inline en currentColor pour heriter de l'or de la topbar.
    const EYE_OPEN = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
    const EYE_SLASH = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/><line x1="3" y1="13" x2="13" y2="3"/></svg>';
    const toggle = document.createElement("button");
    toggle.type = "button"; toggle.className = "gp-toggle";
    const togIcon = document.createElement("span");
    toggle.append(togIcon);   // picto seul, sans libelle

    // Picto ECLAIR : vue climax (uniquement les POI nes sur bougie a volume
    // dominant — regle validee : 61.7% vs 53.8%). Contour = off, rempli = on.
    const BOLT_OFF = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1 3.5 9H7l-1 6L12.5 7H9l1.5-6z"/></svg>';
    const BOLT_ON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"><path d="M9 1 3.5 9H7l-1 6L12.5 7H9l1.5-6z"/></svg>';
    const CLIMAX_KEY = "gon.poi.climaxOnly";
    let climaxOnly = false;
    try { climaxOnly = localStorage.getItem(CLIMAX_KEY) === "1"; } catch (_) {}
    const bolt = document.createElement("button");
    bolt.type = "button"; bolt.className = "gp-toggle";
    const boltIcon = document.createElement("span");
    bolt.append(boltIcon);
    const applyBolt = () => {
      render.setClimaxOnly(climaxOnly);
      boltIcon.innerHTML = climaxOnly ? BOLT_ON : BOLT_OFF;
      bolt.title = climaxOnly
        ? "Vue CLIMAX : seuls les POI nes sur bougie a volume dominant — cliquer : tout afficher"
        : "Tous les POI — cliquer : vue climax (volume dominant sur 30 bougies)";
    };
    bolt.onclick = () => {
      climaxOnly = !climaxOnly;
      try { localStorage.setItem(CLIMAX_KEY, climaxOnly ? "1" : "0"); } catch (_) {}
      applyBolt();
    };
    const sep = document.createElement("span"); sep.className = "gp-sep";
    // Picto entonnoir : filtre par score minimum (meme trait que l'oeil)
    const sliderLabel = document.createElement("span"); sliderLabel.className = "gp-ico";
    sliderLabel.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12L9.5 8.5V13l-3-1.5V8.5L2 3z"/></svg>';
    sliderLabel.title = "Filtre : score d'importance minimum";
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "0"; slider.max = "100"; slider.step = "1";
    slider.value = String(minScore); slider.className = "gon-poi-range";
    slider.title = "Score d'importance minimum affiche";
    const sliderVal = document.createElement("span"); sliderVal.className = "gp-val";
    group.append(toggle, bolt, sep, sliderLabel, slider, sliderVal);

    // Insertion dans la topbar entre REPLAY et le statut ; repli flottant si la
    // structure attendue est absente (robustesse au cas ou G-Bot evolue).
    const topbar = document.getElementById("topbar");
    const statusEl = document.getElementById("status");
    if (topbar && statusEl && statusEl.parentElement === topbar) topbar.insertBefore(group, statusEl);
    else if (topbar) topbar.appendChild(group);
    else {
      Object.assign(group.style, { position: "absolute", top: "104px", left: "12px", zIndex: "6", background: "rgba(8,7,4,.94)" });
      gon.mount.appendChild(group);
    }

    // Le plancher FORT (80) NE cache JAMAIS les vivants en mode FORT : le score
    // sert a desencombrer les MORTS (nombreux), pas a masquer les vivants (peu,
    // actionnables). Le curseur reste le reglage fin, commun.
    //   FORT   -> morts filtres a >=80, vivants = curseur (tous)
    //   VIVANT -> vivants = curseur,    (pas de morts)
    const liveMin = () => Math.max(minScore, 0);
    const deadMin = () => Math.max(minScore, viewMode === "fort" ? FORT_FLOOR : 0);
    const applyToggle = () => {
      render.setVisible(viewMode !== "none");
      render.setShowConsumed(viewMode === "fort");   // seul FORT montre les morts
      render.setMinScore(liveMin());
      render.setDeadMinScore(deadMin());
      togIcon.innerHTML = viewMode === "none" ? EYE_SLASH : EYE_OPEN;
      // opacite : pleins = morts inclus (fort), attenue = vivants seuls
      togIcon.style.opacity = viewMode === "vivant" ? "0.55" : "1";
      toggle.title =
        viewMode === "fort" ? "FORT : vivants + morts forts (>=80) — cliquer : vivants seuls"
        : viewMode === "vivant" ? "VIVANTS : niveaux vivants (tous scores) — cliquer : masquer"
        : "Niveaux masques — cliquer : FORT (vivants + morts forts)";
    };
    toggle.onclick = () => {
      viewMode = VIEW_CYCLE[(VIEW_CYCLE.indexOf(viewMode) + 1) % VIEW_CYCLE.length];
      try { localStorage.setItem(VIEW_KEY, viewMode); } catch (_) {}
      applyToggle();
    };
    const applySlider = () => { sliderVal.textContent = String(minScore); render.setMinScore(liveMin()); render.setDeadMinScore(deadMin()); };
    slider.oninput = () => {
      minScore = parseInt(slider.value, 10) || 0;
      try { localStorage.setItem(SCORE_KEY, String(minScore)); } catch (_) {}
      applySlider();
    };
    applyToggle();
    applyBolt();
    applySlider();

    let currentSymbol = gon.symbol;
    let poiWallTick = 0;   // tick horloge du rendu (revue) : 1 repaint/min pour les predicats temporels
    startPoiStream(currentSymbol);
    setInterval(() => {
      // Jamais de flush pendant la recovery : flush(Date.now()) finaliserait
      // prematurement un bucket PASSE en cours de rejeu (trades perdus, POI
      // faux). Grace de 2s pour les trades livres en retard par le WS.
      // ... et jamais pendant une fenetre de DECONNEXION : la socket morte,
      // le bucket courant est tronque — le finaliser marquerait complete=true
      // une bougie fausse ET ferait rejeter (finalized_bucket) les trades du
      // gap pourtant recuperes par recoverPoiGap a la reconnexion.
      // WATCHDOG socket demi-ouverte : "open" mais muette depuis STALL_MS ->
      // close force pour declencher la reconnexion (backoff standard).
      // readyState ne detecte JAMAIS ce cas (veille machine, VPN, TCP
      // half-open) — constate en reel : socket OPEN, zero message, flux mort.
      if (poiSocket && poiSocket.readyState === 1 && !poiRecovering
          && poiLastMessageAt && !isStreamLive()) {
        poiSocket.close();
      }
      // Horloge de flush bornee par le dernier message recu : l'accumulateur
      // ne finalise un bucket que si un trade est arrive APRES son endTs —
      // sinon flush(Date.now()) marquerait complete un bucket dont la fin
      // (3-9s de silence en fin de bougie, frequent la nuit) n'est peut-etre
      // pas encore livree par le WS.
      const flushClock = Math.min(Date.now() - 2000, poiLastMessageAt || 0);
      const closed = (!poiRecovering && isStreamLive() && poiAccumulator) ? poiAccumulator.flush(flushClock) : [];
      closed.forEach(processClosedFootprint);
      refreshPoiProvisional();   // auto-gouverne : flux mort/recovery -> se detruit
      // Audit 2026-07-22 : le repaint inconditionnel forcait un paint COMPLET
      // (~10k POI filtres + tris + lasers) chaque seconde meme a vue figee.
      // Les mutations reelles marquent deja le rendu (setPois/setProvisional) ;
      // ceinture sur les buckets clos + UN tick HORLOGE par minute (revue) :
      // les predicats temporels du rendu (recentDead 24 h, cull endSec=now)
      // n'etaient sinon reevalues qu'a la prochaine mutation (~15 min).
      if (closed.length || ++poiWallTick % 60 === 0) render.repaint();
      if (gon.symbol && gon.symbol !== currentSymbol) { currentSymbol = gon.symbol; startPoiStream(currentSymbol); }
      updateDiag();
    }, 1000);

    // --- MODE DIAGNOSTIC (?diag=1) : empreinte comparable entre deux
    // navigateurs — "on ne voit pas la meme chose" se tranche en lisant
    // deux lignes chacun. Zero cout hors du mode.
    let diagEl = null;
    if (/[?&]diag=1/.test(location.search)) {
      diagEl = document.createElement("div");
      Object.assign(diagEl.style, {
        position: "absolute", left: "10px", top: "72px", zIndex: 9,
        font: "10px Consolas,monospace", color: "#d9b64d", whiteSpace: "pre",
        background: "rgba(10,10,8,.82)", border: "1px solid rgba(217,182,77,.3)",
        borderRadius: "4px", padding: "6px 9px", pointerEvents: "none"
      });
      gon.mount.appendChild(diagEl);
    }
    function updateDiag() {
      if (!diagEl) return;
      const l = pois.filter((p) => p.status === "ACTIVE_UNTOUCHED")
        .map((p) => (p.entry ?? p.entryPrice) + "|" + p.direction + "|" + p.score).sort().join(";");
      let h = 0; for (let i = 0; i < l.length; i++) h = (h * 31 + l.charCodeAt(i)) >>> 0;
      const ver = (document.querySelector('script[src*="poi-feature"]') || { src: "?" }).src.split("v=").pop();
      const st = { A: 0, T: 0, M: 0, I: 0 };
      for (const p of pois) st[p.status === "ACTIVE_UNTOUCHED" ? "A" : p.status === "TOUCHED" ? "T" : p.status === "MITIGATED" ? "M" : "I"]++;
      let filtres = "?";
      try {
        filtres = "vue=" + (localStorage.getItem("gon.poi.view") || "live")
          + " climax=" + (localStorage.getItem("gon.poi.climaxOnly") || "0")
          + " S>=" + (localStorage.getItem("gon.poi.minScore") || "0");
      } catch (_) {}
      diagEl.textContent =
        "DIAG G-ON  code v" + ver + "\n" +
        gon.symbol + " " + gon.tf + "  " + filtres + "\n" +
        "actifs " + (l ? l.split(";").length : 0) + "  hash " + h + "\n" +
        "total " + pois.length + " (A" + st.A + " T" + st.T + " M" + st.M + " I" + st.I + ")\n" +
        "flux " + (isStreamLive() ? "VIVANT" : "MORT/RECOVERY");
    }
    window.__gonPoi = {
      pois: () => pois, provisional: () => poiProvisional, restart: startPoiStream, render,
      // Lecture seule pour les modules de confluence (profil/CVD) : bins et
      // deltas des buckets footprint + config (binSize) du symbole courant.
      accumulator: () => poiAccumulator, config: () => poiConfig,
      // Sonde diagnostique du provisoire (lecture seule)
      provDiag: () => ({
        seedTs: poiProvisionalSeedTs ? new Date(poiProvisionalSeedTs).toISOString().slice(11, 16) : null,
        recovering: poiRecovering,
        socketState: poiSocket ? poiSocket.readyState : null,
        attempts: poiAttempt,
        lastMsgAgeMs: poiLastMessageAt ? Date.now() - poiLastMessageAt : null,
        curBucket: (() => {
          const cur = poiAccumulator && poiAccumulator.getCurrent();
          return cur ? { start: new Date(cur.startTs).toISOString().slice(11, 16), complete: cur.complete } : null;
        })()
      })
    };
  }

  setTimeout(boot, 0);
})();
