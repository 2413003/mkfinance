const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "BTC", "ETH", "SOL"];
const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA"]);
const CATEGORIES = [
  ["overview", "Market"],
  ["us", "US"],
  ["crypto", "Crypto"],
  ["etfs", "ETFs"],
];
const RANGES = ["1d", "5d", "1mo", "6mo", "ytd", "1y"];
const REFRESH_INTERVAL_MS = 120000;
const FETCH_TIMEOUT_MS = 15000;
const RANGE_MAP = {
  "1d": ["5d", "5m"],
  "5d": ["5d", "15m"],
  "1mo": ["1mo", "1h"],
  "6mo": ["6mo", "1d"],
  ytd: ["ytd", "1d"],
  "1y": ["1y", "1d"],
};
const SEARCH_UNIVERSE = [
  ["AAPL", "Apple Inc.", "stock"],
  ["MSFT", "Microsoft Corporation", "stock"],
  ["NVDA", "NVIDIA Corporation", "stock"],
  ["TSLA", "Tesla, Inc.", "stock"],
  ["SPY", "SPDR S&P 500 ETF Trust", "etf"],
  ["QQQ", "Invesco QQQ Trust", "etf"],
  ["META", "Meta Platforms, Inc.", "stock"],
  ["AMZN", "Amazon.com, Inc.", "stock"],
  ["GOOGL", "Alphabet Inc.", "stock"],
  ["AMD", "Advanced Micro Devices, Inc.", "stock"],
  ["NFLX", "Netflix, Inc.", "stock"],
  ["AVGO", "Broadcom Inc.", "stock"],
  ["BTC", "Bitcoin", "crypto"],
  ["ETH", "Ethereum", "crypto"],
  ["SOL", "Solana", "crypto"],
  ["XRP", "XRP", "crypto"],
  ["DOGE", "Dogecoin", "crypto"],
  ["ADA", "Cardano", "crypto"],
];
const COINGECKO_IDS = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  DOGE: "dogecoin",
  ADA: "cardano",
};

const state = {
  quotes: new Map(),
  selected: localStorage.getItem("marketpulse:selected") || "AAPL",
  range: "1d",
  category: "overview",
  loading: true,
  loadingSelected: false,
  live: false,
  error: "",
  updatedAt: null,
  nextRefreshAt: 0,
  watchlist: readWatchlist(),
  searchResults: [],
  searchOpen: false,
  news: [],
};

const app = document.querySelector("#app");
let searchTimer = null;
let toastTimer = null;

boot();

function boot() {
  app.className = "app-shell";
  app.innerHTML = `
    <header class="topbar">
      <button class="brand" type="button" data-select-symbol="AAPL" aria-label="MK Finance home">
        <span class="brand-mark">${icon("pulse")}</span>
        <span>MK Finance</span>
      </button>
      <div class="search-wrap">
        <span class="search-icon">${icon("search")}</span>
        <input id="searchInput" class="search-input" type="search" autocomplete="off" placeholder="Search" aria-label="Search stocks, ETFs, crypto" />
        <div id="searchResults" class="search-results" role="listbox"></div>
      </div>
    </header>
    <main class="page">
      <nav id="categoryTabs" class="tabs" aria-label="Market category"></nav>
      <section class="main-grid">
        <section id="assetPanel" class="asset-panel" aria-label="Selected market"></section>
        <aside id="watchlistPanel" class="watchlist" aria-label="Watchlist"></aside>
      </section>
      <section class="lower-grid">
        <section id="moversPanel" class="simple-section"></section>
        <section id="cryptoPanel" class="simple-section"></section>
        <section id="newsPanel" class="simple-section"></section>
      </section>
    </main>
    <div id="toast" class="toast" role="status" aria-live="polite"></div>
  `;

  bindEvents();
  render();
  loadAll();
  setInterval(loadAll, REFRESH_INTERVAL_MS);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target;
    const select = target.closest("[data-select-symbol]");
    const range = target.closest("[data-range]");
    const category = target.closest("[data-category]");
    const watch = target.closest("[data-toggle-watch]");

    if (select) {
      selectSymbol(select.dataset.selectSymbol);
      closeSearch();
    } else if (range) {
      state.range = range.dataset.range;
      loadHistory(state.selected, state.range);
    } else if (category) {
      state.category = category.dataset.category;
      if (state.category === "crypto" && !CRYPTO.has(state.selected)) selectSymbol("BTC");
      render();
    } else if (watch) {
      toggleWatch(state.selected);
    } else if (!target.closest(".search-wrap")) {
      closeSearch();
    }
  });
  document.addEventListener("pointermove", (event) => {
    const chart = event.target.closest("[data-chart-wrap]");
    if (chart) updateChartHover(event, chart);
  });
  document.addEventListener("pointerout", (event) => {
    const chart = event.target.closest("[data-chart-wrap]");
    if (chart && !chart.contains(event.relatedTarget)) hideChartHover(chart);
  });

  const searchInput = document.querySelector("#searchInput");
  searchInput.addEventListener("input", (event) => {
    const query = event.target.value.trim();
    clearTimeout(searchTimer);
    if (!query) {
      state.searchResults = [];
      state.searchOpen = false;
      renderSearch();
      return;
    }
    searchTimer = setTimeout(() => search(query), 120);
  });
  searchInput.addEventListener("focus", () => {
    if (state.searchResults.length) {
      state.searchOpen = true;
      renderSearch();
    }
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && state.searchResults[0]) {
      event.preventDefault();
      selectSymbol(state.searchResults[0].symbol);
      closeSearch();
    }
    if (event.key === "Escape") closeSearch();
  });
}

