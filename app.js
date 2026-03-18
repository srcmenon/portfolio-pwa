/* ============================================================
   CapIntel — app.js
   Main application logic for the portfolio tracker PWA.

   Architecture overview:
   ┌─────────────┐    ┌──────────────┐    ┌──────────────────┐
   │  IndexedDB  │◄──►│  app.js      │◄──►│  Vercel API      │
   │  (db.js)    │    │  (this file) │    │  /api/price.js   │
   └─────────────┘    └──────┬───────┘    │  /api/recommend  │
                             │            └──────────────────┘
                       Chart.js (CDN)

   Data flow:
   1. db.js opens IndexedDB, calls startApp() on success
   2. startApp() loads assets → calculates portfolio → renders UI
   3. updatePrices() fetches live prices from /api/price (Yahoo Finance proxy)
   4. recordPortfolioSnapshot() saves timestamped value to portfolioHistory store
   5. Growth chart reads portfolioHistory and plots by period + category

   Key globals:
   - db            : IndexedDB database handle (set in db.js)
   - lastPortfolio : cached result of calculatePortfolio(), shared across tabs
   - FX            : live EUR-base exchange rates (updated hourly)
   ============================================================ */


/* ── GLOBAL STATE ─────────────────────────────────────────── */

let allocationChartInstance = null   /* Chart.js instance for Asset Allocation donut */
let currencyChartInstance   = null   /* Chart.js instance for Currency Exposure donut */
let growthChartInstance     = null   /* unused — kept to avoid reference errors */
let priceUpdateRunning      = false  /* mutex: prevents overlapping price fetch loops */
let lastPortfolio           = []     /* last computed portfolio array, cached for tab reuse */


/* ── DOM READY: set default date on the Add Asset form ───── */
window.addEventListener("DOMContentLoaded", () => {
  const d = document.getElementById("assetDate")
  if(d) d.value = new Date().toISOString().split("T")[0]
})


/* ── NSE DISPLAY NAMES ────────────────────────────────────
   Maps raw NSE ticker symbols to readable company names.
   Yahoo Finance uses the raw ticker (e.g. "BAJFINANCE"),
   but we display the friendly name in the UI.
   Add new entries here whenever a new NSE stock is added. */
const NSE_NAMES = {
  BAJFINANCE:"Bajaj Finance",     BEL:"Bharat Electronics",    BERGEPAINT:"Berger Paints",
  CDSL:"CDSL",                    COALINDIA:"Coal India",       CRISIL:"CRISIL Ltd",
  DREAMFOLKS:"Dreamfolks Services", ENGINERSIN:"Engineers India", ETERNAL:"Eternal Ltd",
  GESHIP:"Great Eastern Shipping", HDFCBANK:"HDFC Bank",        HEROMOTOCO:"Hero MotoCorp",
  HINDUNILVR:"Hindustan Unilever", IDFCFIRSTB:"IDFC First Bank", INDHOTEL:"Indian Hotels",
  INFY:"Infosys",                 IOLCP:"IOL Chemicals",        IRCTC:"IRCTC",
  ITC:"ITC Ltd",                  ITCHOTELS:"ITC Hotels",       JINDALSTEL:"Jindal Steel & Power",
  JIOFIN:"Jio Financial Services", KALYANKJIL:"Kalyan Jewellers", KEI:"KEI Industries",
  KIRLPNU:"Kirloskar Pneumatic",  KPITTECH:"KPIT Technologies", KTKBANK:"Karnataka Bank",
  KWIL:"Kiri Industries",         LICHSGFIN:"LIC Housing Finance", LICI:"LIC of India",
  LT:"Larsen & Toubro",           LTFOODS:"LT Foods",           MAANALU:"Maan Aluminium",
  MAHSEAMLES:"Maharashtra Seamless", NATIONALUM:"National Aluminium", NAVA:"NAVA Ltd",
  NLCINDIA:"NLC India",           NMDC:"NMDC Ltd",              OFSS:"Oracle Financial Services",
  OIL:"Oil India",                ONGC:"ONGC",                  PATELENG:"Patel Engineering",
  PERSISTENT:"Persistent Systems", PFC:"Power Finance Corp",    PIDILITIND:"Pidilite Industries",
  POWERGRID:"Power Grid Corp",    PTC:"PTC India",              PVRINOX:"PVR Inox",
  RECLTD:"REC Ltd",               RELIANCE:"Reliance Industries", RPOWER:"Reliance Power",
  SAIL:"SAIL",                    SBIN:"State Bank of India",   SCHAEFFLER:"Schaeffler India",
  SHRIRAMFIN:"Shriram Finance",   SOBHA:"Sobha Ltd",            SOLARINDS:"Solar Industries",
  SUNDARMFIN:"Sundaram Finance",  TATACHEM:"Tata Chemicals",    TATASTEEL:"Tata Steel",
  TATATECH:"Tata Technologies",   TCS:"Tata Consultancy Services", TMCV:"Tata Motors (CV)",
  TMPV:"Tata Motors (PV)",        VEDL:"Vedanta Ltd",           VOLTAS:"Voltas Ltd"
}

/* Returns a human-readable name for a portfolio position.
   Falls back to pos.name then pos.key if no NSE mapping exists. */
function resolveDisplayName(pos){
  if(NSE_NAMES[pos.key]) return NSE_NAMES[pos.key]
  return pos.name || pos.key
}


/* ── SERVICE WORKER ───────────────────────────────────────
   Registers sw.js for offline support and PWA installability.
   The SW handles caching strategy: network-first for HTML/JS/CSS,
   cache-first for icons and fonts. See sw.js for details. */
if("serviceWorker" in navigator){
  navigator.serviceWorker.register("sw.js")
}


/* ── FX ENGINE ────────────────────────────────────────────
   All portfolio values are stored and displayed in EUR.
   These rates convert INR/USD amounts to EUR.
   Fallback values are used if the live fetch fails.
   Rates are refreshed once per hour via setInterval. */
let FX = {
  EUR: 1,
  USD: 1.09,   /* fallback: ~1.09 USD per EUR */
  INR: 104     /* fallback: ~104 INR per EUR  */
}

async function updateFX(){
  try{
    const r    = await fetch("https://api.exchangerate.host/latest?base=EUR")
    const data = await r.json()
    if(data && data.rates){
      FX.INR = data.rates.INR
      FX.USD = data.rates.USD
    }
  }catch(e){
    console.log("FX update failed — using fallback rates")
  }
}

updateFX()
setInterval(updateFX, 3600000) /* refresh every hour */


/* ── FORMAT HELPERS ───────────────────────────────────────
   Small utility functions used throughout the app. */

/* Formats a number as currency with the correct symbol.
   Always shows 2 decimal places. */
function formatCurrency(value, currency){
  let symbol = ""
  if(currency === "EUR") symbol = "€"
  if(currency === "USD") symbol = "$"
  if(currency === "INR") symbol = "₹"
  return symbol + Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
}

/* Strips currency symbols and commas, returns a plain number. */
function parseMoney(v){
  return Number(String(v).replace(/[^0-9.-]+/g, ""))
}

/* Converts any supported currency value to EUR using live FX rates. */
function convertToEUR(value, currency){
  if(currency === "EUR") return value
  return value / FX[currency]
}

/* Converts a EUR amount back to a target currency. */
function convertFromEUR(value, currency){
  if(currency === "EUR") return value
  return value * FX[currency]
}


/* ── DATABASE ENGINE ──────────────────────────────────────
   Thin wrappers around the IndexedDB "assets" object store.
   The DB handle `db` is set by db.js before startApp() is called.

   Schema:
   - assets store         : keyPath "id" (autoIncrement)
     Fields: name, ticker, broker, type, currency, quantity,
             buyPrice, buyPriceEUR, currentPrice, buyDate
   - portfolioHistory store : keyPath "timestamp"
     Fields: timestamp (ms), value (EUR total), cats (per-category EUR breakdown)
*/

/* Returns a Promise resolving to all asset records. */
function getAssets(){
  return new Promise(resolve => {
    const tx    = db.transaction("assets", "readonly")
    const store = tx.objectStore("assets")
    store.getAll().onsuccess = e => resolve(e.target.result)
  })
}

/* Writes a new asset record (no duplicate check — each row is a buy lot). */
function saveAsset(asset){
  const tx = db.transaction("assets", "readwrite")
  tx.objectStore("assets").add(asset)
}

/* Deletes a single asset by auto-incremented id, then refreshes the table. */
function deleteAsset(id){
  if(!db) return
  const tx = db.transaction("assets", "readwrite")
  tx.objectStore("assets").delete(id)
  tx.oncomplete = () => loadAssets()
}

/* Partial sell: reduces quantity of a single lot.
   If sellQty >= currentQty, prompts to fully remove the position. */
async function sellPartial(id, currentQty, name){
  const input = prompt(`Sell how many units of ${name}?\nCurrent holding: ${currentQty}`)
  if(input === null) return
  const sellQty = parseFloat(input)
  if(isNaN(sellQty) || sellQty <= 0){
    alert("Please enter a valid number greater than 0.")
    return
  }
  if(sellQty >= currentQty){
    if(confirm(`Selling ${sellQty} units would fully exit ${name}. Remove it entirely?`)){
      deleteAsset(id)
    }
    return
  }
  /* Round to 8 decimal places to avoid floating-point drift */
  const newQty  = Math.round((currentQty - sellQty) * 1e8) / 1e8
  const assets  = await getAssets()
  const asset   = assets.find(a => a.id === id)
  if(!asset) return
  const tx      = db.transaction("assets", "readwrite")
  tx.objectStore("assets").put({ ...asset, quantity: newQty })
  tx.oncomplete = () => loadAssets()
}


/* ── PORTFOLIO ENGINE ─────────────────────────────────────
   Transforms raw asset records into grouped, calculated positions.

   groupAssets()
     Groups individual buy lots by ticker/name key.
     e.g. 3 purchases of NVDA → one group with 3 items.

   calculatePortfolio()
     Converts groups into position objects with:
     - qty, avgBuy, currentPrice (all in original currency)
     - totalBuyEUR, totalCurrentEUR, profitEUR, growth (all in EUR)

   Both functions are pure — they do not touch the DOM or DB. */

/* Groups raw asset records by ticker (or name if no ticker).
   Returns: { "NVDA": [...], "BAJFINANCE": [...], ... } */
function groupAssets(assets){
  const groups = {}
  assets.forEach(a => {
    const key = a.ticker || a.name
    if(!groups[key]) groups[key] = []
    groups[key].push(a)
  })
  return groups
}

/* Converts grouped lots into summarised position objects.
   All monetary values are calculated in the asset's native currency,
   then converted to EUR for cross-currency comparison. */
function calculatePortfolio(groups){
  const results = []
  Object.keys(groups).forEach(key => {
    const list     = groups[key]
    let qty        = 0
    let totalBuyLocal = 0
    const currency = list[0].currency || "EUR"
    const name     = list[0].name || key
    const type     = list[0].type || ""
    let lastDate   = ""

    list.forEach(a => {
      const q   = a.quantity || 0
      const buy = a.buyPrice  || 0
      qty          += q
      totalBuyLocal += buy * q
      if(a.buyDate && a.buyDate > lastDate) lastDate = a.buyDate
    })

    const avgBuy         = qty ? totalBuyLocal / qty : 0
    /* Use the most recent currentPrice from any lot; fall back to avgBuy */
    const currentPrice   = list.reduce((p, c) => c.currentPrice || p, 0) || avgBuy
    const totalCurrentLocal = currentPrice * qty
    const buyEUR         = convertToEUR(avgBuy,       currency)
    const currentEUR     = convertToEUR(currentPrice, currency)
    const totalBuyEUR    = buyEUR     * qty
    const totalCurrentEUR = currentEUR * qty
    const profitLocal    = totalCurrentLocal - totalBuyLocal
    const profitEUR      = totalCurrentEUR   - totalBuyEUR
    const growth         = totalBuyLocal > 0
      ? ((totalCurrentLocal - totalBuyLocal) / totalBuyLocal) * 100
      : 0

    results.push({
      key, name, type, currency,
      qty, avgBuy, currentPrice,
      totalBuyLocal, totalCurrentLocal,
      totalBuyEUR,   totalCurrentEUR,
      profitLocal,   profitEUR,
      growth,        lastDate,
      list
    })
  })
  return results
}


/* ── UI RENDER ENGINE ─────────────────────────────────────
   loadAssets() is the main entry point called after every DB change.
   It reads assets → calculates → sorts → filters → renders everything. */

async function loadAssets(){
  if(!db) return
  try{
    const assets    = await getAssets()
    const groups    = groupAssets(assets)
    const portfolio = calculatePortfolio(groups)

    /* Cache the full portfolio for use by the Insights tab and chart */
    lastPortfolio = portfolio

    /* Sort by user-selected sort order */
    const sortVal = document.getElementById("sortAssets")?.value || "name"
    portfolio.sort((a, b) => {
      if(sortVal === "growth")  return b.growth          - a.growth
      if(sortVal === "profit")  return b.profitEUR       - a.profitEUR
      if(sortVal === "value")   return b.totalCurrentEUR - a.totalCurrentEUR
      return resolveDisplayName(a).localeCompare(resolveDisplayName(b))
    })

    /* Apply search/type/growth filters for the table only
       (summary cards always use the full portfolio) */
    const filtered = applyFilters(portfolio)

    renderPortfolioTable(filtered)
    renderPortfolioSummary(portfolio)
    renderPortfolioReturn(portfolio)

    /* Only redraw Insights charts if that tab is currently visible */
    if(document.getElementById("insightsTab")?.classList.contains("active")){
      drawCharts(lastPortfolio)
      drawGrowthChart()
      renderInsightsSummary(lastPortfolio)
      renderTopMovers(lastPortfolio)
    }
  }catch(err){
    console.error("loadAssets error:", err)
    const tb = document.querySelector("#assetTable tbody")
    if(tb) tb.innerHTML = `<tr><td colspan="11" style="color:var(--red);padding:16px">⚠️ Load error: ${err.message} — check console</td></tr>`
  }
}

/* Builds the main asset table rows.
   Each row shows a grouped position (all lots of the same ticker combined).
   Clicking ▶ expands sub-rows showing individual purchase lots.
   The last column "Performance" is populated asynchronously by loadGrowthFactors(). */
