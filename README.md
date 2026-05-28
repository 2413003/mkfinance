# MarketPulse

A static finance dashboard inspired by modern market apps. It runs on GitHub Pages with no build step.

## GitHub Pages

Upload the repository and enable GitHub Pages from the repository root. The app entry point is `index.html`.

## Data

- Stocks, ETFs, crypto prices, charts, and news: Yahoo Finance JSON endpoints
- Browser access: Yahoo data is fetched through the public Jina reader bridge so the static page can run without a backend

The UI does not use bundled quote data. If live data cannot be fetched, it shows an unavailable state.