async function loadAll(force = false) {
  state.loading = state.quotes.size === 0;
  state.error = "";
  render();

  try {
    const quotes = (await mapLimit(DEFAULT_SYMBOLS, 2, (symbol) => fetchPublicQuote(symbol, "1d"))).filter(isUsableQuote);
    if (!quotes.length && !state.quotes.size) throw new Error("No live quotes returned");

    const nextQuotes = new Map(state.quotes);
    quotes.forEach((quote) => nextQuotes.set(quote.symbol, quote));
    state.quotes = nextQuotes;
    if (!state.quotes.has(state.selected) && quotes[0]) state.selected = quotes[0].symbol;
    state.updatedAt = new Date();
    state.nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
    state.live = true;
    state.loading = false;

    render();
    if (force) showToast("Updated");
  } catch (error) {
    state.live = state.quotes.size > 0;
    state.loading = false;
    state.error = state.quotes.size ? "" : "Live data unavailable";
    render();
  }
}

async function loadHistory(symbol, range, shouldRender = true) {
  state.loadingSelected = !state.quotes.has(symbol);
  if (shouldRender) renderAsset();

  try {
    const quote = await fetchPublicQuote(symbol, range);
    if (isUsableQuote(quote)) {
      state.quotes.set(quote.symbol, { ...state.quotes.get(quote.symbol), ...quote });
      state.selected = quote.symbol;
      state.error = "";
    } else if (!state.quotes.has(symbol)) {
      state.error = "Live quote unavailable";
    }
  } catch (error) {
    if (!state.quotes.has(symbol)) state.error = "Live quote unavailable";
  } finally {
    state.loadingSelected = false;
  }

  if (shouldRender) render();
}

async function loadNews(symbol, shouldRender = true) {
  try {
    state.news = await fetchYahooNews(symbol);
  } catch (error) {
    state.news = [];
  }
  if (shouldRender) renderNews();
}

function search(query) {
  const normalized = query.trim().toLowerCase();
  const local = SEARCH_UNIVERSE.filter(([symbol, name]) => (
    symbol.toLowerCase().includes(normalized) || name.toLowerCase().includes(normalized)
  )).map(([symbol, name, type]) => ({ symbol, name, type }));

  const rawSymbol = query.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "");
  const exact = rawSymbol && rawSymbol.length <= 12 && !local.some((item) => item.symbol === rawSymbol)
    ? [{ symbol: rawSymbol, name: rawSymbol, type: CRYPTO.has(rawSymbol) ? "crypto" : "stock" }]
    : [];

  state.searchResults = [...local, ...exact].slice(0, 10);
  state.searchOpen = true;
  renderSearch();
}