function renderPortfolioTable(portfolio){
  const table = document.querySelector("#assetTable tbody")
  if(!table) return
  table.innerHTML = ""

  updateSearchDropdown(portfolio) /* expose to search dropdown */

  portfolio.forEach(pos => {
    let plClass = "neutral"
    if(pos.profitEUR > 0)      plClass = "profit"
    else if(pos.profitEUR < 0) plClass = "loss"

    const groupId     = "grp_" + pos.key.replace(/[^a-zA-Z0-9]/g, "_")
    const displayName = resolveDisplayName(pos)
    const showTicker  = pos.key !== displayName  /* only show ticker badge if different from display name */
    const typeBadge   = pos.type
      ? `<span class="badge badge-${pos.type}">${pos.type}</span>`
      : ""

    const row = document.createElement("tr")
    row.dataset.key = pos.key
    row.innerHTML = `
      <td>
        <span class="toggleBtn" data-target="${groupId}">▶</span>
        <span class="asset-name">${displayName}</span>
        ${showTicker ? `<span class="asset-sub">${pos.key}</span>` : ""}
      </td>
      <td class="num">${pos.qty.toFixed(3)}</td>
      <td>
        <span class="num">${formatCurrency(pos.avgBuy, pos.currency)}</span>
        <span class="eurValue">${formatCurrency(convertToEUR(pos.avgBuy, pos.currency), "EUR")}</span>
      </td>
      <td>
        <span class="num">${formatCurrency(pos.currentPrice, pos.currency)}</span>
        <span class="eurValue">${formatCurrency(convertToEUR(pos.currentPrice, pos.currency), "EUR")}</span>
      </td>
      <td>
        <span class="num">${formatCurrency(pos.totalBuyLocal, pos.currency)}</span>
        <span class="eurValue">${formatCurrency(pos.totalBuyEUR, "EUR")}</span>
      </td>
      <td>
        <span class="num">${formatCurrency(pos.totalCurrentLocal, pos.currency)}</span>
        <span class="eurValue">${formatCurrency(pos.totalCurrentEUR, "EUR")}</span>
      </td>
      <td class="${plClass}">
        ${formatCurrency(pos.profitLocal, pos.currency)}
        <span class="eurValue">${formatCurrency(pos.profitEUR, "EUR")}</span>
      </td>
      <td class="${plClass}">${pos.growth.toFixed(2)}%</td>
      <td>${typeBadge}</td>
      <td class="num" style="font-size:12px;color:var(--dim)">${pos.lastDate || ""}</td>
      <td class="perf-cell" id="perf_${pos.key.replace(/[^a-zA-Z0-9]/g, "_")}">
        <span class="perf-loading">…</span>
      </td>`
    table.appendChild(row)

    /* Sub-rows: one per buy lot, collapsed by default */
    pos.list.forEach(a => {
      const sub = document.createElement("tr")
      sub.className     = "subRow " + groupId
      sub.style.display = "none"
      sub.innerHTML = `
        <td>↳ ${a.buyDate || ""}</td>
        <td class="num">${a.quantity}</td>
        <td class="num">${formatCurrency(a.buyPrice, a.currency)}</td>
        <td class="num">${formatCurrency(a.currentPrice || a.buyPrice, a.currency)}</td>
        <td colspan="4" style="color:var(--dim)">${a.broker || ""}</td>
        <td>
          <button class="btn-edit-lot" onclick="editAsset(${a.id})">✏️ Edit</button>
          <button class="btn-sell-partial"
            data-assetid="${a.id}"
            data-qty="${a.quantity}"
            data-name="${(a.name || "").replace(/"/g, "&quot;")}">Sell %</button>
          <button onclick="deleteAsset(${a.id})">Remove</button>
        </td>`
      table.appendChild(sub)
    })
  })

  setupToggleButtons()
  /* Load 1D–5Y performance chips after table renders — chips fill in as API responses arrive */
  loadGrowthFactors(portfolio)
}

/* ── PERFORMANCE CHART BUTTON ─────────────────────────────
   Replaces the old chip approach. Renders a small "📈" button in the
   Performance column for each non-MF position.
   Clicking the button opens a modal with a Chart.js price chart and
   period tabs (1D / 1W / 1M / 1Y / 5Y).
   Data is fetched on demand when the modal opens — nothing pre-loaded. */
function loadGrowthFactors(portfolio){
  const targets = portfolio.filter(p => p.key && p.type !== "MutualFund")
  targets.forEach(pos => {
    const cellId = "perf_" + pos.key.replace(/[^a-zA-Z0-9]/g, "_")
    const cell   = document.getElementById(cellId)
    if(!cell) return
    const symbol  = resolveTicker({ ticker: pos.key, currency: pos.currency, type: pos.type })
    const name    = resolveDisplayName(pos)
    if(!symbol){ cell.innerHTML = `<span class="perf-loading">–</span>`; return }
    cell.innerHTML =
      `<button class="perf-chart-btn" onclick="openPerfModal('${symbol}','${name.replace(/'/g,"\\'")}','${pos.currency}')">📈</button>`
  })
}

/* ── PERFORMANCE MODAL ────────────────────────────────────
   Opens a floating modal with a mini price chart for the given symbol.
   Period buttons fetch and render the chart for 1D/1W/1M/1Y/5Y.
   Chart.js instance is stored in window._perfChartInstance. */
let _perfSymbol = null
let _perfName   = null
let _perfCur    = null

function openPerfModal(symbol, name, currency){
  _perfSymbol = symbol
  _perfName   = name
  _perfCur    = currency

  const modal = document.getElementById("perfModal")
  if(!modal) return
  document.getElementById("perfModalTitle").textContent = name
  modal.classList.add("open")

  /* Reset period buttons, activate 1M by default */
  document.querySelectorAll(".perf-period-btn").forEach(b => b.classList.remove("active"))
  const def = document.querySelector('.perf-period-btn[data-range="1mo"]')
  if(def) def.classList.add("active")

  loadPerfChart("1mo", "1M")
}

function closePerfModal(){
  const modal = document.getElementById("perfModal")
  if(modal) modal.classList.remove("open")
  if(window._perfChartInstance){ window._perfChartInstance.destroy(); window._perfChartInstance = null }
}

function setPerfPeriod(btn, range, label){
  document.querySelectorAll(".perf-period-btn").forEach(b => b.classList.remove("active"))
  btn.classList.add("active")
  loadPerfChart(range, label)
}

async function loadPerfChart(range, label){
  const canvas  = document.getElementById("perfModalCanvas")
  const loading = document.getElementById("perfModalLoading")
  const statEl  = document.getElementById("perfModalStat")
  if(!canvas || !loading) return

  loading.style.display = "flex"
  canvas.style.display  = "none"
  statEl.textContent    = ""

  if(window._perfChartInstance){ window._perfChartInstance.destroy(); window._perfChartInstance = null }

  /* For 1D use current price + changePercent — no history endpoint */
  if(range === "1d"){
    try{
      const r = await fetch(`/api/price?ticker=${encodeURIComponent(_perfSymbol)}`)
      if(!r.ok) throw new Error("price fetch failed")
      const d = await r.json()
      loading.style.display = "none"
      const pct = d.changePercent
      const cls = pct >= 0 ? "pf-up" : "pf-dn"
      const s   = pct >= 0 ? "+" : ""
      statEl.innerHTML = `<span class="${cls}" style="font-size:22px;font-weight:700;font-family:var(--mono)">${s}${pct != null ? pct.toFixed(2)+"%" : "–"}</span> <span style="font-size:12px;color:var(--dim)">today vs prev close</span>`
      canvas.style.display = "none"
    }catch(e){
      loading.style.display = "none"
      statEl.textContent = "No data"
    }
    return
  }

  try{
    const r = await fetch(`/api/price?ticker=${encodeURIComponent(_perfSymbol)}&range=${range}&history=true`)
    if(!r.ok) throw new Error("history fetch failed")
    const d = await r.json()
    if(!d.timestamps?.length) throw new Error("no data")

    const labels = d.timestamps.map(ts => {
      const dt = new Date(ts)
      if(range === "5d") return dt.toLocaleDateString([], {month:"short", day:"numeric"})
      if(range === "1mo") return dt.toLocaleDateString([], {month:"short", day:"numeric"})
      if(range === "3mo" || range === "6mo") return dt.toLocaleDateString([], {month:"short", day:"numeric"})
      return dt.toLocaleDateString([], {year:"2-digit", month:"short"})
    })
    const values = d.closes
    const first  = values[0], last = values[values.length-1]
    const pct    = first > 0 ? ((last-first)/first)*100 : 0
    const isUp   = pct >= 0
    const color  = isUp ? "#22d17a" : "#f4506a"
    const s      = isUp ? "+" : ""

    statEl.innerHTML =
      `<span style="font-size:22px;font-weight:700;font-family:var(--mono);color:${color}">${s}${pct.toFixed(2)}%</span>` +
      `<span style="font-size:12px;color:var(--dim);margin-left:8px">over ${label}</span>` +
      `<span style="font-size:12px;color:var(--muted);margin-left:12px">${_perfCur} ${last.toLocaleString(undefined,{maximumFractionDigits:2})}</span>`

    loading.style.display = "none"
    canvas.style.display  = "block"

    const rgb = isUp ? "34,209,122" : "244,80,106"
    window._perfChartInstance = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: color,
          borderWidth: 2,
          pointRadius: values.length > 60 ? 0 : 2,
          pointHoverRadius: 5,
          fill: true,
          backgroundColor: ctx => {
            const g = ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height)
            g.addColorStop(0, `rgba(${rgb},0.3)`)
            g.addColorStop(1, `rgba(${rgb},0.02)`)
            return g
          },
          tension: 0.3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        devicePixelRatio: window.devicePixelRatio || 2,
        interaction: { mode:"index", intersect:false },
        plugins: {
          legend: { display:false },
          tooltip: {
            backgroundColor: "rgba(8,16,40,0.97)",
            titleColor: "#8faac8", bodyColor: "#dce8ff",
            borderColor: `rgba(${rgb},0.4)`, borderWidth: 1,
            callbacks: {
              label: ctx => `${_perfCur} ${ctx.raw.toLocaleString(undefined,{maximumFractionDigits:2})}`
            }
          }
        },
        scales: {
          x: { ticks:{ color:"#8fa3c4", font:{size:10}, maxTicksLimit:7, maxRotation:0 }, grid:{ color:"rgba(91,156,246,0.06)" }, border:{display:false} },
          y: { ticks:{ color:"#8fa3c4", font:{size:10}, maxTicksLimit:6 }, grid:{ color:"rgba(91,156,246,0.06)" }, border:{display:false} }
        }
      }
    })
  }catch(e){
    loading.style.display = "none"
    statEl.textContent = "Could not load chart data"
  }
}


/* ── SEARCH DROPDOWN ──────────────────────────────────────
   Live-search as-you-type over the portfolio.
   Results appear in a floating dropdown below the search input.
   Clicking a result filters the table to that asset. */

/* Stores the portfolio array so the dropdown can filter without a DB read */
function updateSearchDropdown(portfolio){
  window._searchPortfolio = portfolio
}

function bindSearchDropdown(){
  const input    = document.getElementById("filterAsset")
  const dropdown = document.getElementById("searchDropdown")
  if(!input || !dropdown) return

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim()
    if(!q || !window._searchPortfolio){
      dropdown.style.display = "none"
      loadAssets()
      return
    }
    const matches = window._searchPortfolio.filter(p => {
      const dn = resolveDisplayName(p).toLowerCase()
      return dn.includes(q) || p.key.toLowerCase().includes(q)
    })
    if(!matches.length){ dropdown.style.display = "none"; loadAssets(); return }

    dropdown.innerHTML = matches.slice(0, 8).map(p => {
      const dn    = resolveDisplayName(p)
      const showT = p.key !== dn
      return `<div class="search-item" data-value="${dn}">
        <span>${dn}</span>
        ${showT ? `<span class="ticker-tag">${p.key}</span>` : ""}
      </div>`
    }).join("")
    dropdown.style.display = "block"
    loadAssets()
  })

  dropdown.addEventListener("click", e => {
    const item = e.target.closest(".search-item")
    if(item){
      input.value = item.dataset.value
      dropdown.style.display = "none"
      loadAssets()
    }
  })

  /* Close dropdown when clicking anywhere outside */
  document.addEventListener("click", e => {
    if(!input.contains(e.target) && !dropdown.contains(e.target)){
      dropdown.style.display = "none"
    }
  })
}

/* Shows total portfolio value in EUR and INR in the summary cards */
function renderPortfolioSummary(portfolio){
  const totalEUR = portfolio.reduce((s, p) => s + p.totalCurrentEUR, 0)
  const inr      = convertFromEUR(totalEUR, "INR")
  const countEl  = document.getElementById("assetCount")
  const valueEl  = document.getElementById("totalValue")
  if(countEl) countEl.innerText = portfolio.length
  if(valueEl) valueEl.innerHTML = `
    ${formatCurrency(totalEUR, "EUR")}
    <br><span class="inrValue">${formatCurrency(inr, "INR")}</span>`
}

/* Displays total weighted return % in the Portfolio tab header */
function renderPortfolioReturn(portfolio){
  const invested = portfolio.reduce((s, p) => s + p.totalBuyEUR,     0)
  const current  = portfolio.reduce((s, p) => s + p.totalCurrentEUR, 0)
  const retEl    = document.getElementById("portfolioReturn")
  if(!retEl) return
  if(invested <= 0){ retEl.textContent = "No data yet"; return }
  const change = ((current - invested) / invested) * 100
  retEl.textContent = `${change > 0 ? "+" : ""}${change.toFixed(2)}%`
}

/* Wires up the ▶/▼ expand buttons on each table row.
   Uses event delegation on tbody for sell-partial buttons
   to avoid inline onclick handlers with injected data. */
function setupToggleButtons(){
  document.querySelectorAll(".toggleBtn").forEach(btn => {
    btn.onclick = () => {
      const target = btn.dataset.target
      const rows   = document.querySelectorAll("." + target)
      if(!rows.length) return
      const open = rows[0].style.display === "table-row"
      rows.forEach(r => r.style.display = open ? "none" : "table-row")
      btn.textContent = open ? "▶" : "▼"
    }
  })

  /* Event delegation — safer than inline onclick with user-supplied data */
  const table = document.querySelector("#assetTable tbody")
  if(table){
    table.onclick = e => {
      const btn = e.target.closest(".btn-sell-partial")
      if(!btn) return
      sellPartial(Number(btn.dataset.assetid), Number(btn.dataset.qty), btn.dataset.name || "")
    }
  }
}


/* ── PRICE ENGINE ─────────────────────────────────────────
   Handles fetching and updating live market prices.

   updateMutualFundNAV()
     Fetches AMFI's daily NAV text file (pipe-delimited).
     Filters to Growth / Direct plans, skips IDCW/dividend plans.
     Updates matching assets in IndexedDB by scheme code (ticker field).

   resolveTicker()
     Maps internal ticker + currency/type to the correct Yahoo Finance symbol.
     e.g. BAJFINANCE → BAJFINANCE.NS, IWDA (EUR ETF) → IWDA.L

   fetchPrice()
     Calls /api/price (Vercel serverless) which proxies Yahoo Finance.
     Returns null on any failure so the loop continues safely.

   updatePrices()
     Loops all non-MF assets, fetches price, saves to DB.
     After completion: records a portfolio snapshot + refreshes UI.
     Runs every 5 minutes. */

