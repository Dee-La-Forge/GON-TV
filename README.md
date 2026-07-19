# G-ON

Chart de trading temps réel (Binance Futures Perp) avec moteur de POI M15,
POI provisoire sur la bougie ouverte et flux de liquidations — 100 %
client-side, aucun serveur : chaque visiteur a sa propre connexion Binance.

**Application en ligne : https://dee-la-forge.github.io/G-Bot/**

## Fonctionnalités

- **Chart G-Bot** — Lightweight Charts v5, 20 symboles Futures, TF de 3 s à 2 j,
  replay, alertes de prix sonores, persistance des bougies sur disque.
- **POI M15** — détection par footprint aggTrade (bins par décade de prix),
  méthode Antho v1, score gelé v2 (logistique 12 features + calibration
  quantile). Niveaux laser directionnels (bleu long / rouge short), élites en
  pulse, œil 3 états (vivants / tous / rien), filtre score et climax ⚡.
- **POI provisoire** — même moteur appliqué en continu à la bougie M15
  ouverte (chip vert/rouge `P·S…`), détruit et remplacé par le définitif au
  premier trade du bucket suivant. Zéro lookahead.
- **Liquidations FLUX** — panneau temps réel sur flux `!forceOrder` :
  compteurs 15 min du symbole affiché, dominance longs/shorts, canal
  d'orbes tous-marchés, journal.
- **Mode diagnostic** — `?diag=1` affiche l'empreinte comparable de la
  session (version, filtres, hash des niveaux) pour trancher toute
  divergence entre deux navigateurs.

## Architecture

```
index.html            chart G-Bot + intégration (seam window.__gon, additive)
poi/
  poi-config.js       config par symbole (binSize figé par décade de prix)
  footprint-m15.js    accumulateur footprint M15 (aggTrade -> buckets)
  poi-detector.js     détection (Règle d'Or + fallback allM15CandlePois)
  poi-lifecycle.js    vie des niveaux : retest / cassure / balayage
  poi-score-model.js  score v2 GELÉ (parité prouvée par tools/parity-harness.js)
  poi-feature.js      orchestration : flux WS, bootstrap, provisoire, diag
  poi-render.js       rendu laser multi-passes (aucun dégradé)
  liq-flux.js         panneau liquidations
  stream.js           WS avec backoff + watchdog demi-ouvert
  antho-v1-m15-pois.json / archive-*-m15.json   corpus par symbole
tools/
  regen-daily.cmd     pipeline quotidien (20 symboles) : regen -> invalidation -> approche
  regen-archive.js    reconstruction depuis les dumps Binance Vision
  backfill-*.js       invalidation des zombies, profil d'approche, climax
  lock.js / http.js   verrou + écriture atomique ; fetch poli (Retry-After)
  parity-harness.js   preuve de gel du moteur sur fenêtres réelles
```

## Invariants (ne pas régresser)

- **Zéro lookahead** : un POI n'existe qu'à partir de `availableAt`
  (clôture de sa bougie source) ; le provisoire travaille sur un
  instantané immuable de la bougie ouverte.
- **Doctrine lifecycle** : le gap de 2 bougies ne protège que le retest
  partiel de zone — cassure par clôture (INVALIDATED) et balayage en mèche
  du cluster entier (MITIGATED) tuent dès la première bougie close.
- **Score v2 gelé** : calibré sur BTC M15 ; appliqué tel quel aux autres
  symboles. Toute modification du moteur doit repasser le harnais de parité.
- **WS Binance** : chemins routés obligatoires (`/market/ws/…`,
  `/market/stream?…`) — carte complète dans `BINANCE_WS_ENDPOINTS.md`.
- **REST fapi** : budget de poids par IP — tout appel des outils passe par
  `tools/http.js` (`politeFetch`).
- Écritures d'archives : uniquement via `tools/lock.js` (verrou + atomique).

## Pipeline quotidien

Tâche Windows à 17:00 : `tools/regen-daily.cmd` — pour chacun des 20
symboles, régénération depuis Binance Vision, invalidation des zombies,
profil d'approche. Log : `%LOCALAPPDATA%\gon-regen.log`.

## Audits

Historique des passes d'audit dans `AUDIT_*.md` (pipeline complet, moteur
quant, provisoire, deux audits de nuit).
