# Audit de pertinence du score d'importance — 18 juillet 2026

Question : le score `Sxx` affiché ordonne-t-il réellement les niveaux, ou
n'est-il qu'un chiffre bien calculé ? Méthode : reconstruction INDÉPENDANTE des
labels de réaction depuis les klines brutes Binance (recette doctrinale exacte
de `poi_detect.py::evaluate` : ATR14 Wilder à la bougie de retest, réf = bord
d'entrée, fenêtre 13 bougies, ordre conservateur, succès = +1 ATR avant −1 ATR),
puis mesure du pouvoir prédictif sur les **9303 POI retestés** de l'archive.
Outil : `score-relevance-audit.js` ; détail : `score-relevance-report.json`.

## Contrôle de validité : PASSÉ

L'`accumulationScore` (v1, écarté par le backtest) ressort à **AUC 0.488**,
contre 0.489 dans le backtest — notre reconstruction de label reproduit la
recette d'origine à ±0.001. Les mesures ci-dessous sont donc fiables.

## Résultats — score d'importance (v2)

| Mesure | Valeur | Lecture |
|---|---|---|
| AUC global | **0.564** | signal réel, modeste (0.5 = hasard) |
| Base rate | 54.4% | |
| Top 20% par score | 62.7% (**+8.3 pts**) | |
| Top 10% par score | 63.9% (**+9.4 pts**) | |

**Monotonie par palier** (la propriété demandée au score dans l'UI) :

    S0-34 : 48.4%   S35-49 : 54.3%   S50-69 : 54.4%   S70-79 : 59.3%   S80+ : 62.2%

Progression monotone, **13.8 pts d'écart** entre paliers extrêmes. Le filtre
par défaut S≥50 de l'UI est donc aligné sur une réalité mesurable.

**Stabilité temporelle** (le test anti-surapprentissage) :

    train (jan→avr)   AUC 0.565, lift +8.3
    valid (avr→juin)  AUC 0.563, lift +5.8
    test  (juin→juil) AUC 0.557, lift +8.3

Aucun effondrement hors de l'échantillon d'entraînement — le signal est stable
sur 6,5 mois. Symétrique par direction (long 0.568 / short 0.561).

## Le point de vigilance : l'extension (population du détecteur live)

Sur les 114 POI post-archive (détecteur live, sur-émetteur) : base rate
**41.2%** (vs ~54% pour le corpus d'origine) et AUC 0.505 — mais n=114 est
trop petit pour conclure sur l'AUC (le lift top-20% y est +13.3 pts sur 22
POI, signe de bruit d'échantillon). Deux enseignements prudents :

1. **La population sur-émise réagit moins bien en moyenne** (41% vs 54%) —
   cohérent avec le fait que le générateur d'origine était plus sélectif. Le
   filtre par score est donc PLUS important encore sur le flux live.
2. La pertinence du score sur cette population reste **à confirmer** quand
   l'échantillon forward aura grossi (relancer cet audit périodiquement — il
   est rejouable tel quel).

## Verdict

**Le score est pertinent pour ce qu'on lui demande** : ordonner les niveaux du
plus faible au plus fort. C'est prouvé indépendamment du backtest, stable dans
le temps, monotone par palier, symétrique par direction.

**Ce qu'il n'est PAS** : une probabilité de gain ni un signal de trading
autosuffisant. AUC 0.56 est un signal modeste ; le lift (+8 pts au top 20%)
reste sous le seuil GO de +15 pts du PLAN_ACTION. Il trie, il n'autorise pas.