async function updateMutualFundNAV(){
  if(!db) return
  try{
    const res  = await fetch("/api/mfnav")
    const text = await res.text()
    const navMap = {}

    /* AMFI NAV file format: SchemeCode;ISINGrowth;ISINDividend;SchemeName;NAV;Date */
    for(const line of text.split("\n")){
      if(!line || !line.includes(";")) continue
      const parts      = line.split(";")
      if(parts.length < 6) continue
      const schemeCode = parts[0].trim()
      const schemeName = parts[3].toLowerCase()
      const nav        = parseFloat(parts[4])
      if(!schemeCode || isNaN(nav) || nav <= 0) continue

      /* Skip IDCW / dividend / bonus plans — only want Growth or Direct plans */
      const isExcluded = schemeName.includes("idcw") || schemeName.includes("dividend") ||
                         schemeName.includes("payout") || schemeName.includes("bonus")
      const isGrowth   = schemeName.includes("growth")
      const isDirect   = schemeName.includes("direct")

      /* Accept growth OR direct (catches funds like HDFC Gold ETF FOF - Direct
         which don't have "growth" in the name but are still the correct plan) */
      if(!isExcluded && (isGrowth || isDirect) && !navMap[schemeCode]){
        navMap[schemeCode] = nav
      }
    }

    const assets = await getAssets()

    /* Debug logging — helps diagnose missing or mismatched scheme codes */
    console.group("🔍 Mutual Fund NAV Debug")
    const mfAssets = assets.filter(a => a.type === "MutualFund")
    console.log(`Total MF assets in DB: ${mfAssets.length}`)
    console.log(`Total scheme codes in NAV map: ${Object.keys(navMap).length}`)
    console.groupCollapsed("✅ Matched (scheme code found in AMFI)")
    mfAssets.forEach(a => { if(navMap[a.ticker]) console.log(`${a.name} | code: ${a.ticker} | NAV: ₹${navMap[a.ticker]}`) })
    console.groupEnd()
    console.groupCollapsed("❌ Missed (scheme code NOT found in AMFI)")
    mfAssets.forEach(a => { if(!navMap[a.ticker]) console.log(`${a.name} | code: ${a.ticker}`) })
    console.groupEnd()
    console.groupCollapsed("🔎 Nearby AMFI entries for missed funds (first 3 chars match)")
    mfAssets.forEach(a => {
      if(!navMap[a.ticker]){
        const prefix = String(a.ticker).slice(0, 3)
        const nearby = Object.keys(navMap).filter(k => k.startsWith(prefix))
        if(nearby.length) console.log(`${a.name} (${a.ticker}) → nearby codes:`, nearby)
      }
    })
    console.groupEnd()
    console.groupEnd()

    /* Write updated NAVs back to the database */
    const tx    = db.transaction("assets", "readwrite")
    const store = tx.objectStore("assets")
    for(const a of assets){
      if(a.type !== "MutualFund") continue
      const nav = navMap[a.ticker]
      if(!nav) continue
      store.put({ ...a, currentPrice: nav })
    }
    tx.oncomplete = () => loadAssets()

  }catch(e){
    console.log("MF NAV update failed", e)
  }
}

/* Resolves a stored ticker + asset metadata to the correct Yahoo Finance symbol.

   The preferred approach is to always use the autocomplete when adding assets —
   it returns the full Yahoo symbol (e.g. AI3A.DE, SAP.DE, IWDA.L) which already
   has the correct exchange suffix. The dot-passthrough rule below handles these.

   For manually typed tickers or CSV imports without suffixes, best-effort rules:
   - Crypto (BTC-USD etc.)     → pass through unchanged
   - MutualFund                → null (uses AMFI)
   - Already has a dot         → pass through unchanged (autocomplete result)
   - Special overrides         → hardcoded for known ambiguous tickers
   - USD currency              → no suffix (US exchange)
   - EUR + ETF/Commodity       → .L suffix (London)
   - EUR + Stock               → no suffix (assume US-listed; if wrong, user should
                                  type or select the full symbol e.g. AI3A.DE)
   - INR                       → .NS suffix (NSE) */
function resolveTicker(asset){
  const t   = asset.ticker
  const cur = asset.currency || "INR"
  if(!t) return null
  if(t.includes("-USD"))          return t      /* Crypto */
  if(asset.type === "MutualFund") return null   /* AMFI */
  if(t.includes("."))             return t      /* already has exchange suffix */
  if(t === "SEMI")  return "CHIP.PA"           /* Amundi Semiconductors — Euronext Paris */
  if(t === "EWG2")  return "EWG2.SG"          /* EUWAX Gold II — Stuttgart */
  if(cur === "USD") return t
  if(cur === "EUR"){
    const type = (asset.type || "").toLowerCase()
    if(type === "etf" || type === "commodity") return t + ".L"
    /* EUR stocks: assumed US-listed (Scalable/TR fractional shares).
       For European-exchange stocks, always use autocomplete or type the
       full symbol with suffix (e.g. AI3A.DE, SAP.DE) when adding the asset. */
    return t
  }
  return t + ".NS"  /* default: Indian NSE */
}

/* Fetches current price for a single asset via the /api/price serverless proxy. */
async function fetchPrice(asset){
  try{
    const symbol = resolveTicker(asset)
    if(!symbol) return null
    const r = await fetch("/api/price?ticker=" + symbol)
    if(!r.ok) return null
    const data = await r.json()
    return Number(data.price) || null
  }catch(e){
    console.log("Price fetch failed", asset.ticker)
    return null
  }
}

/* Loops all non-MF assets, fetches live prices, saves to DB.
   Currency note: Yahoo returns USD prices for US-listed tickers.
   If an asset is stored in EUR (bought via Scalable/TR), we divide
   by FX.USD to convert the Yahoo USD price back to EUR. */
async function updatePrices(){
  if(priceUpdateRunning || !db) return
  priceUpdateRunning = true

  const assets = await getAssets()
  for(const a of assets){
    if(a.type === "MutualFund") continue
    if(!a.ticker) continue

    const price = await fetchPrice(a)
    if(price !== null){
      const symbol     = resolveTicker(a)
      const isUSTicker = symbol && !symbol.includes(".") && !symbol.includes("-USD")
      /* Convert USD-priced tickers to EUR if the asset is recorded in EUR */
      const adjustedPrice = (isUSTicker && a.currency === "EUR" && FX.USD)
        ? price / FX.USD
        : price

      const tx = db.transaction("assets", "readwrite")
      tx.objectStore("assets").put({ ...a, currentPrice: adjustedPrice })
    }
  }

  priceUpdateRunning = false
  await recordPortfolioSnapshot()
  loadAssets()

  /* Redraw growth chart so the latest data point reflects live prices */
  if(document.getElementById("portfolioGrowthChart")){
    drawGrowthChart()
  }
}


/* ── PORTFOLIO SNAPSHOT ───────────────────────────────────
   Saves a timestamped snapshot to portfolioHistory (IndexedDB).
   This is the data source for the Growth Chart.

   Structure per snapshot:
   {
     timestamp : Date.now()        (ms, used as keyPath — one per save)
     value     : number            (total EUR value of all holdings)
     cats      : {                 (per-category EUR breakdown)
       "Stock_INR":   12400,
       "ETF_EUR":      8900,
       "MutualFund_INR": 3200,
       ...
     }
   }

   Why store per-category?
   Without per-cat data, switching the chart to "India Stocks" would
   apply today's category fraction to ALL historical points — making
   every category's chart look identical to the All chart.
   Storing cats gives each category its own accurate history line.

   Old snapshots that predate this feature have no cats field.
   getCatValues() gracefully falls back to the fraction method for those. */
async function recordPortfolioSnapshot(){
  if(!db) return

  /* Only record from lastPortfolio — never use the fallback that reads raw assets,
     because currentPrice may be 0 before the first price fetch completes. */
  if(!lastPortfolio?.length) return

  let total  = 0
  const cats = {}
  lastPortfolio.forEach(p => {
    total += p.totalCurrentEUR
    const cat = p.type === "Commodity" ? "Commodity" : `${p.type}_${p.currency}`
    if(CAT_DEFS[cat]) cats[cat] = (cats[cat] || 0) + p.totalCurrentEUR
  })

  /* Anomaly guard: if the new total is less than 30% of the most recent snapshot,
     something is wrong (prices not loaded yet, FX failed, etc.) — skip recording.
     This prevents the sharp "V" dips visible when prices momentarily read as zero. */
  if(allPortfolioHistory.length){
    const lastSnap = allPortfolioHistory.reduce((a, b) => a.timestamp > b.timestamp ? a : b)
    if(lastSnap.value > 0 && total < lastSnap.value * 0.30) return
  }

  db.transaction("portfolioHistory", "readwrite")
    .objectStore("portfolioHistory")
    .put({ timestamp: Date.now(), value: total, cats })
}


/* ── CHARTS ENGINE ────────────────────────────────────────
   Two donut charts on the Insights tab:
   - Asset Allocation: EUR value by asset type (Stock, ETF, MF…)
   - Currency Exposure: EUR value by currency (EUR, USD, INR)

   makeDonut() is a generic builder used by both.
   It destroys the previous Chart.js instance to prevent canvas reuse errors.
   CHART_COLORS: consistent palette used across all donut slices. */

const CHART_COLORS = ["#5b9cf6","#22d17a","#f0a535","#f4506a","#a855f7","#fbbf24","#34d399","#f87171"]

/* Generic donut chart builder.
   instanceVar: string name of the global variable tracking the Chart.js instance. */
function makeDonut(canvasId, labels, values, instanceVar){
  if(window[instanceVar]) window[instanceVar].destroy()
  const ctx = document.getElementById(canvasId)
  if(!ctx) return
  Chart.defaults.devicePixelRatio = window.devicePixelRatio || 2
  window[instanceVar] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data:            values,
        backgroundColor: CHART_COLORS.slice(0, labels.length),
        borderColor:     "#0c1428",
        borderWidth:     3,
        hoverOffset:     8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: "62%",
      plugins: {
        legend: {
          position: "bottom",
          labels: { color:"#8899bb", font:{ family:"Outfit", size:12 }, padding:14, boxWidth:12 }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0)
              const pct   = ((ctx.raw / total) * 100).toFixed(1)
              return ` ${ctx.label}: €${ctx.raw.toFixed(0)} (${pct}%)`
            }
          }
        }
      }
    }
  })
}

/* Builds both Insights tab donut charts from the current portfolio */
function drawCharts(portfolio){
  if(!portfolio || !portfolio.length) return
  const allocation = {}
  const currencies = {}
  portfolio.forEach(p => {
    allocation[p.type || "Other"] = (allocation[p.type || "Other"] || 0) + p.totalCurrentEUR
    currencies[p.currency]        = (currencies[p.currency]        || 0) + p.totalCurrentEUR
  })
  makeDonut("allocationChart", Object.keys(allocation), Object.values(allocation), "allocationChartInstance")
  makeDonut("currencyChart",   Object.keys(currencies), Object.values(currencies), "currencyChartInstance")
}


/* ── GROWTH CHART ENGINE ──────────────────────────────────
   The main portfolio growth line chart on the Portfolio tab.

   Key design decisions:
   - responsive:false prevents Chart.js ResizeObserver from causing
     infinite resize loops (canvas height change → observer fires → redraw loop).
   - Chart is created ONCE on first load, then UPDATED IN-PLACE via ch.update("none")
     for all period/category switches. This is critical — destroying and recreating
     the canvas caused the "zoom magnification" bug on category switches.
   - On window resize, a debounced handler manually calls renderGrowthChart()
     to refit the chart, since responsive:false disables auto-resizing.

   Category filtering:
   - getCatValues() returns the EUR value series for a given category.
   - Snapshots now store per-category breakdowns in the `cats` field.
   - Old snapshots fall back to multiplying total by today's category fraction.

   Period + category buttons are bound by bindPeriodButtons() / bindCatButtons()
   after the first chart load from DB. */

let portfolioGrowthChartInstance = null   /* single persistent Chart.js line instance */
let currentPeriod = "1D"                 /* currently selected period button */
let currentCat    = "ALL"                /* currently selected category button */
let allPortfolioHistory = []             /* full history array from IndexedDB */

/* Category definitions: key → display label + chart line colour.
   Key format matches the cats field in snapshots: "Type_Currency" or "Commodity". */
const CAT_DEFS = {
  "ALL":            { label:"All Portfolio", color:"#5b9cf6" },
  "MutualFund_INR": { label:"India MF",      color:"#f0a535" },
  "Stock_INR":      { label:"India Stocks",  color:"#22d17a" },
  "Stock_EUR":      { label:"EUR Stocks",    color:"#7b5cf0" },
  "Stock_USD":      { label:"USD Stocks",    color:"#00cfff" },
  "ETF_EUR":        { label:"EUR ETFs",      color:"#f4506a" },
  "Commodity":      { label:"Commodity",     color:"#e8c84a" }
}

/* Returns true if an asset belongs to the given category key */
function matchCat(asset, cat){
  if(cat === "ALL") return true
  if(cat === "Commodity") return asset.type === "Commodity"
  const [type, cur] = cat.split("_")
  return asset.type === type && asset.currency === cur
}

/* Returns the EUR value series for a given category across history snapshots.
   Uses stored cats breakdown when available (accurate per-category history).
   Falls back to today's fraction × total for old snapshots (approximate). */
function getCatValues(history, cat){
  if(cat === "ALL") return history.map(h => h.value)
  const catTotal  = lastPortfolio.filter(a => matchCat(a, cat)).reduce((s, a) => s + a.totalCurrentEUR, 0)
  const allTotal  = lastPortfolio.reduce((s, a) => s + a.totalCurrentEUR, 0)
  const fraction  = allTotal > 0 ? catTotal / allTotal : 0
  return history.map(h => h.cats?.[cat] != null ? h.cats[cat] : h.value * fraction)
}

/* Returns the cutoff timestamp (ms) for a given period label.
   1D uses today's midnight so the chart start matches the TODAY strip. */
function periodMs(period){
  const now = Date.now()
  if(period === "1D"){
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0)
    return midnight.getTime()
  }
  const map = { "1W":604800000, "1M":2592000000, "3M":7776000000,
                "1Y":31536000000, "5Y":157680000000, "ALL":Infinity }
  return now - (map[period] || map["1W"])
}

