# Audit calcul des niveaux & scoring — 2026-07-23

4 auditeurs parallèles (détection, scoring, fidélité pipeline, statistique), auto-réfutation
obligatoire, toute affirmation prouvée sur pièce (fichier:ligne) ou par script node sur
l'archive réelle (44 861 POI BTCUSDT : 35 040 backfill 2025 + 9 354 canonique 2026 + 467
extension JS). Reproduction indépendante de la formule de score : 100 % sur 2025,
97,79 % sur le canonique (= porte M1 du protocole v3).

## Verdict en une phrase

Le CALCUL est fidèle et propre (un seul détecteur partagé par tous les chemins, zéro bug
de calcul prouvé, base techniquement saine) ; les vrais problèmes sont ARCHITECTURAUX :
un corpus qui colle deux régimes d'émission incompatibles, et un score juste en
ORDRE mais non stationnaire en NIVEAU — le seuil FORT≥80 ne désigne pas la même
population selon l'époque.

## ⚖️ DOCTRINE D'USAGE DU SCORE (D3 — gravée, ratifiée par Meddy le 2026-07-23)

> **Le score TRIE, il n'autorise pas.**
>
> Il classe les niveaux par probabilité de RÉACTION au retest (les ≥80 réagissent à
> 63-64 % contre 54 % de base — vérifié sur 2025 ET 2026). Il ne prédit NI le gain
> d'un trade (AUC 0,518 ≈ hasard) NI la survie d'un niveau (T vs I). Il sert à choisir
> QUELS niveaux regarder, jamais à décider DE trader — la décision reste la lecture
> (biais, structure, contexte). Ne jamais présenter un winrate comme une propriété du
> score. Gravé dans l'UI : tooltip du slider de score (poi-feature v46).

## 🔴 Prouvé

1. **« 1 POI par bougie M15 » est un choix de conception, pas un bug** — flag
   `allM15CandlePois: true` (poi-config.js:29) + cascade fallback→forcé qui ne peut pas
   échouer (poi-detector.js:146-169) + `keepOneExtremePoiPerCandle`. Le « détecteur » est
   un générateur de candidats + extracteur de features ; la sélection vit dans le score
   (le modèle connaît originZone/fallbackZone et écrase les bougies plates : doji→9,
   forcée→24). 33 assertions node vertes.
2. **Corpus chimérique** — le générateur canonique Antho v1 était SÉLECTIF (médiane
   49 POI/jour, jamais 96 en 196 jours) ; le détecteur JS SATURE (96/96, 365/365 jours en
   2025, idem extension 2026-07-17+, idem ETH). Saut mesuré à la couture arrière :
   96 → 7 POI/jour entre le 31-12-2025 et le 01-01-2026. 79 % du fichier relève du régime
   saturé. Toute statistique qui mélange les provenances est contaminée.
3. **« Parité prouvée » sur-vendue** — parity-harness.js ne prouve que la parité
   CONDITIONNELLE (même zone/score quand le canonique émettait, n=11 bougies) ; la
   sur-émission est explicitement « informative, pas un échec » (parity-harness.js:13-15,
   232). Les notes d'archive (regen-archive.js:322, extend-archive-past.js, méta) omettent
   la réserve. Le canari devient CIRCULAIRE (les pools d'échantillonnage sont désormais
   ~80-100 % des lignes JS) et parity-report.json est gitignoré (aucune preuve rejouable).
4. **Le score n'est pas stationnaire en NIVEAU** — importanceScore = régression
   logistique gelée dominée par f8 rangeAtr (+0.109) et f7 bodyFraction (+0.098), puis
   calibration PERCENTILE gelée sur la population jan-avr 2026 (logitQuantiles,
   poi-score-model.js:61). Attribution exacte de l'écart 2025 (p50 42) vs canonique
   (p50 51) : f8 = −0.0447 sur −0.0411 logit (109 %) — régime de volatilité, pas bug.
   Le p50 mensuel canonique oscille lui-même de 44 à 59. Conséquence : FORT≥80
   sélectionne 13-14 % des POI en régime calme, 21-28 % en régime volatil.
5. **Ce que le score prédit — et ne prédit pas** :
   - ✅ il ORDONNE la réaction au retest (label doctrinal ±1 ATR) : AUC 0.553-0.564,
     S80+ hit 63-64 % vs base ~54 %, monotone, ET TRANSFÈRE à 2025 hors époque
     (63,7 % ≡ canonique) — « il trie, il n'autorise pas » (SCORE_RELEVANCE.md confirmé).
   - ❌ il ne prédit PAS le win strict (+1 % avant SL 0,15 %) : AUC 0.518, winrate 14,4 %
     ≈ baseline aléatoire 13,0 % (= SL/(SL+TP)), déciles non monotones, aucune covariable
     ne sépare (imbalance, climax, accumulation, origin, direction).
   - ❌ il n'ordonne pas T vs I (AUC 0.475), et l'effet du seuil 80 sur l'invalidation
     S'INVERSE selon la provenance (JS2025 z=−6,8 vs canonique z=+2,4).

