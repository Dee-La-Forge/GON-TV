"use strict";

/* SCORE V3 — Jalon M2 : entrainement des 3 essais + selection sur VALIDATION.
 * Cf. SCORE_V3_PROTOCOL.md. La fenetre "compare" n'est PAS touchee (M3).
 *  - T1 : 12 features v2 (controle)  - T2 : +birthDist  - T3 : +birthDist+climaxRel
 *  - Regression logistique L2 (IRLS), standardisation et quantiles de
 *    reference calcules sur TRAIN uniquement ; lambda choisi sur validation.
 *  - Transformations GELEES des nouvelles features :
 *      birthDistT = clamp01(birthDist / 3)
 *      climaxRelT = clamp01(log1p(climaxRel) / log(6))
 *  - Sortie : tableau essais x lambda (AUC valid), gagnant, artefact candidat
 *    tools/v3-model-candidate.json (non deploye).
 * Lancer : node g-on/tools/v3-m2-train.js   (local, aucun reseau)
 */

const fs = require("fs");
const path = require("path");

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
function quantileRank(knots, value) {
  const x = Number(value);
  if (!Number.isFinite(x) || !knots.length) return 0;
  if (x <= knots[0]) return 0;
  if (x >= knots[knots.length - 1]) return 1;
  let lo = 0, hi = knots.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (knots[m] <= x) lo = m; else hi = m; }
  const w = knots[hi] - knots[lo];
  return clamp01((lo + (w > 1e-12 ? (x - knots[lo]) / w : 0)) / (knots.length - 1));
}
function quantiles21(values) {
  const s = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k <= 20; k++) out.push(s[Math.min(s.length - 1, Math.round(k / 20 * (s.length - 1)))]);
  return out;
}
function auc(pos, neg) {
  const all = pos.map((s) => [s, 1]).concat(neg.map((s) => [s, 0]));
  all.sort((a, b) => a[0] - b[0]);
  let i = 0, rankSum = 0;
  while (i < all.length) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (all[k][1] === 1) rankSum += avg;
    i = j;
  }
  const n1 = pos.length, n0 = neg.length;
  return n1 && n0 ? (rankSum - n1 * (n1 + 1) / 2) / (n1 * n0) : NaN;
}
// Resolution d'un systeme lineaire (Gauss, pivot partiel) — d <= 16.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat(b[i]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) M[c][c] = 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}
// Logistique L2 par IRLS. X: lignes standardisees SANS intercept.
function trainLogistic(X, y, lambda) {
  const n = X.length, d = X[0].length;
  let w = new Array(d + 1).fill(0);   // [intercept, ...coefs]
  for (let iter = 0; iter < 50; iter++) {
    const A = Array.from({ length: d + 1 }, () => new Array(d + 1).fill(0));
    const g = new Array(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      let z = w[0];
      for (let j = 0; j < d; j++) z += w[j + 1] * X[i][j];
      const p = 1 / (1 + Math.exp(-z));
      const s = Math.max(p * (1 - p), 1e-6);
      const r = y[i] - p;
      const xi = [1, ...X[i]];
      for (let a = 0; a <= d; a++) {
        g[a] += r * xi[a];
        for (let b = a; b <= d; b++) A[a][b] += s * xi[a] * xi[b];
      }
    }
    for (let a = 0; a <= d; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    for (let j = 1; j <= d; j++) { A[j][j] += lambda; g[j] -= lambda * w[j]; }  // L2 hors intercept
    const delta = solve(A, g);
    let move = 0;
    for (let a = 0; a <= d; a++) { w[a] += delta[a]; move = Math.max(move, Math.abs(delta[a])); }
    if (move < 1e-8) break;
  }
  return w;
}

(async () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "v3-dataset.json"), "utf8"));
  const rows = data.rows.filter((r) => r.y != null);
  const train = rows.filter((r) => r.split === "train");
  const valid = rows.filter((r) => r.split === "valid");
  console.log(`train n=${train.length}, valid n=${valid.length} (compare NON touche)`);

  // Quantiles de reference (TRAIN uniquement) pour les rangs de volume
  const rawVolQ = quantiles21(train.map((r) => Math.log1p(Math.max(0, r.input.zoneVolume))));
  const relVolQ = quantiles21(train.map((r) => Math.max(0, r.input.zoneVolumeShare)));

  const FEATURES = {
    raw_volume_rank: (r) => quantileRank(rawVolQ, Math.log1p(Math.max(0, r.input.zoneVolume))),
    relative_volume_rank: (r) => quantileRank(relVolQ, Math.max(0, r.input.zoneVolumeShare)),
    absolute_imbalance: (r) => clamp01(Math.abs(r.input.imbalance) / 0.90),
    footprint_time: (r) => clamp01(r.input.fpTimeShare / 0.12),
    compactness: (r) => clamp01(3 / Math.max(1, r.input.clusterBins)),
    directional_share: (r) => clamp01(r.input.directionalVolumeShare),
    directional_vs_gate: (r) => clamp01(Math.log1p(Math.max(0, r.input.directionalVsGate)) / Math.log(6)),
    body_fraction: (r) => clamp01(r.input.bodyFraction),
    range_atr: (r) => clamp01(r.input.rangeAtr / 3),
    origin_zone: (r) => r.input.originZone ? 1 : 0,
    fallback_zone: (r) => r.input.fallbackZone ? 1 : 0,
    direction_long: (r) => r.input.direction === "long" ? 1 : 0,
    birth_dist: (r) => clamp01((r.birthDist ?? 0) / 3),
    climax_rel: (r) => clamp01(Math.log1p(Math.max(0, r.climaxRel ?? 0)) / Math.log(6))
  };
  const V2 = ["raw_volume_rank", "relative_volume_rank", "absolute_imbalance", "footprint_time",
    "compactness", "directional_share", "directional_vs_gate", "body_fraction", "range_atr",
    "origin_zone", "fallback_zone", "direction_long"];
  const TRIALS = {
    T1_v2: V2,
    T2_birthDist: V2.concat(["birth_dist"]),
    T3_birth_climax: V2.concat(["birth_dist", "climax_rel"])
  };
  const LAMBDAS = [0.3, 1, 3, 10, 30, 100];

  const matrix = (rs, names) => rs.map((r) => names.map((f) => FEATURES[f](r)));
  const standardize = (Xtr) => {
    const d = Xtr[0].length, mean = new Array(d).fill(0), std = new Array(d).fill(0);
    for (const x of Xtr) for (let j = 0; j < d; j++) mean[j] += x[j];
    for (let j = 0; j < d; j++) mean[j] /= Xtr.length;
    for (const x of Xtr) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2;
    for (let j = 0; j < d; j++) { std[j] = Math.sqrt(std[j] / Xtr.length); if (std[j] < 1e-9) std[j] = 1; }
    return { mean, std, apply: (X) => X.map((x) => x.map((v, j) => (v - mean[j]) / std[j])) };
  };
  const logits = (Xs, w) => Xs.map((x) => x.reduce((z, v, j) => z + w[j + 1] * v, w[0]));
  const evalAuc = (scores, rs) => auc(scores.filter((_, i) => rs[i].y), scores.filter((_, i) => !rs[i].y));
  const top20 = (scores, rs) => {
    const idx = scores.map((s, i) => [s, rs[i].y]).sort((a, b) => b[0] - a[0]);
    const n = Math.floor(idx.length * 0.2);
    return idx.slice(0, n).filter(([, y]) => y).length / n;
  };

  // Reference : le score v2 STOCKE sur la validation
  const v2AucValid = evalAuc(valid.map((r) => r.stored), valid);
  const v2Top20 = top20(valid.map((r) => r.stored), valid);
  const baseValid = valid.filter((r) => r.y).length / valid.length;
  console.log(`\nReference v2 (stocke) sur valid: AUC=${v2AucValid.toFixed(4)} top20=${(100 * v2Top20).toFixed(1)}% (base ${(100 * baseValid).toFixed(1)}%)`);

  console.log("\n=== SELECTION (AUC validation) ===");
  let best = null;
  const yTr = train.map((r) => r.y ? 1 : 0);
  for (const [trial, names] of Object.entries(TRIALS)) {
    const S = standardize(matrix(train, names));
    const XsTr = S.apply(matrix(train, names));
    const XsVa = S.apply(matrix(valid, names));
    const line = [];
    for (const lambda of LAMBDAS) {
      const w = trainLogistic(XsTr, yTr, lambda);
      const a = evalAuc(logits(XsVa, w), valid);
      line.push(`λ${lambda}:${a.toFixed(4)}`);
      if (!best || a > best.auc) best = { trial, lambda, auc: a, w, names, S, XsTr };
    }
    console.log(`  ${trial.padEnd(16)} ${line.join("  ")}`);
  }

  const XsVaBest = best.S.apply(matrix(valid, best.names));
  const vaScores = logits(XsVaBest, best.w);
  console.log(`\nGAGNANT: ${best.trial} λ=${best.lambda} — AUC valid ${best.auc.toFixed(4)} (v2: ${v2AucValid.toFixed(4)}, delta ${(best.auc - v2AucValid >= 0 ? "+" : "")}${(best.auc - v2AucValid).toFixed(4)})`);
  console.log(`top20 valid: ${(100 * top20(vaScores, valid)).toFixed(1)}% (v2: ${(100 * v2Top20).toFixed(1)}%)`);

  // Calibration percentile (train) + artefact candidat
  const trLogits = logits(best.XsTr, best.w);
  const artifact = {
    version: "poi-importance-v3-candidate",
    trainedAt: new Date().toISOString(),
    trial: best.trial, lambda: best.lambda,
    featureNames: best.names,
    featureMean: best.S.mean, featureStd: best.S.std,
    intercept: best.w[0], coefficients: best.w.slice(1),
    rawVolumeQuantiles: rawVolQ, relativeVolumeQuantiles: relVolQ,
    logitQuantiles: quantiles21(trLogits),
    validation: { auc: best.auc, v2Auc: v2AucValid, top20: top20(vaScores, valid), v2Top20 }
  };
  fs.writeFileSync(path.join(__dirname, "v3-model-candidate.json"), JSON.stringify(artifact, null, 2), "utf8");
  console.log("\nArtefact candidat: tools/v3-model-candidate.json (NON deploye — M3 ensuite)");
})().catch((e) => { console.error("ECHEC:", e.message); process.exit(1); });
