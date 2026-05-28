# MK Finance

A static finance dashboard inspired by modern market apps. It runs on GitHub Pages with no build step.

## GitHub Pages

Upload the repository and enable GitHub Pages from the repository root. The app entry point is `index.html`.

## Data

- Default mode: Yahoo Finance JSON endpoints through the public Jina reader bridge, with CoinGecko crypto and Stooq quote fallbacks

The UI does not use bundled quote data. If live data cannot be fetched, it shows an unavailable state.
