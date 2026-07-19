# G-ON — Audit final avec le POI provisoire (18 juillet 2026, soir)

Audit complet de l'application incluant la nouvelle feature « POI provisoire
sur la bougie M15 ouverte ». Chaque point exécuté et constaté.

## 1. Conformité à la spécification du provisoire — VÉRIFIÉE EN RÉEL

| Exigence | Preuve |
|---|---|
| Même source/timestamps que le chart (WS aggTrade, buckets UTC, zéro serveur) | Accumulateur M15 existant ; amorce REST du bucket ouvert sur son premier trade |
| Mêmes règles de détection et de score que les définitifs | `B.detectPoi` + score v2 gelé + décoration climax sur instantané immuable — **provisoire 20:15 ETH = `1,859 S71` et définitif calculé à la clôture = `1,859 S71`, valeurs identiques** |
| Zéro lookahead | L'instantané ne contient que des trades reçus ; seules les gardes anti-bougie-ouverte sont levées sur la copie |
| Recalcul ≤ 750 ms, slot unique remplacé | Throttle interne + slot unique constaté stable sur re-queries |
| Jamais touché par sa propre bougie | Jamais inséré dans `pois` — vérifié `provisoire_dans_pois: false` |
| Clôture au premier aggTrade du bucket suivant | **3 clôtures observées en réel** : BTC 19:00 (provisoire S41 supprimé, footprint complète le refuse — abandon honnête), BTC 19:15 (S4 → définitif S4 identique), ETH 20:30 (S71 → définitif S71 identique) |
| Vert long / rouge short, bande translucide pointillée, `P·S<score>` | Constaté à l'écran sur les deux symboles |
| Multi-symbole | ETH : bins 1 $ automatiques, switch propre (destruction + ré-amorce) |

## 2. Revue adversariale du code provisoire — 6 défauts corrigés

| Sévérité | Défaut | Correctif |
|---|---|---|
| Critique | `fullySeeded` pouvait promouvoir `complete=true` une footprint **tronquée** (socket silencieusement morte : veille, TCP half-open — `readyState` reste 1) → définitif faux + historique empoisonné + recovery rejetée | Garde de **fraîcheur du flux** : le flush exige un message reçu depuis < 10 s, plus seulement `readyState===1` |
| Majeure | Provisoire calculé pendant une recovery (buckets passés à moitié rejoués affichés « en formation ») | `refreshPoiProvisional` refuse pendant recovery + n'accepte que le bucket **horloge** courant |
| Majeure | Amorce ancrée sur le bucket horloge, pas sur le bucket du trade retourné (course de frontière → couverture réelle jamais flaggée) | Ancre sur le bucket du **trade effectivement retourné** |
| Majeure | Continuation `onopen` d'une socket remplacée survivait : recoveries concurrentes (rafale de requêtes → risque 429), buffer volé, backoff annulé | Identité de socket (`current()`) re-vérifiée après chaque `await`, propagée dans `recoverPoiGap` |
| Mineure | Provisoire périmé affiché pendant une déconnexion (données gelées) | L'intervalle détruit le slot quand le flux est mort/en recovery |
| Mineure | Chip `P·S` fantôme clampé au bord quand l'entrée sort de l'échelle de prix | Aucun dessin hors échelle |

Le zombie ETH `1,859 S4` découvert par le scan (extrêmes intrabar antérieurs à
l'ajout bootstrap, réconciliation en course avec la recovery) est corrigé par
un **double rattrapage** : à l'ajout de chaque POI bootstrap + après la
recovery — toute entrelacement converge. Vérifié : MITIGATED après reload.

## 3. Incident observé en direct — le scénario critique s'est produit

Pendant l'audit, la socket aggTrade est passée **OPEN mais muette** (zéro
message, REST parfaitement fonctionnel — VPN instable) : exactement le
scénario half-open du défaut critique. Les nouvelles gardes ont tenu (aucun
flush, aucun provisoire sur données gelées) et le **watchdog** ajouté dans la
foulée ferme toute socket muette > 10 s → reconnexion backoff → recovery
comble le gap. Constaté en réel : socket fermée par le watchdog, reconnexion,
**retour spontané du provisoire (`1,855 P·S18`) dès que le flux a revécu**,
nouveau définitif `1,857 S43` émis au passage. Auto-guérison complète.

## 4. Reste de l'application — SAIN (re-vérifié)

- **Statique** : 21 fichiers valides, arbre propre, versions cohérentes
  (lifecycle v4, render v21, feature v21).
- **Matrice lifecycle : 12/12** (gap, post-gap, intrabar, rattrapage, gel
  terminal). **Archives** : BTC 9533 / ETH 2816, 0 géométrie invalide.
- **Scans de vérité** : 0 zombie / 52 actifs ETH (après correctif), 0 / 165
  BTC (audit précédent, moteur inchangé depuis).
- **Console** : zéro erreur applicative. **Rendu** : 60 fps, 0 long task.
- **Automatisation** : tâche quotidienne tirée à 17:00, exit 0.

## Verdict

**L'outil complet — provisoire inclus — est conforme, prouvé en conditions
réelles (3 clôtures + 1 incident réseau half-open traversé), et
auto-réparant.** Vigilances : instabilité du VPN (le watchdog la gère mais la
latence REST peut ralentir amorce/bootstrap), canari de parité, échantillons
forward.
