# G-ON — mode d'emploi de l'interface

Application 100 % client-side : chaque visiteur a sa propre connexion Binance.
URLs : https://dee-la-forge.github.io/G-Bot/ · https://dee-la-forge.github.io/Antho/g-on/

---

## 1. Le chart (G-Bot)

- **Symbole** : menu en haut à gauche — 28 paires Futures Perp + saisie libre.
  ⚠️ Le **sonar baleines** et les **archives POI** ne couvrent que 20 de ces
  paires (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, LINK, APT, ARB, OP, SUI, FIL,
  INJ, ETC, AAVE, WLD, TIA, 1000PEPE, 1000SHIB) : sur une autre paire, le
  radar reste en ambiance et il n'y a pas de niveaux archivés.
- **Timeframes** : de 3 s à 4 mois. Les TF secondes chargent leur historique
  en tâche de fond.
- **Défilement automatique** : si tu scrolles dans le passé, le chart revient
  seul sur la dernière bougie après 30 s sans interaction (jamais pendant un
  replay, un chargement ou un drag ; tout geste réarme le délai).
- **REPLAY** : rejoue le passé bougie par bougie.
- **Outils de dessin** (colonne gauche) : lignes, rectangles, texte, mesure…
  et **alertes de prix sonores** (icône cloche) qui sonnent au franchissement.
- **Œil de la barre du haut** : masque/affiche tous les dessins.
- La dernière vue (symbole, TF, dessins, bougies) est **mémorisée par
  navigateur** — deux machines = deux contextes. ⚠️ Les deux URLs ci-dessus
  partagent le **même** stockage : ne travaille pas sur les deux à la fois
  (le symbole et les dessins de l'une écrasent ceux de l'autre).

## 2 bis. Les ✦ validés (marquage de la règle de retest)

Un **losange doré ✦** est posé au point exact où un niveau a été touché et où
la règle de retest a **payé** : trait bleu touché par-dessus → long, SL
−0,15 %, validé si +1 % atteint avant le stop (rouge symétrique). Un compteur
« ✦ N validés · % » s'affiche en haut à gauche, calculé sur la fenêtre visible.
Franchise : sur BTC cette règle tourne à ~13 % de réussite (seuil de
rentabilité ~13 %) — les ✦ montrent *où* ça a marché, pas une stratégie
gagnante. BTC uniquement pour l'instant.

## 2. Les niveaux POI (le cœur de l'outil)

Zones de footprint M15 détectées par le moteur (méthode Antho v1, zéro
lookahead : un niveau n'existe qu'après la clôture de sa bougie source).

- **Bleu = long** (support attendu), **rouge = short** (résistance attendue).
- **Chip à droite** : prix + score 0-100 (score v2, calibré BTC). Plus c'est
  haut, plus le niveau a de qualité statistique.
- **Élites (score élevé)** : ligne qui **pulse** + point doré sur le chip.
- **Niveaux morts** : fins et estompés — traversés (invalidés) ou déjà
  retestés (servis). L'historique se lit d'un coup d'œil.
- **`P·S57` vert/rouge** : le **POI provisoire** de la bougie M15 en cours —
  recalculé en continu, détruit ou confirmé à la clôture. Vert = long,
  rouge = short.

**Contrôles (barre du haut, à droite)** :
| Bouton | Effet |
|---|---|
| 👁 | cycle : niveaux **vivants** → **tous** (morts inclus) → **rien** |
| ⚡ | ne garder que les POI nés sur un **climax de volume** (stat prouvée : ils tiennent mieux) |
| curseur | **score minimum** affiché (0 → 100) |

## 3. Le sonar baleines ◎ (haut gauche)

Détecte les ordres géants sur les 20 symboles (seuils en percentile glissant
par symbole — top 0,1 % du flux).

- **Radar autour du logo** : blips vifs = gros prints sur TON symbole
  (taille = montant), blips tamisés = ambiance des 19 autres. Un **bip
  sonar** discret accompagne chaque tour de balayage.
