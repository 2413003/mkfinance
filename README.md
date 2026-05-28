# MarketPulse

A local finance dashboard inspired by modern market apps. It serves a static front end plus a small Python proxy for live market data.

## Run

```powershell
& "C:\Users\Galen Butler\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" server.py 8001
```

Open `http://127.0.0.1:8001`.

## Data

- Stocks, ETFs, search, and news: Yahoo Finance JSON endpoints
- Crypto prices and history: CoinGecko public API

The server keeps a small in-memory request cache to reduce repeat API calls. The UI does not use bundled quote data; if live data cannot be fetched, it shows an unavailable state.
