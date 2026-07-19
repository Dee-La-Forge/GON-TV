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
    return Object.freeze(config);
  }

  api.DEFAULT_POI_CONFIG = DEFAULT_POI_CONFIG;
  api.createPoiConfig = createPoiConfig;
})(window);
