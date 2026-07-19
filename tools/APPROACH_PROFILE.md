# Profil d'approche avant premier touch — effet validé, champ de données

Date : 18 juillet 2026. Origine : hypothèse du collègue quant (« désactiver un
niveau frôlé — l'enjeu est dans les stops »). Outils : `near-miss-test.js`
(découverte), `approach-validation.js` (robustesse), `backfill-approach.js`
(persistance du champ `approachAtr`).

## Verdict sur l'hypothèse initiale

Le FRÔLAGE (approche < 0.1-0.25 ATR sans toucher) ne dégrade PAS le niveau :
delta ≈ 0 (−1.4 / +0.8 pt). Nuance : sur les S≥80, léger coût (~−4 pts).
L'intuition opérationnelle était bonne, le mécanisme non.

## L'effet réel : le PROFIL D'ARRIVÉE (beaucoup plus fort)

Taux de réaction (label doctrinal +1 ATR avant −1 ATR) selon la distance
MINIMALE d'approche entre l'éligibilité (création + 2 bougies) et le premier
touch — 9303 POI BTCUSDT labellisés :

    retest immédiat (pas de fenêtre)     ~49 %
    collé   (0 – 0.25 ATR)               ~57 %
    SWEET   (0.25 – 2 ATR)               ~71 %   ★
    VIOLENT (jamais < 2 ATR)             ~29 %   ⚠

Lecture : un niveau visité de près puis quitté tient à ~71 % ; un niveau
percuté depuis le large (arrivée momentum) se fait transpercer (~29 %).

## Robustesse (approach-validation.js) — les 3 contrôles passent

| Contrôle | Écart sweet−violent | |
|---|---|---|
| Périodes | train +44.0 / valid +34.6 / test +43.2 pts | stable 6,5 mois |
| Directions | long +41.7 / short +42.2 (violent 29.3 % des DEUX côtés) | symétrique |
| Régime (relATR médian) | vol basse +44.1 / vol haute +39.8 | pas un artefact de volatilité |

C'est l'effet le plus robuste mesuré sur le projet (devant le climax +7.9 et
le lift du score +8.3).

## Décision d'altitude : donnée, pas décoration

Ce signal est DYNAMIQUE (propriété du touch, pas du niveau) — sa place est la
couche stratégie/validation, pas l'affichage. Implémentation retenue :

- Colonne `approachAtr` dans les archives (BTC + ETH) : distance min en ATR ;
  `-1` = retest immédiat ; `null` = non calculable (actif, ou timing de retest
  du générateur d'origine incompatible — ~13 % des lignes canoniques BTC,
  ~2 % ETH) .
- Backfill quotidien automatique (regen-daily.cmd) après chaque régénération.
- Exposé par le loader (`poi.approachAtr`) pour tout consommateur futur.
- AUCUNE expression UI pour l'instant (sobriété ; l'usage réel décidera).

## Généralisation ETHUSDT (fenêtre 30 j, population détecteur permissif)

Même hiérarchie sur les deux moitiés de fenêtre, les deux directions et les
deux régimes : immédiat ~37 % < collé ~59-69 % < sweet 74-84 % (encore plus
fort qu'en BTC). Retest immédiat plus fréquent (66 %) et plus faible qu'en
BTC — cohérent avec des zones nées près du prix. Réserve : le groupe violent
est minuscule sur ETH (n=51 total) — delta sweet−violent positif partout
(+15 à +48 pts) mais estimation bruitée ; directionnellement cohérent,
statistiquement fragile sur cette paire.

Vérification de persistance : 2701/2701 `approachAtr` stockés identiques au
recalcul indépendant (0 écart) — le backfill est exact.

## Usage recommandé (couche stratégie / validation forward)

Règle candidate pour le test GO (+15 pts) : au premier touch d'un niveau,
si le prix n'est jamais venu à moins de ~2 ATR depuis l'éligibilité (arrivée
momentum), NE PAS jouer le rebond (29 % de tenue). Préférer les touches de
niveaux déjà visités (0.25-2 ATR : ~71 %). À re-tester sur données fraîches
avant toute exploitation — mesure descriptive in-sample malgré les splits.