/* Formats a timestamp as a chart x-axis label appropriate for the zoom level */
function formatLabel(ts, period){
  const d = new Date(ts)
  if(period === "1D")
    return d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })
  if(["1W","1M","3M","1Y"].includes(period))
    return d.toLocaleDateString([], { month:"short", day:"numeric" })
  return d.toLocaleDateString([], { year:"2-digit", month:"short" })
}

/* Maps app period labels to Yahoo Finance range + history params.
   1D is always from snapshots (intraday, Yahoo free tier has no minute data).
   All other periods use real per-asset Yahoo historical data for accuracy. */
const PERIOD_TO_YAHOO = {
  "1W":  "5d",   "1M":  "1mo",  "3M":  "3mo",
  "1Y":  "1y",   "5Y":  "5y",   "ALL": "max"
}

/* ── CATEGORY CHART FROM REAL PRICE HISTORY ─────────────────
   For non-ALL categories and non-1D periods, this builds an accurate
   historical value series by fetching Yahoo Finance OHLCV data for
   each asset in the category, then summing qty × close at each date.

   Why not use snapshots for categories?
   All old snapshots lack the `cats` field so getCatValues() falls back
   to `total × today's_fraction` — making every category identical in
   shape to the ALL chart. Yahoo gives us the actual diverging prices.

   Indian MutualFunds have no Yahoo history → skipped (cats snapshot
   fallback is used for MF-only view, which accumulates going forward).

   Returns: { labels: string[], values: number[] } sorted by date,
            OR null if no data could be fetched (triggers snapshot fallback). */
async function buildCategoryChartData(cat, period){
  const yahooRange = PERIOD_TO_YAHOO[period]
  if(!yahooRange) return null                        /* 1D always uses snapshots */

  /* Identify assets belonging to this category */
  const assets = lastPortfolio.filter(a => matchCat(a, cat))
  if(!assets.length) return null

  /* MutualFunds have no Yahoo Finance historical data — fall back to snapshots */
  const fetchable = assets.filter(a => a.key && a.type !== "MutualFund")
  if(!fetchable.length) return null

  /* Fetch full close history for each asset in parallel */
  const histories = await Promise.all(fetchable.map(async pos => {
    const symbol = resolveTicker({ ticker: pos.key, currency: pos.currency, type: pos.type })
    if(!symbol) return null
    try{
      const r = await fetch(`/api/price?ticker=${encodeURIComponent(symbol)}&range=${yahooRange}&history=true`)
      if(!r.ok) return null
      const d = await r.json()
      /* d.timestamps = [ms, ms, ...], d.closes = [price, price, ...] */
      if(!d.timestamps?.length) return null
      return { pos, timestamps: d.timestamps, closes: d.closes }
    }catch(e){ return null }
  }))

  const valid = histories.filter(Boolean)
  if(!valid.length) return null

  /* Build a unified sorted timeline from all assets' timestamps */
  const allTs = [...new Set(valid.flatMap(h => h.timestamps))].sort((a, b) => a - b)

  /* For each timestamp, sum (quantity × interpolated_close) across all assets in category,
     converting to EUR using live FX rates */
  const values = allTs.map(ts => {
    let total = 0
    valid.forEach(({ pos, timestamps, closes }) => {
      /* Find the most recent close at or before this timestamp */
      let idx = timestamps.findLastIndex(t => t <= ts)
      if(idx < 0) idx = 0
      const close = closes[idx]
      if(close == null) return
      /* Convert to EUR using the asset's currency */
      total += convertToEUR(close * pos.qty, pos.currency)
    })
    return total
  })

  /* Filter to remove leading zeros (assets not yet in portfolio at that date) */
  const firstNonZero = values.findIndex(v => v > 0)
  if(firstNonZero < 0) return null
  const trimTs  = allTs.slice(firstNonZero)
  const trimVal = values.slice(firstNonZero)

  return {
    labels: trimTs.map(ts => formatLabel(ts, period)),
    values: trimVal
  }
}

/* Entry point: loads all history from DB, cleans bad snapshots, renders chart, and binds buttons.
   Bad snapshots (near-zero values from race-condition recordings) are filtered out here
   so they never appear in the chart even if they were already stored in the DB. */
function drawGrowthChart(){
  if(!db) return
  db.transaction("portfolioHistory", "readonly")
    .objectStore("portfolioHistory")
    .getAll().onsuccess = e => {
      const raw = e.target.result || []

      /* Remove bad snapshots: any value below 20% of the median is an anomaly.
         Median is more robust than mean — a few near-zero points won't skew it. */
      if(raw.length > 2){
        const sorted = [...raw].sort((a, b) => a.value - b.value)
        const median = sorted[Math.floor(sorted.length / 2)].value
        allPortfolioHistory = raw.filter(h => h.value >= median * 0.20)
      } else {
        allPortfolioHistory = raw
      }

      renderGrowthChart(currentPeriod, currentCat)
      bindPeriodButtons()
      bindCatButtons()
    }
}

/* Debounced resize handler — redraws to fill new container width.
   Needed because responsive:false disables Chart.js's own ResizeObserver.
   renderGrowthChart is async so we just fire-and-forget (no await needed). */
let _resizeTimer = null
window.addEventListener("resize", () => {
  clearTimeout(_resizeTimer)
  _resizeTimer = setTimeout(() => { renderGrowthChart(currentPeriod, currentCat) }, 200)
})

/* Wires period buttons (1D / 1W / 1M / 3M / 1Y / 5Y / ALL) */
function bindPeriodButtons(){
  document.querySelectorAll(".period-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"))
      btn.classList.add("active")
      currentPeriod = btn.dataset.period
      renderGrowthChart(currentPeriod, currentCat)
    }
  })
}

/* Wires category buttons (All / India MF / India Stocks / …) */
function bindCatButtons(){
  document.querySelectorAll(".cat-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"))
      btn.classList.add("active")
      currentCat = btn.dataset.cat
      const lbl = document.getElementById("growthStatLabel")
      if(lbl) lbl.textContent = CAT_DEFS[currentCat]?.label || "Portfolio"
      renderGrowthChart(currentPeriod, currentCat)
    }
  })
}

/* Core chart render function.
   For ALL category or 1D period: uses IndexedDB snapshots (fast, intraday).
   For all other category + period combos: fetches real Yahoo Finance historical
   price data via buildCategoryChartData() — giving genuinely different curves
   per category rather than scaled copies of the All chart.
   Updates existing Chart.js instance in-place via ch.update("none"). */
async function renderGrowthChart(period, cat){
  cat = cat || currentCat || "ALL"

  /* Show a subtle loading state on the canvas while fetching */
  const canvasEl = document.getElementById("portfolioGrowthChart")
  if(canvasEl && cat !== "ALL" && period !== "1D") canvasEl.style.opacity = "0.4"

  let labels, values

  /* ── Route: use real Yahoo history for category+period combos ── */
  if(cat !== "ALL" && period !== "1D"){
    const catData = await buildCategoryChartData(cat, period)
    if(catData){
      labels = catData.labels
      values = catData.values
    } else {
      /* Fallback to snapshots with cats if Yahoo data unavailable (e.g. MF only) */
      const cutoff  = periodMs(period)
      let history   = allPortfolioHistory.filter(h => h.timestamp >= cutoff).sort((a,b)=>a.timestamp-b.timestamp)
      if(!history.length) history = [...allPortfolioHistory].sort((a,b)=>a.timestamp-b.timestamp)
      labels = history.map(h => formatLabel(h.timestamp, period))
      values = getCatValues(history, cat)
    }
  } else {
    /* ── Route: ALL or 1D always use snapshots ── */
    const cutoff = periodMs(period)
    let history  = allPortfolioHistory
      .filter(h => h.timestamp >= cutoff)
      .sort((a, b) => a.timestamp - b.timestamp)
    if(!history.length) history = [...allPortfolioHistory].sort((a, b) => a.timestamp - b.timestamp)
    if(!history.length){ if(canvasEl) canvasEl.style.opacity="1"; return }
    labels = history.map(h => formatLabel(h.timestamp, period))
    values = getCatValues(history, cat)
  }

  if(canvasEl) canvasEl.style.opacity = "1"
  if(!values?.length) return
  const first   = values[0] || 0
  const last    = values[values.length - 1] || 0
  const change  = last - first
  const pct     = first > 0 ? (change / first) * 100 : 0
  const isUp    = change >= 0

  /* Update the stat pills above the chart */
  const sv  = document.getElementById("growthStatValue")
  const sc  = document.getElementById("growthStatChange")
  const sp  = document.getElementById("growthStatPct")
  const spl = document.getElementById("growthStatPeriodLabel")
  if(sv)  sv.textContent  = "€" + last.toLocaleString("de-DE", { minimumFractionDigits:2, maximumFractionDigits:2 })
  if(sc){ sc.textContent  = (isUp ? "+" : "-") + "€" + Math.abs(change).toFixed(2); sc.className = "growth-stat-chg " + (isUp ? "profit" : "loss") }
  if(sp){ sp.textContent  = (isUp ? "+" : "")  + pct.toFixed(2) + "%";              sp.className = "growth-stat-pct "  + (isUp ? "profit" : "loss") }
  if(spl) spl.textContent = period === "ALL" ? "all time" : period === "1D" ? "24H" : period.toLowerCase()

  /* ── TODAY pill ───────────────────────────────────────────
     todayRef = last snapshot before midnight (yesterday close)
     todayNow = most recent snapshot today
     The same fraction is applied to both so they are consistent
     with the value shown in the bottom TODAY strip. */
  const fraction = cat === "ALL" ? 1 : (() => {
    if(!lastPortfolio.length) return 1
    const catTotal = lastPortfolio.filter(a => matchCat(a, cat)).reduce((s, a) => s + a.totalCurrentEUR, 0)
    const allTotal  = lastPortfolio.reduce((s, a) => s + a.totalCurrentEUR, 0)
    return allTotal > 0 ? catTotal / allTotal : 1
  })()

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const ySnaps     = [...allPortfolioHistory].filter(h => h.timestamp < todayStart.getTime()).sort((a, b) => b.timestamp - a.timestamp)
  const tSnaps     = [...allPortfolioHistory].filter(h => h.timestamp >= todayStart.getTime()).sort((a, b) => b.timestamp - a.timestamp)
  const todayRef   = ySnaps.length ? ySnaps[0].value * fraction : null
  const todayNow   = tSnaps.length ? tSnaps[0].value * fraction : null

  const todayGroup = document.getElementById("growthTodayGroup")
  const todayValEl = document.getElementById("growthTodayVal")
  const todayPctEl = document.getElementById("growthTodayPct")
  /* Hide TODAY pill when viewing 1D period (same info as main stat) */
  if(todayGroup) todayGroup.style.display = period === "1D" ? "none" : "flex"
  if(todayValEl && todayPctEl){
    if(todayRef !== null && todayNow !== null){
      const dChg  = todayNow - todayRef
      const dPct  = todayRef > 0 ? (dChg / todayRef) * 100 : 0
      const dSign = dChg >= 0 ? "+" : "-"
      const dCls  = dChg >= 0 ? "up" : "dn"
      todayValEl.textContent = dSign + "€" + Math.abs(dChg).toFixed(2)
      todayValEl.className   = "growth-today-val today-" + dCls
      /* Math.abs(pct) prevents double-minus: sign="-" + pct="-0.61" → "--0.61%" */
      todayPctEl.textContent = dSign + Math.abs(dPct).toFixed(2) + "%"
      todayPctEl.className   = "growth-today-pct today-" + dCls
    } else {
      todayValEl.textContent = "–"; todayValEl.className = "growth-today-val"
      todayPctEl.textContent = "–"; todayPctEl.className = "growth-today-pct"
    }
  }

  /* Chart line colour: category colour if up, red if down */
  const catColor  = CAT_DEFS[cat]?.color || "#5b9cf6"
  const lineColor = isUp ? catColor : "#f4506a"

  const dotEl = document.getElementById("growthDot")
  if(dotEl) dotEl.style.background = catColor
  const lblEl = document.getElementById("growthStatLabel")
  if(lblEl) lblEl.textContent = CAT_DEFS[cat]?.label || "All Portfolio"

  /* Convert hex colour to comma-separated RGB for use in rgba() gradient stops */
  function hexToRgb(h){
    const n = parseInt(h.replace("#", ""), 16)
    return `${(n>>16)&255},${(n>>8)&255},${n&255}`
  }
  const rgb     = hexToRgb(lineColor)
  const gradTop = `rgba(${rgb},0.35)`
  const gradBot = `rgba(${rgb},0.03)`

  /* Compute "nice" Y axis range so gridlines land on round numbers */
  const min       = Math.min(...values)
  const max       = Math.max(...values)
  const range     = max - min || max * 0.02
  const rawStep   = range / 5
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const niceStep  = Math.ceil(rawStep / magnitude) * magnitude
  const yMin      = Math.floor((min - niceStep * 0.5) / niceStep) * niceStep
  const yMax      = Math.ceil( (max + niceStep * 0.5) / niceStep) * niceStep

  /* Y-axis tick formatter — scales label based on value magnitude */
  const yTickFmt = v => {
    if(range >= 50000) return "€" + (v/1000).toFixed(0) + "k"
    if(range >= 5000)  return "€" + (v/1000).toFixed(1) + "k"
    if(v >= 1000000)   return "€" + (v/1000000).toFixed(1) + "M"
    if(v >= 10000)     return "€" + (v/1000).toFixed(1) + "k"
    if(v >= 1000)      return "€" + Math.round(v).toLocaleString("de-DE")
    return "€" + v.toFixed(0)
  }

  /* Tooltip body — shows absolute value + delta from period start */
  const tooltipLabel = ctx => {
    const v    = ctx.raw
    const diff = v - first
    const dp   = first > 0 ? (diff / first) * 100 : 0
    const sign = diff >= 0 ? "+" : ""
    const fmtV = v >= 1000 ? "€" + (v/1000).toFixed(2) + "k" : "€" + v.toFixed(2)
    const fmtD = Math.abs(diff) >= 1000
      ? sign + (diff < 0 ? "-" : "") + "€" + (Math.abs(diff)/1000).toFixed(2) + "k"
      : sign + "€" + diff.toFixed(2)
    return fmtV + "   " + fmtD + " (" + sign + dp.toFixed(2) + "%)"
  }

  /* ── UPDATE IN-PLACE or CREATE FRESH ─────────────────── */
  const applyChart = () => {
    const canvas = document.getElementById("portfolioGrowthChart")
    if(!canvas) return

    if(portfolioGrowthChartInstance){
      /* Mutate existing instance — never call destroy().
         This keeps the canvas at its original size with no resize loop. */
      const ch = portfolioGrowthChartInstance
      ch.data.labels                            = labels
      ch.data.datasets[0].label                = CAT_DEFS[cat]?.label || "Portfolio"
      ch.data.datasets[0].data                 = values
      ch.data.datasets[0].borderColor          = lineColor
      ch.data.datasets[0].pointBackgroundColor = lineColor
      ch.data.datasets[0].pointRadius          = values.length > 50 ? 0 : 3
      ch.data.datasets[0].backgroundColor      = ctx => {
        const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height)
        g.addColorStop(0, gradTop); g.addColorStop(1, gradBot); return g
      }
      ch.options.scales.x.ticks.maxTicksLimit          = period === "1D" ? 12 : 7
      ch.options.scales.y.min                          = yMin
      ch.options.scales.y.max                          = yMax
      ch.options.scales.y.ticks.stepSize               = niceStep
      ch.options.scales.y.ticks.callback               = yTickFmt
      ch.options.plugins.tooltip.borderColor           = `rgba(${rgb},0.45)`
      ch.options.plugins.tooltip.callbacks.label       = tooltipLabel
      ch.update("none")  /* "none" = instant update, no animation */
      return
    }

    /* First-time creation — only runs once per page load */
    Chart.defaults.devicePixelRatio = window.devicePixelRatio || 2
    portfolioGrowthChartInstance = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label:                CAT_DEFS[cat]?.label || "Portfolio",
          data:                 values,
          borderColor:          lineColor,
          borderWidth:          2.5,
          pointRadius:          values.length > 50 ? 0 : 3,
          pointHoverRadius:     6,
          pointBackgroundColor: lineColor,
          pointBorderColor:     "#070c18",
          pointBorderWidth:     1.5,
          fill:                 true,
          backgroundColor:      ctx => {
            const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, ctx.chart.height)
            g.addColorStop(0, gradTop); g.addColorStop(1, gradBot); return g
          },
          tension: 0.35
        }]
      },
      options: {
        responsive:          false,   /* manual resize via window resize handler above */
        maintainAspectRatio: false,
        interaction:         { mode:"index", intersect:false },
        scales: {
          x: {
            ticks: {
              color:"#8fa3c4",
              font:{ size:11, family:"Outfit, sans-serif", weight:"500" },
              maxTicksLimit: period === "1D" ? 12 : 7,
              maxRotation:0, padding:6
            },
            grid:   { color:"rgba(91,156,246,0.07)", drawTicks:false },
            border: { display:false }
          },
          y: {
            position: "left",
            ticks: {
              color:"#8fa3c4",
              font:{ size:11, family:"Outfit, sans-serif", weight:"500" },
              stepSize:      niceStep,
              callback:      yTickFmt,
              padding:10,    maxTicksLimit:7
            },
            grid:   { color:"rgba(91,156,246,0.07)", drawTicks:false },
            border: { display:false },
            min:    yMin,
            max:    yMax
          }
        },
        plugins: {
          legend: { display:false },
          tooltip: {
            backgroundColor: "rgba(8,16,40,0.97)",
            titleColor:      "#8faac8",
            bodyColor:       "#dce8ff",
            borderColor:     `rgba(${rgb},0.45)`,
            borderWidth:     1,
            padding:         14,
            caretSize:       5,
            caretPadding:    8,
            displayColors:   false,
            titleFont: { family:"Outfit, sans-serif", size:12, weight:"500" },
            bodyFont:  { family:"ui-monospace, 'SF Mono', Menlo, Consolas, monospace", size:14, weight:"700" },
            callbacks: { title: items => items[0].label, label: tooltipLabel }
          }
        }
      }
    })
  }

  /* Wait for fonts before drawing so text metrics are accurate */
  if(document.fonts && document.fonts.ready){
    document.fonts.ready.then(applyChart)
  } else {
    applyChart()
  }

  /* Pass todayRef/todayNow to the bottom strip — same values, same reference */
  renderDailyProgress(cat, todayRef, todayNow)
}


