# Binance WebSocket — carte des endpoints (migration 2026)

Référence constatée le 19 juillet 2026, suite à l'extinction silencieuse des
anciens chemins futures : les connexions s'ouvraient, les SUBSCRIBE étaient
acquittés (`{"result":null}`), mais **aucune donnée** n'était servie. La
migration vers les chemins **routés** est obligatoire.

## USDⓈ-M Futures (fstream.binance.com) — ce que l'outil utilise

| Catégorie | Base | Contenu |
|---|---|---|
| **Market** | `wss://fstream.binance.com/market` | aggTrade, kline, ticker, markPrice, **forceOrder** — données régulières |
| **Public** | `wss://fstream.binance.com/public` | haute fréquence : depth, bookTicker |
| **Private** | `wss://fstream.binance.com/private` | données utilisateur : ordres, comptes |

Modes d'accès sur chaque base :
- **ws mode (path)** : `<base>/ws/<streamName>` — ex. `wss://fstream.binance.com/market/ws/btcusdt@aggTrade`
- **stream mode (query)** : `<base>/stream?streams=<s1>/<s2>` — ex. `wss://fstream.binance.com/market/stream?streams=bnbusdt@aggTrade/btcusdt@markPrice`

⚠️ **Une connexion non routée (ancien `/ws`, `/stream` sans catégorie) ne
sert plus que la catégorie Public** : les `@aggTrade`, `@kline`,
`@forceOrder`… y sont muets. Piège : la connexion s'ouvre et acquitte les
SUBSCRIBE — silence sans erreur.

## Résultats de tests (19/07/2026, ~01:00 UTC, ligne locale sans VPN)

| URL testée | Résultat |
|---|---|
| `fstream…/ws/btcusdt@aggTrade` (ancien) | ouvert, **0 msg** ❌ |
| `fstream…/ws` + SUBSCRIBE (ancien) | ACK reçu, **0 msg** ❌ |
| `fstream…/stream?streams=…` (ancien) | ouvert, **0 msg** ❌ |
| `fstream…/market/ws/btcusdt@aggTrade` | ✅ 21 msgs/10 s |
| `fstream…/market/ws/!markPrice@arr@1s` | ✅ 16 msgs/8 s |
| `fstream…/market/ws/!forceOrder@arr` | ✅ 2 liquidations reçues/8 s |
| `fstream…/market/stream?streams=aggTrade/kline` | ✅ 35 msgs/8 s |
| `fstream…/market` + SUBSCRIBE (sans /ws) | refusé (pas de handshake) |
| `fstream…/public` + SUBSCRIBE (sans /ws) | refusé (pas de handshake) |

## Spot (inchangé — fonctionnait pendant toute la panne)

| Type | URL |
|---|---|
| Raw stream | `wss://stream.binance.com:9443/ws` (ou :443) |
| Combined | `wss://stream.binance.com:9443/stream` (ou :443) |
| Raw/Combined SBE | `wss://stream-sbe.binance.com/ws` · `/stream` (ou :9443) |
| Miroir data | `wss://data-stream.binance.vision/ws` ✅ testé |

## WebSocket API (trading actif — non utilisé par G-ON)

| Produit | URL |
|---|---|
| Spot | `wss://ws-api.binance.com:443/ws-api/v3` (9443 aussi) |
| USDⓈ-M Futures | `wss://ws-fapi.binance.com/ws-fapi/v1` |
| COIN-M Futures | `wss://ws-dapi.binance.com/ws-dapi/v1` |

## Testnet

| Produit | URL |
|---|---|
| Spot — WS API | `wss://ws-api.testnet.binance.vision/ws-api/v3` |
| Spot — Market Streams | `wss://stream.testnet.binance.vision/stream` |
| Futures — WS API | `wss://testnet.binancefuture.com/ws-fapi/v1` |
| Futures — Market Streams | `wss://fstream.binance.com` (prod, data testnet) |

## Impact sur G-ON (corrigé le 19/07/2026)

- `index.html` (kline G-Bot) : `/stream` → `/market/stream`
- `poi/poi-feature.js` (aggTrade POI) : `/ws/` → `/market/ws/`
- `poi/liq-flux.js` (liquidations) : `/ws/!forceOrder@arr` → `/market/ws/!forceOrder@arr`
- CSP inchangée (autorisation au niveau de l'hôte).
- Le REST `fapi.binance.com` n'est pas concerné par la migration.
