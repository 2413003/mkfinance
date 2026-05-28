from __future__ import annotations

import json
import math
import mimetypes
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from html import escape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent
DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ", "META", "AMZN", "GOOGL"]
CRYPTO = {
    "BTC": ("bitcoin", "Bitcoin"),
    "ETH": ("ethereum", "Ethereum"),
    "SOL": ("solana", "Solana"),
    "XRP": ("ripple", "XRP"),
    "DOGE": ("dogecoin", "Dogecoin"),
    "ADA": ("cardano", "Cardano"),
}
CRYPTO_ID_TO_SYMBOL = {value[0]: key for key, value in CRYPTO.items()}
RANGE_MAP = {
    "1d": ("1d", "5m"),
    "5d": ("5d", "15m"),
    "1mo": ("1mo", "1h"),
    "6mo": ("6mo", "1d"),
    "ytd": ("ytd", "1d"),
    "1y": ("1y", "1d"),
}
CRYPTO_DAYS = {
    "1d": "1",
    "5d": "7",
    "1mo": "30",
    "6mo": "180",
    "ytd": "365",
    "1y": "365",
}

HTTP_CACHE: dict[str, tuple[float, object]] = {}


def cached_json(url: str, ttl: int = 25) -> object:
    now = time.time()
    cached = HTTP_CACHE.get(url)
    if cached and now - cached[0] < ttl:
        return cached[1]

    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json,text/plain,*/*",
            "User-Agent": "Mozilla/5.0 MarketPulse/1.0",
        },
    )
    with urllib.request.urlopen(request, timeout=14) as response:
        payload = json.loads(response.read().decode("utf-8"))
    HTTP_CACHE[url] = (now, payload)
    return payload


def sample_points(points: list[dict[str, float]], limit: int = 96) -> list[dict[str, float]]:
    if len(points) <= limit:
        return points
    step = max(1, math.ceil(len(points) / limit))
    return points[::step][-limit:]


def clean_symbol(symbol: str) -> str:
    return "".join(ch for ch in symbol.upper().strip() if ch.isalnum() or ch in ".-")[:18]


def is_crypto(symbol: str) -> bool:
    normalized = clean_symbol(symbol).replace("-USD", "")
    return normalized in CRYPTO


def crypto_id(symbol: str) -> str | None:
    normalized = clean_symbol(symbol).replace("-USD", "")
    details = CRYPTO.get(normalized)
    return details[0] if details else None


def compact_history(timestamps: list[int], closes: list[float | None]) -> list[dict[str, float]]:
    points: list[dict[str, float]] = []
    for timestamp, close in zip(timestamps, closes):
        if close is None:
            continue
        points.append({"time": int(timestamp), "price": round(float(close), 4)})
    return sample_points(points)


def format_money(value: object) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "--"
    if number <= 0:
        return "--"
    digits = 2 if abs(number) >= 1 else 6
    return f"${number:,.{digits}f}"


def format_percent(value: object) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "--"
    return f"{number:+.2f}%"


def format_signed_money(value: object) -> str:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "--"
    sign = "+" if number > 0 else "-" if number < 0 else ""
    return f"{sign}{format_money(abs(number))}"


def svg_path(points: list[dict[str, float]], width: int, height: int, padding: int) -> tuple[str, str]:
    values = [float(point["price"]) for point in points if point.get("price") is not None]
    if len(values) < 2:
        return "", ""
    minimum = min(values)
    maximum = max(values)
    value_range = maximum - minimum or max(1, maximum * 0.01)
    coords = []
    for index, value in enumerate(values):
        x = padding + (index / (len(values) - 1)) * (width - padding * 2)
        y = padding + (1 - (value - minimum) / value_range) * (height - padding * 2)
        coords.append((x, y))
    line = " ".join(f"{'L' if index else 'M'}{x:.2f} {y:.2f}" for index, (x, y) in enumerate(coords))
    first = coords[0]
    last = coords[-1]
    area = f"{line} L{last[0]:.2f} {height - padding} L{first[0]:.2f} {height - padding} Z"
    return line, area


def chart_svg(points: list[dict[str, float]], positive: bool, width: int = 900, height: int = 340) -> str:
    line, area = svg_path(points, width, height, 18)
    if not line:
        return '<div class="chart-empty">No chart</div>'
    color = "#0a8f54" if positive else "#d93025"
    grid = "".join(
        f'<line class="chart-grid-line" x1="0" y1="{y}" x2="{width}" y2="{y}"></line>'
        for y in (76, 152, 228, 304)
    )
    return (
        f'<svg class="chart-svg" viewBox="0 0 {width} {height}" preserveAspectRatio="none" role="img">'
        f"{grid}<path class=\"chart-fill\" d=\"{area}\" fill=\"{color}\"></path>"
        f'<path class="chart-line" d="{line}" stroke="{color}"></path></svg>'
    )


def sparkline_svg(points: list[dict[str, float]], positive: bool) -> str:
    line, _ = svg_path(points, 84, 28, 2)
    if not line:
        return ""
    color = "#0a8f54" if positive else "#d93025"
    return (
        '<svg class="sparkline-svg" viewBox="0 0 84 28" preserveAspectRatio="none" aria-hidden="true">'
        f'<path d="{line}" fill="none" stroke="{color}" stroke-width="1.8" stroke-linecap="round"></path></svg>'
    )


def initial_app_html() -> str:
    requested = DEFAULT_SYMBOLS + ["BTC", "ETH", "SOL", "XRP"]
    payload = quotes_payload(requested)
    quotes = [quote for quote in payload.get("quotes", []) if quote.get("price")]
    if not quotes:
        raise ValueError("No live quotes available")

    selected = quotes[0]
    watched_symbols = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "BTC", "ETH"]
    by_symbol = {quote["symbol"]: quote for quote in quotes}
    watchlist = [by_symbol[symbol] for symbol in watched_symbols if symbol in by_symbol]
    movers = sorted(quotes, key=lambda quote: abs(float(quote.get("changePercent") or 0)), reverse=True)[:6]
    crypto = [quote for quote in quotes if quote.get("type") == "crypto"][:6]
    positive = float(selected.get("changePercent") or 0) >= 0
    updated_at = time.strftime("%d %b, %H:%M", time.localtime(int(payload.get("updatedAt", time.time()))))

    def quote_row(quote: dict[str, object]) -> str:
        row_positive = float(quote.get("changePercent") or 0) >= 0
        direction = "is-gain" if row_positive else "is-loss"
        return (
            f'<button class="quote-row" type="button" data-select-symbol="{escape(str(quote["symbol"]))}">'
            f'<span><span class="row-symbol">{escape(str(quote["symbol"]))}</span>'
            f'<span class="row-name">{escape(str(quote.get("name") or quote["symbol"]))}</span></span>'
            f'<span class="mini-spark">{sparkline_svg(quote.get("history", []), row_positive)}</span>'
            f'<span class="row-price">{format_money(quote.get("price"))}</span>'
            f'<span class="{direction}">{format_percent(quote.get("changePercent"))}</span></button>'
        )

    def table_rows(rows: list[dict[str, object]]) -> str:
        body = []
        for quote in rows:
            row_positive = float(quote.get("changePercent") or 0) >= 0
            direction = "is-gain" if row_positive else "is-loss"
            body.append(
                f'<tr><td><button class="table-symbol" type="button" data-select-symbol="{escape(str(quote["symbol"]))}">'
                f'{escape(str(quote["symbol"]))}<span>{escape(str(quote.get("name") or quote["symbol"]))}</span></button></td>'
                f"<td>{format_money(quote.get('price'))}</td><td class=\"{direction}\">{format_percent(quote.get('changePercent'))}</td></tr>"
            )
        return (
            '<table class="table"><thead><tr><th>Symbol</th><th>Price</th><th>Change</th></tr></thead>'
            f"<tbody>{''.join(body)}</tbody></table>"
        )

    return f"""
      <header class="topbar">
        <button class="brand" type="button" data-select-symbol="AAPL" aria-label="MarketPulse home">
          <span class="brand-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 13h4l2-6 4 12 3-8h5"/></svg></span>
          <span>MarketPulse</span>
        </button>
        <div class="search-wrap">
          <span class="search-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/></svg></span>
          <input id="searchInput" class="search-input" type="search" autocomplete="off" placeholder="Search" aria-label="Search stocks, ETFs, crypto" />
          <div id="searchResults" class="search-results" role="listbox"></div>
        </div>
        <button id="refreshButton" class="icon-button" type="button" aria-label="Refresh"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M19 11a7 7 0 0 0-12-4l-3 3"/><path d="M5 13a7 7 0 0 0 12 4l3-3"/></svg></button>
        <div class="live-state" aria-live="polite"><span id="liveDot" class="live-dot"></span><span id="statusText">Live</span></div>
      </header>
      <main class="page">
        <nav id="categoryTabs" class="tabs" aria-label="Market category">
          <button class="tab is-active" type="button" data-category="overview">Market</button>
          <button class="tab" type="button" data-category="us">US</button>
          <button class="tab" type="button" data-category="crypto">Crypto</button>
          <button class="tab" type="button" data-category="etfs">ETFs</button>
        </nav>
        <section class="main-grid">
          <section id="assetPanel" class="asset-panel" aria-label="Selected market">
            <div class="asset-top">
              <div>
                <div class="asset-name-row">
                  <h1>{escape(str(selected.get("name") or selected["symbol"]))}</h1>
                  <span>{escape(str(selected["symbol"]))} &#183; {escape(str(selected.get("exchange") or selected.get("type") or "Market"))}</span>
                </div>
                <div class="price-row">
                  <span class="price">{format_money(selected.get("price"))}</span>
                  <span class="change {'is-gain' if positive else 'is-loss'}">{format_signed_money(selected.get("change"))} ({format_percent(selected.get("changePercent"))})</span>
                </div>
              </div>
              <button class="watch-toggle" type="button" data-toggle-watch aria-label="Toggle watch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.1L12 17.2 6.4 20.1 7.5 14 3 9.6l6.2-.9L12 3z"/></svg></button>
            </div>
            <div class="meta-line">{updated_at}</div>
            <div class="range-row"><button class="range is-active" type="button" data-range="1d">1D</button><button class="range" type="button" data-range="5d">5D</button><button class="range" type="button" data-range="1mo">1MO</button><button class="range" type="button" data-range="6mo">6MO</button><button class="range" type="button" data-range="ytd">YTD</button><button class="range" type="button" data-range="1y">1Y</button></div>
            <div class="chart-wrap">{chart_svg(selected.get("history", []), positive)}</div>
          </section>
          <aside id="watchlistPanel" class="watchlist" aria-label="Watchlist">
            <div class="section-head"><h2>Watchlist</h2></div>
            <div class="quote-list">{''.join(quote_row(quote) for quote in watchlist)}</div>
          </aside>
        </section>
        <section class="lower-grid">
          <section id="moversPanel" class="simple-section"><div class="section-head"><h2>Movers</h2></div>{table_rows(movers)}</section>
          <section id="cryptoPanel" class="simple-section"><div class="section-head"><h2>Crypto</h2></div>{table_rows(crypto)}</section>
          <section id="newsPanel" class="simple-section"><div class="section-head"><h2>News</h2></div><div class="news-list"><div class="empty-state">Loading headlines</div></div></section>
        </section>
      </main>
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
    """


def index_html() -> bytes:
    style = (ROOT / "styles.css").read_text(encoding="utf-8")
    try:
        app_html = initial_app_html()
    except Exception as exc:
        app_html = f'<main class="boot-fallback"><strong>MarketPulse</strong><span>{escape(str(exc))}</span></main>'
    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MarketPulse</title>
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23111722'/%3E%3Cpath d='M10 35h12l5-17 10 32 7-22h10' fill='none' stroke='%2328b67a' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" />
    <style>{style}</style>
  </head>
  <body>
    <div id="app" class="app-shell">{app_html}</div>
    <script type="module" src="/app.js?v=realdata2"></script>
  </body>
</html>""".encode("utf-8")


def fetch_yahoo_chart(symbol: str, range_key: str = "1d", interval: str = "5m") -> dict[str, object]:
    encoded = urllib.parse.quote(symbol)
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
        f"?range={urllib.parse.quote(range_key)}&interval={urllib.parse.quote(interval)}"
        "&includePrePost=false&events=div%2Csplits"
    )
    data = cached_json(url, ttl=18)
    result = data.get("chart", {}).get("result", [None])[0] if isinstance(data, dict) else None
    if not result:
        raise ValueError(f"No chart data for {symbol}")

    meta = result.get("meta", {})
    quote = result.get("indicators", {}).get("quote", [{}])[0]
    timestamps = result.get("timestamp") or []
    closes = quote.get("close") or []
    history = compact_history(timestamps, closes)
    price = meta.get("regularMarketPrice")
    if price is None and history:
        price = history[-1]["price"]
    previous = meta.get("chartPreviousClose") or meta.get("previousClose")
    if previous is None and len(history) > 1:
        previous = history[0]["price"]
    price = float(price or 0)
    previous = float(previous or price or 1)
    change = price - previous
    change_percent = (change / previous * 100) if previous else 0

    return {
        "symbol": clean_symbol(symbol),
        "name": meta.get("longName") or meta.get("shortName") or clean_symbol(symbol),
        "type": "stock" if meta.get("instrumentType") != "ETF" else "etf",
        "exchange": meta.get("exchangeName") or meta.get("fullExchangeName") or "Market",
        "currency": meta.get("currency") or "USD",
        "price": round(price, 4),
        "previousClose": round(previous, 4),
        "change": round(change, 4),
        "changePercent": round(change_percent, 4),
        "dayHigh": meta.get("regularMarketDayHigh"),
        "dayLow": meta.get("regularMarketDayLow"),
        "yearHigh": meta.get("fiftyTwoWeekHigh"),
        "yearLow": meta.get("fiftyTwoWeekLow"),
        "volume": meta.get("regularMarketVolume") or quote.get("volume", [None])[-1],
        "marketTime": meta.get("regularMarketTime"),
        "history": history,
        "source": "Yahoo Finance",
    }


def fetch_crypto_prices(symbols: list[str]) -> dict[str, dict[str, object]]:
    ids = [crypto_id(symbol) for symbol in symbols if crypto_id(symbol)]
    if not ids:
        return {}
    url = (
        "https://api.coingecko.com/api/v3/simple/price?"
        + urllib.parse.urlencode(
            {
                "ids": ",".join(sorted(set(ids))),
                "vs_currencies": "usd",
                "include_24hr_change": "true",
                "include_24hr_vol": "true",
                "include_market_cap": "true",
            }
        )
    )
    data = cached_json(url, ttl=28)
    results: dict[str, dict[str, object]] = {}
    if not isinstance(data, dict):
        return results
    for coin_id, values in data.items():
        symbol = CRYPTO_ID_TO_SYMBOL.get(coin_id)
        if not symbol or not isinstance(values, dict):
            continue
        price = float(values.get("usd") or 0)
        percent = float(values.get("usd_24h_change") or 0)
        previous = price / (1 + percent / 100) if percent > -99.9 else price
        name = CRYPTO[symbol][1]
        results[symbol] = {
            "symbol": symbol,
            "name": name,
            "type": "crypto",
            "exchange": "CoinGecko",
            "currency": "USD",
            "price": round(price, 6),
            "previousClose": round(previous, 6),
            "change": round(price - previous, 6),
            "changePercent": round(percent, 4),
            "dayHigh": None,
            "dayLow": None,
            "yearHigh": None,
            "yearLow": None,
            "volume": values.get("usd_24h_vol"),
            "marketCap": values.get("usd_market_cap"),
            "marketTime": int(time.time()),
            "history": [],
            "source": "CoinGecko",
        }
    return results


def fetch_crypto_yahoo(symbol: str, range_key: str = "1d", interval: str = "5m") -> dict[str, object]:
    normalized = clean_symbol(symbol).replace("-USD", "")
    quote = fetch_yahoo_chart(f"{normalized}-USD", range_key, interval)
    quote["symbol"] = normalized
    quote["name"] = CRYPTO.get(normalized, (normalized.lower(), normalized))[1]
    quote["type"] = "crypto"
    quote["exchange"] = "Crypto"
    quote["source"] = "Yahoo Finance"
    return quote


def fetch_crypto_history(symbol: str, range_key: str = "1d") -> list[dict[str, float]]:
    coin_id = crypto_id(symbol)
    if not coin_id:
        return []
    days = CRYPTO_DAYS.get(range_key, "1")
    url = (
        f"https://api.coingecko.com/api/v3/coins/{urllib.parse.quote(coin_id)}/market_chart?"
        + urllib.parse.urlencode({"vs_currency": "usd", "days": days})
    )
    data = cached_json(url, ttl=60)
    prices = data.get("prices", []) if isinstance(data, dict) else []
    points = [
        {"time": int(timestamp / 1000), "price": round(float(price), 6)}
        for timestamp, price in prices
        if price is not None
    ]
    return sample_points(points, limit=140)


def quotes_payload(symbols: list[str]) -> dict[str, object]:
    normalized = []
    for symbol in symbols:
        cleaned = clean_symbol(symbol).replace("-USD", "")
        if cleaned and cleaned not in normalized:
            normalized.append(cleaned)
    if not normalized:
        normalized = DEFAULT_SYMBOLS + ["BTC", "ETH", "SOL", "XRP"]

    stock_symbols = [symbol for symbol in normalized if not is_crypto(symbol)]
    crypto_symbols = [symbol for symbol in normalized if is_crypto(symbol)]
    quotes: list[dict[str, object]] = []
    errors: list[str] = []

    if stock_symbols:
        with ThreadPoolExecutor(max_workers=min(8, len(stock_symbols))) as executor:
            future_map = {executor.submit(fetch_yahoo_chart, symbol): symbol for symbol in stock_symbols}
            for future in as_completed(future_map):
                symbol = future_map[future]
                try:
                    quotes.append(future.result())
                except Exception as exc:
                    errors.append(f"{symbol}: {exc}")

    crypto_quotes: dict[str, dict[str, object]] = {}
    if crypto_symbols:
        try:
            crypto_quotes = fetch_crypto_prices(crypto_symbols)
        except Exception as exc:
            errors.append(f"CoinGecko: {exc}")
        for symbol in crypto_symbols:
            try:
                quote = crypto_quotes.get(clean_symbol(symbol))
                if not quote:
                    quote = fetch_crypto_yahoo(symbol)
                if quote:
                    try:
                        quote["history"] = fetch_crypto_history(symbol, "1d")
                    except Exception:
                        if not quote.get("history"):
                            quote["history"] = fetch_crypto_yahoo(symbol).get("history", [])
                    quotes.append(quote)
            except Exception as exc:
                errors.append(f"{symbol}: {exc}")

    order = {symbol: index for index, symbol in enumerate(normalized)}
    quotes.sort(key=lambda item: order.get(str(item["symbol"]), 999))
    return {"updatedAt": int(time.time()), "quotes": quotes, "errors": errors}


def history_payload(symbol: str, range_key: str) -> dict[str, object]:
    symbol = clean_symbol(symbol).replace("-USD", "")
    if is_crypto(symbol):
        quote = None
        history: list[dict[str, float]] = []
        try:
            quote = fetch_crypto_prices([symbol]).get(symbol)
            history = fetch_crypto_history(symbol, range_key)
        except Exception:
            quote = None
        if not history:
            chart_range, interval = RANGE_MAP.get(range_key, RANGE_MAP["1d"])
            fallback = fetch_crypto_yahoo(symbol, chart_range, interval)
            quote = quote or fallback
            history = fallback.get("history", [])
        return {
            "symbol": symbol,
            "range": range_key,
            "history": history,
            "quote": quote,
        }

    chart_range, interval = RANGE_MAP.get(range_key, RANGE_MAP["1d"])
    quote = fetch_yahoo_chart(symbol, chart_range, interval)
    return {"symbol": symbol, "range": range_key, "history": quote["history"], "quote": quote}


def search_payload(query: str) -> dict[str, object]:
    query = query.strip()
    if not query:
        return {"results": []}

    results: list[dict[str, object]] = []
    lowered = query.lower()
    for symbol, (coin_id, name) in CRYPTO.items():
        if lowered in symbol.lower() or lowered in name.lower() or lowered in coin_id:
            results.append({"symbol": symbol, "name": name, "exchange": "Crypto", "type": "crypto"})

    try:
        url = (
            "https://query1.finance.yahoo.com/v1/finance/search?"
            + urllib.parse.urlencode({"q": query, "quotesCount": "8", "newsCount": "0"})
        )
        data = cached_json(url, ttl=60)
        for quote in data.get("quotes", []) if isinstance(data, dict) else []:
            quote_type = quote.get("quoteType")
            if quote_type not in {"EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY"}:
                continue
            symbol = clean_symbol(quote.get("symbol", ""))
            if not symbol or any(item["symbol"] == symbol for item in results):
                continue
            results.append(
                {
                    "symbol": symbol,
                    "name": quote.get("longname") or quote.get("shortname") or symbol,
                    "exchange": quote.get("exchDisp") or quote.get("exchange") or "Market",
                    "type": "etf" if quote_type == "ETF" else "stock",
                }
            )
    except Exception:
        pass

    return {"results": results[:10]}


def news_payload(symbol: str) -> dict[str, object]:
    symbol = clean_symbol(symbol).replace("-USD", "") or "markets"
    query = symbol if not is_crypto(symbol) else CRYPTO[symbol][1]
    try:
        url = (
            "https://query1.finance.yahoo.com/v1/finance/search?"
            + urllib.parse.urlencode({"q": query, "quotesCount": "0", "newsCount": "8"})
        )
        data = cached_json(url, ttl=120)
        items = []
        for item in data.get("news", []) if isinstance(data, dict) else []:
            thumbnail = None
            resolutions = item.get("thumbnail", {}).get("resolutions") if isinstance(item.get("thumbnail"), dict) else None
            if resolutions:
                thumbnail = resolutions[-1].get("url")
            items.append(
                {
                    "title": item.get("title") or "Market update",
                    "publisher": item.get("publisher") or "Yahoo Finance",
                    "link": item.get("link"),
                    "publishedAt": item.get("providerPublishTime"),
                    "thumbnail": thumbnail,
                }
            )
        return {"symbol": symbol, "news": items}
    except Exception as exc:
        return {"symbol": symbol, "news": [], "error": str(exc)}


class MarketPulseHandler(SimpleHTTPRequestHandler):
    server_version = "MarketPulse/1.0"

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, payload: object, status: int = 200) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/health":
            self.send_json({"ok": True, "time": int(time.time())})
            return
        if path == "/api/quotes":
            symbols = ",".join(query.get("symbols", [",".join(DEFAULT_SYMBOLS + ["BTC", "ETH", "SOL", "XRP"])]))
            self.send_json(quotes_payload([part for part in symbols.split(",") if part.strip()]))
            return
        if path == "/api/history":
            symbol = query.get("symbol", ["AAPL"])[0]
            range_key = query.get("range", ["1d"])[0]
            try:
                self.send_json(history_payload(symbol, range_key))
            except Exception as exc:
                symbol = clean_symbol(symbol).replace("-USD", "")
                quote = None
                if is_crypto(symbol):
                    try:
                        quote = fetch_crypto_prices([symbol]).get(symbol)
                    except Exception:
                        quote = None
                self.send_json(
                    {
                        "error": str(exc),
                        "symbol": symbol,
                        "range": range_key,
                        "history": [],
                        "quote": quote,
                    }
                )
            return
        if path == "/api/search":
            self.send_json(search_payload(query.get("q", [""])[0]))
            return
        if path == "/api/news":
            self.send_json(news_payload(query.get("symbol", ["AAPL"])[0]))
            return

        if path in {"/", "/index.html"}:
            data = index_html()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        file_path = (ROOT / path.lstrip("/")).resolve()
        if ROOT not in file_path.parents and file_path != ROOT:
            self.send_error(404)
            return
        if not file_path.exists() or file_path.is_dir():
            self.send_error(404)
            return

        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write("%s - %s\n" % (self.log_date_time_string(), format % args))


def main() -> None:
    port = 8000
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    server = ThreadingHTTPServer(("127.0.0.1", port), MarketPulseHandler)
    print(f"MarketPulse running at http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