- **Mini-écho** (petit anneau sur la bougie) : print isolé exceptionnel
  (~1/heure).
- **Onde de choc** (grand anneau + sillage vertical) : **burst** — 3+ prints
  extrêmes même sens en 5 s (~1 toutes les 2-3 h). Bleu = achat, rouge = vente.
- **`⌾ DÉFENDU`** : un niveau POI touché par l'onde s'embrase 30 s — de la
  taille défend ou attaque ce niveau, maintenant.
- **Journal 🐋** sous le radar : les derniers événements (montant, sens, heure).
- **Clic sur le radar** : coupe/active les sons du sonar. Bouton **◎** de la
  barre : masque tout le module.

## 4. La colonne CARNET & PROFIL ▮

À droite du chart, **alignée sur son échelle de prix** — se recalcule sur la
période VISIBLE (zoom/pan suivis automatiquement).

- **Profil de volume** (barres fluo) : volume échangé à chaque prix, split
  bleu (acheteurs agressifs) / rouge (vendeurs). Barre la plus longue,
  encadrée d'or = **POC**, le prix le plus tradé — l'aimant de la période.
- **Murs de liquidité** (barres épaisses) : gros ordres passifs du carnet
  réel (≥ 1,5 M$ et 6× la médiane). **Pâle = jeune** (rien prouvé), **éclatant
  = a tenu** 20 s+. Un mur retiré jeune laisse un fantôme **`SPOOF ?`** 3 s.
- **`MUR + NIVEAU`** (cadre or) : un mur posé sur un de tes POI actifs — la
  confluence la plus forte de l'outil.
- Bouton **▮** : masque la colonne (et le CVD).

## 5. Le CVD (courbe de pression, en bas)

Pression nette cumulée des agresseurs, par-dessus les barres de volume.
Monte = les acheteurs paient, descend = les vendeurs paient.
**Mode d'emploi complet : `CVD_MODE_EMPLOI.md`** (divergences, absorption,
checklist de retest).

## 6. Le panneau LIQUIDATIONS ≋

- **Compteurs 15 min** : longs brûlés (rouge) / shorts brûlés (bleu) du
  symbole affiché + barre de **dominance**.
- **Canal d'orbes** : chaque liquidation tombe/monte en boule lumineuse ;
  petites boules tamisées = tout le marché.
- **Journal** : les liquidations > 250 k$.
- Bouton **≋** : masque le panneau liquidations. NB : Binance n'émet qu'UNE
  liquidation par symbole et par seconde — les montants sont des minorants.

## 6 bis. L'écran vidéo (socle de la colonne droite)

Sous les deux tours (profil | liquidations) : ♪ pour le son, molette de
volume au survol, et le bouton **⇄** (mode cinéma) qui fait passer la vidéo
en plein chart — re-clic pour revenir. Masqué automatiquement sous 860 px de
large.

## 7. Diagnostic entre collègues

Deux personnes ne voient « pas la même chose » ? Ouvrez tous les deux la
même URL avec **`?diag=1`** : un encadré affiche version, filtres actifs,
nombre de niveaux et **hash**. Même hash = mêmes niveaux (seuls vos réglages
diffèrent) ; hash différent après une clôture M15 complète = vrai problème.

## 8. À savoir

- **Réglages par navigateur ET par URL** : l'œil, le score min, les sons, les
  panneaux — tout vit dans le localStorage de l'origine. `127.0.0.1` et
  `github.io` sont deux mondes séparés.
- **Après un chargement**, le moteur rattrape l'historique manquant en tâche
  de fond (quelques minutes) : les statuts convergent, c'est normal.
- **Petits écrans** : sous 1100 px la colonne profil se masque, sous 860 px
  les panneaux latéraux — le chart garde toujours la priorité.
- Les archives POI sont régénérées **chaque jour à 17:00** ; entre-temps le
  live détecte et vieillit ses propres niveaux.