function selectSymbol(symbol) {
  if (!symbol) return;
  state.selected = symbol.replace("-USD", "").toUpperCase();
  localStorage.setItem("marketpulse:selected", state.selected);
  document.querySelector("#searchInput").value = "";
  if (state.range === "1d" && state.quotes.has(state.selected)) {
    render();
  } else {
    loadHistory(state.selected, state.range);
  }
  render();
}

function toggleWatch(symbol) {
  if (state.watchlist.includes(symbol)) {
    state.watchlist = state.watchlist.filter((item) => item !== symbol);
  } else {
    state.watchlist = [symbol, ...state.watchlist].slice(0, 10);
  }
  localStorage.setItem("marketpulse:watchlist", JSON.stringify(state.watchlist));
  render();
}

async function fetchYahooChart(symbol, rangeKey = "1d") {
  const displaySymbol = symbol.replace("-USD", "").toUpperCase();
  const yahooSymbol = toYahooSymbol(displaySymbol);
  const [range, interval] = RANGE_MAP[rangeKey] || RANGE_MAP["1d"];
  const includePrePost = rangeKey === "1d" ? "true" : "false";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}&includePrePost=${includePrePost}&events=div%2Csplits`;
  const data = await fetchJsonThroughReader(url);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`No chart data for ${displaySymbol}`);

  const meta = result.meta || {};
  const quote = result.indicators?.quote?.[0] || {};
  const timestamps = result.timestamp || [];
  const closes = quote.close || [];
  const rawHistory = timestamps.map((timestamp, index) => ({
    time: timestamp,
    price: Number(closes[index]),
  })).filter((point) => Number.isFinite(point.price));
  const history = clipHistoryForRange(rawHistory, rangeKey, meta);

  const price = Number(meta.regularMarketPrice || history.at(-1)?.price || 0);
  const previous = Number(meta.chartPreviousClose || meta.previousClose || history[0]?.price || price);
  const change = price - previous;
  const changePercent = previous ? (change / previous) * 100 : 0;
  const known = SEARCH_UNIVERSE.find(([knownSymbol]) => knownSymbol === displaySymbol);

  return {
    symbol: displaySymbol,
    name: known?.[1] || meta.longName || meta.shortName || displaySymbol,
    type: CRYPTO.has(displaySymbol) ? "crypto" : meta.instrumentType === "ETF" ? "etf" : "stock",
    exchange: CRYPTO.has(displaySymbol) ? "Crypto" : meta.exchangeName || meta.fullExchangeName || "Market",
    currency: meta.currency || "USD",
    price,
    previousClose: previous,
    change,
    changePercent,
    volume: meta.regularMarketVolume || quote.volume?.at(-1),
    history: samplePoints(history, rangeKey === "1d" ? 120 : 160),
    source: "Yahoo Finance",
  };
}

async function fetchPublicQuote(symbol, rangeKey = "1d") {
  try {
    return await fetchYahooChart(symbol, rangeKey);
  } catch (error) {
    if (CRYPTO.has(symbol)) return fetchCoinGeckoQuote(symbol);
    return fetchStooqQuote(symbol);
  }
}

async function fetchCoinGeckoQuote(symbol) {
  const displaySymbol = symbol.replace("-USD", "").toUpperCase();
  const id = COINGECKO_IDS[displaySymbol];
  if (!id) throw new Error(`No CoinGecko id for ${displaySymbol}`);

  const [priceData, chartData] = await Promise.all([
    fetchJsonUrl(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`),
    fetchJsonUrl(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=1`),
  ]);
  const row = priceData?.[id] || {};
  const price = Number(row.usd);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`No CoinGecko price for ${displaySymbol}`);

  const changePercent = Number(row.usd_24h_change || 0);
  const previousClose = changePercent ? price / (1 + changePercent / 100) : price;
  const change = price - previousClose;
  const history = (chartData?.prices || []).map(([time, value]) => ({
    time: Math.floor(Number(time) / 1000),
    price: Number(value),
  })).filter((point) => Number.isFinite(point.time) && Number.isFinite(point.price));
  const known = SEARCH_UNIVERSE.find(([knownSymbol]) => knownSymbol === displaySymbol);

  return {
    symbol: displaySymbol,
    name: known?.[1] || displaySymbol,
    type: "crypto",
    exchange: "Crypto",
    currency: "USD",
    price,
    previousClose,
    change,
    changePercent,
    volume: undefined,
    history: samplePoints(history, 120),
    source: "CoinGecko",
  };
}

async function fetchStooqQuote(symbol) {
  const displaySymbol = symbol.replace("-USD", "").toUpperCase();
  const stooqSymbol = `${displaySymbol.toLowerCase().replace(".", "-")}.us`;
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&h&e=csv`;
  const text = await fetchTextThroughReader(url);
  const csv = text.includes("Markdown Content:") ? text.split("Markdown Content:").pop() : text;
  const lines = csv.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.includes(","));
  const row = lines.find((line) => line.toUpperCase().startsWith(stooqSymbol.toUpperCase())) || lines[1];
  if (!row) throw new Error(`No Stooq quote for ${displaySymbol}`);

  const values = parseCsvLine(row);
  const price = Number(values[6]);
  if (!Number.isFinite(price) || price <= 0) throw new Error(`No Stooq price for ${displaySymbol}`);

  const open = Number(values[3]);
  const previousClose = Number.isFinite(open) && open > 0 ? open : price;
  const change = price - previousClose;
  const changePercent = previousClose ? (change / previousClose) * 100 : 0;
  const known = SEARCH_UNIVERSE.find(([knownSymbol]) => knownSymbol === displaySymbol);

  return {
    symbol: displaySymbol,
    name: known?.[1] || displaySymbol,
    type: displaySymbol === "SPY" || displaySymbol === "QQQ" ? "etf" : "stock",
    exchange: "Stooq",
    currency: "USD",
    price,
    previousClose,
    change,
    changePercent,
    volume: Number(values[7]) || undefined,
    history: [],
    source: "Stooq",
  };
}

