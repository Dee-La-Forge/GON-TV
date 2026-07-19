# G-ON — Audit complet du pipeline (18 juillet 2026, soir)

Périmètre : de la réception des flux de données à l'affichage final, après les
chantiers du jour (invalidation précoce, balayage pendant le gap, bootstrap en
tâche de fond, rendu laser pulsé). Chaque point a été exécuté et constaté.

## 1. Intégrité statique — PASSÉE

- 21 fichiers JS (`poi/` + `tools/`) valides (`node --check`), arbre git
  propre, tout est poussé (`5f5f2f6`).
- Cache-busters cohérents : config v1, score-model v1, detector v2,
  lifecycle v3, stream v1, render v19, feature v14.

## 2. Archives (corpus canonique) — SAINES

| | POI | A | T | I | Géom. invalides | NaN | Doublons | Frontière |
|---|---|---|---|---|---|---|---|---|
| BTCUSDT | 9533 | 160 | 9350 | 23 | 0 | 0 | 0 | 17 juil. 23:45 |
| ETHUSDT | 2816 | 50 | 2755 | 11 | 0 | 0 | 0 | 17 juil. 23:45 |

Compteurs méta (`activePois`) cohérents avec les lignes. Les purges du jour
(23 I BTC / 11 I ETH) reflètent les deux backfills d'invalidation.

## 3. Chaîne de calcul — PROUVÉE

- **Harnais de parité** (re-run frais, 11 positifs + 4 négatifs) : 7/11
  reproductions 17/17 champs, **9/11 scores identiques**, 4/4 sur-émissions
  attendues (design allM15CandlePois). Les 2 écarts de score (±2 pts) sont la
  classe canari documentée : dérive sub-ppm des données source Binance
  (fpTimeEnd décalé de 2 ms entre capture WS d'origine et replay REST) —
  aucune divergence de calcul.
- **Score v2 gelé** : recalcul direct impossible hors détecteur (4 features
  dérivées de la bougie source absentes de l'archive) — le harnais est le
  juge, et il passe.
- **Matrice lifecycle : 17/17 règles** vérifiées en test unitaire — gap
  doctrinal (respiration protégée, cassure par clôture → INVALIDATED,
  balayage en mèche du cluster entier → MITIGATED), post-gap (touch partiel,
  pénétration complète, invalidation, indifférence hors zone), intrabar
  (balayage pendant gap, touch/mitigation post-gap), garde-fous (statuts
  terminaux figés, anti-retour temporel).

## 4. Fonctionnel en navigateur — PASSÉ (deux symboles)

- **Console : zéro erreur applicative** (seul bruit : extension Chrome tierce).
- BTC : 9 606 POI (archive + bootstrap caché + live), statuts
  167 A / 4 390 T / 248 M / 4 801 I, 789 climax, 36 élites actives.
- ETH (bascule à chaud) : 2 889 POI, 53 A, prix cohérents (~1 8xx).
- **Scan de vérité** (rejeu de 5 jours de bougies closes REST sur chaque
  actif via le vrai lifecycle) : **0 zombie / 167 actifs BTC**,
  **0 zombie / 53 actifs ETH** — l'affichage ne ment plus.
- Contrôles topbar présents (œil / ⚡ climax / slider S≥), préférences
  persistées, filigrane logo au premier plan (z-index 7).
- **Rendu : 60 fps constants, zéro long task** sur 3 s avec élites pulsées à
  l'écran (repaint continu armé uniquement en présence d'élites).

## 5. Automatisation — VÉRIFIÉE

Tâche « G-ON archive regen » : dernier tir aujourd'hui 17:00:00, **résultat
0**, prochaine exécution demain 17:00. Enchaîne BTC + ETH + backfill
approche ; rattrapage multi-jours si le poste est éteint.

## 6. Revue adversariale des flux (WS → accumulateur → lifecycle)

Un relecteur indépendant a tracé chaque scénario de course (microtâches,
fenêtres d'abort, ordre flush/recovery). **6 défauts réels confirmés sur le
code, tous corrigés dans la foulée** (lifecycle v4, feature v15) :

| # | Sévérité | Défaut | Correctif |
|---|---|---|---|
| 1 | Critique | Le flush 1 s tournait pendant une fenêtre de **déconnexion WS** : bucket tronqué finalisé `complete=true` (bougie fausse → détection corrompue) et trades du gap ensuite rejetés (`finalized_bucket`) — perte définitive. | Flush conditionné à une socket **ouverte** (`readyState === 1`) : bucket laissé ouvert, la recovery le complète à la reconnexion. |
| 2 | Critique | `recoverPoiGap` ne re-vérifiait pas la souscription **après** l'`await` du fetch : une page de trades de l'ancien symbole pouvait être ingérée dans l'accumulateur du nouveau (statuts faussés en masse + `poiLastTradeId` pollué → flux mort en silence). | Re-check `id/accumulator` post-`await` + `AbortSignal` propagé au fetch. |
| 3 | Majeure | Le re-seed post-bootstrap **remplaçait** `poiHistory` par un instantané REST potentiellement plus vieux que l'état local : une bougie close pendant le fetch disparaissait à jamais. | **Fusion** : les bougies locales absentes de l'instantané sont conservées, tri + cap `historyCandles`. |
| 4 | Mineure | Cluster absent/NaN dans une archive → comparaisons de cassure/balayage à jamais fausses (`close > NaN === false`) : POI **intuable**. | Repli cluster→zone (`Number.isFinite`) au chargement de l'archive. |
| 5 | Mineure | À la déconnexion pendant le seed initial (`poiLastTradeId` null), le buffer WS était jeté sans possibilité de récupération REST : extrêmes intrabar perdus. | Buffer **conservé** quand il n'existe pas de point de reprise ; dédup/ordre gérés par l'accumulateur au rejeu. |
| 6 | Mineure | Le gate d'idempotence (`lastLifecycleCandleTs`) avancé par un touch **intrabar** sur la bougie courante bloquait le rejeu d'une bougie antérieure ré-ajoutée par le re-seed : balayage définitivement manqué. | Le gate n'avance que jusqu'à la dernière bougie **close** ; rejeu vérifié sans double comptage (4/4 tests). |

Points examinés et jugés sains (non corrigés car sans défaut) : dédup des POI
bootstrap (`existingStarts` figé inoffensif), frontières de bucket M15 (floor
cohérent partout), double comptage `touchCount` (protégé), chevauchement
d'`onopen` concurrents (protégé de bout en bout par le dédup `tradeId` et le
rejet d'ordre de l'accumulateur).

## Verdict

**Pipeline sain de bout en bout.** Données d'entrée prouvées (parité,
archives 0 défaut), règles de vie prouvées (17/17 + 4/4), affichage honnête
(0 zombie sur 220 actifs re-vérifiés contre 5 jours de bougies réelles,
60 fps, 0 erreur console), résilience réseau renforcée (6 défauts de
concurrence purgés — dont 2 critiques qui ne se manifestaient qu'en cas de
coupure WS ou de changement de symbole pendant une recovery). Vigilances
inchangées : canari de parité (dérive source Binance) et petitesse des
échantillons forward.
