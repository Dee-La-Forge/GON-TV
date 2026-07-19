(function (root) {
  "use strict";

  const api = root.BiquettePoi = root.BiquettePoi || {};

  const MODEL = Object.freeze({
    version: "poi-importance-v2",
    trainedThrough: "2026-04-18T16:15:00Z",
    validatedThrough: "2026-06-05T01:15:00Z",
    featureMean: Object.freeze([0.4998944483568818,0.4985235147024332,0.5271932159434658,0.6040921003056794,0.973964137168006,0.5557767736900542,0.6500072411962811,0.47596343570057664,0.39733404990403065,0.9738963531669865,0.058349328214971206,0.508253358925144]),
    featureStd: Object.freeze([0.2867836433800204,0.2858235789390636,0.21535539304485982,0.4139638366126683,0.10615973417287056,0.0612622077168947,0.2013713293307599,0.25239425644812935,0.1810192212237742,0.1594435525665179,0.23440282445361454,0.4999318774257666]),
    intercept: 0.20978714042254107,
    coefficients: Object.freeze([-0.007734296994697913,0.011995179594705379,-0.03779046433903173,-0.021135684671906112,0.028678308038330297,0.03328455496365363,-0.0032061051444279343,0.09788834287988465,0.1086718486117641,0.02186032197203452,0.007450428006044969,0.01883597512353877]),
    rawVolumeQuantiles: Object.freeze([0.8254903675476585,1.7240685489609153,2.0835580571916754,2.3708555360518626,2.613724456503573,2.8234600049913947,2.99570726667822,3.1782412132580107,3.3516847963860528,3.522402589511855,3.700103570943959,3.8602443300938942,4.012913796632239,4.183893480802133,4.36117446935003,4.545152097155723,4.724372132312702,4.941569823372,5.217725883164811,5.61390152392186,7.664870661828771]),
    relativeVolumeQuantiles: Object.freeze([0.0004140966611646829,0.0017062133706951083,0.0026242238421763635,0.0035680143977466577,0.004790016832629301,0.006136234989382814,0.0077055828131005685,0.00946953421672886,0.01157488155253786,0.013676732891860678,0.016340280801655865,0.019292624167891924,0.023007839432409766,0.027583426469799513,0.03351465911771275,0.040624484091258566,0.04968531961216653,0.06369241872950357,0.08499804852733117,0.1366119291560822,0.8377887330045564]),
    logitQuantiles: Object.freeze([-0.38235678916445426,-0.05239520495919277,-0.004279430864888539,0.026329104944649857,0.056275263849848996,0.08280306284706807,0.10616165638609493,0.1296328619939092,0.15334508752609965,0.176123625108334,0.1974469162866001,0.22109270808501885,0.24507920339234598,0.26647630297022745,0.295313963858196,0.32540504131691905,0.3535047814689745,0.394576342754597,0.4431582389568367,0.5161366490222921,0.8003563242516109])
  });

  function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function quantileRank(knots, value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || !knots.length) return 0;
    if (numeric <= knots[0]) return 0;
    if (numeric >= knots[knots.length - 1]) return 1;
    let low = 0;
    let high = knots.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (knots[middle] <= numeric) low = middle;
      else high = middle;
    }
    const width = knots[high] - knots[low];
    const fraction = width > 1e-12 ? (numeric - knots[low]) / width : 0;
    return clamp01((low + fraction) / (knots.length - 1));
  }

  function computePoiImportanceScore(input) {
    const clusterBins = Math.max(1, Number(input.clusterBins) || 1);
    const features = [
      quantileRank(MODEL.rawVolumeQuantiles, Math.log1p(Math.max(0, Number(input.zoneVolume) || 0))),
      quantileRank(MODEL.relativeVolumeQuantiles, Math.max(0, Number(input.zoneVolumeShare) || 0)),
      clamp01(Math.abs(Number(input.imbalance) || 0) / 0.90),
      clamp01((Number(input.fpTimeShare) || 0) / 0.12),
      clamp01(3 / clusterBins),
      clamp01(Number(input.directionalVolumeShare) || 0),
      clamp01(Math.log1p(Math.max(0, Number(input.directionalVsGate) || 0)) / Math.log(6)),
      clamp01(Number(input.bodyFraction) || 0),
      clamp01((Number(input.rangeAtr) || 0) / 3),
      input.originZone === true ? 1 : 0,
      input.fallbackZone === true ? 1 : 0,
      input.direction === "long" ? 1 : 0
    ];
    let logit = MODEL.intercept;
    for (let index = 0; index < features.length; index += 1) {
      const standardized = (features[index] - MODEL.featureMean[index]) / MODEL.featureStd[index];
      logit += standardized * MODEL.coefficients[index];
    }
    return Math.round(quantileRank(MODEL.logitQuantiles, logit) * 100);
  }

  // Partition unique du score d'importance 0-100 en paliers d'affichage.
  // Source de verite pour app.js (comptage) et poi-overlay.js (filtrage/rendu) :
  // une seule table ordonnee d'ou derivent les identifiants et la classification.
  const SCORE_BUCKETS_TABLE = Object.freeze([
    Object.freeze({ id: "s0_34", maxExclusive: 35 }),
    Object.freeze({ id: "s35_49", maxExclusive: 50 }),
    Object.freeze({ id: "s50_69", maxExclusive: 70 }),
    Object.freeze({ id: "s70_79", maxExclusive: 80 }),
    Object.freeze({ id: "s80_plus", maxExclusive: Infinity })
  ]);
  const SCORE_BUCKET_IDS = Object.freeze(SCORE_BUCKETS_TABLE.map((bucket) => bucket.id));

  function scoreBucket(score) {
    const value = Math.round(Number(score) || 0);
    return (SCORE_BUCKETS_TABLE.find((bucket) => value < bucket.maxExclusive) ||
      SCORE_BUCKETS_TABLE[SCORE_BUCKETS_TABLE.length - 1]).id;
  }

  api.POI_IMPORTANCE_MODEL = MODEL;
  api.poiImportanceQuantileRank = quantileRank;
  api.computePoiImportanceScore = computePoiImportanceScore;
  api.SCORE_BUCKETS_TABLE = SCORE_BUCKETS_TABLE;
  api.SCORE_BUCKET_IDS = SCORE_BUCKET_IDS;
  api.scoreBucket = scoreBucket;
})(window);
