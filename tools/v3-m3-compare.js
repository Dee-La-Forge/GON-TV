"use strict";

/* SCORE V3 — Jalon M3 : COMPARAISON UNIQUE v2 <-> v3-candidat sur la fenetre
 * 5 juin -> 16 juil (ex-test du v2). Cette fenetre est CONSOMMEE par ce run,
 * quel que soit le resultat (protocole §5). Aucune selection ici : le candidat
 * est fige (v3-model-candidate.json), on ne fait que mesurer.
 * Lancer : node g-on/tools/v3-m3-compare.js   (local, aucun reseau)
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

const data = JSON.parse(fs.readFileSync(path.join(__dirname, "v3-dataset.json"), "utf8"));
const M = JSON.parse(fs.readFileSync(path.join(__dirname, "v3-model-candidate.json"), "utf8"));

const FEATURES = {
  raw_volume_rank: (r) => quantileRank(M.rawVolumeQuantiles, Math.log1p(Math.max(0, r.input.zoneVolume))),
  relative_volume_rank: (r) => quantileRank(M.relativeVolumeQuantiles, Math.max(0, r.input.zoneVolumeShare)),
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
function v3Logit(r) {
  let z = M.intercept;
  M.featureNames.forEach((f, j) => {
    z += M.coefficients[j] * ((FEATURES[f](r) - M.featureMean[j]) / M.featureStd[j]);
  });
  return z;
}

const rows = data.rows.filter((r) => r.split === "compare" && r.y != null);
const stats = (scores, rs) => {
  const a = auc(scores.filter((_, i) => rs[i].y), scores.filter((_, i) => !rs[i].y));
  const idx = scores.map((s, i) => [s, rs[i].y]).sort((x, y) => y[0] - x[0]);
  const t = (f) => { const n = Math.max(1, Math.floor(idx.length * f)); return idx.slice(0, n).filter(([, y]) => y).length / n; };
  return { auc: a, top20: t(0.2), top10: t(0.1) };
};
const pct = (x) => (100 * x).toFixed(1) + "%";

console.log(`=== M3 — COMPARAISON UNIQUE (fenetre 5 juin -> 16 juil, consommee par ce run) ===`);
console.log(`n=${rows.length}, base=${pct(rows.filter((r) => r.y).length / rows.length)}\n`);
const v2 = stats(rows.map((r) => r.stored), rows);
const v3 = stats(rows.map((r) => v3Logit(r)), rows);
console.log(`v2 (stocke)     : AUC=${v2.auc.toFixed(4)}  top20=${pct(v2.top20)}  top10=${pct(v2.top10)}`);
console.log(`v3 (candidat)   : AUC=${v3.auc.toFixed(4)}  top20=${pct(v3.top20)}  top10=${pct(v3.top10)}`);
console.log(`delta           : AUC ${(v3.auc - v2.auc >= 0 ? "+" : "")}${(v3.auc - v2.auc).toFixed(4)}  top20 ${(100 * (v3.top20 - v2.top20)).toFixed(1)} pts\n`);

let gates = 0;
for (const d of ["long", "short"]) {
  const rs = rows.filter((r) => r.direction === d);
  const a2 = stats(rs.map((r) => r.stored), rs);
  const a3 = stats(rs.map((r) => v3Logit(r)), rs);
  const ok = a3.auc > a2.auc;
  if (ok) gates++;
  console.log(`${d.padEnd(6)}: v2 AUC=${a2.auc.toFixed(4)} | v3 AUC=${a3.auc.toFixed(4)} ${ok ? "(v3 devant)" : "(v2 devant)"}`);
}
const pass = v3.auc > v2.auc && v3.top20 > v2.top20 && gates === 2;
console.log(`\nVERDICT M3: ${pass ? "PASSE — v3 devant sur AUC, top20 et les 2 directions -> GO M4 (accrual forward)" : "ECHEC — v3 archive comme experience, v2 reste affiche"}`);
process.exit(pass ? 0 : 1);
