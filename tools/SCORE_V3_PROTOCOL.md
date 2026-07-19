# Chantier SCORE V3 — Protocole (gelé avant exécution)

Date d'ouverture : 18 juillet 2026. Statut : protocole rédigé AVANT tout
entraînement — les choix ci-dessous sont verrouillés pour empêcher la
fabrication de signal par itérations (doctrine PLAN_ACTION / Bailey & López
de Prado, comme pour le v2).

## 1. Objectif et critère d'adoption

Améliorer le classement des niveaux (le rôle du score dans l'UI) en intégrant
les signaux découverts et validés depuis le v2. Le v3 remplace le v2 affiché
SEULEMENT si :
- AUC ET lift top-20% supérieurs au v2 sur la fenêtre de comparaison (§5),
  dans les deux directions ;
- confirmation sur l'accrual forward (§5, monitoring post-déploiement) ;
- sinon : v3 archivé comme expérience, v2 reste affiché.

## 2. Features candidates (fermées — pas d'ajout en cours de route)

- Les 12 features du v2 (inchangées, mêmes définitions/échelles).
- **birthDist** : |clôture de la bougie source − entryPrice| / ATR14 à la
  création. Causale, mécanisme documenté (immediate-analysis.js : monotone
  51%→72% sur 5 bandes, additive au v2 de +12-14 pts à palier égal).
- **climaxRel** : volume de la bougie source / max des 30 précédentes
  (version continue du flag climax ; résiduel mesuré +3.7 pts à S>=80).
Essais autorisés (3 seulement, sélection sur validation UNIQUEMENT) :
  T1 = v2-features (contrôle), T2 = v2+birthDist, T3 = v2+birthDist+climaxRel.

## 3. Données et reconstruction

- Population d'entraînement : **corpus strict uniquement** (générateur Antho
  v1, avant extendedFromTs) — comparabilité avec le v2. La population
  extension (détecteur live) est évaluée séparément en reporting.
- Toutes les features sont reconstructibles depuis archive + klines :
  footprint (zoneVolume, share, imbalance, fpTimeShare, clusterBins, origin,
  fallback) depuis l'archive ; contexte (directionalShare via taker volume
  row[9], directionalVsGate, bodyFraction, rangeAtr, birthDist, climaxRel)
  depuis les klines. AUCUN retraitement aggTrades nécessaire.
- Labels : recette doctrinale exacte (déjà éprouvée — contrôle accumulation
  0.488 vs 0.489 du backtest).

## 4. Porte de validité du pipeline (M1 — bloquante)

Avant tout entraînement : les features reconstruites doivent REPRODUIRE le
score v2 stocké (en réappliquant le modèle v2 gelé) à ±1 point sur ≥95% des
lignes du corpus strict. Échec = bug de reconstruction, on s'arrête.

## 5. Splits, purge, évaluation

- Train : 1 jan → 18 avr 16:15 UTC (identique v2).
- Validation (sélection des essais T1-T3 et hyperparamètres) : 18 avr → 5 juin.
- Fenêtre de comparaison v2↔v3 : 5 juin → 16 juil (l'ex-test du v2 — chaque
  modèle ne s'y évalue qu'UNE fois ; elle sert à comparer, pas à sélectionner).
- **Test final jamais touché : accrual forward à partir du 18 juil** (archives
  quotidiennes). Décision d'adoption définitive après ≥4 semaines d'accrual.
- Purge : tout label dont la fenêtre forward (13 bougies) croise une frontière
  de split est exclu (comme v2).
- Métriques : AUC (Mann-Whitney), lift top-20/top-10, par direction, stabilité
  par sous-périodes hebdomadaires.

## 6. Modèle et calibration (continuité v2)

Régression logistique L2 sur features standardisées + calibration percentile
(logitQuantiles) vers 0-100 — même famille, mêmes artefacts gelés
(featureMean/Std, coefficients, quantiles). Hyperparamètre L2 choisi sur
validation uniquement.

## 7. Déploiement (si adopté)

- Nouvel artefact gelé dans poi-score-model.js (v3) ; le v2 reste dans le
  fichier pour audit.
- Colonne d'archive additionnelle `importanceScoreV3` (le v2 n'est jamais
  écrasé — rollback trivial).
- Re-run du harnais de parité ; UI inchangée (mêmes paliers/slider — la
  calibration percentile garantit la même sémantique 0-100).

## 8. Jalons

- M1 : dataset builder + porte de reproduction v2 (§4).
- M2 : entraînement T1-T3, sélection sur validation.
- M3 : comparaison unique v2↔v3 sur 5 juin→16 juil + rapport.
- M4 : accrual forward ≥4 semaines → décision d'adoption + déploiement §7.

## 9. RÉSULTATS — chantier clos le 18 juillet 2026

- **M1 PASSÉ** : reproduction du v2 à ±1 pt sur 97.79 % des 9400 lignes
  (méd. 0). Splits purgés identiques au backtest d'origine à la ligne près
  (train 5210, valid 1726).
- **M2** : gagnant T2 (+birthDist, λ=100) — AUC valid 0.5644 vs v2 0.5585
  (+0.0059, stable sur toute la grille). T3 (+climaxRel) rejeté (redondant).
  T1 (contrôle) reproduit le v2 → le gain de T2 était bien attribuable à la
  feature.
- **M3 ÉCHEC (fenêtre 5 juin→16 juil, consommée)** : global v3 légèrement
  devant (AUC 0.5591 vs 0.5559, top10 70.2 % vs 67.4 %) MAIS asymétrique par
  direction — long : v2 devant (0.5717 vs 0.5656) ; short : v3 devant
  (0.5582 vs 0.5466). La porte exigeait les deux directions → **v3 archivé
  comme expérience, le v2 reste le score affiché.**

Lecture : le gain de validation de birthDist s'est largement évaporé hors
échantillon et s'est révélé porté par le côté short uniquement. La discipline
a joué son rôle : pas de remplacement sur un signal fragile.

Ce qui reste acquis : le pipeline complet (M1) est rejouable ; birthDist
demeure une donnée de recherche valable (immediate-analysis.js) exploitée par
la couche stratégie via `approachAtr`.

**Chemin futur si réouverture** : la fenêtre juin-juillet étant consommée,
tout v3' devra s'entraîner/sélectionner sur jan→16 juil et être jugé
EXCLUSIVEMENT sur l'accrual forward (≥4-6 semaines, population live) — aucune
autre fenêtre propre n'existe plus.