/* ── DAILY PROGRESS & MARKET TICKER ──────────────────────
   The strip at the bottom of the growth chart showing:
   - TODAY: portfolio EUR change + % since midnight
   - Benchmarks: S&P 500, Nifty 50, DAX day change %

   todayRef / todayNow are computed in renderGrowthChart()
   so TODAY here matches the TODAY pill on the chart exactly.

   indexCache: simple in-memory cache for index prices (session-lived). */

let indexCache = {}  /* ticker string → price+changePercent object */

/* Fetches index price with in-memory caching to avoid redundant API calls */
async function fetchIndexPrice(ticker){
  if(indexCache[ticker]) return indexCache[ticker]
  try{
    const r = await fetch("/api/price?ticker=" + ticker)
    if(!r.ok) return null
    const d = await r.json()
    indexCache[ticker] = d
    return d
  }catch(e){ return null }
}

/* Renders the TODAY change strip and benchmark comparison columns */
async function renderDailyProgress(cat, todayRef, todayNow){
  const bar = document.getElementById("dailyProgressBar")
  if(!bar) return

  const valEl = document.getElementById("dailyChangeVal")
  const pctEl = document.getElementById("dailyChangePct")

  if(valEl && pctEl){
    if(todayRef !== null && todayRef !== undefined && todayNow !== null && todayNow !== undefined){
      const chg  = todayNow - todayRef
      const pct  = todayRef > 0 ? (chg / todayRef) * 100 : 0
      const cls  = chg >= 0 ? "profit" : "loss"
      const sign = chg >= 0 ? "+" : "-"
      valEl.textContent = sign + "€" + Math.abs(chg).toFixed(2)
      valEl.className   = "daily-val " + cls
      /* Math.abs prevents double minus: sign="-" + negative pct → "--0.61%" */
      pctEl.textContent = sign + Math.abs(pct).toFixed(2) + "%"
      pctEl.className   = "daily-pct " + cls
    } else {
      valEl.textContent = "–"; valEl.className = "daily-val neutral"
      pctEl.textContent = "–"; pctEl.className = "daily-pct neutral"
    }
  }

  /* Fetch benchmark indices in parallel */
  const [sp, nifty, dax] = await Promise.all([
    fetchIndexPrice("%5EGSPC"),    /* S&P 500 */
    fetchIndexPrice("%5ENSEI"),    /* Nifty 50 */
    fetchIndexPrice("%5EGDAXI")    /* DAX */
  ])

  const setComp = (elId, data) => {
    const el = document.getElementById(elId)
    if(!el) return
    if(!data || data.changePercent == null){ el.textContent = "–"; el.className = "daily-bench neutral"; return }
    const pct  = data.changePercent
    const sign = pct >= 0 ? "+" : ""
    el.textContent = sign + pct.toFixed(2) + "%"
    el.className   = "daily-bench " + (pct >= 0 ? "profit" : "loss")
  }

  setComp("dailyVsSP",    sp)
  setComp("dailyVsNifty", nifty)
  setComp("dailyVsDAX",   dax)
}

/* ── HEADER MARKET TICKER ─────────────────────────────────
   Scrolling ticker in the tab bar: Nifty 50, S&P 500, DAX, EU Stoxx 50.
   Appends the user's own portfolio total return as the last chip. */
async function fetchMarketTicker(){
  const wrap = document.getElementById("headerMarket")
  if(!wrap) return

  const indices = [
    { ticker:"%5ENSEI",     label:"Nifty 50",  color:"#22d17a" },
    { ticker:"%5EGSPC",     label:"S&P 500",   color:"#5b9cf6" },
    { ticker:"%5EGDAXI",    label:"DAX",       color:"#a78bfa" },
    { ticker:"%5ESTOXX50E", label:"EU Stoxx",  color:"#f0a535" }
  ]

  const results = await Promise.all(
    indices.map(async idx => ({ ...idx, data: await fetchIndexPrice(idx.ticker) }))
  )

  wrap.innerHTML = results.map(r => {
    if(!r.data || r.data.price == null) return ""
    const pct    = r.data.changePercent
    const isUp   = pct != null ? pct >= 0 : true
    const sign   = isUp ? "+" : ""
    const cls    = isUp ? "mkt-up" : "mkt-dn"
    const arrow  = isUp ? "▲" : "▼"
    const pctStr = pct != null ? sign + pct.toFixed(2) + "%" : "–"
    return `<div class="mkt-item">
      <span class="mkt-name" style="color:${r.color}">${r.label}</span>
      <span class="mkt-price">${Number(r.data.price).toLocaleString(undefined, { maximumFractionDigits:0 })}</span>
      <span class="mkt-chg ${cls}">${arrow} ${pctStr}</span>
    </div>`
  }).join("")

  /* Append "My Portfolio" chip after indices */
  if(lastPortfolio.length){
    let invested = 0, current = 0
    lastPortfolio.forEach(p => { invested += p.totalBuyEUR; current += p.totalCurrentEUR })
    const portRet = invested > 0 ? ((current - invested) / invested) * 100 : 0
    const sign    = portRet >= 0 ? "+" : ""
    const cls     = portRet >= 0 ? "mkt-up" : "mkt-dn"
    wrap.insertAdjacentHTML("beforeend",
      `<div class="mkt-item mkt-portfolio">
        <span class="mkt-name" style="color:#e8c84a">My Portfolio</span>
        <span class="mkt-chg ${cls}">${sign}${portRet.toFixed(2)}% total</span>
      </div>`)
  }
}


/* ── INSIGHTS TAB SUMMARIES ───────────────────────────────
   renderInsightsSummary(): hero metric cards — Total Return,
     Best/Worst %, Best/Worst Absolute EUR profit.

   renderTopMovers(): four mover lists:
     Top 5 Gainers %  |  Top 5 Losers %
     Top Abs Profit   |  Top Abs Loss    */

function renderInsightsSummary(portfolio){
  if(!portfolio || !portfolio.length) return
  let invested = 0, current = 0
  portfolio.forEach(p => { invested += p.totalBuyEUR; current += p.totalCurrentEUR })
  const ret  = invested > 0 ? ((current - invested) / invested) * 100 : 0
  const sign = ret >= 0 ? "+" : ""
  const retEl = document.getElementById("portfolioReturn")
  if(retEl){ retEl.textContent = sign + ret.toFixed(2) + "%"; retEl.className = ret >= 0 ? "profit" : "loss" }

  /* Best/worst by % growth */
  const sorted = [...portfolio].sort((a, b) => b.growth - a.growth)
  const best   = sorted[0]
  const worst  = sorted[sorted.length - 1]
  const bestEl = document.getElementById("bestPerformer");  const bestNm = document.getElementById("bestPerformerName")
  const wrstEl = document.getElementById("worstPerformer"); const wrstNm = document.getElementById("worstPerformerName")
  if(best  && bestEl){ bestEl.innerHTML = `+${best.growth.toFixed(2)}% <span class="abs-val">+€${best.profitEUR.toFixed(0)}</span>`;   if(bestNm) bestNm.textContent = resolveDisplayName(best)  }
  if(worst && wrstEl){ wrstEl.innerHTML = `${worst.growth.toFixed(2)}% <span class="abs-val">€${worst.profitEUR.toFixed(0)}</span>`;    if(wrstNm) wrstNm.textContent = resolveDisplayName(worst) }

  /* Best/worst by absolute EUR profit */
  const sortedAbs = [...portfolio].sort((a, b) => b.profitEUR - a.profitEUR)
  const bestAbs   = sortedAbs[0]
  const worstAbs  = sortedAbs[sortedAbs.length - 1]
  const bestAbsEl = document.getElementById("bestAbsolute");  const bestAbsNm  = document.getElementById("bestAbsoluteName")
  const wrstAbsEl = document.getElementById("worstAbsolute"); const wrstAbsNm  = document.getElementById("worstAbsoluteName")
  if(bestAbs  && bestAbsEl){ bestAbsEl.innerHTML = `+€${bestAbs.profitEUR.toFixed(0)} <span class="abs-val">+${bestAbs.growth.toFixed(1)}%</span>`;   if(bestAbsNm)  bestAbsNm.textContent  = resolveDisplayName(bestAbs)  }
  if(worstAbs && wrstAbsEl){ wrstAbsEl.innerHTML = `€${worstAbs.profitEUR.toFixed(0)} <span class="abs-val">${worstAbs.growth.toFixed(1)}%</span>`;   if(wrstAbsNm) wrstAbsNm.textContent = resolveDisplayName(worstAbs) }
}

function renderTopMovers(portfolio){
  if(!portfolio || !portfolio.length) return
  const sorted  = [...portfolio].sort((a, b) => b.growth - a.growth)
  const gainers = sorted.slice(0, 5)
  const losers  = sorted.slice(-5).reverse()

  const gEl = document.getElementById("topGainers")
  const lEl = document.getElementById("topLosers")
  if(gEl) gEl.innerHTML = gainers.map(p => `
    <div class="mover-item">
      <span class="mover-name">${resolveDisplayName(p)}</span>
      <span class="mover-vals">
        <span class="mover-pct profit">+${p.growth.toFixed(2)}%</span>
        <span class="mover-abs profit">+€${p.profitEUR.toFixed(0)}</span>
      </span>
    </div>`).join("")
  if(lEl) lEl.innerHTML = losers.map(p => `
    <div class="mover-item">
      <span class="mover-name">${resolveDisplayName(p)}</span>
      <span class="mover-vals">
        <span class="mover-pct loss">${p.growth.toFixed(2)}%</span>
        <span class="mover-abs loss">€${p.profitEUR.toFixed(0)}</span>
      </span>
    </div>`).join("")

  /* Absolute EUR movers */
  const sortedByAbs = [...portfolio].sort((a, b) => b.profitEUR - a.profitEUR)
  const absGainers  = sortedByAbs.filter(p => p.profitEUR > 0).slice(0, 5)
  const absLosers   = sortedByAbs.filter(p => p.profitEUR < 0).slice(-5).reverse()

  const agEl = document.getElementById("topAbsGainers")
  const alEl = document.getElementById("topAbsLosers")
  if(agEl) agEl.innerHTML = absGainers.map(p => `
    <div class="mover-item">
      <span class="mover-name">${resolveDisplayName(p)}</span>
      <span class="mover-vals">
        <span class="mover-pct profit">+€${p.profitEUR.toFixed(0)}</span>
        <span class="mover-abs profit">+${p.growth.toFixed(1)}%</span>
      </span>
    </div>`).join("")
  if(alEl) alEl.innerHTML = absLosers.map(p => `
    <div class="mover-item">
      <span class="mover-name">${resolveDisplayName(p)}</span>
      <span class="mover-vals">
        <span class="mover-pct loss">€${p.profitEUR.toFixed(0)}</span>
        <span class="mover-abs loss">${p.growth.toFixed(1)}%</span>
      </span>
    </div>`).join("")
}


