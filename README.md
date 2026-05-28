# MarketPulse

A static finance dashboard inspired by modern market apps. It runs on GitHub Pages with no build step.

## GitHub Pages

Upload the repository and enable GitHub Pages from the repository root. The app entry point is `index.html`.

## Data

- Default mode: Yahoo Finance JSON endpoints through the public Jina reader bridge
- Realtime mode: click the live status in the top bar and paste a Finnhub token
- Crypto stream symbols use Finnhub's `BINANCE:*USDT` trade feed

The UI does not use bundled quote data. If live data cannot be fetched, it shows an unavailable state.

GitHub Pages cannot hide a private market-data key. For immediate streaming prices, the Finnhub token is stored only in the visitor's browser local storage. Without a token, the app stays fully static and falls back to periodic public data.

Finnhub WebSocket docs: https://finnhub.io/docs/api/websocket-trades
