(function (root) {
  "use strict";

  const api = root.BiquettePoi = root.BiquettePoi || {};
  const TERMINAL = new Set(["MITIGATED", "INVALIDATED"]);

  function zoneTouched(poi, candle) {
    return candle.low <= poi.zoneHigh && candle.high >= poi.zoneLow;
  }

  // Predicats doctrinaux de MORT du niveau — source unique : les deux
  // fonctions lifecycle et le pre-filtre de vieillissement (poi-feature)
  // doivent rester exactement alignes. (tools/backfill-invalidation.js,
  // outil node hors navigateur, en garde une copie a synchroniser.)
  function clusterBroken(poi, close) {
    return poi.direction === "short" ? close > poi.clusterHigh : close < poi.clusterLow;
  }
  function clusterSwept(poi, high, low) {
    return poi.direction === "short" ? high > poi.clusterHigh : low < poi.clusterLow;
  }

  function penetrationPct(poi, candle) {
    const width = poi.zoneHigh - poi.zoneLow;
    if (!(width > 0) || !zoneTouched(poi, candle)) return 0;
    if (poi.direction === "short") return Math.max(0, Math.min(1, (candle.high - poi.zoneLow) / width));
    return Math.max(0, Math.min(1, (poi.zoneHigh - candle.low) / width));
  }

  function updatePoiLifecycle(poi, candle, options) {
    if (!poi || !candle || TERMINAL.has(poi.status)) return poi;
    const config = api.createPoiConfig ? api.createPoiConfig(options) : options;
    const candleTs = Number(candle.startTs ?? candle.timestamp);
    if (!Number.isFinite(candleTs)) return poi;
    if (Number.isFinite(poi.lifecycleValidAfterTs) && candleTs < poi.lifecycleValidAfterTs) return poi;
    if (Number.isFinite(poi.lastLifecycleCandleTs) && candleTs < poi.lastLifecycleCandleTs) return poi;
    const eligibleAt = poi.availableAt + config.minRetestGapCandles * config.timeframeMs;
    // Pendant la fenetre du gap doctrinal, deux traversees FRANCHES tuent le
    // niveau des la premiere bougie close apres la source : la cloture au-dela
    // du cluster (INVALIDATED, cassure) et la meche au-dela du cluster ENTIER
    // (MITIGATED, balayage — les ordres du niveau sont consommes). Le gap de
    // minRetestGapCandles ne protege que le retest partiel de zone : le
    // generateur d'origine n'avait ni invalidation ni survie a definir, le gap
    // n'a jamais ete specifie pour elles. Sans ceci, un niveau traverse
    // pendant sa fenetre d'eligibilite reste affiche actif (zombie).
    if (candleTs < eligibleAt) {
      if (candleTs >= poi.availableAt) {
        const brokenEarly = clusterBroken(poi, candle.close);
        const sweptEarly = clusterSwept(poi, candle.high, candle.low);
        if (brokenEarly || sweptEarly) {
          return Object.freeze(Object.assign({}, poi, {
            status: brokenEarly ? "INVALIDATED" : "MITIGATED",
            lastLifecycleCandleTs: candleTs,
            statusChangedTs: candleTs
          }));
        }
      }
      return poi;
    }
    const touched = zoneTouched(poi, candle);
    const penetration = penetrationPct(poi, candle);
    const invalidated = clusterBroken(poi, candle.close);
    const mitigated = touched && penetration >= 1;
    let status = poi.status;
    if (invalidated) status = "INVALIDATED";
    else if (mitigated) status = "MITIGATED";
    else if (touched) status = "TOUCHED";

    // Audit 2026-07-22 : != recomptait une bougie deja comptee quand un re-seed
    // rejouait une bougie anterieure au pointeur (touchCount gonflait). Une
    // bougie <= la derniere comptee ne compte jamais deux fois.
    const newTouchCandle = touched && !(Number.isFinite(poi.lastTouchCandleTs) && poi.lastTouchCandleTs >= candleTs);
    return Object.freeze(Object.assign({}, poi, {
      status,
      firstTouchTs: poi.firstTouchTs ?? (touched ? candleTs : null),
      touchCount: poi.touchCount + (newTouchCandle ? 1 : 0),
      maxPenetrationPct: Math.max(poi.maxPenetrationPct || 0, penetration),
      // Math.max (revue) : un rejeu de bougie ANTERIEURE ne doit jamais faire
      // REGRESSER le pointeur — sinon la garde >= est battue au tour suivant.
      lastTouchCandleTs: touched ? Math.max(poi.lastTouchCandleTs || 0, candleTs) : poi.lastTouchCandleTs,
      lastLifecycleCandleTs: candleTs,
      statusChangedTs: status !== poi.status ? candleTs : poi.statusChangedTs
    }));
  }

  function updatePoiTouch(poi, range, options) {
    if (!poi || !range || TERMINAL.has(poi.status)) return poi;
    const config = api.createPoiConfig ? api.createPoiConfig(options) : options;
    const timestamp = Number(range.timestamp);
    const high = Number(range.high);
    const low = Number(range.low);
    if (!Number.isFinite(timestamp) || !Number.isFinite(high) || !Number.isFinite(low)) return poi;
    if (Number.isFinite(poi.lifecycleValidAfterTs) && timestamp <= poi.lifecycleValidAfterTs) return poi;
    const candleTs = Math.floor(timestamp / config.timeframeMs) * config.timeframeMs;
    if (candleTs < poi.availableAt + config.minRetestGapCandles * config.timeframeMs) {
      // Balayage intrabar au-dela du cluster ENTIER pendant le gap : les
      // ordres du niveau sont consommes, il meurt sans attendre la cloture.
      if (candleTs >= poi.availableAt) {
        if (clusterSwept(poi, high, low)) {
          return Object.freeze(Object.assign({}, poi, {
            status: "MITIGATED",
            lastLifecycleCandleTs: candleTs,
            statusChangedTs: timestamp
          }));
        }
      }
      return poi;
    }
    if (Number.isFinite(poi.lastLifecycleCandleTs) && candleTs < poi.lastLifecycleCandleTs) return poi;
    const candle = { high, low };
    if (!zoneTouched(poi, candle)) return poi;
    const penetration = penetrationPct(poi, candle);
    const newTouchCandle = !(Number.isFinite(poi.lastTouchCandleTs) && poi.lastTouchCandleTs >= candleTs);   // idem gate anti-recomptage (audit)
    const status = penetration >= 1 ? "MITIGATED" : "TOUCHED";
    return Object.freeze(Object.assign({}, poi, {
      status,
      firstTouchTs: poi.firstTouchTs ?? timestamp,
      touchCount: poi.touchCount + (newTouchCandle ? 1 : 0),
      maxPenetrationPct: Math.max(poi.maxPenetrationPct || 0, penetration),
      lastTouchCandleTs: Math.max(poi.lastTouchCandleTs || 0, candleTs),   // monotone (revue) : jamais de regression du pointeur
      // Le gate d'idempotence n'avance que jusqu'a la derniere bougie CLOSE :
      // la bougie courante n'est pas terminee, et un rattrapage (re-seed) doit
      // pouvoir rejouer une bougie anterieure re-ajoutee a l'historique.
      lastLifecycleCandleTs: Number.isFinite(poi.lastLifecycleCandleTs)
        ? Math.max(poi.lastLifecycleCandleTs, candleTs - config.timeframeMs)
        : candleTs - config.timeframeMs,
      statusChangedTs: status !== poi.status ? timestamp : poi.statusChangedTs
    }));
  }

  function updatePoiTouches(pois, range, options) {
    const config = api.createPoiConfig ? api.createPoiConfig(options) : options;
    return (pois || []).map((poi) => updatePoiTouch(poi, range, config));
  }

  function updatePoiList(pois, candle, options) {
    const config = api.createPoiConfig ? api.createPoiConfig(options) : options;
    const updated = (pois || []).map((poi) => updatePoiLifecycle(poi, candle, config));
    const canonical = updated.filter((poi) => poi.provenance === "antho_v1_canonical");
    const live = updated.filter((poi) => poi.provenance !== "antho_v1_canonical")
      .slice(-config.maxActivePois);
    return canonical.concat(live).sort((a, b) => a.createdTs - b.createdTs);
  }

  api.zoneTouched = zoneTouched;
  api.clusterBroken = clusterBroken;
  api.clusterSwept = clusterSwept;
  api.poiPenetrationPct = penetrationPct;
  api.updatePoiLifecycle = updatePoiLifecycle;
  api.updatePoiList = updatePoiList;
  api.updatePoiTouch = updatePoiTouch;
  api.updatePoiTouches = updatePoiTouches;
})(window);
