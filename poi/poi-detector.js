(function (root) {
  "use strict";

  const api = root.BiquettePoi = root.BiquettePoi || {};

  function clamp01(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }

  // Polars utilise l'interpolation "nearest" par defaut dans Antho v1.
  function percentile(values, pct) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    const index = Math.round(clamp01(pct / 100) * (sorted.length - 1));
    return sorted[index];
  }

  function departureDirection(candle, config) {
    const range = candle.high - candle.low;
    if (!(range > 0)) return null;
    if (Math.abs(candle.close - candle.open) / range < config.minBodyFraction) return null;
    const closePosition = (candle.close - candle.low) / range;
    if (candle.close < candle.open && closePosition <= config.closeExtremeFraction) return "short";
    if (candle.close > candle.open && closePosition >= 1 - config.closeExtremeFraction) return "long";
    return null;
  }

  function fallbackCandleDirection(candle) {
    if (candle.close > candle.open) return "long";
    if (candle.close < candle.open) return "short";
    const totalDelta = (candle.bins || []).reduce((sum, bin) => sum + Number(bin.delta || 0), 0);
    if (totalDelta > 0) return "long";
    if (totalDelta < 0) return "short";
    return "long";
  }

  function candidateDirection(candle, config) {
    return departureDirection(candle, config) || (config.allM15CandlePois ? fallbackCandleDirection(candle) : null);
  }

  function imbalance(bin) {
    return bin.volume > 0 ? bin.delta / bin.volume : 0;
  }

  function passesDirection(bin, direction, minimum) {
    const ratio = imbalance(bin);
    return direction === "short" ? ratio <= -minimum : ratio >= minimum;
  }

  function buildCluster(seed, byBin, direction, volumeGate, footprint, config) {
    const clusterGate = Math.max(volumeGate * config.clusterVolumeFraction,
      seed.volume * config.clusterVolumeFraction);
    let lowBin = seed.bin;
    let highBin = seed.bin;
    while (byBin.has(lowBin - 1)) {
      const candidate = byBin.get(lowBin - 1);
      if (candidate.volume < clusterGate || !passesDirection(candidate, direction, config.clusterImbalance)) break;
      lowBin -= 1;
    }
    while (byBin.has(highBin + 1)) {
      const candidate = byBin.get(highBin + 1);
      if (candidate.volume < clusterGate || !passesDirection(candidate, direction, config.clusterImbalance)) break;
      highBin += 1;
    }
    const bins = [];
    for (let key = lowBin; key <= highBin; key += 1) {
      if (byBin.has(key)) bins.push(byBin.get(key));
    }
    const zoneVolume = bins.reduce((sum, bin) => sum + bin.volume, 0);
    const zoneDelta = bins.reduce((sum, bin) => sum + bin.delta, 0);
    if (!(zoneVolume > 0) || !bins.length) return null;
    const firstTs = Math.min(...bins.map((bin) => Number(bin.firstTs ?? bin.t_first)));
    const lastTs = Math.max(...bins.map((bin) => Number(bin.lastTs ?? bin.t_last)));
    const clusterLow = lowBin * config.binSize;
    const clusterHigh = (highBin + 1) * config.binSize;
    const entryPrice = direction === "short" ? clusterLow : clusterHigh;
    return {
      lowBin, highBin, bins, zoneVolume, zoneDelta, firstTs, lastTs,
      clusterLow, clusterHigh, entryPrice,
      zoneLow: direction === "short" ? entryPrice - config.zoneWidthBins * config.binSize : entryPrice,
      zoneHigh: direction === "short" ? entryPrice : entryPrice + config.zoneWidthBins * config.binSize,
      zoneVolumeShare: zoneVolume / Math.max(Number(footprint.volume), Number.EPSILON),
      fpTimeShare: Math.max(0, lastTs - firstTs) / config.timeframeMs,
      seedPrice: (seed.bin + 0.5) * config.binSize,
      originZone: false,
      fallbackZone: false
    };
  }

  function computePoiScore(zone, footprint, config) {
    const volumeShare = zone.zoneVolume / Math.max(footprint.volume, Number.EPSILON);
    const timeShare = Math.max(0, zone.lastTs - zone.firstTs) / config.timeframeMs;
    const imbalanceScore = Math.abs(zone.zoneDelta / Math.max(zone.zoneVolume, Number.EPSILON));
    const compactness = 3 / Math.max(1, zone.highBin - zone.lowBin + 1);
    return Math.round(10000 * (
      0.35 * clamp01(volumeShare / 0.003) +
      0.25 * clamp01(timeShare / 0.08) +
      0.25 * clamp01(imbalanceScore / 0.75) +
      0.15 * clamp01(compactness)
    )) / 100;
  }

  function orderedBins(footprint, direction, fraction, config) {
    const range = footprint.high - footprint.low;
    const bins = footprint.bins.filter((bin) => {
      const middle = (bin.bin + 0.5) * config.binSize;
      return direction === "short"
        ? middle >= footprint.high - range * fraction
        : middle <= footprint.low + range * fraction;
    });
    return bins.sort((a, b) => direction === "short" ? b.bin - a.bin : a.bin - b.bin);
  }

  function buildZones(footprint, direction, config) {
    if (!Array.isArray(footprint.bins) || !footprint.bins.length || !(footprint.volume > 0)) return [];
    const byBin = new Map(footprint.bins.map((bin) => [Number(bin.bin), bin]));
    const zones = [];
    const blocked = new Set();
    const addBlocked = (zone) => {
      for (let key = zone.lowBin - config.minClusterSeparationBins;
        key <= zone.highBin + config.minClusterSeparationBins; key += 1) blocked.add(key);
    };

    const originGate = Math.max(footprint.volume * config.originMinZoneCandleVolumeShare, 1e-9);
    const originSeed = orderedBins(footprint, direction, config.originScanFraction, config)
      .find((bin) => bin.volume >= originGate && passesDirection(bin, direction, config.originImbalance));
    if (originSeed) {
      const zone = buildCluster(originSeed, byBin, direction, originGate, footprint, config);
      if (zone) {
        zone.originZone = true;
        zones.push(zone);
        addBlocked(zone);
      }
    }

    const volumeQuantile = percentile(footprint.bins.map((bin) => Number(bin.volume)), config.seedVolumePercentile);
    const volumeGate = Math.max(Number(volumeQuantile || 0), footprint.volume * config.minZoneCandleVolumeShare);
    for (const seed of orderedBins(footprint, direction, 1, config)) {
      if (blocked.has(seed.bin) || seed.volume < volumeGate ||
          !passesDirection(seed, direction, config.seedImbalance)) continue;
      const zone = buildCluster(seed, byBin, direction, volumeGate, footprint, config);
      if (!zone) continue;
      zones.push(zone);
      addBlocked(zone);
      if (zones.length >= config.maxZonesPerCandle) break;
    }

    if (config.allM15CandlePois && !zones.length) {
      const fallbackGate = Math.max(footprint.volume * config.fallbackMinVolumeShare, 1e-9);
      const fallbackSeed = orderedBins(footprint, direction, 1, config)
        .find((bin) => bin.volume >= fallbackGate && passesDirection(bin, direction, config.fallbackImbalance));
      if (fallbackSeed) {
        const zone = buildCluster(fallbackSeed, byBin, direction, fallbackGate, footprint, config);
        if (zone) {
          zone.originZone = true;
          zone.fallbackZone = true;
          zones.push(zone);
        }
      }
    }
    if (config.allM15CandlePois && !zones.length) {
      const ordered = footprint.bins.slice().sort((a, b) => direction === "short" ? b.bin - a.bin : a.bin - b.bin);
      const forcedSeed = ordered.find((bin) => Number(bin.volume) > 0);
      const zone = forcedSeed ? buildCluster(forcedSeed, byBin, direction, 0, footprint, config) : null;
      if (zone) {
        zone.originZone = true;
        zone.fallbackZone = true;
        zone.forcedZone = true;
        zones.push(zone);
      }
    }
    return zones;
  }

  function selectExtremeZones(zones, direction, config) {
    if (!config.keepOneExtremePoiPerCandle || zones.length <= 1) return zones;
    return [zones.slice().sort((a, b) => direction === "short"
      ? b.zoneHigh - a.zoneHigh || b.zoneVolume - a.zoneVolume
      : a.zoneLow - b.zoneLow || b.zoneVolume - a.zoneVolume)[0]];
  }

  function wilderAtr(footprint, history, period) {
    // Warmup sur TOUT l'historique fourni (192 M15) : le pipeline d'entrainement
    // calcule l'EWM sur la serie complete ; tronquer a 4*period biaisait le seed
    // (~1.6%) alors que range/ATR porte le plus gros coefficient du score.
    const rows = (history || []).filter((row) => [row.high, row.low, row.close].every(Number.isFinite))
      .concat(footprint);
    let previousClose = null;
    let atr = null;
    for (const row of rows) {
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      if (![high, low, close].every(Number.isFinite) || high < low) continue;
      const trueRange = previousClose == null ? high - low : Math.max(
        high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
      atr = atr == null ? trueRange : atr + (trueRange - atr) / period;
      previousClose = close;
    }
    return Number(atr) || 0;
  }

  function zoneToPoi(zone, footprint, direction, directionalVolume, directionalGate, history, config) {
    const id = `${config.symbol}-${footprint.startTs}-${direction}-${zone.lowBin}-${zone.highBin}`;
    const accumulationScore = computePoiScore(zone, footprint, config);
    const range = Math.max(0, Number(footprint.high) - Number(footprint.low));
    const atr = wilderAtr(footprint, history, 14);
    const bodyFraction = range > 0 ? Math.abs(Number(footprint.close) - Number(footprint.open)) / range : 0;
    const rangeAtr = atr > 0 ? range / atr : 0;
    const importanceScore = typeof api.computePoiImportanceScore === "function"
      ? api.computePoiImportanceScore({
        zoneVolume: zone.zoneVolume,
        zoneVolumeShare: zone.zoneVolumeShare,
        imbalance: zone.zoneDelta / zone.zoneVolume,
        fpTimeShare: zone.fpTimeShare,
        clusterBins: zone.highBin - zone.lowBin + 1,
        directionalVolumeShare: directionalVolume / Math.max(footprint.volume, Number.EPSILON),
        directionalVsGate: directionalVolume / Math.max(directionalGate, Number.EPSILON),
        bodyFraction,
        rangeAtr,
        originZone: zone.originZone === true,
        fallbackZone: zone.fallbackZone === true,
        direction
      })
      : Math.round(accumulationScore);
    return Object.freeze({
      id,
      symbol: config.symbol,
      timeframe: config.timeframe,
      source: config.source,
      method: config.method,
      detectorVersion: config.detectorVersion,
      createdTs: footprint.startTs,
      availableAt: footprint.availableAt,
      direction,
      zoneLow: zone.zoneLow,
      zoneHigh: zone.zoneHigh,
      entryPrice: zone.entryPrice,
      clusterLow: zone.clusterLow,
      clusterHigh: zone.clusterHigh,
      seedPrice: zone.seedPrice,
      imbalance: zone.zoneDelta / zone.zoneVolume,
      zoneVolume: zone.zoneVolume,
      zoneVolumeShare: zone.zoneVolumeShare,
      directionalVolumeShare: directionalVolume / footprint.volume,
      candleDirectionalVolume: directionalVolume,
      fpTimeStart: zone.firstTs,
      fpTimeEnd: zone.lastTs,
      fpTimeShare: zone.fpTimeShare,
      clusterBins: zone.highBin - zone.lowBin + 1,
      originZone: zone.originZone === true,
      fallbackZone: zone.fallbackZone === true,
      forcedZone: zone.forcedZone === true,
      zoneRankInCandle: 1,
      accumulationScore,
      importanceScore,
      poiChargeScore: importanceScore,
      score: importanceScore,
      status: "ACTIVE_UNTOUCHED",
      firstTouchTs: null,
      touchCount: 0,
      maxPenetrationPct: 0,
      lastLifecycleCandleTs: null,
      statusChangedTs: footprint.availableAt
    });
  }

  function detectPois(footprint, priorFootprints, options, now) {
    const config = api.createPoiConfig ? api.createPoiConfig(options) : options;
    // Garde anti-lookahead FERMEE par defaut : now/availableAt invalides
    // (NaN, absent) doivent REFUSER l'emission, pas la laisser passer —
    // 'NaN < x' vaut false et emettait avant la cloture sans erreur.
    if (!footprint || footprint.complete !== true) return [];
    if (!(Number(now) >= Number(footprint.availableAt))) return [];
    const history = (priorFootprints || [])
      .filter((item) => item && item.availableAt <= footprint.startTs)
      .slice(-config.historyCandles);
    // minHistoryCandles etait valide par la config mais applique nulle part :
    // sans historique (seed en echec, demarrage a froid), 3 des features les
    // plus lourdes du score (rangeAtr, directionalVsGate...) degenerent en
    // constantes — mieux vaut ne rien emettre que scorer faux. Sans effet sur
    // la parite : corpus et harnais fournissent toujours l'historique plein.
    if (history.length < config.minHistoryCandles) return [];

    const direction = candidateDirection(footprint, config);
    if (!direction) return [];
    const directionalVolume = direction === "long" ? footprint.longVolume : footprint.shortVolume;
    const historyDirectional = history.map((item) => direction === "long" ? item.longVolume : item.shortVolume);
    const directionalGate = percentile(historyDirectional, config.directionalVolumePercentile) || directionalVolume || 1;
    const zones = selectExtremeZones(buildZones(footprint, direction, config), direction, config);
    return zones.map((zone) => zoneToPoi(zone, footprint, direction, directionalVolume, directionalGate, history, config));
  }

  function detectPoi(footprint, priorFootprints, options, now) {
    return detectPois(footprint, priorFootprints, options, now)[0] || null;
  }

  api.percentile = percentile;
  api.getPoiDepartureDirection = departureDirection;
  api.getPoiCandidateDirection = candidateDirection;
  api.computePoiScore = computePoiScore;
  api.buildPoiZones = buildZones;
  api.detectPois = detectPois;
  api.detectPoi = detectPoi;
})(window);
