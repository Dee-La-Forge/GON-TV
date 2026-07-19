# G-ON — Audit quant profond (calculs, données, flux, fiabilité)

Date : 18 juillet 2026.
Méthode : 4 audits spécialisés indépendants (moteur footprint/détecteur, modèle de
score, flux/ingestion live, rendu/intégration) + vérifications numériques et
d'intégrité de données menées séparément. Chaque calcul a été confronté à la
référence doctrinale Python (`poi_detect.py`) et à l'artefact d'entraînement du
score (`score_backtest.py`, `poi-score-backtest.json`).

## Verdict global

**Le cœur arithmétique est juste.** Aucune erreur de formule dans le footprint
(signe du delta, volumes directionnels, agrégation par bin, frontières de
bucket), dans l'ATR de Wilder, le percentile "nearest" (Polars), ni dans le
modèle de score (ordre des 12 features prouvé correct contre 3 sources
indépendantes ; standardisation et quantileRank fidèles bit-à-bit au backtest).
Les données de l'archive (9399 POI) sont propres : 0 NaN, 0 géométrie invalide,
0 doublon, scores bien distribués.

**Un défaut de fiabilité critique a été trouvé (R1)** dans l'ingestion live, et
deux angles morts structurels demandent une décision : la parité doctrinale du
détecteur (le générateur M15 Python d'entraînement est absent du repo) et le
vieillissement des POI d'archive (invalidations ratées loin du prix).

---

## 🔴 Critique

### R1 — `flush()` périodique pendant la gap recovery → trades perdus, POI faux
`poi-feature.js` (setInterval 1s) / `footprint-m15.js` (`flush`).
Pendant `recoverPoiGap`, chaque `await fetchAggTrades` rend la main à l'event
loop ; le `setInterval` appelle `poiAccumulator.flush(Date.now())`. `flush`
compare le temps PRÉSENT au `endTs` d'un bucket PASSÉ en cours de rejeu → il le
finalise prématurément, `complete=true`. Le reste du bucket (page suivante)
tombe en `finalized_bucket` → **rejeté**. Résultat : footprint partiel marqué
complet → volume/delta faux → **POI détecté sur données fausses**, précisément
sur le chemin censé garantir la fiabilité (reprise après coupure).
**Fix** : suspendre le flush quand `poiRecovering` est vrai (ou flusher sur le
temps d'échange du dernier trade, pas l'horloge murale).

---

## 🟠 Importants

### O1 — Vieillissement de l'archive : invalidations ratées loin du prix
`poi-feature.js` (filtre par zone) vs `poi-lifecycle.js` (invalidation par
CLÔTURE au-delà du **cluster**). Le filtre "à portée de prix" saute les POI dont
la *zone* ne recoupe pas les bougies rejouées — mais l'invalidation
(`close > clusterHigh` / `< clusterLow`) agit **hors zone**. Un POI cassé peut
rester affiché `ACTIVE_UNTOUCHED` après rechargement.
**Fix** : filtrer sur les bornes de **cluster** (élargies) au lieu de la zone.

### O2 — Parité doctrinale du détecteur non prouvable (angle mort principal)
Le seul détecteur Python du repo est l'ancêtre **H4** (`poi_detect.py`). Le
générateur **M15** qui a produit les features d'entraînement du score est
absent. Le détecteur JS est plus permissif que la doctrine H4 : pas de gate
d'imbalance au niveau zone (`0.60`), seeds non restreints à la zone extrême
(fraction=1), `bins>=3` non appliqué, Règle d'Or sur la clôture (seuil 0.65
lâche) au lieu du POC, zone = bande proximale (10$) vs cluster complet. Ce sont
des choix M15 assumés (`allM15CandlePois`) — MAIS ils ne sont **pas prouvés
identiques** à ce qui a entraîné le score.
**Fix** : golden test de parité — recomputer les 12 features JS vs le pipeline
Python M15 sur un échantillon commun ; et acter par écrit les divergences
voulues (imbalance-zone, seuil 0.65, bins>=3).