/* ── DAILY MARKET INSIGHTS ────────────────────────────────
   Scans news for ALL holdings using Google News RSS fetched
   client-side via allorigins.win (a free public CORS proxy).

   Why client-side? Google News RSS blocks requests from Vercel's
   datacenter IP ranges. allorigins.win forwards from a residential
   IP where News RSS works normally.

   Scoring pipeline per article:
   1. Impact score   — financial keyword hits (earnings, FDA, tariff…)
   2. Recency score  — decays linearly over 48h
   3. Weight score   — higher for larger portfolio holdings

   Cross-source confirmation:
   - topicSources tracks distinct sources per headline topic
   - Articles covered by > 1 source show a "✓ confirmed" badge

   Outlook badge per article:
   - Counts bullish vs bearish keywords
   - Shows ▲ Likely Up / ▼ Likely Down / ↔ Watch

   Cache: localStorage key "capintel_insights_YYYY-MM-DD"
   Auto-expires next day (key no longer matches).
   force=true bypasses cache (Refresh button). */

/* Keywords that indicate a financially significant article */
const IMPACT_WORDS  = ["earnings","results","guidance","downgrade","upgrade","beats","misses",
                        "merger","acquisition","recall","lawsuit","investigation","FDA","tariff",
                        "ban","layoffs","buyback","dividend","quarterly","forecast","revenue",
                        "profit","loss","crash","surge","record"]

/* Keyword lists for directional sentiment */
const BULLISH_WORDS = ["beats","beat","surge","gain","profit","upgrade","raises","strong",
                        "record","deal","buyback","growth","rises","soars","jumps","bullish",
                        "outperform","positive","launches","expands"]
const BEARISH_WORDS = ["misses","miss","falls","drops","decline","loss","downgrade","cuts",
                        "weak","warning","lawsuit","crash","inflation","tariff","ban","probe",
                        "concern","disappoints","below","recall","investigation","layoffs"]

/* Returns an integer impact score based on keyword hits in title + desc */
function scoreArticle(title, desc){
  const text = (title + " " + desc).toLowerCase()
  let score  = 0
  IMPACT_WORDS.forEach(w => { if(text.includes(w)) score += 2 })
  return score
}

/* Returns { label, cls } outlook based on bullish vs bearish keyword balance */
function getOutlook(title, desc){
  const text = (title + " " + desc).toLowerCase()
  let bull = 0, bear = 0
  BULLISH_WORDS.forEach(w => { if(text.includes(w)) bull++ })
  BEARISH_WORDS.forEach(w => { if(text.includes(w)) bear++ })
  if(bull > bear) return { label:"▲ Likely Up",   cls:"out-up" }
  if(bear > bull) return { label:"▼ Likely Down", cls:"out-down" }
  return             { label:"↔ Watch",        cls:"out-neutral" }
}

async function fetchDailyInsights(portfolio, force){
  const el  = document.getElementById("dailyInsightsResult")
  const btn = document.getElementById("insightsBtnText")
  if(!el) return

  const today    = new Date().toISOString().slice(0, 10)
  const cacheKey = "capintel_insights_" + today

  /* Return cached results for today unless force refresh */
  if(!force){
    try{
      const c = localStorage.getItem(cacheKey)
      if(c){ renderInsightCards(JSON.parse(c), el); return }
    }catch(e){}
  }

  if(!portfolio?.length){
    el.innerHTML = `<p class="intel-empty">Load your portfolio first, then refresh.</p>`
    return
  }

  el.innerHTML = `<div class="insights-loading"><span class="insights-spinner"></span>Scanning news for all your holdings…</div>`
  if(btn) btn.textContent = "⏳ Loading…"

  /* Deduplicate tickers across the portfolio; clean exchange suffixes for search queries */
  const tickerMap = {}
  portfolio.forEach(h => {
    const ticker = h.ticker || ""
    const clean  = ticker.replace(/[\^]|\.NS|\.BO|-USD|-EUR|-INR/g, "").trim()
    const query  = clean || h.name.split(" ")[0]
    if(!tickerMap[query]) tickerMap[query] = { name:h.name, ticker, query, value:h.totalCurrentEUR || 0 }
    else tickerMap[query].value += h.totalCurrentEUR || 0
  })
  const allTickers = Object.values(tickerMap).sort((a, b) => b.value - a.value)

  /* Fetches Google News RSS for one ticker via allorigins.win CORS proxy */
  async function fetchRSS(q){
    const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q.query + " stock finance")}&hl=en-US&gl=US&ceid=US:en`
    const url    = `https://api.allorigins.win/get?url=${encodeURIComponent(rssUrl)}`
    try{
      const r    = await fetch(url)
      if(!r.ok) return []
      const json = await r.json()
      const xml  = json.contents || ""
      if(!xml.includes("<item>")) return []
      return parseRSSClient(xml, q.name, q.ticker).slice(0, 3)
    }catch(e){ return [] }
  }

  try{
    /* Batch in groups of 8 to stay within allorigins.win rate limits */
    const allArticles = []
    for(let i = 0; i < allTickers.length; i += 8){
      const batch = allTickers.slice(i, i + 8)
      const res   = await Promise.all(batch.map(q => fetchRSS(q)))
      res.flat().forEach(a => allArticles.push(a))
    }

    /* Compute portfolio weight % per holding for scoring */
    const totalPortValue = portfolio.reduce((s, p) => s + (p.totalCurrentEUR || 0), 0)
    const tickerWeight   = {}
    allTickers.forEach(t => { tickerWeight[t.name] = (t.value / totalPortValue) * 100 })

    /* Score each article */
    allArticles.forEach(a => {
      const recencyScore = Math.max(0, 1 - (Date.now() - a.pubMs) / 172800000) * 10  /* decays over 48h */
      const impactScore  = scoreArticle(a.title, a.desc)
      const weightScore  = tickerWeight[a.holding] || 0
      a.score = recencyScore + impactScore + weightScore * 0.5
    })

    /* Build topic→sources map for cross-source confirmation badge */
    const topicSources = {}
    allArticles.forEach(a => {
      const key = a.title.toLowerCase().slice(0, 55)
      topicSources[key] = topicSources[key] || new Set()
      topicSources[key].add(a.source)
    })

    /* Deduplicate by topic prefix, annotate with outlook + multiSource */
    const seen    = new Set()
    const deduped = allArticles
      .sort((a, b) => b.score - a.score)
      .filter(a => {
        const key = a.title.toLowerCase().slice(0, 55)
        if(seen.has(key)) return false
        seen.add(key)
        a.multiSource = topicSources[key].size > 1
        a.outlook     = getOutlook(a.title, a.desc)
        return true
      })

    const articles = deduped.slice(0, 10)
    try{ localStorage.setItem(cacheKey, JSON.stringify(articles)) }catch(e){}
    renderInsightCards(articles, el)

  }catch(e){
    el.innerHTML = `<p class="intel-empty">Could not load news. Try refreshing.</p>`
  }finally{
    if(btn) btn.textContent = "🔄 Refresh"
  }
}

/* Parses a Google News RSS XML string into article objects.
   Handles CDATA-wrapped tag values. Filters articles older than 48h. */
function parseRSSClient(xml, holdingName, ticker){
  const items = []
  const rx    = /<item>([\s\S]*?)<\/item>/g
  let m
  while((m = rx.exec(xml)) !== null){
    const b       = m[1]
    const title   = stripHTML(exTag(b, "title"))
    const link    = exTag(b, "link") || exTag(b, "guid")
    const pubDate = exTag(b, "pubDate")
    const source  = exTag(b, "source") || "News"
    const desc    = stripHTML(exTag(b, "description")).slice(0, 200)
    if(!title || title.length < 5) continue
    const pubMs = pubDate ? new Date(pubDate).getTime() : Date.now()
    if(Date.now() - pubMs > 172800000) continue   /* skip articles older than 48h */
    items.push({ title, link: cleanNewsLink(link), source, desc, pubMs, holding: holdingName, ticker })
  }
  return items
}

/* Extracts the text content of an XML tag.
   Handles CDATA-wrapped values (Google News uses these for title/description). */
function exTag(str, tag){
  const cd = str.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i"))
  if(cd) return cd[1].trim()
  const pl = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"))
  return pl ? pl[1].trim() : ""
}

/* Strips HTML tags and decodes common HTML entities */
function stripHTML(s){
  return s.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim()
}

/* Google News link URLs are redirects; this extracts the actual destination */
function cleanNewsLink(url){
  try{
    const m = decodeURIComponent(url).match(/url=([^&]+)/)
    return m ? m[1] : url
  }catch(e){ return url }
}

/* Renders the top-10 insight cards into the given container element.
   Each card shows: number, clickable headline, outlook badge,
   holding/source/age badges, and a description snippet. */
function renderInsightCards(articles, el){
  if(!articles?.length){
    el.innerHTML = `<p class="intel-empty">No recent news found. Try refreshing.</p>`
    return
  }
  el.innerHTML = articles.map((a, i) => {
    const age = a.pubMs ? timeAgo(a.pubMs) : ""
    /* Re-compute outlook for cached articles stored before the field was added */
    const out = a.outlook || getOutlook(a.title || "", a.desc || "")
    return `
    <div class="insight-item">
      <div class="insight-item-header">
        <span class="insight-num">${i + 1}</span>
        <a class="insight-headline" href="${a.link}" target="_blank" rel="noopener">${a.title}</a>
        <span class="out-badge ${out.cls}">${out.label}</span>
      </div>
      <div class="insight-meta">
        <span class="ins-ticker">${a.holding}</span>
        <span class="insight-source">${a.source}</span>
        ${age ? `<span class="insight-age">${age}</span>` : ""}
        ${a.multiSource ? `<span class="multi-src">✓ confirmed</span>` : ""}
      </div>
      ${a.desc ? `<p class="insight-detail">${a.desc}</p>` : ""}
    </div>`
  }).join("")
}

/* Formats a Unix ms timestamp as human-readable relative age */
function timeAgo(ms){
  const diff = Date.now() - ms
  const h    = Math.floor(diff / 3600000)
  if(h < 1)  return Math.floor(diff / 60000) + "m ago"
  if(h < 24) return h + "h ago"
  return Math.floor(h / 24) + "d ago"
}


/* ── AI MARKET INTELLIGENCE ───────────────────────────────
   Two AI-powered features accessible from the Insights tab:

   runMoversAnalysis() — "Smart Picks"
     Sends the full portfolio to /api/recommend (Claude API, no web search).
     Receives a JSON array of BUY / TRIM / SELL recommendations with
     tax notes and urgency ratings.
     Excludes Indian MFs (no publicly queryable fundamentals).

   runMarketIntelligence() — "AI Market Intelligence"
     Two-step deep analysis (~45–60s total):
     Step 1 → /api/market-search: Claude uses web_search to gather live
       prices, P/E ratios, technicals, macro news for each holding.
     Step 2 → /api/analyse: Claude synthesises everything into a
       structured tax-aware investment report (markdown → HTML).
     Progress labels rotate every 7s while the user waits.

   simpleMarkdown()
     Lightweight markdown → HTML converter for AI response rendering. */