async function fetchYahooNews(symbol) {
  const query = CRYPTO.has(symbol) ? SEARCH_UNIVERSE.find(([item]) => item === symbol)?.[1] || symbol : symbol;
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=5`;
  const data = await fetchJsonThroughReader(url);
  return (data.news || []).slice(0, 5).map((item) => ({
    title: item.title,
    publisher: item.publisher,
    link: item.link,
  })).filter((item) => item.title);
}

async function fetchJsonThroughReader(url) {
  const text = await fetchTextThroughReader(url);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Reader returned no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

async function fetchTextThroughReader(url) {
  const readerUrls = [
    `https://r.jina.ai/http://${url}`,
    `https://r.jina.ai/http://r.jina.ai/http://${url}`,
  ];
  let lastError;
  for (const readerUrl of readerUrls) {
    try {
      return await fetchTextUrl(readerUrl);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Reader request failed");
}

async function fetchJsonUrl(url) {
  const text = await fetchTextUrl(url);
  return JSON.parse(text);
}

async function fetchTextUrl(url) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller?.signal,
    });
    if (!response.ok) throw new Error(`Request failed ${response.status}`);
    return response.text();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toYahooSymbol(symbol) {
  if (CRYPTO.has(symbol)) return `${symbol}-USD`;
  return symbol.replace(".", "-");
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      try {
        results.push(await mapper(current));
      } catch (error) {
        // Individual quote failures should not blank the whole dashboard.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function samplePoints(points, limit) {
  if (points.length <= limit) return points;
  const step = Math.max(1, Math.ceil(points.length / limit));
  return points.filter((_, index) => index % step === 0).slice(-limit);
}

function clipHistoryForRange(points, rangeKey, meta = {}) {
  if (rangeKey !== "1d") return points;
  const end = Number(meta.regularMarketTime || points.at(-1)?.time || Date.now() / 1000);
  const cutoff = end - 24 * 60 * 60;
  const clipped = points.filter((point) => Number(point.time) >= cutoff);
  return clipped.length >= 8 ? clipped : points.slice(-160);
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (const char of line) {
    if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function render() {
  renderTabs();
  renderAsset();
  renderWatchlist();
  renderMovers();
  renderCrypto();
  renderNews();
}

function renderTabs() {
  document.querySelector("#categoryTabs").innerHTML = CATEGORIES.map(([id, label]) => (
    `<button class="tab ${id === state.category ? "is-active" : ""}" type="button" data-category="${id}">${label}</button>`
  )).join("");
}

function renderAsset() {
  const panel = document.querySelector("#assetPanel");
  if (state.loading || state.loadingSelected) {
    panel.innerHTML = `
      <div class="asset-loading">
        <div class="skeleton line short"></div>
        <div class="skeleton price"></div>
        <div class="skeleton chart"></div>
      </div>
    `;
    return;
  }

  const quote = state.quotes.get(state.selected);
  if (!quote) {
    panel.innerHTML = `<div class="empty-state">${escapeHtml(state.error || "No live data")}</div>`;
    return;
  }

  const positive = Number(quote.changePercent) >= 0;
  const watched = state.watchlist.includes(quote.symbol);
  const history = Array.isArray(quote.history) ? quote.history : [];

  panel.innerHTML = `
    <div class="asset-top">
      <div>
        <div class="asset-name-row">
          <h1>${escapeHtml(quote.name || quote.symbol)}</h1>
          <span>${escapeHtml(quote.symbol)} &#183; ${escapeHtml(quote.exchange || quote.type || "Market")}</span>
        </div>
        <div class="price-row">
          <span class="price">${formatMoney(quote.price)}</span>
          <span class="change ${positive ? "is-gain" : "is-loss"}">${formatSignedMoney(quote.change)} (${formatSignedPercent(quote.changePercent)})</span>
        </div>
      </div>
      <button class="watch-toggle ${watched ? "is-active" : ""}" type="button" data-toggle-watch aria-label="Toggle watch">${icon("star")}</button>
    </div>
    <div class="meta-line">${state.updatedAt ? formatDateTime(state.updatedAt) : ""}</div>
    <div class="range-row">${RANGES.map((range) => `<button class="range ${range === state.range ? "is-active" : ""}" type="button" data-range="${range}">${range.toUpperCase()}</button>`).join("")}</div>
    <div class="chart-wrap" data-chart-wrap>${history.length > 1 ? `${chartSvg(history, positive)}${chartHoverMarkup()}` : `<div class="chart-empty">No chart</div>`}</div>
  `;
}

function renderWatchlist() {
  const rows = state.watchlist.map((symbol) => state.quotes.get(symbol)).filter(Boolean);
  document.querySelector("#watchlistPanel").innerHTML = `
    <div class="section-head"><h2>Watchlist</h2></div>
    <div class="quote-list">${rows.length ? rows.map(quoteRow).join("") : `<div class="empty-state">No data</div>`}</div>
  `;
}

function renderMovers() {
  const rows = filteredQuotes()
    .sort((a, b) => Math.abs(Number(b.changePercent || 0)) - Math.abs(Number(a.changePercent || 0)))
    .slice(0, 6);
  document.querySelector("#moversPanel").innerHTML = `
    <div class="section-head"><h2>Movers</h2></div>
    ${simpleTable(rows)}
  `;
}

function renderCrypto() {
  const rows = [...state.quotes.values()].filter((quote) => quote.type === "crypto").slice(0, 6);
  document.querySelector("#cryptoPanel").innerHTML = `
    <div class="section-head"><h2>Crypto</h2></div>
    ${simpleTable(rows)}
  `;
}

function renderNews() {
  document.querySelector("#newsPanel").innerHTML = `
    <div class="section-head"><h2>News</h2></div>
    <div class="news-list">${state.news.length ? state.news.slice(0, 5).map(newsRow).join("") : `<div class="empty-state">No headlines</div>`}</div>
  `;
}

function renderSearch() {
  const container = document.querySelector("#searchResults");
  container.classList.toggle("is-open", state.searchOpen);
  container.innerHTML = state.searchResults.length
    ? state.searchResults.map((result) => `
        <button class="search-result" type="button" role="option" data-select-symbol="${escapeAttr(result.symbol)}">
          <span class="result-symbol">${escapeHtml(result.symbol)}</span>
          <span class="result-name">${escapeHtml(result.name || result.symbol)}</span>
        </button>
      `).join("")
    : `<div class="empty-state">No results</div>`;
}

function quoteRow(quote) {
  const positive = Number(quote.changePercent) >= 0;
  return `
    <button class="quote-row ${quote.symbol === state.selected ? "is-selected" : ""}" type="button" data-select-symbol="${escapeAttr(quote.symbol)}">
      <span><span class="row-symbol">${escapeHtml(quote.symbol)}</span><span class="row-name">${escapeHtml(quote.name || quote.symbol)}</span></span>
      <span class="mini-spark">${sparklineSvg(quote.history || [], positive)}</span>
      <span class="row-price">${formatMoney(quote.price)}</span>
      <span class="${positive ? "is-gain" : "is-loss"}">${formatSignedPercent(quote.changePercent)}</span>
    </button>
  `;
}

function simpleTable(rows) {
  if (!rows.length) return `<div class="empty-state">No data</div>`;
  return `
    <table class="table">
      <thead><tr><th>Symbol</th><th>Price</th><th>Change</th></tr></thead>
      <tbody>${rows.map((quote) => {
        const positive = Number(quote.changePercent) >= 0;
        return `
          <tr>
            <td><button class="table-symbol" type="button" data-select-symbol="${escapeAttr(quote.symbol)}">${escapeHtml(quote.symbol)}<span>${escapeHtml(quote.name || quote.symbol)}</span></button></td>
            <td>${formatMoney(quote.price)}</td>
            <td class="${positive ? "is-gain" : "is-loss"}">${formatSignedPercent(quote.changePercent)}</td>
          </tr>
        `;
      }).join("")}</tbody>
    </table>
  `;
}

function newsRow(item) {
  return `
    <a class="news-row" href="${escapeAttr(item.link || "#")}" target="_blank" rel="noreferrer">
      <span>${escapeHtml(item.title || "Market update")}</span>
      <small>${escapeHtml(item.publisher || "News")}</small>
    </a>
  `;
}

function filteredQuotes() {
  const quotes = [...state.quotes.values()];
  if (state.category === "crypto") return quotes.filter((quote) => quote.type === "crypto");
  if (state.category === "etfs") return quotes.filter((quote) => quote.type === "etf");
  if (state.category === "us") return quotes.filter((quote) => quote.type !== "crypto");
  return quotes;
}

function closeSearch() {
  state.searchOpen = false;
  renderSearch();
}

function isUsableQuote(quote) {
  return quote && quote.symbol && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0;
}

function readWatchlist() {
  try {
    const stored = JSON.parse(localStorage.getItem("marketpulse:watchlist") || "[]");
    if (Array.isArray(stored) && stored.length) return stored;
  } catch (error) {
    // Ignore invalid local state.
  }
  return ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "BTC", "ETH"];
}

function chartSvg(points, positive) {
  const path = makePath(points, 900, 340, 18);
  if (!path.line) return "";
  const color = positive ? "#0a8f54" : "#d93025";
  return `
    <svg class="chart-svg" viewBox="0 0 900 340" preserveAspectRatio="none" role="img">
      ${[76, 152, 228, 304].map((y) => `<line class="chart-grid-line" x1="0" y1="${y}" x2="900" y2="${y}"></line>`).join("")}
      <path class="chart-fill" d="${path.area}" fill="${color}"></path>
      <path class="chart-line" d="${path.line}" stroke="${color}"></path>
    </svg>
  `;
}

function chartHoverMarkup() {
  return `
    <div class="chart-hover" aria-hidden="true">
      <div class="chart-crosshair"></div>
      <div class="chart-point"></div>
      <div class="chart-tooltip">
        <strong data-chart-price></strong>
        <span data-chart-time></span>
        <span data-chart-change></span>
      </div>
    </div>
  `;
}

function updateChartHover(event, chart) {
  const quote = state.quotes.get(state.selected);
  const points = (quote?.history || []).filter((point) => Number.isFinite(Number(point.price)));
  if (points.length < 2) {
    hideChartHover(chart);
    return;
  }

  const rect = chart.getBoundingClientRect();
  const x = clamp(event.clientX - rect.left, 0, rect.width);
  const xPad = rect.width * (18 / 900);
  const yPad = rect.height * (18 / 340);
  const plotWidth = Math.max(1, rect.width - xPad * 2);
  const ratio = clamp((x - xPad) / plotWidth, 0, 1);
  const index = Math.round(ratio * (points.length - 1));
  const point = points[index];
  const values = points.map((item) => Number(item.price));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const valueRange = max - min || Math.max(1, max * 0.01);
  const xPos = xPad + (index / (points.length - 1)) * plotWidth;
  const yPos = yPad + (1 - (Number(point.price) - min) / valueRange) * (rect.height - yPad * 2);
  const first = Number(points[0].price);
  const pointPrice = Number(point.price);
  const change = pointPrice - first;
  const changePercent = first ? (change / first) * 100 : 0;
  const positive = change >= 0;
  const hover = chart.querySelector(".chart-hover");
  const crosshair = chart.querySelector(".chart-crosshair");
  const dot = chart.querySelector(".chart-point");
  const tooltip = chart.querySelector(".chart-tooltip");
  const price = chart.querySelector("[data-chart-price]");
  const time = chart.querySelector("[data-chart-time]");
  const pointChange = chart.querySelector("[data-chart-change]");
  if (!hover || !crosshair || !dot || !tooltip || !price || !time || !pointChange) return;

  chart.style.setProperty("--chart-hover-color", positive ? "#0a8f54" : "#d93025");
  price.textContent = formatMoney(pointPrice);
  time.textContent = formatPointTime(point.time);
  pointChange.textContent = `${formatSignedMoney(change)} (${formatSignedPercent(changePercent)})`;
  pointChange.className = positive ? "is-gain" : "is-loss";
  crosshair.style.transform = `translateX(${xPos}px)`;
  dot.style.transform = `translate(${xPos}px, ${yPos}px)`;
  hover.classList.add("is-visible");

  const tooltipWidth = tooltip.offsetWidth || 142;
  const tooltipHeight = tooltip.offsetHeight || 70;
  const tooltipLeft = xPos > rect.width - tooltipWidth - 24 ? xPos - tooltipWidth - 12 : xPos + 12;
  tooltip.style.left = `${clamp(tooltipLeft, 8, rect.width - tooltipWidth - 8)}px`;
  tooltip.style.top = `${clamp(yPos - tooltipHeight - 12, 8, rect.height - tooltipHeight - 8)}px`;
}

function hideChartHover(chart) {
  chart.querySelector(".chart-hover")?.classList.remove("is-visible");
}

function sparklineSvg(points, positive) {
  const values = points.map((point) => Number(point.price)).filter(Number.isFinite);
  if (values.length < 8) return "";
  const path = makePath(points, 84, 28, 2);
  if (!path.line) return "";
  return `<svg class="sparkline-svg" viewBox="0 0 84 28" preserveAspectRatio="none" aria-hidden="true"><path d="${path.line}" fill="none" stroke="${positive ? "#0a8f54" : "#d93025"}" stroke-width="1.8" stroke-linecap="round"></path></svg>`;
}

function makePath(points, width, height, padding) {
  const values = points.map((point) => Number(point.price)).filter(Number.isFinite);
  if (values.length < 2) return { line: "", area: "" };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(1, max * 0.01);
  const coords = values.map((value, index) => {
    const x = padding + (index / (values.length - 1)) * (width - padding * 2);
    const y = padding + (1 - (value - min) / range) * (height - padding * 2);
    return [x, y];
  });
  const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  return {
    line,
    area: `${line} L${last[0].toFixed(2)} ${height - padding} L${first[0].toFixed(2)} ${height - padding} Z`,
  };
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "--";
  return formatCurrency(number, Math.abs(number) >= 1 ? 2 : 6);
}

function formatCurrency(number, maximumFractionDigits) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  }).format(number);
}

function formatSignedMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const sign = number > 0 ? "+" : number < 0 ? "-" : "";
  const absolute = Math.abs(number);
  return `${sign}${formatCurrency(absolute, absolute >= 0.01 ? 2 : 6)}`;
}

function formatSignedPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatDateTime(date) {
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function formatPointTime(epochSeconds) {
  const date = new Date(Number(epochSeconds) * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  const dateOptions = state.range === "1d" || state.range === "5d"
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric" };
  return date.toLocaleString([], dateOptions);
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-open");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-open"), 2200);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function icon(name) {
  const icons = {
    pulse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M3 13h4l2-6 4 12 3-8h5"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5L21 21"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M19 11a7 7 0 0 0-12-4l-3 3"/><path d="M5 13a7 7 0 0 0 12 4l3-3"/></svg>`,
    star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.1L12 17.2 6.4 20.1 7.5 14 3 9.6l6.2-.9L12 3z"/></svg>`,
  };
  return icons[name] || "";
}