### O3 — Backoff neutralisé après connexion : reset dans `onopen`
`poiAttempt = 0` en tête d'`onopen`, AVANT seed/recovery. Si la recovery échoue
en boucle, chaque reconnexion repart à ~1s → martèlement de Binance sans montée
en backoff. **Fix** : reset après le catch-up complet.

### O4 — Handlers de socket obsolètes non gardés par `id`
`onmessage`/`onerror` ne testent pas `id !== poiSubscription`. Au changement de
symbole, un trade de l'ancien symbole peut être ingéré dans l'accumulateur du
nouveau (POI au mauvais prix), ou la nouvelle socket fermée par erreur.
**Fix** : capturer `id` et garder les 4 handlers.

### O5 — Flush sur horloge murale : tail de bougie sous-compté
Un trade `T < endTs` livré avec latence après le flush est rejeté
(`finalized_bucket`). Sous-comptage léger et systématique de fin de bougie.
**Fix** : fenêtre de grâce (~1-2s) ou flush sur temps d'échange.

### O6 — Rendu : cull-prix déborde dans l'axe temps + pas de clip vertical
La sonde basse `coordinateToPrice(hauteur totale)` tombe dans la bande de l'axe
temps → bande de prix trop large (faux positifs ~3%), et le canvas POI n'est
pas clippé au pane → en forte densité, niveaux/labels peuvent se peindre sur
les libellés de l'axe temps. **Fix** : borner à `hauteur - ts().height()` et
clipper comme l'overlay natif de G-Bot.

### O7 — ATR : warmup tronqué à 56 bougies
`wilderAtr` seed sur 56 barres vs EWM pleine série côté Python. Écart résiduel
(~1.6%) mais `range_atr` porte le plus gros coefficient du score (0.109) →
peut décaler un score de ±1 rang. **Fix** : élargir aux 192 bougies dispo.

---

## 🟡 Mineurs (liste consolidée)

- Sentinelle `retestTs=0` sur les 544 POI actifs de l'archive (ignorée par le
  loader — bénin, mais piège si un chemin futur la lit comme date).
- Gap > 50 000 trades : recovery par paliers de 50 pages avec churn de socket
  (progresse, ne bloque pas).
- Bougie bootstrap > 40 pages abandonnée (pas de POI bootstrap pour elle).
- `updatePoiList` : O(9399) par bougie fermée (canoniques jamais plafonnés) —
  perf, pas justesse.
- Double `normalizeAggTrade` par trade (perf).
- Rendu : `??` ne capte pas NaN (`entryPrice` NaN → POI écarté silencieusement
  du declutter), tri par `score` non-fini indéterminé, chips morts centrés non
  anti-chevauchés, prix de declutter ≠ prix dessiné pour un short sans entry,
  DPR seul non re-dimensionné (flou), duplication des modules avec Biquette (à
  garder synchronisés).
- Détecteur : séparation min de clusters non appliquée à l'extension, asymétrie
  `orderedBins` à range nul, configs mortes (`minDirectionalVolumeShare`,
  `minFootprintBins`), `|| directionalVolume || 1` masque un gate nul légitime,
  divisions sûres par invariant seulement (non documenté).
- Modèle : pas de garde `std==0` runtime (non atteignable avec les std gelés),
  epsilon `Number.EPSILON` vs `1e-9` du backtest (non atteignable).

## Vérifications numériques (modèle de score)

- Déterministe ; borné [0,100] sur des entrées extrêmes ; entrées NaN → 0 sans
  crash. Config d'entrée conforme à l'entraînement (P55, timeframeMs 900000).
- Note : le score DÉCROÎT quand l'imbalance croît (coefficient −0.038). C'est
  le modèle entraîné (régularisation L2, cf. backtest), pas un bug — mais c'est
  contre-intuitif pour un trader : à documenter dans l'UI/doc.

## Plan de correction priorisé — statut