## 🟠 À trancher / surveiller

- Clés de config MORTES : `minDirectionalVolumeShare`, `minFootprintBins` déclarées,
  validées, jamais appliquées (piège de tuning).
- Doji parfait → direction "long" codée en dur (poi-detector.js:32) ; 62 POI à imbalance
  de signe contraire à la direction (57 en 2025, 0 en canonique) — bougies minces.
- climax : 2 sources de calcul (backfill-climax klines vs copie JS aggTrades), champ non
  couvert par le harnais ; 4,1 % (2025) vs 8,3 % (canonique) = effet de sélection.
- strategyScore : null sur 100 % des lignes JS = encode la provenance, MAIS le loader
  aplatit (`Number(null)=0`, provenance:"antho_v1_canonical" pour tout) — le runtime ne
  peut plus distinguer les régimes.
- Le score d'« importance » est un score d'ANATOMIE DE BOUGIE : coefficients volume ≈ 0,
  corrélation score↔zoneVolumeShare NÉGATIVE (−0,3). Des scores 90+ portés par des
  footprints de 0,4-1,4 s / 7 BTC ; des ≤15 avec 10× plus de volume. Entraîné ainsi
  (légitime), mais le nom trompe.
- win jamais jugé sur les alts (ETH 0/54 336), couverture win = 9,7 % du fichier (BTC 2026
  seulement) ; 3 conventions de sentinelles dans le même fichier (retestTs 0 vs null,
  approachAtr −1, win −1).
- fpTimeShare = enveloppe temporelle (last−first), pas temps actif ; gate directionnelle
  dégénère silencieusement si l'historique perd longVolume (dormant) ; 2 tables binSize à
  synchroniser à la main.

## 🟢 Vérifié sain (ne pas re-chasser)

Accumulation bins/priceBin/epsilon ; cluster aux bords de bins exacts ; zone adjacente
10 $ par construction (jamais inversée, 0 doublon createdTs, unicité par bougie) ;
imbalance∈[−1,1] ; fpTime dans la bougie ; availableAt=createdTs+TF partout, garde
anti-lookahead fail-closed ; graine fapi bins:[] SANS effet (bins d'historique jamais lus ;
longVolume klines ≡ footprint par construction) ; warmup ATR complet (192) ; les 3 chemins
JS (regen/extend/live) chargent physiquement les mêmes modules, blocs identiques ligne à
ligne ; loader id round-trip exact ; chantier v3 mené proprement (porte bidirectionnelle
respectée, candidat archivé, v2 conservé à raison).

## Décisions proposées (à Meddy)

- **D1 Corpus** : (a) régénérer 2026-01→07 au détecteur JS → archive 100 % homogène
  (96/j partout, ~+9 000 lignes, perd le corpus canonique en ligne — il reste dans git) ;
  (b) garder l'assemblage mais EXPOSER la provenance au runtime (un booléen au chargement,
  strategyScore≠null) et l'utiliser dans les stats ; (c) statu quo documenté.
- **D2 Score** : stationnariser le NIVEAU (recalibration glissante des logitQuantiles ou
  rang trailing de f8) pour que FORT≥80 désigne la même « part » à toute époque — le
  pouvoir d'ordonnancement, lui, n'a pas besoin d'être retouché.
- **D3 UI/doctrine** : graver que le score TRIE la réaction au retest mais n'est ni une
  proba de win ni un prédicteur de survie (T/I) ; ne jamais afficher un winrate issu des
  2 938 verdicts comme une propriété du score.
- **D4 Hygiène (sûrs, sans effet de données)** : documenter/supprimer les clés de config
  mortes ; unifier les sentinelles à l'écriture future ; dé-gitignorer parity-report.json ;
  corriger les notes « parité prouvée » → « parité conditionnelle (zones/scores), taux
  d'émission par conception ».

## Appliqué (même jour)

- **D1 (commit 4837ebd)** : fenêtre canonique 2026-01→07 régénérée au détecteur JS
  (9 399 → 18 874 lignes) — 566 jours à exactement 96 POI/jour, plus de couture ;
  verdicts win étendus à toute l'archive (28 266) ; sentinelles retestTs=0 disparues.
- **D2 (commit 85148ca)** : score affiché = percentile GLISSANT 90 j (chargeur
  poi-feature v45, histogramme 101 cases O(n), live calibré par la fenêtre de queue,
  brut dans scoreRaw, archive disque inchangée). Mesuré : FORT≥80 = 18,8-22,1 % par
  trimestre sur 2025-2026 (contre 13-16,5 % errant en brut), ordre local 99,9 %.
- **D4 (commit 85148ca)** : clés mortes documentées, parity-report dé-gitignoré,
  libellés « parité prouvée » corrigés partout, note regen ne clobbe plus D1.
- **D3 (commit qui suit)** : doctrine gravée en tête de ce doc + tooltip du slider de
  score dans l'app (poi-feature v46) — « Le score trie, il n'autorise pas ».
- **Restent ouverts** : 🟠 doji→long, gate directionnelle fragile, fpTimeShare mal
  nommé, win jamais jugé sur les alts.
