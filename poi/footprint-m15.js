(function (root) {
  "use strict";

  const api = root.BiquettePoi = root.BiquettePoi || {};

  function bucketStart(timestamp, timeframeMs) {
    return Math.floor(timestamp / timeframeMs) * timeframeMs;
  }

  function priceBin(price, binSize) {
    // Epsilon : un prix pile sur une frontiere de bin peut donner x.9999...
    // en flottant et tomber dans le bin d'en dessous — le meme trade serait
    // alors binne differemment selon le chemin de calcul qui a produit price.
    return Math.floor(price / binSize + 1e-9);
  }

  function normalizeAggTrade(message) {
    const payload = message && message.data ? message.data : message;
    const price = Number(payload && (payload.p ?? payload.price));
    const quantity = Number(payload && (payload.q ?? payload.quantity));
    const timestamp = Number(payload && (payload.T ?? payload.transactTime ?? payload.timestamp));
    const tradeId = Number(payload && (payload.a ?? payload.aggTradeId ?? payload.id));
    const isBuyerMaker = Boolean(payload && (payload.m ?? payload.isBuyerMaker));
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0 ||
        !Number.isFinite(timestamp) || timestamp < 0) {
      return null;
    }
    // Plausibilite du timestamp : un passage silencieux de Binance aux
    // microsecondes (deja vu sur d'autres endpoints) donnerait des buckets
    // en l'an 55000 — chaque trade ouvrirait son propre bucket et le POI
    // provisoire deviendrait n'importe quoi. Fail-closed : trade rejete.
    if (timestamp < 1546300800000 /* 2019-01-01 UTC */ ||
        timestamp > Date.now() + 5 * 60 * 1000) {
      return null;
    }
    return { price, quantity, timestamp, isBuyerMaker, tradeId: Number.isSafeInteger(tradeId) ? tradeId : null };
  }

  function createBucket(timestamp, timeframeMs, complete) {
    const startTs = bucketStart(timestamp, timeframeMs);
    return {
      startTs,
      endTs: startTs + timeframeMs,
      open: null,
      high: -Infinity,
      low: Infinity,
      close: null,
      volume: 0,
      delta: 0,
      firstTradeTs: Infinity,
      lastTradeTs: -Infinity,
      tradeCount: 0,
      complete: complete === true,
      bins: new Map()
    };
  }

  function accumulateTrade(bucket, trade, binSize) {
    if (!bucket || !trade || trade.timestamp < bucket.startTs || trade.timestamp >= bucket.endTs) {
      return false;
    }
    const signedQuantity = trade.isBuyerMaker ? -trade.quantity : trade.quantity;
    if (trade.timestamp < bucket.firstTradeTs) {
      bucket.firstTradeTs = trade.timestamp;
      bucket.open = trade.price;
    }
    if (trade.timestamp >= bucket.lastTradeTs) {
      bucket.lastTradeTs = trade.timestamp;
      bucket.close = trade.price;
    }
    bucket.high = Math.max(bucket.high, trade.price);
    bucket.low = Math.min(bucket.low, trade.price);
    bucket.volume += trade.quantity;
    bucket.delta += signedQuantity;
    bucket.tradeCount += 1;

    const key = priceBin(trade.price, binSize);
    let bin = bucket.bins.get(key);
    if (!bin) {
      bin = { bin: key, volume: 0, delta: 0, firstTs: Infinity, lastTs: -Infinity, tradeCount: 0 };
      bucket.bins.set(key, bin);
    }
    bin.volume += trade.quantity;
    bin.delta += signedQuantity;
    bin.firstTs = Math.min(bin.firstTs, trade.timestamp);
    bin.lastTs = Math.max(bin.lastTs, trade.timestamp);
    bin.tradeCount += 1;
    return true;
  }

  function finalizeBucket(bucket) {
    if (!bucket || bucket.tradeCount === 0) return null;
    const longVolume = (bucket.volume + bucket.delta) / 2;
    const shortVolume = (bucket.volume - bucket.delta) / 2;
    return Object.freeze({
      startTs: bucket.startTs,
      endTs: bucket.endTs,
      availableAt: bucket.endTs,
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      volume: bucket.volume,
      delta: bucket.delta,
      longVolume,
      shortVolume,
      tradeCount: bucket.tradeCount,
      complete: bucket.complete === true,
      bins: Object.freeze(Array.from(bucket.bins.values())
        .sort((a, b) => a.bin - b.bin)
        .map((bin) => Object.freeze(Object.assign({}, bin))))
    });
  }

  function buildClosedFootprintFromTrades(messages, windowSpec, options) {
    const config = api.createPoiConfig ? api.createPoiConfig(options) : Object.assign({}, options);
    if (!Array.isArray(messages) || !windowSpec || windowSpec.complete !== true) return null;
    const startTs = Number(windowSpec.startTs);
    const endTs = Number(windowSpec.endTs);
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs) ||
        startTs < 0 || endTs <= startTs ||
        startTs % config.timeframeMs !== 0 || endTs % config.timeframeMs !== 0 ||
        endTs - startTs !== config.timeframeMs) return null;
    if (messages.length === 0) return null;

    const byTradeId = new Map();
    for (const message of messages) {
      const trade = normalizeAggTrade(message);
      if (!trade || !Number.isSafeInteger(trade.tradeId) ||
          trade.timestamp < startTs || trade.timestamp >= endTs) return null;
      const previous = byTradeId.get(trade.tradeId);
      if (previous && (previous.timestamp !== trade.timestamp || previous.price !== trade.price ||
          previous.quantity !== trade.quantity || previous.isBuyerMaker !== trade.isBuyerMaker)) return null;
      byTradeId.set(trade.tradeId, trade);
    }

    const trades = Array.from(byTradeId.values()).sort((left, right) =>
      left.timestamp - right.timestamp || left.tradeId - right.tradeId);
    if (trades.length === 0) return null;
    for (let index = 1; index < trades.length; index += 1) {
      if (trades[index].tradeId !== trades[index - 1].tradeId + 1) return null;
    }

    const bucket = createBucket(startTs, config.timeframeMs, true);
    for (const trade of trades) {
      if (!accumulateTrade(bucket, trade, config.binSize)) return null;
    }
    const footprint = finalizeBucket(bucket);
    if (!footprint || footprint.startTs !== startTs || footprint.endTs !== endTs) return null;
    return Object.freeze(Object.assign({}, footprint, {
      complete: true,
      provenance: windowSpec.provenance || "historical_raw"
    }));
  }

  function createM15Accumulator(options) {
    const config = api.createPoiConfig ? api.createPoiConfig(options) : Object.assign({}, options);
    let current = null;
    let latestTimestamp = -Infinity;
    let lastFinalizedEndTs = -Infinity;
    let completeAfterFlushStartTs = null;
    const closed = [];
    const seenTradeIds = new Set();
    const seenTradeIdOrder = [];
    // Fallback si l'accumulateur est construit sans createPoiConfig (options
    // brutes) : un historyCandles NaN rendrait les deux bornes inertes
    // (comparaisons false) -> closed[] et seenTradeIds sans limite (fuite).
    const historyLimit = Number.isFinite(config.historyCandles) && config.historyCandles > 0
      ? config.historyCandles : 192;
    const maxSeenTradeIds = Math.max(2000, Math.min(50000, historyLimit * 100));

    function remember(footprint) {
      if (!footprint) return;
      closed.push(footprint);
      while (closed.length > historyLimit) closed.shift();
      lastFinalizedEndTs = Math.max(lastFinalizedEndTs, footprint.endTs);
    }

    function rememberTradeId(tradeId) {
      if (tradeId === null) return;
      seenTradeIds.add(tradeId);
      seenTradeIdOrder.push(tradeId);
      while (seenTradeIdOrder.length > maxSeenTradeIds) {
        seenTradeIds.delete(seenTradeIdOrder.shift());
      }
    }

    function snapshotBucket(bucket) {
      if (!bucket) return null;
      return Object.assign({}, bucket, { bins: Array.from(bucket.bins.entries()) });
    }

    function restoreBucket(value) {
      if (!value || !Number.isFinite(value.startTs) || !Number.isFinite(value.endTs) ||
          !Number.isFinite(value.tradeCount) || value.tradeCount < 0 || !Array.isArray(value.bins)) return null;
      const bucket = Object.assign({}, value, { bins: new Map() });
      for (const entry of value.bins) {
        if (!Array.isArray(entry) || entry.length !== 2 || !Number.isFinite(Number(entry[0])) || !entry[1]) return null;
        bucket.bins.set(Number(entry[0]), Object.assign({}, entry[1]));
      }
      return bucket;
    }

    return {
      ingest(message) {
        const trade = normalizeAggTrade(message);
        if (!trade) return { accepted: false, reason: "invalid_trade", closed: [] };
        if (trade.tradeId !== null && seenTradeIds.has(trade.tradeId)) {
          return { accepted: false, reason: "duplicate_trade", closed: [] };
        }
        if (trade.timestamp < lastFinalizedEndTs) {
          return { accepted: false, reason: "finalized_bucket", closed: [] };
        }
        if (trade.timestamp < latestTimestamp) {
          return { accepted: false, reason: "out_of_order", closed: [] };
        }
        const startTs = bucketStart(trade.timestamp, config.timeframeMs);
        const finalized = [];
        if (!current) {
          const complete = completeAfterFlushStartTs === startTs;
          current = createBucket(trade.timestamp, config.timeframeMs, complete);
          completeAfterFlushStartTs = null;
        }
        if (startTs > current.startTs) {
          const contiguous = startTs === current.endTs;
          const footprint = finalizeBucket(current);
          if (footprint) {
            remember(footprint);
            finalized.push(footprint);
          }
          current = createBucket(trade.timestamp, config.timeframeMs, contiguous);
        }
        const accepted = accumulateTrade(current, trade, config.binSize);
        if (accepted) {
          latestTimestamp = trade.timestamp;
          rememberTradeId(trade.tradeId);
        }
        return { accepted, reason: accepted ? null : "wrong_bucket", closed: finalized };
      },

      flush(now) {
        const finalized = [];
        if (current && Number(now) >= current.endTs) {
          const footprint = finalizeBucket(current);
          if (footprint) {
            remember(footprint);
            finalized.push(footprint);
            completeAfterFlushStartTs = footprint.endTs;
          }
          current = null;
        }
        return finalized;
      },

      getCurrent() { return current ? finalizeBucket(current) : null; },
      getClosed() { return closed.slice(); },
      snapshot() {
        return {
          version: 3,
          // Empreinte de config : un snapshot binne en binSize=10 restaure
          // dans un accumulateur binSize=5 melangerait deux grilles de bins
          // dans le meme bucket. Le restore refuse toute empreinte differente.
          binSize: config.binSize,
          timeframeMs: config.timeframeMs,
          latestTimestamp: Number.isFinite(latestTimestamp) ? latestTimestamp : null,
          lastFinalizedEndTs: Number.isFinite(lastFinalizedEndTs) ? lastFinalizedEndTs : null,
          completeAfterFlushStartTs,
          seenTradeIds: seenTradeIdOrder.slice(),
          current: snapshotBucket(current)
        };
      },
      restore(state) {
        // v1/v2 (sans empreinte) refuses : le caller repart d'un reseed REST,
        // cout unique d'une migration — jamais de bins de deux grilles melees.
        if (!state || state.version !== 3) return false;
        if (state.binSize !== config.binSize || state.timeframeMs !== config.timeframeMs) return false;
        const restored = restoreBucket(state.current);
        if (state.current && !restored) return false;
        current = restored;
        latestTimestamp = Number.isFinite(state.latestTimestamp) ? state.latestTimestamp : -Infinity;
        lastFinalizedEndTs = Number.isFinite(state.lastFinalizedEndTs) ? state.lastFinalizedEndTs : -Infinity;
        completeAfterFlushStartTs = Number.isFinite(state.completeAfterFlushStartTs)
          ? state.completeAfterFlushStartTs : null;
        seenTradeIds.clear();
        seenTradeIdOrder.length = 0;
        if (Array.isArray(state.seenTradeIds)) {
          state.seenTradeIds.slice(-maxSeenTradeIds).forEach((value) => {
            const tradeId = Number(value);
            if (Number.isSafeInteger(tradeId) && !seenTradeIds.has(tradeId)) rememberTradeId(tradeId);
          });
        }
        closed.length = 0;
        return true;
      },
      reset() {
        current = null;
        latestTimestamp = -Infinity;
        lastFinalizedEndTs = -Infinity;
        completeAfterFlushStartTs = null;
        closed.length = 0;
        seenTradeIds.clear();
        seenTradeIdOrder.length = 0;
      }
    };
  }

  api.bucketStart = bucketStart;
  api.priceBin = priceBin;
  api.normalizeAggTrade = normalizeAggTrade;
  api.createFootprintBucket = createBucket;
  api.accumulateFootprintTrade = accumulateTrade;
  api.finalizeFootprintBucket = finalizeBucket;
  api.buildClosedFootprintFromTrades = buildClosedFootprintFromTrades;
  api.createM15Accumulator = createM15Accumulator;
})(window);
