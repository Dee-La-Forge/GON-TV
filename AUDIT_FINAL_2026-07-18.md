# G-ON — Audit final de l'outil (18 juillet 2026, soir)

Vérification complète de bout en bout après l'ensemble du chantier. Chaque
point ci-dessous a été exécuté et constaté, pas supposé.

## 1. Intégrité statique — PASSÉE

- **Code** : 21 fichiers JS (`poi/` + `tools/`) valides (`node --check`).
- **Repo** : arbre propre, 0 commit non poussé, 33 fichiers suivis dans
  `g-on/` (app + modules + outils + archives + docs).
- **Archives** :
  - BTC : 9533 POI (182 A / 9349 T / 2 I), 0 géométrie invalide, 0 NaN,
    colonnes v2 + climax + approachAtr, frontière 18 juil. 00:00.
  - ETH : 2816 POI (61 A / 2755 T), 0 défaut, mêmes colonnes, même frontière.

## 2. Fonctionnel en navigateur — PASSÉ

- Boot BTC : 9601 POI (archive + bootstrap caché + live), statuts cohérents
  (187 A / 4438 T / 203 M / 4773 I), 789 flags climax, 8034 approachAtr,
  36 élites S≥90 (halo + liseré or + pastille).
- Contrôles intégrés à la topbar (`#gonPoiCtl` dans `#topbar`) : œil
  vivants/tous, ⚡ climax, slider S≥ — états persistés. Filigrane logo au
  premier plan (z-index 7). Versions de scripts correctes (cache-busters).
- **Bascule de symbole BTC → ETHUSDT** : archive ETH chargée (2816
  canoniques), 96 climax, prix cohérents (~1683-1690), live/bootstrap
  démarrés. Zéro erreur console sur tout le parcours.

## 3. Chaîne quant (harnais de parité, re-run frais) — SAINE avec canari

Échantillon re-tiré (la frontière ayant avancé, bougies nouvelles) :
3/5 reproductions 17/17, **4/5 scores identiques**, 2/2 sur-émissions
attendues. Le cas divergent (66 vs 68) provient d'une dérive **sub-ppm des
données source** (révision Binance entre capture WS d'origine et replay REST,
~3e-6 relatif sur zoneVolumeShare) amplifiée par la pente de la calibration
quantile — cohérent avec la distribution M1 (p99 = 2 pts sur 9400 lignes,
médiane 0). Aucune divergence de calcul. Le harnais strict (±1 pt) joue son
rôle de canari : à surveiller s'il se dégradait au fil des re-runs.

## 4. Automatisation — VALIDÉE EN PRODUCTION

La tâche planifiée « G-ON archive regen » **a tiré en réel à 17:00:00
aujourd'hui** (exit 0, « rien à combler » — idempotence constatée), prochaine
exécution armée demain 17:00. Le wrapper enchaîne désormais BTC + ETH + le
backfill approachAtr. Rattrapage automatique multi-jours si le poste est
éteint.

## 5. État de la recherche

- Score affiché : **v2** (prouvé — parité 11/11, pertinence AUC 0.564 stable,
  monotone par palier). Chantier v3 **clos proprement sur échec M3**
  (asymétrie directionnelle hors échantillon) — cf. SCORE_V3_PROTOCOL.md §9.
- Effets validés et persistés en données : climax (colonne + vue ⚡),
  profil d'approche/immédiateté (`approachAtr`, doc APPROACH_PROFILE.md).
- Fenêtres historiques propres : épuisées. Tout futur modèle se jugera sur
  l'accrual forward (alimenté automatiquement chaque jour).

## Verdict

**L'outil est complet, cohérent et opérationnel.** Données saines et
auto-entretenues sur deux marchés, moteur prouvé, affichage fidèle aux
statuts (zombies purgés), hiérarchie visuelle claire (élites or), recherche
documentée et rejouable. Points de vigilance restants : le canari de parité
(dérives de données source) et la petitesse des échantillons forward — les
deux se re-mesurent avec les outils du dossier `tools/`.