function simpleMarkdown(text){
  return text
    .replace(/## (.+)/g,    '<h2 class="intel-h2">$1</h2>')
    .replace(/### (.+)/g,   '<h3 class="intel-h3">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)/gm,  '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, m => '<ul>' + m + '</ul>')
    .replace(/\n{2,}/g,    '</p><p>')
    .replace(/^(?!<[hul])/gm, '')
    .replace(/(<p><\/p>)/g, '')
    || text
}

async function runMoversAnalysis(){
  if(!lastPortfolio || !lastPortfolio.length){ alert("Load your portfolio first."); return }

  const btn     = document.getElementById("runPicksBtn")
  const btnText = document.getElementById("picksBtnText")
  const result  = document.getElementById("picksResult")
  const disc    = document.getElementById("picksDisclaimer")

  btn.disabled         = true
  btnText.textContent  = "🧠 Analysing portfolio…"
  result.style.display = "none"

  /* Include ALL positions including MutualFunds.
     MFs don't have live prices but Claude can still analyse cluster redundancy,
     over-allocation to small cap, and consolidation opportunities. */
  const portfolioPayload = lastPortfolio
    .map(p => ({
      name:            resolveDisplayName(p),
      key:             p.key,
      type:            p.type,
      currency:        p.currency,
      totalBuyEUR:     p.totalBuyEUR,
      totalCurrentEUR: p.totalCurrentEUR,
      growth:          p.growth,
      profitEUR:       p.profitEUR
    }))

  try{
    const res = await fetch("/api/recommend", {
      method:  "POST",
      headers: { "Content-Type":"application/json" },
      body:    JSON.stringify({ portfolio: portfolioPayload })
    })
    const raw = await res.json()
    if(!res.ok || raw.error) throw new Error(raw.error || "API error")

    const recs = raw.recommendations || []
    if(!recs.length){
      disc.style.display = "none"
      result.innerHTML   = `<div class="picks-timestamp">Analysis complete — no actionable trades identified. Your portfolio looks well-positioned to hold.</div>`
      result.style.display = "block"
      return
    }

    /* Group by verdict for sectioned display */
    const byVerdict = { BUY:[], TRIM:[], SELL:[] }
    recs.forEach(r => { const v = (r.verdict || "").toUpperCase(); if(byVerdict[v]) byVerdict[v].push(r) })

    const verdictConfig = {
      BUY:  { label:"📈 Buy More", cls:"rec-buy"  },
      TRIM: { label:"✂️ Trim",     cls:"rec-trim" },
      SELL: { label:"🔴 Sell",     cls:"rec-sell" }
    }

    /* Compact accordion: each pick is a single row (name + badges).
       Clicking a row expands the detail panel inline. Only one open at a time. */
    let pickIdCounter = 0
    const renderRec = r => {
      const v       = (r.verdict || "").toUpperCase()
      const cfg     = verdictConfig[v] || verdictConfig.BUY
      const confCls = `conf-${(r.confidence || "").toLowerCase()}`
      const id      = `pick-detail-${pickIdCounter++}`
      return `<div class="pick-row" onclick="togglePickDetail('${id}')">
        <div class="pick-row-main">
          <span class="pick-row-chevron">›</span>
          <span class="pick-row-name">${r.name}</span>
          <div class="pick-row-badges">
            <span class="rec-badge ${cfg.cls}">${r.verdict}</span>
            ${r.confidence ? `<span class="rec-conf ${confCls}">${r.confidence}</span>` : ""}
            ${r.urgency === "Immediate" ? `<span class="rec-urgent">⚡ Now</span>` : ""}
          </div>
        </div>
        <div class="pick-detail" id="${id}">
          <div class="rec-reason">${r.reason}</div>
          <div class="rec-tax">🧾 ${r.taxNote}</div>
          ${r.urgency ? `<div class="rec-meta"><span class="rec-urgency">⏱ ${r.urgency}</span>${r.targetWeight ? `<span class="rec-target">→ ${r.targetWeight}</span>` : ""}</div>` : ""}
        </div>
      </div>`
    }

    const sections = Object.entries(byVerdict)
      .filter(([, items]) => items.length > 0)
      .map(([verdict, items]) => {
        const cfg = verdictConfig[verdict]
        return `<div class="picks-section">
          <div class="picks-section-title">${cfg.label} <span class="picks-count">${items.length}</span></div>
          <div class="picks-accordion">${items.map(renderRec).join("")}</div>
        </div>`
      }).join("")

    disc.style.display = "none"
    result.innerHTML   = `
      <div class="picks-timestamp">${recs.length} actionable picks across ${portfolioPayload.length} positions (stocks + funds) · ${new Date().toLocaleString()} · Knowledge-based</div>
      <div class="picks-grid">${sections}</div>`
    result.style.display = "block"
    /* Persist so the user can return to this analysis without regenerating */
    try{ localStorage.setItem("capintel_picks_last", JSON.stringify({ html: result.innerHTML, ts: Date.now() })) }catch(e){}

  }catch(e){
    result.innerHTML     = `<p class="intel-error">❌ ${e.message}</p>`
    result.style.display = "block"
  }finally{
    btnText.textContent = "🎯 Analyse My Picks"
    btn.disabled        = false
  }
}

/* Toggles a single pick's detail panel open/closed.
   Rotates the chevron › → ↓ to signal state. */
function togglePickDetail(id){
  const detail = document.getElementById(id)
  if(!detail) return
  const row     = detail.closest(".pick-row")
  const chevron = row?.querySelector(".pick-row-chevron")
  const isOpen  = detail.classList.contains("open")
  detail.classList.toggle("open", !isOpen)
  if(chevron) chevron.textContent = isOpen ? "›" : "↓"
}

async function runMarketIntelligence(){
  if(!lastPortfolio || !lastPortfolio.length){ alert("Load your portfolio first."); return }

  const btn     = document.getElementById("runIntelBtn")
  const btnText = document.getElementById("intelBtnText")
  const result  = document.getElementById("intelResult")
  const disc    = document.getElementById("intelDisclaimer")

  btn.disabled         = true
  result.style.display = "none"

  /* Rotate step labels every 7 seconds while waiting for the API (~45–60s) */
  const steps = [
    "🔍 Searching live market data…",
    "📊 Fetching P/E ratios & fundamentals…",
    "📈 Gathering technical indicators…",
    "🌍 Reading macro & geopolitical news…",
    "🧠 Running deep portfolio analysis…",
    "⚖️ Applying tax-aware optimisation…"
  ]
  let stepIdx = 0
  btnText.textContent = steps[0]
  const stepTimer = setInterval(() => {
    stepIdx = (stepIdx + 1) % steps.length
    btnText.textContent = steps[stepIdx]
  }, 7000)

  let invested = 0, current = 0
  lastPortfolio.forEach(p => { invested += p.totalBuyEUR; current += p.totalCurrentEUR })
  const totalReturn = invested > 0 ? ((current - invested) / invested) * 100 : 0

  const payload = {
    portfolio: lastPortfolio.map(p => ({
      name:            resolveDisplayName(p),
      key:             p.key,
      type:            p.type,
      currency:        p.currency,
      totalBuyEUR:     p.totalBuyEUR,
      totalCurrentEUR: p.totalCurrentEUR,
      growth:          p.growth,
      profitEUR:       p.profitEUR
    })),
    totalValue:  current,
    totalReturn
  }

  try{
    /* Step 1: Gather live data via Claude web_search (~20–25s) */
    result.innerHTML     = `<div class="intel-step">🔍 Step 1 of 2 — Gathering live market data, technicals & fundamentals…</div>`
    result.style.display = "block"

    const searchRes = await fetch("/api/market-search", {
      method:  "POST",
      headers: { "Content-Type":"application/json" },
      body:    JSON.stringify(payload)
    })
    const searchRaw = await searchRes.text()
    let searchData
    try{ searchData = JSON.parse(searchRaw) }
    catch(e){ throw new Error("Market search bad response: " + searchRaw.slice(0, 200)) }
    if(!searchRes.ok || searchData.error){
      throw new Error("Market search failed: " + JSON.stringify(searchData.error || searchData.detail))
    }
    const { marketData } = searchData

    /* Step 2: Deep analysis from gathered data (~25–30s) */
    stepIdx             = 4
    btnText.textContent = steps[4]
    result.innerHTML    = `<div class="intel-step">🧠 Step 2 of 2 — Running deep fundamental + technical analysis…</div>`

    const analyseRes = await fetch("/api/analyse", {
      method:  "POST",
      headers: { "Content-Type":"application/json" },
      body:    JSON.stringify({ ...payload, marketData })
    })
    const analyseRaw = await analyseRes.text()
    let analyseData
    try{ analyseData = JSON.parse(analyseRaw) }
    catch(e){ throw new Error("Analysis bad response: " + analyseRaw.slice(0, 200)) }
    if(!analyseRes.ok || analyseData.error){
      throw new Error("Analysis failed: " + JSON.stringify(analyseData.error || analyseData.detail))
    }

    /* Convert Claude's markdown output to HTML for display */
    const html = analyseData.analysis
      .split("\n")
      .map(line => {
        if(line.startsWith("## "))  return `<h2 class="intel-h2">${line.slice(3)}</h2>`
        if(line.startsWith("### ")) return `<h3 class="intel-h3">${line.slice(4)}</h3>`
        if(line.startsWith("**") && line.endsWith("**")) return `<p class="intel-bold">${line.slice(2,-2)}</p>`
        if(line.startsWith("- "))   return `<li>${line.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</li>`
        if(line.startsWith("| ") || line.startsWith("|--")) return `<p class="intel-table-row">${line}</p>`
        if(line.trim() === "")      return "<br>"
        return `<p>${line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>`
      })
      .join("")
      .replace(/(<li>.*?<\/li>\s*<br>\s*)+/gs, m => `<ul>${m.replace(/<br>/g, "")}</ul>`)
      .replace(/(<li>.*?<\/li>\n?)+/gs, m => `<ul>${m}</ul>`)

    disc.style.display = "none"
    result.innerHTML   = `
      <div class="intel-timestamp">Analysis generated ${new Date().toLocaleString()} · Powered by Claude with live web search + extended thinking</div>
      ${html}`
    /* Persist so the user can return without re-running the expensive API call */
    try{ localStorage.setItem("capintel_intel_last", JSON.stringify({ html: result.innerHTML, ts: Date.now() })) }catch(e){}

  }catch(e){
    result.innerHTML = `<p class="intel-error">❌ ${e.message}</p><p class="intel-error" style="font-size:12px;margin-top:8px">Check Vercel logs for details.</p>`
  }finally{
    clearInterval(stepTimer)
    btnText.textContent  = "⚡ Analyse Portfolio"
    btn.disabled         = false
    result.style.display = "block"
  }
}


/* ── EXPORT CSV ───────────────────────────────────────────
   Generates a downloadable CSV of all raw asset records.
   Format: Date, Name, Ticker, Broker, Type, Quantity, Price, Currency
   One row per buy lot (not aggregated by ticker). */
async function exportPortfolioCSV(){
  if(!db) return
  const assets = await getAssets()
  if(!assets.length){ alert("No assets to export."); return }

  const rows = [["Date","Name","Ticker","Broker","Type","Quantity","Price","Currency"]]
  assets.forEach(a => {
    const txns = a.transactions || [{ date:a.date, qty:a.quantity, price:a.buyPrice }]
    txns.forEach(t => {
      rows.push([
        t.date || a.date  || "",
        a.name            || "",
        a.ticker          || "",
        a.broker          || "",
        a.type            || "",
        t.qty   ?? a.quantity ?? "",
        t.price ?? a.buyPrice ?? "",
        a.currency        || "EUR"
      ])
    })
  })

  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type:"text/csv" })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement("a")
  a.href     = url
  a.download = `portfolio_export_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}


/* ── BACKUP & RESTORE ─────────────────────────────────────
   Solves the iOS PWA storage isolation problem:
   Safari browser and the home screen PWA use completely separate
   IndexedDB databases. This feature lets you export the full database
   (assets + portfolio history snapshots) as a .json file, then
   import it into any other browser/context (e.g. the home screen app).

   Export format:
   {
     version: 1,
     exportedAt: "2026-03-17T...",
     assets: [ ...all asset records from IndexedDB ],
     portfolioHistory: [ ...all snapshot records from IndexedDB ]
   }

   Import: clears both stores, then bulk-writes the exported records.
   IDs are preserved so sub-row expand buttons still work. */

async function exportBackup(){
  if(!db) return
  try{
    const assets  = await getAssets()
    const history = await new Promise(resolve => {
      db.transaction("portfolioHistory","readonly")
        .objectStore("portfolioHistory")
        .getAll().onsuccess = e => resolve(e.target.result || [])
    })

    const backup = {
      version:         1,
      exportedAt:      new Date().toISOString(),
      assets,
      portfolioHistory: history
    }

    const json = JSON.stringify(backup, null, 2)
    const blob = new Blob([json], { type:"application/json" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href     = url
    a.download = `capintel_backup_${new Date().toISOString().slice(0,10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)

    /* Show success feedback on the export button */
    const btn = document.querySelector("[onclick='exportBackup()']")
    if(btn){ btn.textContent = "✅ Downloaded!"; setTimeout(()=>{ btn.textContent="⬇ Export Backup" }, 3000) }

  }catch(e){
    alert("Export failed: " + e.message)
  }
}

async function importBackup(file){
  if(!db || !file) return
  const statusEl = document.getElementById("backupStatus")

  try{
    const text   = await file.text()
    const backup = JSON.parse(text)

    /* Validate format */
    if(!backup.version || !Array.isArray(backup.assets)){
      alert("Invalid backup file. Please use a .json file exported from CapIntel.")
      return
    }

    const assetCount   = backup.assets.length
    const historyCount = (backup.portfolioHistory || []).length

    const confirmed = confirm(
      `This will REPLACE all current data with:\n` +
      `• ${assetCount} assets\n` +
      `• ${historyCount} portfolio history snapshots\n\n` +
      `Your current data will be overwritten. Continue?`
    )
    if(!confirmed) return

    if(statusEl) statusEl.textContent = "Importing…"

    /* Clear both stores, then write all records */
    await new Promise((resolve, reject) => {
      const tx    = db.transaction(["assets","portfolioHistory"], "readwrite")
      tx.onerror  = () => reject(tx.error)
      tx.oncomplete = resolve

      const assetStore   = tx.objectStore("assets")
      const historyStore = tx.objectStore("portfolioHistory")

      assetStore.clear().onsuccess = () => {
        historyStore.clear().onsuccess = () => {
          /* Write assets — remove id so autoIncrement assigns fresh ones
             (avoids key conflicts if IDs differ between devices) */
          backup.assets.forEach(a => {
            const { id, ...rest } = a
            assetStore.add(rest)
          })
          /* Write history — timestamp is keyPath, preserve as-is */
          ;(backup.portfolioHistory || []).forEach(h => {
            historyStore.put(h)
          })
        }
      }
    })

    if(statusEl) statusEl.textContent = `✅ Restored ${assetCount} assets + ${historyCount} snapshots`
    setTimeout(() => { if(statusEl) statusEl.textContent = "" }, 5000)

    /* Reload everything */
    loadAssets()
    drawGrowthChart()

  }catch(e){
    if(statusEl) statusEl.textContent = "❌ Import failed: " + e.message
    console.error("Backup import error:", e)
  }
}

/* ── TIMEZONE CLOCK ───────────────────────────────────────
   Live clocks for IST, Frankfurt, and New York (updates every second).
   Also shows whether NSE, XETRA, and NYSE are currently open.

   IST: computed manually (UTC+5:30, fixed offset — no DST in India).
   Frankfurt / New York: via Intl.DateTimeFormat for automatic DST.

   Market hours:
   - NSE:   09:15–15:30 IST, Mon–Fri
   - XETRA: 09:00–17:30 Frankfurt, Mon–Fri
   - NYSE:  09:30–16:00 ET, Mon–Fri */
function startClock(){
  const elIST = document.getElementById("clockIST")
  const elDE  = document.getElementById("clockDE")
  const elNY  = document.getElementById("clockNY")
  if(!elIST || !elDE) return

  /* Returns { minutes: h*60+m, day: "Mon"/"Tue"/… } for a given IANA timezone */
  function tzInfo(tz){
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone:tz, weekday:"short", hour:"2-digit", minute:"2-digit", hour12:false
    }).formatToParts(new Date())
    const h = parseInt(parts.find(p => p.type === "hour").value)
    const m = parseInt(parts.find(p => p.type === "minute").value)
    const d = parts.find(p => p.type === "weekday").value
    return { minutes: h * 60 + m, day: d }
  }

  /* Sets market status chip to open (green dot) or closed (grey dot) */
  function setChip(id, open){
    const el = document.getElementById(id)
    if(!el) return
    const dot = el.querySelector(".mkt-status-dot")
    if(open){
      el.classList.add("mkt-open"); el.classList.remove("mkt-closed")
      if(dot){ dot.style.background = "var(--green)"; dot.style.boxShadow = "0 0 5px var(--green)" }
    } else {
      el.classList.remove("mkt-open"); el.classList.add("mkt-closed")
      if(dot){ dot.style.background = "var(--muted)"; dot.style.boxShadow = "none" }
    }
  }

  function tick(){
    const now = new Date()

    /* IST = UTC+5:30, no daylight saving */
    const ist  = new Date(now.getTime() + (5*60+30)*60000)
    elIST.textContent =
      String(ist.getUTCHours()).padStart(2,"0") + ":" +
      String(ist.getUTCMinutes()).padStart(2,"0") + ":" +
      String(ist.getUTCSeconds()).padStart(2,"0")

    /* Frankfurt and New York via Intl for correct DST handling */
    elDE.textContent = new Intl.DateTimeFormat("en-GB",{
      timeZone:"Europe/Berlin", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
    }).format(now)
    if(elNY) elNY.textContent = new Intl.DateTimeFormat("en-GB",{
      timeZone:"America/New_York", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
    }).format(now)

    /* Compute market open/closed state */
    const nseMinutes = ist.getUTCHours()*60 + ist.getUTCMinutes()
    const istDay     = ist.getUTCDay()   /* 0=Sun, 6=Sat */
    const nseOpen    = istDay >= 1 && istDay <= 5 && nseMinutes >= 9*60+15 && nseMinutes < 15*60+30

    const de         = tzInfo("Europe/Berlin")
    const xetraOpen  = !["Sat","Sun"].includes(de.day) && de.minutes >= 9*60 && de.minutes < 17*60+30

    const ny         = tzInfo("America/New_York")
    const nyseOpen   = !["Sat","Sun"].includes(ny.day) && ny.minutes >= 9*60+30 && ny.minutes < 16*60

    setChip("mktNSE",   nseOpen)
    setChip("mktXETRA", xetraOpen)
    setChip("mktNYSE",  nyseOpen)
  }

  tick()
  setInterval(tick, 1000)
}