1. **R1** — flush suspendu pendant la recovery + grâce 2s (couvre aussi O5).
   ✅ CORRIGÉ (poi-feature.js, setInterval).
2. **O1** — vieillissement : rejoue aussi les POI invalidables par clôture
   au-delà du cluster (pas seulement les touchables par zone).
   ✅ CORRIGÉ — vérifié en live : 0 short actif résiduel sous le prix.
3. **O4** — socket capturée localement, tous les handlers gardés par `id`.
   ✅ CORRIGÉ.
4. **O3** — reset du backoff déplacé après le catch-up complet. ✅ CORRIGÉ.
5. **O6** — sonde de prix bornée au pane + clip du canvas au pane + colonne
   d'étiquettes bornée au pane. ✅ CORRIGÉ.
6. **O7** — warmup ATR sur tout l'historique fourni (192 M15). ✅ CORRIGÉ.
   Note : la copie Biquette de poi-detector.js diverge désormais (à resynchro).
7. **O2** — harnais de parité détecteur JS ↔ générateur M15. ✅ FERMÉ.
   Le générateur Python est perdu mais son output (l'archive) sert de golden
   dataset : `tools/parity-harness.js` re-télécharge les aggTrades bruts des
   bougies sources, reconstruit le footprint, exécute le détecteur JS et
   compare 17 champs contre la ligne d'archive. Résultat (échantillon
   déterministe, seed 42017, 11 positifs dont 3 anciens + 4 négatifs) :
   - 9/11 reproductions EXACTES (17/17 champs, y compris février/avril —
     l'historique REST Binance est rejouable en profondeur) ;
   - **importanceScore identique 11/11** — la chaîne features → modèle est
     fidèle au générateur d'entraînement ;
   - les 2 écarts résiduels sont des différences de données en bord de
     fenêtre (80 ms sur un timestamp de trade, ~6e-6 relatif sur un ratio),
     sans aucun effet sur les scores ;
   - sur-émission confirmée 4/4 sur les négatifs (design `allM15CandlePois`,
     le live émet là où le générateur n'émettait pas ; scores souvent bas
     mais pas toujours — un S70 observé). À garder en tête pour la
     validation forward.
8. 🟡 — documentés ci-dessus, au fil de l'eau. ⏳ OUVERTS.

Validation post-correctifs : node --check OK sur les 3 fichiers modifiés ;
rechargement live : 9411 POI, statuts cohérents (215 A / 3867 T / 444 M /
4885 I), zéro erreur console.

## Réflexion sur la cohérence du raisonnement d'ensemble

- **Architecture à deux régimes** (archive figée + moteur live causal après le
  cutoff) : cohérente et bien étanchéifiée (ids, cutoff, lifecycleValidAfterTs).
  Sa limite assumée : la fraîcheur de l'archive (trou entre l'export et la
  fenêtre bootstrap de 23h) — à traiter par régénération périodique
  (poi_detect.py / Binance Vision), pas par du code navigateur.
- **Sémantique du score** : rang d'importance relatif 0-100, PAS une
  probabilité de gain (AUC test 0.557). Le coefficient NÉGATIF de l'imbalance
  est contre-intuitif mais est bien le modèle entraîné/régularisé. À afficher
  tel quel, sans sur-interprétation ; l'edge mesuré reste sous le seuil GO du
  PLAN_ACTION.
- **Détecteur M15 permissif par design** (`allM15CandlePois`) vs doctrine H4
  stricte : ce choix multiplie les POI de faible qualité (médiane de score 51,
  un tiers < 35) et reporte la sélectivité sur le score + les filtres UI.
  C'est défendable, mais il faut l'acter : la Règle d'Or originelle n'est plus
  un GATE, elle est devenue une FEATURE du score. Toute validation forward
  doit en tenir compte.
- **Le risque épistémique n°1 reste O2** : sans le générateur M15
  d'entraînement, la fidélité détecteur→score repose sur la parité documentée
  Biquette (96.8% origin) mais n'est pas re-prouvable ici. Le harnais de
  parité est le prochain investissement structurel utile.
