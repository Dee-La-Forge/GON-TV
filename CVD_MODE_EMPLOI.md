# CVD — mode d'emploi

La courbe de pression en bas du chart (bandeau « volume »). Elle cumule, bougie
par bougie, le volume des acheteurs agressifs moins celui des vendeurs
agressifs — données exactes Binance (`takerBuyVolume`), pas une estimation.

**En un mot : le prix dit où on est, le CVD dit qui paie pour y aller.**

---

## Lecture en 3 secondes

| Ce que tu vois | Ce que ça veut dire |
|---|---|
| Courbe qui **monte** (segments bleus) | les acheteurs tapent au marché — ils paient le spread pour entrer |
| Courbe qui **descend** (segments rouges) | les vendeurs tapent au marché |
| **Ligne zéro** pointillée | équilibre de la fenêtre affichée |
| **Aire dégradée** bleue/rouge | le camp net dominant de la période, d'un coup d'œil |
| Courbe **plate** | personne n'est agressif — marché en attente |

## Les 5 situations du playbook

### 1. Confirmation — *suivre*
Prix ↑ **et** CVD ↑ (ou prix ↓ et CVD ↓). Le mouvement est payé par du vrai
flux agressif : il est sain. C'est le feu vert pour suivre une cassure.

### 2. Divergence basse — *guetter le long*
Le prix fait un **nouveau plus bas**, le CVD **refuse** de faire le sien.
Les vendeurs agressifs s'épuisent : plus personne ne paie pour vendre plus
bas. Sur un retest d'un POI long, c'est le meilleur indice de tenue.

### 3. Divergence haute — *guetter le short*
Miroir : nouveau plus haut du prix, CVD qui plafonne. Les acheteurs qui ont
porté la montée ne paient plus. Sur un POI short : zone de travail.

### 4. Absorption — *le signal des gros*
Le CVD **chute fort** mais le prix **ne bouge pas**. Toute la vente agressive
est encaissée passivement par quelqu'un de déterminé — souvent exactement sur
un mur du carnet ou un de tes niveaux. Les vendeurs se vident contre un
acheteur de taille : retournement fréquent derrière. (Miroir à la hausse :
CVD qui grimpe, prix scotché = distribution.)

### 5. Effort sans résultat — *méfiance*
Le CVD progresse nettement mais le prix n'avance presque pas alors qu'il n'y
a ni mur ni niveau pour l'expliquer : l'agressivité se fait manger par un
flux passif invisible. Ne pas suivre ce camp.

## Les combos avec le reste de l'outil

- **CVD + POI** : une divergence PILE au retest d'un niveau > une divergence
  au milieu de nulle part. Le niveau donne le lieu, le CVD donne le verdict
  sur la qualité du test.
- **CVD + mur (carnet)** : absorption sur un mur encore affiché = le mur est
  réel et il travaille. Absorption puis mur retiré = piège possible.
- **CVD + POC** : autour du POC le CVD oscille naturellement (zone
  d'équilibre) — les lectures y sont moins fiables ; elles comptent aux
  extrêmes du profil.
- **CVD + onde de choc (sonar)** : une onde baleine qui part DANS le sens de
  la pente CVD = flux confirmé par de la taille.

## Pièges à connaître

1. **La fenêtre est relative** : la courbe se recalcule sur la période
   VISIBLE du chart — son zéro et sa forme changent quand tu zoomes. Compare
   des pentes et des divergences, jamais des valeurs absolues entre deux zooms.
2. **Heures creuses** : à 3 h du matin, trois trades font une "tendance" CVD.
   Une lecture CVD vaut ce que vaut le volume derrière elle.
3. **Jamais seul** : le CVD est un filtre de qualité, pas un déclencheur.
   Le lieu (POI, mur, POC) d'abord, le CVD pour juger le test.
4. **Perp only** : on lit les futures Binance — un mouvement porté par le
   spot peut monter sans que notre CVD suive (c'est d'ailleurs une info).

## Checklist avant d'agir sur un retest

- [ ] Le prix est sur un lieu qui compte (POI / mur / extrême du profil) ?
- [ ] La pente CVD confirme ou diverge ?
- [ ] Le volume de la période est-il significatif (pas une heure morte) ?
- [ ] Absorption visible (CVD qui pousse, prix qui refuse) ?

Trois cases sur quatre du bon côté : le test est de qualité.