/* ── APP STARTUP ──────────────────────────────────────────
   Called by db.js once IndexedDB is successfully opened.
   Boots the clock, loads assets, fetches prices and MF NAVs,
   records an initial snapshot, and sets up recurring refresh intervals.

   Refresh intervals (when online):
   - Prices + snapshot : every 5 minutes (300 000 ms)
   - Market ticker     : every 5 minutes
   - MF NAV            : once per day (86 400 000 ms — AMFI updates once daily) */
function startApp(){
  startClock()

  loadAssets().then(() => {
    /* Fetch market ticker after portfolio loads so "My Portfolio" chip has data */
    if(navigator.onLine) fetchMarketTicker()
  }).catch(err => console.error("startApp loadAssets failed:", err))

  if(navigator.onLine){
    /* updatePrices() calls recordPortfolioSnapshot() when it finishes —
       do NOT call recordPortfolioSnapshot() here directly, it fires before
       lastPortfolio is populated and records a near-zero bad snapshot */
    updatePrices()
    updateMutualFundNAV()
  }

  /* Every 5 minutes: update prices (which internally records a snapshot).
     Do NOT call recordPortfolioSnapshot() separately — it would race with
     updatePrices() and record before fresh prices are written. */
  setInterval(() => {
    if(navigator.onLine && db) updatePrices()
  }, 300000)

  setInterval(() => { if(navigator.onLine) fetchMarketTicker() }, 300000)

  /* MF NAV once per day — AMFI publishes after market close */
  setInterval(updateMutualFundNAV, 86400000)
}


/* ── FORM + TABS ENGINE ───────────────────────────────────
   bindAssetForm()     : wires the "Add Asset" manual entry form
   bindCSVImport()     : wires CSV file import + export
   bindTabs()          : wires Portfolio ↔ Insights tab switching
   applyFilters()      : filters portfolio array by search / type / growth
*/

function parseNumber(value){
  return Number(value || 0)
}

/* Reads the Add Asset form, validates, and saves a new buy lot to IndexedDB */
function bindAssetForm(){
  const saveBtn = document.getElementById("saveAsset")
  if(!saveBtn) return

  saveBtn.onclick = () => {
    if(!db) return

    const name     = document.getElementById("assetName")?.value?.trim()
    const ticker   = document.getElementById("assetTicker")?.value?.trim().toUpperCase()
    const broker   = document.getElementById("assetBroker")?.value   || ""
    const type     = document.getElementById("assetType")?.value     || "Other"
    const currency = document.getElementById("assetCurrency")?.value || "EUR"
    const quantity = parseNumber(document.getElementById("assetQty")?.value)
    const buyPrice = parseNumber(document.getElementById("assetPrice")?.value)
    const buyDate  = document.getElementById("assetDate")?.value     || ""

    if(!name || quantity <= 0 || buyPrice < 0) return

    saveAsset({ name, ticker, broker, type, currency, quantity,
                buyPrice, buyPriceEUR: convertToEUR(buyPrice, currency),
                currentPrice: buyPrice, buyDate })

    /* Clear form fields after save */
    document.getElementById("assetName").value   = ""
    document.getElementById("assetTicker").value = ""
    document.getElementById("assetQty").value    = ""
    document.getElementById("assetPrice").value  = ""
    document.getElementById("assetDate").value   = ""

    loadAssets()
  }

  /* Wire up ticker/name autocomplete */
  bindTickerAutocomplete()
}

/* ── TICKER AUTOCOMPLETE ──────────────────────────────────
   Searches Yahoo Finance as the user types in the ticker or name field.
   Selecting a result auto-fills both name and ticker fields.
   Debounced to 350ms to avoid hammering the API. */
function bindTickerAutocomplete(){
  const nameInput   = document.getElementById("assetName")
  const tickerInput = document.getElementById("assetTicker")
  const dropdown    = document.getElementById("tickerDropdown")
  if(!nameInput || !tickerInput || !dropdown) return

  let debounceTimer = null

  async function searchAndShow(query){
    if(!query || query.length < 2){ dropdown.style.display = "none"; return }
    try{
      const r = await fetch(`/api/search?q=${encodeURIComponent(query)}`)
      if(!r.ok) return
      const { results } = await r.json()
      if(!results.length){ dropdown.style.display = "none"; return }

      dropdown.innerHTML = results.map(r => `
        <div class="ticker-suggest" data-symbol="${r.symbol}" data-name="${r.name.replace(/"/g,'&quot;')}" data-type="${r.type}">
          <span class="ts-symbol">${r.symbol}</span>
          <span class="ts-name">${r.name}</span>
          <span class="ts-exch">${r.exchange}</span>
        </div>`).join("")
      dropdown.style.display = "block"

      dropdown.querySelectorAll(".ticker-suggest").forEach(el => {
        el.onclick = () => {
          tickerInput.value = el.dataset.symbol
          nameInput.value   = el.dataset.name
          /* Auto-select type if recognisable */
          const typeMap = { EQUITY:"Stock", ETF:"ETF", CRYPTOCURRENCY:"Crypto", FUTURE:"Commodity" }
          const typeEl  = document.getElementById("assetType")
          if(typeEl && typeMap[el.dataset.type]) typeEl.value = typeMap[el.dataset.type]
          dropdown.style.display = "none"
          document.getElementById("assetQty")?.focus()
        }
      })
    }catch(e){ dropdown.style.display = "none" }
  }

  function onInput(e){
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => searchAndShow(e.target.value.trim()), 350)
  }

  nameInput.addEventListener("input",   onInput)
  tickerInput.addEventListener("input", onInput)

  /* Close dropdown when clicking outside */
  document.addEventListener("click", e => {
    if(!nameInput.contains(e.target) && !tickerInput.contains(e.target) && !dropdown.contains(e.target)){
      dropdown.style.display = "none"
    }
  })
}

/* ── EDIT ASSET LOT ──────────────────────────────────────
   Opens an inline edit form in the sub-row to adjust qty or buy price.
   Current price is intentionally not editable — it comes from market data.
   After saving, reloads the table and triggers a fresh price update. */
async function editAsset(id){
  const assets = await getAssets()
  const asset  = assets.find(a => a.id === id)
  if(!asset) return

  const newQty   = parseFloat(prompt(`Edit quantity for ${asset.name}\nCurrent: ${asset.quantity}`, asset.quantity))
  if(isNaN(newQty) || newQty <= 0){ alert("Invalid quantity."); return }

  const newPrice = parseFloat(prompt(`Edit buy price for ${asset.name} (${asset.currency})\nCurrent: ${asset.buyPrice}`, asset.buyPrice))
  if(isNaN(newPrice) || newPrice < 0){ alert("Invalid price."); return }

  const tx = db.transaction("assets", "readwrite")
  tx.objectStore("assets").put({
    ...asset,
    quantity:    newQty,
    buyPrice:    newPrice,
    buyPriceEUR: convertToEUR(newPrice, asset.currency)
    /* currentPrice intentionally preserved — will update on next price fetch */
  })
  tx.oncomplete = () => loadAssets()
}

/* Reads a CSV file, parses rows, and bulk-imports assets.
   Supports 7-column (no date) and 8-column (with date) formats.
   Handles quoted-comma CSV fields and iPhone line endings (\r\n, \r). */
function bindCSVImport(){
  const fileInput = document.getElementById("csvFile")
  const exportBtn = document.getElementById("exportCSV")
  if(exportBtn) exportBtn.onclick = exportPortfolioCSV
  if(!fileInput) return

  /* CSV file input now has onchange wired in HTML to call importCSVFile()
     The hidden importCSV button is kept only for legacy compatibility */
  fileInput.addEventListener("change", () => {
    const file = fileInput.files[0]
    if(!file) return
    importCSVFile(file)
    fileInput.value = ""
  })
}

function importCSVFile(file){

    const reader = new FileReader()
    reader.onload = e => {
      let text = e.target.result
      /* Normalise line endings */
      text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
      const rows = text.split("\n").map(r => r.trim()).filter(r => r)
      if(rows.length <= 1) return

      rows.shift()  /* remove header row */

      let imported = 0, skipped = 0
      rows.forEach(row => {
        /* Split on commas not inside quoted fields */
        const cols = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, "").trim())
        if(cols[1] === "Name") return  /* skip secondary header rows */

        /* Auto-detect 8-col format (date in col 0) vs 7-col (no date) */
        const hasDate = cols.length >= 8 && cols[0].match(/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|\d{1,2}[-\/]\d{1,2}[-\/]\d{4}/)

        const nameIdx   = hasDate ? 1 : 0
        const tickerIdx = hasDate ? 2 : 1
        const brokerIdx = hasDate ? 3 : 2
        const typeIdx   = hasDate ? 4 : 3
        const qtyIdx    = hasDate ? 5 : 4
        const priceIdx  = hasDate ? 6 : 5
        const curIdx    = hasDate ? 7 : 6

        const buy = parseMoney(cols[priceIdx])
        const qty = parseMoney(cols[qtyIdx])
        let   cur = (cols[curIdx] || "EUR").trim().toUpperCase()

        if(isNaN(buy) || isNaN(qty) || qty <= 0 || buy < 0){ skipped++; return }
        if(!["EUR","USD","INR"].includes(cur)) cur = "EUR"

        saveAsset({
          name:         cols[nameIdx]   || "Unknown",
          ticker:       cols[tickerIdx] || "",
          broker:       cols[brokerIdx] || "",
          type:         cols[typeIdx]   || "Stock",
          quantity:     qty,
          buyPrice:     buy,
          currency:     cur,
          buyPriceEUR:  convertToEUR(buy, cur),
          currentPrice: buy,
          buyDate:      hasDate ? cols[0] : new Date().toISOString().split("T")[0]
        })
        imported++
      })

      loadAssets()
      if(skipped > 0) console.warn(`CSV import: ${imported} imported, ${skipped} rows skipped (invalid qty/price)`)
    }
    reader.readAsText(file)
}

/* Wires tab switching: Portfolio ↔ Insights.
   On switching to Insights: draws donuts, summaries, movers, loads news.
   The growth chart is NOT recreated on tab switch (it persists from initial load). */
/* Restores the last generated Smart Picks and AI Intelligence results from
   localStorage so the user can see them without re-running the API call.
   Called every time the Insights tab is opened.
   Shows a "Last generated on …" banner so the user knows it's cached. */
function restoreLastAnalysis(){
  const restoreSection = (storageKey, resultId, disclaimerId) => {
    const el   = document.getElementById(resultId)
    const disc = document.getElementById(disclaimerId)
    if(!el) return
    /* Don't overwrite if content was already generated this session */
    if(el.innerHTML.trim() && el.style.display !== "none") return
    try{
      const saved = localStorage.getItem(storageKey)
      if(!saved) return
      const { html, ts } = JSON.parse(saved)
      if(!html) return
      const age    = Math.round((Date.now() - ts) / 60000)
      const ageStr = age < 60 ? `${age}m ago` : age < 1440 ? `${Math.round(age/60)}h ago` : `${Math.round(age/1440)}d ago`
      /* Prepend a subtle "cached" banner before the saved HTML */
      el.innerHTML = `<div class="analysis-cached-banner">📋 Last analysis · ${ageStr} · <button class="cached-clear-btn" onclick="clearAnalysisCache('${storageKey}','${resultId}','${disclaimerId}')">Clear</button></div>` + html
      if(disc) disc.style.display = "none"
      el.style.display = "block"
    }catch(e){}
  }

  restoreSection("capintel_picks_last",  "picksResult",  "picksDisclaimer")
  restoreSection("capintel_intel_last",  "intelResult",  "intelDisclaimer")
}

/* Clears a saved analysis from localStorage and hides the result panel */
function clearAnalysisCache(storageKey, resultId, disclaimerId){
  try{ localStorage.removeItem(storageKey) }catch(e){}
  const el   = document.getElementById(resultId)
  const disc = document.getElementById(disclaimerId)
  if(el){ el.innerHTML = ""; el.style.display = "none" }
  if(disc) disc.style.display = ""
}

function bindTabs(){
  document.querySelectorAll(".tabBtn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"))
      document.querySelectorAll(".tabContent").forEach(tab => tab.classList.remove("active"))
      btn.classList.add("active")

      const tabId = btn.dataset.tab
      const tab   = document.getElementById(tabId)
      if(tab) tab.classList.add("active")

      if(tabId === "insightsTab"){
        drawCharts(lastPortfolio)
        renderInsightsSummary(lastPortfolio)
        renderTopMovers(lastPortfolio)
        fetchDailyInsights(lastPortfolio, false)
        /* Restore last analysis results without re-running the API */
        restoreLastAnalysis()
      }
      /* portfolioTab: growth chart persists — no recreate needed here */
    }
  })
}

/* Filters the portfolio array by active search text, type dropdown,
   and profit/loss filter dropdown. Pure function — does not touch the DOM. */
function applyFilters(rows){
  const asset  = document.getElementById("filterAsset")?.value.toLowerCase().trim()
  const type   = document.getElementById("filterType")?.value
  const growth = document.getElementById("filterGrowth")?.value

  return rows.filter(r => {
    if(asset){
      const dn     = resolveDisplayName(r).toLowerCase()
      const ticker = (r.key || "").toLowerCase()
      if(!dn.includes(asset) && !ticker.includes(asset)) return false
    }
    if(type   && r.type !== type) return false
    if(growth === "positive" && r.profitEUR <= 0) return false
    if(growth === "negative" && r.profitEUR >= 0) return false
    return true
  })
}


/* ── BOOT SEQUENCE ────────────────────────────────────────
   These calls run immediately at script parse time.
   bindAssetForm / bindTabs / bindCSVImport attach event listeners.
   initDB() (from db.js) opens IndexedDB; on success it calls startApp(). */
bindAssetForm()
bindTabs()
bindCSVImport()
bindSearchDropdown()

document.getElementById("sortAssets")?.addEventListener("change",  () => loadAssets())
document.getElementById("filterType")?.addEventListener("change",   () => loadAssets())
document.getElementById("filterGrowth")?.addEventListener("change", () => loadAssets())

if(typeof initDB === "function"){
  initDB()
}
