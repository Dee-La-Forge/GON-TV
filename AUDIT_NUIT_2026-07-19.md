# G-ON — Audit nocturne complet (19 juillet 2026)

Audit intégral demandé pendant le sommeil de Meddy : 4 relecteurs
adversariaux en parallèle sur tout le code, vérifications statiques,
unitaires, parité, et E2E navigateur sur les deux symboles. **21 défauts
réels trouvés (0 critique), 15 corrigés cette nuit (`a8ac98f`), 6 assumés
comme limites documentées.**

## 1. Socle vérifié sain (avant correctifs)

- **Statique** : 22 fichiers JS valides, arbre propre.
- **Matrice lifecycle : 17/17** (gap, post-gap, intrabar, rattrapage, gels).
- **Archives** : BTC 9533 / ETH 2816, zéro géométrie invalide, zéro NaN.
- **Parité** : 9/11 scores identiques — canari de dérive source stable.
- **Scans de vérité** : 0 zombie / 167 actifs BTC, 0 / 52 ETH.
- **Ancres multi-TF** : exactes sur 8m, 30m, 1h, 15m (sondes < 0,5 px).
  Le « 6/6 KO » sur 45s est un artefact de sonde : les bougies secondes
  n'ont pas d'historique profond, les ancres antérieures aux données
  partent proprement du bord gauche.
- **Flux** : aggTrade et forceOrder vivants sur les chemins routés
  `/market` ; provisoire opérationnel ; panneau liq suit le symbole.

## 2. Défauts corrigés (15)

### poi-render.js (8)
| Sévérité | Défaut | Correctif |
|---|---|---|
| medium | **Boucle pulse fantôme** : masquer les niveaux avec une élite à l'écran laissait un repaint ~30 fps d'un canvas vide pour toute la session | `hasEliteVisible` remis à zéro AVANT les early-returns de paint |
| medium | **viewSig aveugle au TF** : un changement de TF retombant sur les mêmes ranges logique+prix ne repeignait jamais (ancres périmées) | tf/tfSec inclus dans la signature |
| medium | **Chip provisoire écrasait la colonne des actifs** (il naît près du prix, pile où les tags se concentrent — pastille élite masquée) | esquive verticale des tags + respect de l'anti-doublon de prix |
| low | Snap hebdo sur grille epoch → origines une barre trop tôt (bougies G-Bot ancrées lundi) ; mensuels sans grille fixe | grille W0=lundi pour les semaines, pas de snap pour les mois |
| low | Culling sur le createdTs brut vs ancre snappée dessinée → pop-in au bord droit sur TF hauts | cull sur l'ancre snappée |
| low | Cull/declutter testaient zoneHigh pour un short sans entry, dessiné à zoneLow | référence de prix unifiée avec le dessin |
| low | Cache de largeurs de chips figé sur la police de repli | purge sur `document.fonts.ready` |
| low | dpr non détecté (écran 1x↔2x sans resize CSS) → overlay flou ; sig committé avant un paint qui peut lever → frame corrompue figée | check dpr dans tick ; commit APRÈS paint réussi |

### poi-feature.js (3)
| Sévérité | Défaut | Correctif |
|---|---|---|
| medium | **?diag=1 lisait la clé morte** de l'œil (`showConsumed`) — l'outil censé trancher « on ne voit pas pareil » rapportait de faux filtres | lit `gon.poi.view` |
| low | Continuation abortée (switch de symbole) écrivait le cache bootstrap de l'ANCIEN ticker avec le binSize du NOUVEAU → cache jeté au prochain load | garde `poiConfig.symbol === ticker` dans saveBootCache |
| low | Watchdog 10 s intenable pour un altcoin calme (socket SAINE recyclée en boucle) | seuil adaptatif : 10 s BTC/ETH, 60 s sinon |

### liq-flux.js (4 + hygiène)
| Sévérité | Défaut | Correctif |
|---|---|---|
| major | **`waves[]` sans borne panneau masqué** (rAF suspendu = zéro purge, WS continue) → fuite mémoire + gel au ré-affichage | visuels conditionnés à la visibilité + borne dure 80 |
| major | **Écouteur de son survivant** : après un premier geste (clic), le keydown restait armé et pouvait dé-muter la vidéo malgré un mute explicite | les deux écouteurs retirés au premier geste |
| minor | Compteurs fantômes au switch de symbole (millions qui décroissent) | reset de `shown` |
| minor | Voile fantôme 8 bits du phosphore ; rAF à vide panneau masqué ; survol vidéo/volume mort (pointer-events hérité) ; panneau rigide en fenêtre étroite | purge dure périodique ; rAF suspendu ; panneau pointer-events:auto (il vit À CÔTÉ du chart) ; media query < 860 px |

## 3. Limites assumées (documentées, non corrigées)

- TF secondes : ancres antérieures aux données aggTrade → ligne clampée au
  bord (pas d'historique profond possible).
- Pulsation : coût O(N²) du declutter à 30 fps sur très grosses watchlists
  (mesuré sain à ~170 niveaux : 60 fps, 0 long task).
- TF mensuels : pas de snap (bougies calendaires) — interpolation exacte.
- WS liquidations maintenu connecté panneau masqué (fenêtre 15 min chaude
  au ré-affichage — choix délibéré).
- Format des payloads `/market/ws` supposé non-enveloppé (vérifié
  empiriquement par le parsing en production).

## 4. Post-correctifs — revalidé en réel

Versions v26/v26/v15 chargées, diag affiche `vue=live`, provisoire vivant
(`1,868 P·S96`), injection de test → orbes/compteurs/dominance/journal OK,
vidéo en lecture. Site public GitHub Pages synchronisé automatiquement.

## Verdict

**Aucun défaut critique dans tout le code.** Les trouvailles étaient des
défauts d'usure (itérations design), de robustesse périphérique (veille,
altcoins, fenêtres étroites) et d'outillage (diag). Le cœur — détection,
score, lifecycle, archives, parité — est resté irréprochable sous les
quatre angles d'attaque.
