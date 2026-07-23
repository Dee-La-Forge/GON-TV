(function (root) {
  "use strict";

  const api = root.BiquettePoi = root.BiquettePoi || {};

  const DEFAULT_POI_CONFIG = Object.freeze({
    symbol: "BTCUSDT",
    source: "BINANCE_FUTURES_AGGTRADE",
    timeframe: "15m",
    timeframeMs: 15 * 60 * 1000,
    binSize: 10,
    historyCandles: 192,
    minHistoryCandles: 20,
    minBodyFraction: 0.30,
    closeExtremeFraction: 0.65,
    directionalVolumePercentile: 55,
    // ⚠ MORTE (audit 2026-07-23) : declaree et validee mais JAMAIS appliquee
    // par le detecteur — la durcir ne change RIEN. Conservee pour compat de
    // signature ; a rebrancher ou supprimer en connaissance de cause.
    minDirectionalVolumeShare: 0.35,
    seedVolumePercentile: 40,
    seedImbalance: 0.55,
    minZoneCandleVolumeShare: 0.001,
    clusterImbalance: 0.25,
    clusterVolumeFraction: 0.50,
    zoneWidthBins: 1,
    maxZonesPerCandle: 4,
    minClusterSeparationBins: 1,
    originImbalance: 0.25,
    originMinZoneCandleVolumeShare: 0.001,
    originScanFraction: 0.45,
    allM15CandlePois: true,
    fallbackImbalance: 0.05,
    fallbackMinVolumeShare: 0.0001,
    keepOneExtremePoiPerCandle: true,
    // ⚠ MORTE (audit 2026-07-23) : jamais lue par le detecteur, meme piege
    // que minDirectionalVolumeShare.
    minFootprintBins: 1,
    minRetestGapCandles: 2,
    maxActivePois: 1000,
    method: "FP_IMBALANCE_FULL_CANDLE",
    detectorVersion: "fp-m15-importance-v2"
  });

  function createPoiConfig(overrides) {
    const config = Object.assign({}, DEFAULT_POI_CONFIG, overrides || {});
    const positive = ["timeframeMs", "binSize", "historyCandles", "minHistoryCandles", "zoneWidthBins",
      "maxZonesPerCandle", "minFootprintBins"];
    positive.forEach((key) => {
      if (!Number.isFinite(config[key]) || config[key] <= 0) {
        throw new TypeError(`Configuration POI invalide: ${key}`);
      }
    });
    // Gates/fractions : un NaN (ex : override '0,5' avec virgule) DESACTIVE
    // silencieusement la gate dans le detecteur ('x < NaN' === false) — le
    // moteur gele produirait un comportement non gele sans bruit. Fail-loud.
    ["seedImbalance", "clusterImbalance", "clusterVolumeFraction", "seedVolumePercentile",
      "directionalVolumePercentile", "minBodyFraction", "minDirectionalVolumeShare",
      "minRetestGapCandles", "maxActivePois"].forEach((key) => {
      if (key in config && !Number.isFinite(config[key])) {
        throw new TypeError(`Configuration POI invalide (non numerique): ${key}`);
      }
    });
    if (config.minHistoryCandles > config.historyCandles) {
      throw new RangeError("minHistoryCandles ne peut pas depasser historyCandles");
    }
    // Plages fail-loud : validees "finies" plus haut, mais des valeurs hors
    // plage DESACTIVENT silencieusement une protection.
    //  - maxActivePois <= 0 -> .slice(-0) === .slice(0) = tout le tableau : le
    //    plafond de POI actifs saute (fuite memoire/rendu). Doit etre entier > 0.
    //  - minRetestGapCandles < 0 -> eligibleAt < availableAt : fenetre de gap
    //    inversee, la protection de retest saute. Doit etre >= 0.
    if (!(Number.isInteger(config.maxActivePois) && config.maxActivePois > 0)) {
      throw new RangeError("maxActivePois doit etre un entier > 0");
    }
    if (!(config.minRetestGapCandles >= 0)) {
      throw new RangeError("minRetestGapCandles doit etre >= 0");
    }
    return Object.freeze(config);
  }

  api.DEFAULT_POI_CONFIG = DEFAULT_POI_CONFIG;
  api.createPoiConfig = createPoiConfig;
})(window);
