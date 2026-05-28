const DEFAULT_SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ", "META", "AMZN", "GOOGL", "BTC", "ETH", "SOL", "XRP"];
const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA"]);
const CATEGORIES = [
  ["overview", "Market"],
  ["us", "US"],
  ["crypto", "Crypto"],
  ["etfs", "ETFs"],
];
const RANGES = ["1d", "5d", "1mo", "6mo", "ytd", "1y"];

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
      <button class="brand" type="button" data-select-symbol="AAPL" aria-label="MarketPulse home">
        <span class="brand-mark">${icon("pulse")}</span>
        <span>MarketPulse</span>
      </button>
      <div class="search-wrap">
        <span class="search-icon">${icon("search")}</span>
        <input id="searchInput" class="search-input" type="search" autocomplete="off" placeholder="Search" aria-label="Search stocks, ETFs, crypto" />
        <div id="searchResults" class="search-results" role="listbox"></div>
      </div>
      <button id="refreshButton" class="icon-button" type="button" aria-label="Refresh">${icon("refresh")}</button>
      <div class="live-state" aria-live="polite"><span id="liveDot" class="live-dot"></span><span id="statusText">--</span></div>
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
  setInterval(updateStatus, 1000);
  setInterval(loadAll, 60000);
}

function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target;
    const select = target.closest("[data-select-symbol]");
    const range = target.closest("[data-range]");
    const category = target.closest("[data-category]");
    const watch = target.closest("[data-toggle-watch]");
    const refresh = target.closest("#refreshButton");

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
    } else if (refresh) {
      loadAll(true);
    } else if (!target.closest(".search-wrap")) {
      closeSearch();
    }
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
    searchTimer = setTimeout(() => search(query), 180);
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
    const data = await fetchJson(`/api/quotes?symbols=${encodeURIComponent(DEFAULT_SYMBOLS.join(","))}`);
    const quotes = Array.isArray(data.quotes) ? data.quotes.filter((quote) => isUsableQuote(quote)) : [];
    if (!quotes.length) throw new Error("No live quotes returned");

    state.quotes = new Map(quotes.map((quote) => [quote.symbol, quote]));
    if (!state.quotes.has(state.selected)) state.selected = quotes[0].symbol;
    state.updatedAt = data.updatedAt ? new Date(data.updatedAt * 1000) : new Date();
    state.nextRefreshAt = Date.now() + 60000;
    state.live = true;
    state.loading = false;

    await Promise.all([loadHistory(state.selected, state.range, false), loadNews(state.selected, false)]);
    render();
    if (force) showToast("Updated");
  } catch (error) {
    state.live = false;
    state.loading = false;
    if (!state.quotes.size) state.error = "Live data unavailable";
    render();
  }
}

async function loadHistory(symbol, range, shouldRender = true) {
  state.loadingSelected = !state.quotes.has(symbol);
  if (shouldRender) renderAsset();

  try {
    const data = await fetchJson(`/api/history?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(range)}`);
    const quote = data.quote || state.quotes.get(symbol);
    if (isUsableQuote(quote)) {
      state.quotes.set(symbol, {
        ...state.quotes.get(symbol),
        ...quote,
        history: Array.isArray(data.history) ? data.history : quote.history || [],
      });
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
    const data = await fetchJson(`/api/news?symbol=${encodeURIComponent(symbol)}`);
    state.news = Array.isArray(data.news) ? data.news : [];
  } catch (error) {
    state.news = [];
  }
  if (shouldRender) renderNews();
}

async function search(query) {
  try {
    const data = await fetchJson(`/api/search?q=${encodeURIComponent(query)}`);
    state.searchResults = Array.isArray(data.results) ? data.results : [];
  } catch (error) {
    state.searchResults = [];
  }
  state.searchOpen = true;
  renderSearch();
}

function selectSymbol(symbol) {
  if (!symbol) return;
  state.selected = symbol.replace("-USD", "").toUpperCase();
  localStorage.setItem("marketpulse:selected", state.selected);
  document.querySelector("#searchInput").value = "";
  loadHistory(state.selected, state.range);
  loadNews(state.selected);
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

function render() {
  renderTabs();
  renderAsset();
  renderWatchlist();
  renderMovers();
  renderCrypto();
  renderNews();
  updateStatus();
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
    <div class="chart-wrap">${history.length > 1 ? chartSvg(history, positive) : `<div class="chart-empty">No chart</div>`}</div>
  `;
}

function renderWatchlist() {
  const rows = state.watchlist.map((symbol) => state.quotes.get(symbol)).filter(Boolean);
  document.querySelector("#watchlistPanel").innerHTML = `
    <div class="section-head">
      <h2>Watchlist</h2>
    </div>
    <div class="quote-list">
      ${rows.length ? rows.map(quoteRow).join("") : `<div class="empty-state">No data</div>`}
    </div>
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
    <div class="news-list">
      ${state.news.length ? state.news.slice(0, 5).map(newsRow).join("") : `<div class="empty-state">No headlines</div>`}
    </div>
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
      <span>
        <span class="row-symbol">${escapeHtml(quote.symbol)}</span>
        <span class="row-name">${escapeHtml(quote.name || quote.symbol)}</span>
      </span>
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
          <tr data-select-symbol="${escapeAttr(quote.symbol)}">
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

function updateStatus() {
  const status = document.querySelector("#statusText");
  const dot = document.querySelector("#liveDot");
  if (!status || !dot) return;
  dot.classList.toggle("is-off", !state.live);
  if (state.loading) {
    status.textContent = "Loading";
    return;
  }
  if (!state.live) {
    status.textContent = "Offline";
    return;
  }
  const seconds = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  status.textContent = `Live ${seconds || 60}s`;
}

function closeSearch() {
  state.searchOpen = false;
  renderSearch();
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Request failed ${response.status}`);
  return response.json();
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

function sparklineSvg(points, positive) {
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

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(number) >= 1 ? 2 : 6,
  }).format(number);
}

function formatSignedMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const sign = number > 0 ? "+" : "";
  return `${sign}${formatMoney(number)}`;
}

function formatSignedPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatDateTime(date) {
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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
