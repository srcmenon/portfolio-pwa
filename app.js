/* =========================
GLOBAL STATE
========================= */

let allocationChartInstance = null
let currencyChartInstance = null
let growthChartInstance = null
let priceUpdateRunning = false
let allocationBarChartInstance=null
let lastPortfolio = []
window.addEventListener("DOMContentLoaded",()=>{

let d=document.getElementById("assetDate")

if(d){
d.value=new Date().toISOString().split("T")[0]
}

})

/* =========================
NSE DISPLAY NAMES
========================= */
const NSE_NAMES = {
  BAJFINANCE:"Bajaj Finance", BEL:"Bharat Electronics", BERGEPAINT:"Berger Paints",
  CDSL:"CDSL", COALINDIA:"Coal India", CRISIL:"CRISIL Ltd",
  DREAMFOLKS:"Dreamfolks Services", ENGINERSIN:"Engineers India", ETERNAL:"Eternal Ltd",
  GESHIP:"Great Eastern Shipping", HDFCBANK:"HDFC Bank", HEROMOTOCO:"Hero MotoCorp",
  HINDUNILVR:"Hindustan Unilever", IDFCFIRSTB:"IDFC First Bank", INDHOTEL:"Indian Hotels",
  INFY:"Infosys", IOLCP:"IOL Chemicals", IRCTC:"IRCTC", ITC:"ITC Ltd",
  ITCHOTELS:"ITC Hotels", JINDALSTEL:"Jindal Steel & Power", JIOFIN:"Jio Financial Services",
  KALYANKJIL:"Kalyan Jewellers", KEI:"KEI Industries", KIRLPNU:"Kirloskar Pneumatic",
  KPITTECH:"KPIT Technologies", KTKBANK:"Karnataka Bank", KWIL:"Kiri Industries",
  LICHSGFIN:"LIC Housing Finance", LICI:"LIC of India", LT:"Larsen & Toubro",
  LTFOODS:"LT Foods", MAANALU:"Maan Aluminium", MAHSEAMLES:"Maharashtra Seamless",
  NATIONALUM:"National Aluminium", NAVA:"NAVA Ltd", NLCINDIA:"NLC India",
  NMDC:"NMDC Ltd", OFSS:"Oracle Financial Services", OIL:"Oil India", ONGC:"ONGC",
  PATELENG:"Patel Engineering", PERSISTENT:"Persistent Systems", PFC:"Power Finance Corp",
  PIDILITIND:"Pidilite Industries", POWERGRID:"Power Grid Corp", PTC:"PTC India",
  PVRINOX:"PVR Inox", RECLTD:"REC Ltd", RELIANCE:"Reliance Industries",
  RPOWER:"Reliance Power", SAIL:"SAIL", SBIN:"State Bank of India",
  SCHAEFFLER:"Schaeffler India", SHRIRAMFIN:"Shriram Finance", SOBHA:"Sobha Ltd",
  SOLARINDS:"Solar Industries", SUNDARMFIN:"Sundaram Finance", TATACHEM:"Tata Chemicals",
  TATASTEEL:"Tata Steel", TATATECH:"Tata Technologies", TCS:"Tata Consultancy Services",
  TMCV:"Tata Motors (CV)", TMPV:"Tata Motors (PV)", VEDL:"Vedanta Ltd", VOLTAS:"Voltas Ltd"
}

function resolveDisplayName(pos){
  if(NSE_NAMES[pos.key]) return NSE_NAMES[pos.key]
  return pos.name || pos.key
}

/* =========================
SERVICE WORKER
========================= */

if ("serviceWorker" in navigator){
navigator.serviceWorker.register("sw.js")
}

/* =========================
FX ENGINE
========================= */
let FX = {
EUR: 1,
USD: 1.09,
INR: 104
}

async function updateFX(){

try{

let r = await fetch("https://api.exchangerate.host/latest?base=EUR")
let data = await r.json()

if(data && data.rates){
FX.INR = data.rates.INR
FX.USD = data.rates.USD
}

}catch(e){
console.log("FX update failed")
}

}

updateFX()
setInterval(updateFX,3600000)

/* =========================
FORMAT HELPERS
========================= */

function formatCurrency(value,currency){

let symbol=""

if(currency==="EUR") symbol="€"
if(currency==="USD") symbol="$"
if(currency==="INR") symbol="₹"

return symbol + Number(value).toLocaleString(undefined,{
minimumFractionDigits:2,
maximumFractionDigits:2
})

}
function parseMoney(v){
return Number(String(v).replace(/[^0-9.-]+/g,""))
}
function convertToEUR(value,currency){

if(currency==="EUR") return value
return value / FX[currency]

}

function convertFromEUR(value,currency){

if(currency==="EUR") return value
return value * FX[currency]

}

/* =========================
DATABASE ENGINE
========================= */

function getAssets(){

return new Promise(resolve=>{

let tx=db.transaction("assets","readonly")
let store=tx.objectStore("assets")

store.getAll().onsuccess=(e)=>{
resolve(e.target.result)
}

})

}

function saveAsset(asset){

let tx=db.transaction("assets","readwrite")
tx.objectStore("assets").add(asset)

}

function deleteAsset(id){

if(!db) return

let tx=db.transaction("assets","readwrite")
tx.objectStore("assets").delete(id)

tx.oncomplete=()=>{
loadAssets()
}

}



/* =========================
PORTFOLIO ENGINE
========================= */

function groupAssets(assets){

let groups={}

assets.forEach(a=>{
let key=a.ticker || a.name

if(!groups[key]) groups[key]=[]
groups[key].push(a)
})

return groups

}
/*New function single Portfolio engine*/
function calculatePortfolio(groups){

let results=[]

Object.keys(groups).forEach(key=>{

let list=groups[key]

let qty=0
let totalBuyLocal=0
let currency=list[0].currency || "EUR"
let name=list[0].name || key
let type=list[0].type || ""
let lastDate=""

list.forEach(a=>{

let q=a.quantity || 0
let buy=a.buyPrice || 0
let current=a.currentPrice || buy

qty+=q
totalBuyLocal+=buy*q

if(a.buyDate && a.buyDate>lastDate) lastDate=a.buyDate

})

let avgBuy = qty ? totalBuyLocal/qty : 0
let currentPrice=list.reduce((p,c)=>c.currentPrice || p ,0) || avgBuy

let totalCurrentLocal=currentPrice*qty

let buyEUR=convertToEUR(avgBuy,currency)
let currentEUR=convertToEUR(currentPrice,currency)

let totalBuyEUR=buyEUR*qty
let totalCurrentEUR=currentEUR*qty

let profitLocal=totalCurrentLocal-totalBuyLocal
let profitEUR=totalCurrentEUR-totalBuyEUR

let growth = 0

if(totalBuyLocal > 0){
growth = ((totalCurrentLocal - totalBuyLocal) / totalBuyLocal) * 100
}

results.push({
key,
name,
type,
currency,
qty,
avgBuy,
currentPrice,
totalBuyLocal,
totalCurrentLocal,
totalBuyEUR,
totalCurrentEUR,
profitLocal,
profitEUR,
growth,
lastDate,
list
})

})

return results

}


/* =========================
UI RENDER ENGINE
========================= */

async function loadAssets(){

if(!db) return

let assets = await getAssets()

let groups = groupAssets(assets)

/* Use unified portfolio engine */

let portfolio = calculatePortfolio(groups)

/* Cache for tab reuse */
lastPortfolio = portfolio

/* Sort */
let sortVal = document.getElementById("sortAssets")?.value || "name"
portfolio.sort((a,b)=>{
  if(sortVal==="growth")  return b.growth - a.growth
  if(sortVal==="profit")  return b.profitEUR - a.profitEUR
  if(sortVal==="value")   return b.totalCurrentEUR - a.totalCurrentEUR
  return resolveDisplayName(a).localeCompare(resolveDisplayName(b))
})

/* Filter for table only */
let filtered = applyFilters(portfolio)

/* Render UI */
renderPortfolioTable(filtered)
renderPortfolioSummary(portfolio)
renderPortfolioReturn(portfolio)

/* Charts */
drawPortfolioAllocation(portfolio)

if(document.getElementById("insightsTab")?.classList.contains("active")){
  drawCharts(lastPortfolio)
  drawGrowthChart()
  renderInsightsSummary(lastPortfolio)
  renderTopMovers(lastPortfolio)
}

}

function renderPortfolioTable(portfolio){

let table=document.querySelector("#assetTable tbody")
if(!table) return

table.innerHTML=""

/* Populate search dropdown */
updateSearchDropdown(portfolio)

portfolio.forEach(pos=>{

let plClass="neutral"
if(pos.profitEUR>0) plClass="profit"
else if(pos.profitEUR<0) plClass="loss"

let groupId="grp_"+pos.key.replace(/[^a-zA-Z0-9]/g,"_")
let displayName = resolveDisplayName(pos)
let showTicker = (pos.key !== displayName)
let typeBadge = pos.type ? `<span class="badge badge-${pos.type}">${pos.type}</span>` : ""

let row=document.createElement("tr")
row.innerHTML=`
<td>
  <span class="toggleBtn" data-target="${groupId}">▶</span>
  <span class="asset-name">${displayName}</span>
  ${showTicker ? `<span class="asset-sub">${pos.key}</span>` : ""}
</td>
<td class="num">${pos.qty.toFixed(3)}</td>
<td>
  <span class="num">${formatCurrency(pos.avgBuy,pos.currency)}</span>
  <span class="eurValue">${formatCurrency(convertToEUR(pos.avgBuy,pos.currency),"EUR")}</span>
</td>
<td>
  <span class="num">${formatCurrency(pos.currentPrice,pos.currency)}</span>
  <span class="eurValue">${formatCurrency(convertToEUR(pos.currentPrice,pos.currency),"EUR")}</span>
</td>
<td>
  <span class="num">${formatCurrency(pos.totalBuyLocal,pos.currency)}</span>
  <span class="eurValue">${formatCurrency(pos.totalBuyEUR,"EUR")}</span>
</td>
<td>
  <span class="num">${formatCurrency(pos.totalCurrentLocal,pos.currency)}</span>
  <span class="eurValue">${formatCurrency(pos.totalCurrentEUR,"EUR")}</span>
</td>
<td class="${plClass}">
  ${formatCurrency(pos.profitLocal,pos.currency)}
  <span class="eurValue">${formatCurrency(pos.profitEUR,"EUR")}</span>
</td>
<td class="${plClass}">${pos.growth.toFixed(2)}%</td>
<td>${typeBadge}</td>
<td class="num" style="font-size:12px;color:var(--dim)">${pos.lastDate || ""}</td>
`
table.appendChild(row)

pos.list.forEach(a=>{
  let sub=document.createElement("tr")
  sub.className="subRow "+groupId
  sub.style.display="none"
  sub.innerHTML=`
    <td>↳ ${a.buyDate || ""}</td>
    <td class="num">${a.quantity}</td>
    <td class="num">${formatCurrency(a.buyPrice,a.currency)}</td>
    <td class="num">${formatCurrency(a.currentPrice || a.buyPrice,a.currency)}</td>
    <td colspan="4" style="color:var(--dim)">${a.broker || ""}</td>
    <td><button onclick="deleteAsset(${a.id})">Remove</button></td>
  `
  table.appendChild(sub)
})

})

setupToggleButtons()
}

/* ── Search dropdown ── */
function updateSearchDropdown(portfolio){
  window._searchPortfolio = portfolio
}

function bindSearchDropdown(){
  const input = document.getElementById("filterAsset")
  const dropdown = document.getElementById("searchDropdown")
  if(!input || !dropdown) return

  input.addEventListener("input", ()=>{
    const q = input.value.toLowerCase().trim()
    if(!q || !window._searchPortfolio){
      dropdown.style.display="none"
      loadAssets()
      return
    }
    const matches = window._searchPortfolio.filter(p=>{
      const dn = resolveDisplayName(p).toLowerCase()
      return dn.includes(q) || p.key.toLowerCase().includes(q)
    })
    if(!matches.length){ dropdown.style.display="none"; loadAssets(); return }
    dropdown.innerHTML = matches.slice(0,8).map(p=>{
      const dn = resolveDisplayName(p)
      const showT = p.key !== dn
      return `<div class="search-item" data-value="${dn}">
        <span>${dn}</span>
        ${showT ? `<span class="ticker-tag">${p.key}</span>` : ""}
      </div>`
    }).join("")
    dropdown.style.display = "block"
    loadAssets()
  })

  dropdown.addEventListener("click", e=>{
    const item = e.target.closest(".search-item")
    if(item){
      input.value = item.dataset.value
      dropdown.style.display = "none"
      loadAssets()
    }
  })

  document.addEventListener("click", e=>{
    if(!input.contains(e.target) && !dropdown.contains(e.target)){
      dropdown.style.display = "none"
    }
  })
}

function renderPortfolioSummary(portfolio){

let totalEUR = 0

portfolio.forEach(p=>{
totalEUR += p.totalCurrentEUR
})

let inr = convertFromEUR(totalEUR,"INR")

let countEl=document.getElementById("assetCount")
let valueEl=document.getElementById("totalValue")

if(countEl) countEl.innerText = portfolio.length

if(valueEl){

valueEl.innerHTML=`
${formatCurrency(totalEUR,"EUR")}
<br>
<span class="inrValue">${formatCurrency(inr,"INR")}</span>
`

}

}

function renderPortfolioReturn(portfolio){

let invested=0
let current=0

portfolio.forEach(p=>{
invested += p.totalBuyEUR
current += p.totalCurrentEUR
})

let returnEl=document.getElementById("portfolioReturn")

if(!returnEl) return

if(invested<=0){
returnEl.textContent="No data yet"
return
}

let change=((current-invested)/invested)*100
let sign=change>0?"+":""

returnEl.textContent=`${sign}${change.toFixed(2)}%`

}


function setupToggleButtons(){

document.querySelectorAll(".toggleBtn").forEach(btn=>{

btn.onclick=()=>{

let target=btn.dataset.target
let rows=document.querySelectorAll("."+target)
if(!rows.length) return
let open = rows[0].style.display === "table-row"

rows.forEach(r=>{
r.style.display=open?"none":"table-row"
})

btn.textContent=open?"▶":"▼"

}

})

}

/* =========================
PRICE ENGINE
========================= */
async function updateMutualFundNAV(){

if(!db) return

try{

const res = await fetch("/api/mfnav")
const text = await res.text()

const navMap = {}

const lines = text.split("\n")

for(const line of lines){

if(!line || !line.includes(";")) continue

const parts = line.split(";")

if(parts.length < 6) continue

const schemeCode = parts[0].trim()
const schemeName = parts[3].toLowerCase()
const nav = parseFloat(parts[4])

if(!schemeCode || isNaN(nav) || nav <= 0) continue

const isExcluded =
schemeName.includes("idcw") ||
schemeName.includes("dividend") ||
schemeName.includes("payout") ||
schemeName.includes("bonus")

const isGrowth = schemeName.includes("growth")
const isDirect = schemeName.includes("direct")

/* Accept growth plans, OR direct plans without IDCW
   (catches funds like HDFC Gold ETF FOF - Direct Plan with no "growth" in name) */
if(!isExcluded && (isGrowth || isDirect) && !navMap[schemeCode]){
navMap[schemeCode] = nav
}

}   // ✅ THIS BRACE WAS MISSING (closing the for loop)

const assets = await getAssets()

/* ── DEBUG: log all MF matches and misses ── */
console.group("🔍 Mutual Fund NAV Debug")
const mfAssets = assets.filter(a => a.type === "MutualFund")
console.log(`Total MF assets in DB: ${mfAssets.length}`)
console.log(`Total scheme codes in NAV map: ${Object.keys(navMap).length}`)
console.groupCollapsed("✅ Matched (scheme code found in AMFI)")
mfAssets.forEach(a => {
  const nav = navMap[a.ticker]
  if(nav) console.log(`${a.name} | code: ${a.ticker} | NAV: ₹${nav}`)
})
console.groupEnd()
console.groupCollapsed("❌ Missed (scheme code NOT found in AMFI)")
mfAssets.forEach(a => {
  if(!navMap[a.ticker]) console.log(`${a.name} | code: ${a.ticker}`)
})
console.groupEnd()
console.groupCollapsed("🔎 Nearby AMFI entries for missed funds (first 3 chars match)")
mfAssets.forEach(a => {
  if(!navMap[a.ticker]){
    const prefix = String(a.ticker).slice(0,3)
    const nearby = Object.keys(navMap).filter(k => k.startsWith(prefix))
    if(nearby.length){
      console.log(`${a.name} (${a.ticker}) → nearby codes:`, nearby)
    }
  }
})
console.groupEnd()
console.groupEnd()
/* ── END DEBUG ── */

const tx = db.transaction("assets","readwrite")
const store = tx.objectStore("assets")

for(const a of assets){

if(a.type !== "MutualFund") continue

const nav = navMap[a.ticker]

if(!nav) continue

store.put({
...a,
currentPrice: nav
})

}

tx.oncomplete = () => loadAssets()

}catch(e){

console.log("MF NAV update failed",e)

}

}
function resolveTicker(asset){

let t = asset.ticker
const cur = asset.currency || "INR"

if(!t) return null

/* Crypto */
if(t.includes("-USD")) return t

/* Mutual funds handled separately */
if(asset.type==="MutualFund") return null

/* Explicit exchange suffixes — already fully qualified */
if(t.includes(".")) return t

/* Special overrides for ambiguous tickers */
if(t === "SEMI") return "CHIP.PA"   /* Amundi Semiconductors — Paris, EUR */
if(t === "EWG2") return "EWG2.SG"   /* EUWAX Gold II — Stuttgart */

/* Currency + type based resolution:
   USD → US exchange (no suffix)
   EUR + ETF/Commodity → LSE (.L) — e.g. IWDA, EIMI, SSLV, DFNS
   EUR + Stock → US exchange (no suffix) — e.g. GOOGL, AMZN, MU bought via Scalable/TR
   INR → NSE (.NS)
*/
if(cur === "USD") return t
if(cur === "EUR"){
  const type = (asset.type || "").toLowerCase()
  if(type === "etf" || type === "commodity") return t + ".L"
  return t  /* Stock in EUR = US-listed, no suffix */
}
return t + ".NS"

}
async function fetchPrice(asset){

try{

let symbol = resolveTicker(asset)

if(!symbol) return null

let r = await fetch("/api/price?ticker=" + symbol)

if(!r.ok) return null

let data = await r.json()

return Number(data.price) || null

}catch(e){

console.log("Price fetch failed",asset.ticker)
return null

}

}

async function updatePrices(){

if(priceUpdateRunning || !db) return
priceUpdateRunning=true

let assets=await getAssets()

for(let a of assets){

/* Skip mutual funds */
if(a.type==="MutualFund") continue

if(!a.ticker) continue

let price=await fetchPrice(a)

if(price!==null){

/* Currency conversion:
   Yahoo Finance always returns USD prices for US-listed tickers.
   If the asset is stored in EUR (e.g. bought via Scalable/TR),
   convert the USD price to EUR using the live FX rate. */
const symbol = resolveTicker(a)
const isUSTicker = symbol && !symbol.includes(".") && !symbol.includes("-USD")
if(isUSTicker && a.currency === "EUR" && FX.USD){
  price = price / FX.USD
}

let tx=db.transaction("assets","readwrite")

tx.objectStore("assets").put({
...a,
currentPrice:price
})

}

}

priceUpdateRunning=false
loadAssets()

}

/* =========================
PORTFOLIO SNAPSHOT
========================= */

async function recordPortfolioSnapshot(){

if(!db) return

let assets=await getAssets()

let total=0

assets.forEach(a=>{
let value=(a.currentPrice||0)*(a.quantity||0)
total+=convertToEUR(value,a.currency)
})

let tx=db.transaction("portfolioHistory","readwrite")

tx.objectStore("portfolioHistory").put({
timestamp:Date.now(),
value:total
})

}

/* =========================
CHARTS ENGINE
========================= */

const CHART_COLORS = ["#5b9cf6","#22d17a","#f0a535","#f4506a","#a855f7","#fbbf24","#34d399","#f87171"]

function makeDonut(canvasId, labels, values, instanceVar){
  if(window[instanceVar]) window[instanceVar].destroy()
  const ctx = document.getElementById(canvasId)
  if(!ctx) return
  window[instanceVar] = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: CHART_COLORS.slice(0, labels.length),
        borderColor: "#0c1428",
        borderWidth: 3,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: "62%",
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#8899bb",
            font: { family: "Outfit", size: 12 },
            padding: 14,
            boxWidth: 12
          }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a,b)=>a+b,0)
              const pct = ((ctx.raw/total)*100).toFixed(1)
              return ` ${ctx.label}: €${ctx.raw.toFixed(0)} (${pct}%)`
            }
          }
        }
      }
    }
  })
}

function drawCharts(portfolio){
  if(!portfolio || !portfolio.length) return
  const allocation={}, currencies={}
  portfolio.forEach(p=>{
    allocation[p.type||"Other"] = (allocation[p.type||"Other"]||0)+p.totalCurrentEUR
    currencies[p.currency]      = (currencies[p.currency]||0)+p.totalCurrentEUR
  })
  makeDonut("allocationChart", Object.keys(allocation), Object.values(allocation), "allocationChartInstance")
  makeDonut("currencyChart",   Object.keys(currencies), Object.values(currencies), "currencyChartInstance")
}
function drawPortfolioAllocation(portfolio){
  if(!portfolio||!portfolio.length) return
  const allocation={}
  portfolio.forEach(p=>{
    const type=p.type||"Other"
    allocation[type]=(allocation[type]||0)+p.totalCurrentEUR
  })
  makeDonut("portfolioAllocationChart", Object.keys(allocation), Object.values(allocation), "allocationBarChartInstance")
}
let portfolioGrowthChartInstance = null
let currentPeriod = "1W"
let currentCat = "ALL"
let allPortfolioHistory = []

const CAT_DEFS = {
  "ALL":           { label:"All Portfolio", color:"#5b9cf6" },
  "MutualFund_INR":{ label:"India MF",      color:"#f0a535" },
  "Stock_INR":     { label:"India Stocks",  color:"#22d17a" },
  "Stock_EUR":     { label:"EUR Stocks",    color:"#7b5cf0" },
  "Stock_USD":     { label:"USD Stocks",    color:"#00cfff" },
  "ETF_EUR":       { label:"EUR ETFs",      color:"#f4506a" },
  "Commodity":     { label:"Commodity",     color:"#e8c84a" }
}

function matchCat(asset, cat){
  if(cat==="ALL") return true
  if(cat==="Commodity") return asset.type==="Commodity"
  const [type, cur] = cat.split("_")
  return asset.type===type && asset.currency===cur
}

function getCatValues(history, cat){
  if(cat==="ALL") return history.map(h=>h.value)
  if(!lastPortfolio||!lastPortfolio.length) return history.map(h=>h.value)
  const catAssets = lastPortfolio.filter(a=>matchCat(a,cat))
  const catTotal  = catAssets.reduce((s,a)=>s+a.totalCurrentEUR,0)
  const allTotal  = lastPortfolio.reduce((s,a)=>s+a.totalCurrentEUR,0)
  const fraction  = allTotal>0 ? catTotal/allTotal : 0
  return history.map(h=>h.value * fraction)
}

function periodMs(period){
  const now = Date.now()
  const map = { "1D":86400000,"1W":604800000,"1M":2592000000,
                "3M":7776000000,"1Y":31536000000,"5Y":157680000000,"ALL":Infinity }
  return now - (map[period]||map["1W"])
}

function formatLabel(ts, period){
  const d = new Date(ts)
  if(period==="1D") return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})
  if(period==="1W"||period==="1M"||period==="3M"||period==="1Y")
    return d.toLocaleDateString([],{month:"short",day:"numeric"})
  return d.toLocaleDateString([],{year:"2-digit",month:"short"})
}

function drawGrowthChart(){
  if(!db) return
  db.transaction("portfolioHistory","readonly")
    .objectStore("portfolioHistory")
    .getAll().onsuccess = e => {
      allPortfolioHistory = e.target.result || []
      renderGrowthChart(currentPeriod, currentCat)
      bindPeriodButtons()
      bindCatButtons()
    }
}

function bindPeriodButtons(){
  document.querySelectorAll(".period-btn").forEach(btn=>{
    btn.onclick = ()=>{
      document.querySelectorAll(".period-btn").forEach(b=>b.classList.remove("active"))
      btn.classList.add("active")
      currentPeriod = btn.dataset.period
      renderGrowthChart(currentPeriod, currentCat)
    }
  })
}

function bindCatButtons(){
  document.querySelectorAll(".cat-btn").forEach(btn=>{
    btn.onclick = ()=>{
      document.querySelectorAll(".cat-btn").forEach(b=>b.classList.remove("active"))
      btn.classList.add("active")
      currentCat = btn.dataset.cat
      const lbl = document.getElementById("growthStatLabel")
      if(lbl) lbl.textContent = CAT_DEFS[currentCat]?.label||"Portfolio"
      renderGrowthChart(currentPeriod, currentCat)
    }
  })
}

function renderGrowthChart(period, cat){
  cat = cat || currentCat || "ALL"
  const cutoff = periodMs(period)
  let history = allPortfolioHistory
    .filter(h=>h.timestamp>=cutoff)
    .sort((a,b)=>a.timestamp-b.timestamp)
  if(!history.length) history = [...allPortfolioHistory].sort((a,b)=>a.timestamp-b.timestamp)
  if(!history.length) return

  const values = getCatValues(history, cat)
  const labels  = history.map(h=>formatLabel(h.timestamp, period))
  const first   = values[0]||0
  const last    = values[values.length-1]||0
  const change  = last - first
  const pct     = first>0 ? (change/first)*100 : 0
  const isUp    = change >= 0

  const sv = document.getElementById("growthStatValue")
  const sc = document.getElementById("growthStatChange")
  const sp = document.getElementById("growthStatPct")
  if(sv) sv.textContent = "\u20ac"+last.toFixed(2)
  if(sc){ sc.textContent=(isUp?"+":"-")+"\u20ac"+Math.abs(change).toFixed(2); sc.className="growth-stat-chg "+(isUp?"profit":"loss") }
  if(sp){ sp.textContent=(isUp?"+":"")+pct.toFixed(2)+"%"; sp.className="growth-stat-pct "+(isUp?"profit":"loss") }

  const catColor  = CAT_DEFS[cat]?.color || "#5b9cf6"
  const lineColor = isUp ? catColor : "#f4506a"
  // Update dot colour to match category
  const dotEl = document.getElementById("growthDot")
  if(dotEl) dotEl.style.background = catColor
  const lblEl = document.getElementById("growthStatLabel")
  if(lblEl) lblEl.textContent = CAT_DEFS[cat]?.label || "All Portfolio"
  function hexToRgb(h){ const n=parseInt(h.replace("#",""),16); return `${(n>>16)&255},${(n>>8)&255},${n&255}` }
  const rgb     = hexToRgb(lineColor)
  const gradTop = `rgba(${rgb},0.35)`
  const gradBot = `rgba(${rgb},0.03)`
  const min = Math.min(...values)
  const max = Math.max(...values)

  if(portfolioGrowthChartInstance) portfolioGrowthChartInstance.destroy()

  portfolioGrowthChartInstance = new Chart(document.getElementById("portfolioGrowthChart"),{
    type:"line",
    data:{
      labels,
      datasets:[{
        label: CAT_DEFS[cat]?.label||"Portfolio",
        data: values,
        borderColor: lineColor,
        borderWidth: 2.5,
        pointRadius: values.length>50?0:3,
        pointHoverRadius:6,
        pointBackgroundColor:lineColor,
        pointBorderColor:"#070c18",
        pointBorderWidth:1.5,
        fill:true,
        backgroundColor:(ctx)=>{
          const g=ctx.chart.ctx.createLinearGradient(0,0,0,ctx.chart.height)
          g.addColorStop(0,gradTop); g.addColorStop(1,gradBot); return g
        },
        tension:0.35
      }]
    },
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:"index",intersect:false},
      scales:{
        x:{ ticks:{color:"#4a5c80",font:{size:10},maxTicksLimit:7}, grid:{color:"rgba(26,45,80,0.3)"}, border:{display:false} },
        y:{ ticks:{color:"#4a5c80",font:{size:10},callback:v=>"\u20ac"+v.toFixed(0)},
            grid:{color:"rgba(26,45,80,0.3)"}, border:{display:false},
            suggestedMin:min*0.985, suggestedMax:max*1.015 }
      },
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:"rgba(10,20,50,0.92)",
          titleColor:"#8899bb", bodyColor:"#e0e8ff",
          borderColor:`rgba(${rgb},0.4)`, borderWidth:1, padding:10,
          callbacks:{
            title:items=>items[0].label,
            label:ctx=>{
              const v=ctx.raw, diff=v-first
              const dp=first>0?((diff/first)*100):0, sign=diff>=0?"+":""
              return ["  \u20ac"+v.toFixed(2), "  "+sign+"\u20ac"+diff.toFixed(2)+" ("+sign+dp.toFixed(2)+"%)"]
            }
          }
        }
      }
    }
  })
}

/* =========================
INSIGHTS ENGINE
========================= */

function renderInsightsSummary(portfolio){
if(!portfolio || !portfolio.length) return

let invested=0, current=0
portfolio.forEach(p=>{ invested+=p.totalBuyEUR; current+=p.totalCurrentEUR })
const ret = invested>0 ? ((current-invested)/invested)*100 : 0
const sign = ret>=0 ? "+" : ""

const retEl = document.getElementById("portfolioReturn")
if(retEl){
  retEl.textContent = sign+ret.toFixed(2)+"%"
  retEl.className = ret>=0 ? "profit" : "loss"
}

const sorted = [...portfolio].sort((a,b)=>b.growth-a.growth)
const best = sorted[0]
const worst = sorted[sorted.length-1]

const bestEl = document.getElementById("bestPerformer")
const bestNm = document.getElementById("bestPerformerName")
const worstEl = document.getElementById("worstPerformer")
const worstNm = document.getElementById("worstPerformerName")

if(best && bestEl){
  bestEl.innerHTML = `+${best.growth.toFixed(2)}% <span class="abs-val">+€${best.profitEUR.toFixed(0)}</span>`
  if(bestNm) bestNm.textContent = resolveDisplayName(best)
}
if(worst && worstEl){
  worstEl.innerHTML = `${worst.growth.toFixed(2)}% <span class="abs-val">€${worst.profitEUR.toFixed(0)}</span>`
  if(worstNm) worstNm.textContent = resolveDisplayName(worst)
}

/* Absolute best/worst by EUR profit */
const sortedAbs = [...portfolio].sort((a,b) => b.profitEUR - a.profitEUR)
const bestAbs  = sortedAbs[0]
const worstAbs = sortedAbs[sortedAbs.length - 1]

const bestAbsEl  = document.getElementById("bestAbsolute")
const bestAbsNm  = document.getElementById("bestAbsoluteName")
const worstAbsEl = document.getElementById("worstAbsolute")
const worstAbsNm = document.getElementById("worstAbsoluteName")

if(bestAbs && bestAbsEl){
  bestAbsEl.innerHTML = `+€${bestAbs.profitEUR.toFixed(0)} <span class="abs-val">+${bestAbs.growth.toFixed(1)}%</span>`
  if(bestAbsNm) bestAbsNm.textContent = resolveDisplayName(bestAbs)
}
if(worstAbs && worstAbsEl){
  worstAbsEl.innerHTML = `€${worstAbs.profitEUR.toFixed(0)} <span class="abs-val">${worstAbs.growth.toFixed(1)}%</span>`
  if(worstAbsNm) worstAbsNm.textContent = resolveDisplayName(worstAbs)
}
}

function renderTopMovers(portfolio){
if(!portfolio || !portfolio.length) return
const sorted = [...portfolio].sort((a,b)=>b.growth-a.growth)
const gainers = sorted.slice(0,5)
const losers  = sorted.slice(-5).reverse()

const gEl = document.getElementById("topGainers")
const lEl = document.getElementById("topLosers")

if(gEl) gEl.innerHTML = gainers.map(p=>`
  <div class="mover-item">
    <span class="mover-name">${resolveDisplayName(p)}</span>
    <span class="mover-vals">
      <span class="mover-pct profit">+${p.growth.toFixed(2)}%</span>
      <span class="mover-abs profit">+€${p.profitEUR.toFixed(0)}</span>
    </span>
  </div>`).join("")

if(lEl) lEl.innerHTML = losers.map(p=>`
  <div class="mover-item">
    <span class="mover-name">${resolveDisplayName(p)}</span>
    <span class="mover-vals">
      <span class="mover-pct loss">${p.growth.toFixed(2)}%</span>
      <span class="mover-abs loss">€${p.profitEUR.toFixed(0)}</span>
    </span>
  </div>`).join("")

/* Absolute EUR movers */
const sortedByAbs = [...portfolio].sort((a,b) => b.profitEUR - a.profitEUR)
const absGainers  = sortedByAbs.filter(p => p.profitEUR > 0).slice(0,5)
const absLosers   = sortedByAbs.filter(p => p.profitEUR < 0).slice(-5).reverse()

const agEl = document.getElementById("topAbsGainers")
const alEl = document.getElementById("topAbsLosers")

if(agEl) agEl.innerHTML = absGainers.map(p=>`
  <div class="mover-item">
    <span class="mover-name">${resolveDisplayName(p)}</span>
    <span class="mover-vals">
      <span class="mover-pct profit">+€${p.profitEUR.toFixed(0)}</span>
      <span class="mover-abs profit">+${p.growth.toFixed(1)}%</span>
    </span>
  </div>`).join("")

if(alEl) alEl.innerHTML = absLosers.map(p=>`
  <div class="mover-item">
    <span class="mover-name">${resolveDisplayName(p)}</span>
    <span class="mover-vals">
      <span class="mover-pct loss">€${p.profitEUR.toFixed(0)}</span>
      <span class="mover-abs loss">${p.growth.toFixed(1)}%</span>
    </span>
  </div>`).join("")
}


/* =========================
AI MARKET INTELLIGENCE
========================= */

function simpleMarkdown(text){
  return text
    .replace(/## (.+)/g, '<h2 class="intel-h2">$1</h2>')
    .replace(/### (.+)/g, '<h3 class="intel-h3">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/gs, m => '<ul>'+m+'</ul>')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hul])/gm, '')
    .replace(/(<p><\/p>)/g, '')
    || text
}

async function runMarketIntelligence(){
  if(!lastPortfolio || !lastPortfolio.length){
    alert("Load your portfolio first.")
    return
  }

  const btn     = document.getElementById("runIntelBtn")
  const btnText = document.getElementById("intelBtnText")
  const result  = document.getElementById("intelResult")
  const disc    = document.getElementById("intelDisclaimer")

  btn.disabled = true
  result.style.display = "none"

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
  const stepTimer = setInterval(()=>{
    stepIdx = (stepIdx + 1) % steps.length
    btnText.textContent = steps[stepIdx]
  }, 7000)

  let invested=0, current=0
  lastPortfolio.forEach(p=>{ invested+=p.totalBuyEUR; current+=p.totalCurrentEUR })
  const totalReturn = invested>0 ? ((current-invested)/invested)*100 : 0

  const payload = {
    portfolio: lastPortfolio.map(p=>({
      name: resolveDisplayName(p),
      key: p.key,
      type: p.type,
      currency: p.currency,
      totalBuyEUR: p.totalBuyEUR,
      totalCurrentEUR: p.totalCurrentEUR,
      growth: p.growth,
      profitEUR: p.profitEUR
    })),
    totalValue: current,
    totalReturn
  }

  try{
    /* ── Step 1: Market Search (~20-25s) ── */
    result.innerHTML = `<div class="intel-step">🔍 Step 1 of 2 — Gathering live market data, technicals & fundamentals…</div>`
    result.style.display = "block"

    const searchRes = await fetch("/api/market-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })

    const searchRaw = await searchRes.text()
    let searchData
    try { searchData = JSON.parse(searchRaw) }
    catch(e) { throw new Error("Market search bad response: " + searchRaw.slice(0,200)) }

    if(!searchRes.ok || searchData.error){
      throw new Error("Market search failed: " + JSON.stringify(searchData.error || searchData.detail))
    }

    const { marketData } = searchData

    /* ── Step 2: Deep Analysis (~25-30s) ── */
    stepIdx = 4
    btnText.textContent = steps[4]
    result.innerHTML = `<div class="intel-step">🧠 Step 2 of 2 — Running deep fundamental + technical analysis…</div>`

    const analyseRes = await fetch("/api/analyse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, marketData })
    })

    const analyseRaw = await analyseRes.text()
    let analyseData
    try { analyseData = JSON.parse(analyseRaw) }
    catch(e) { throw new Error("Analysis bad response: " + analyseRaw.slice(0,200)) }

    if(!analyseRes.ok || analyseData.error){
      throw new Error("Analysis failed: " + JSON.stringify(analyseData.error || analyseData.detail))
    }

    const html = analyseData.analysis
      .split("\n")
      .map(line => {
        if(line.startsWith("## ")) return `<h2 class="intel-h2">${line.slice(3)}</h2>`
        if(line.startsWith("### ")) return `<h3 class="intel-h3">${line.slice(4)}</h3>`
        if(line.startsWith("**") && line.endsWith("**")) return `<p class="intel-bold">${line.slice(2,-2)}</p>`
        if(line.startsWith("- ")) return `<li>${line.slice(2).replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")}</li>`
        if(line.startsWith("| ") || line.startsWith("|--")) return `<p class="intel-table-row">${line}</p>`
        if(line.trim()==="") return "<br>"
        return `<p>${line.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")}</p>`
      })
      .join("")
      .replace(/(<li>.*?<\/li>\s*<br>\s*)+/gs, m=>`<ul>${m.replace(/<br>/g,"")}</ul>`)
      .replace(/(<li>.*?<\/li>\n?)+/gs, m=>`<ul>${m}</ul>`)

    disc.style.display = "none"
    result.innerHTML = `
      <div class="intel-timestamp">
        Analysis generated ${new Date().toLocaleString()} · Powered by Claude with live web search + extended thinking
      </div>
      ${html}`

  } catch(e){
    result.innerHTML = `<p class="intel-error">❌ ${e.message}</p><p class="intel-error" style="font-size:12px;margin-top:8px">Check Vercel logs for details.</p>`
  } finally {
    clearInterval(stepTimer)
    btnText.textContent = "⚡ Analyse Portfolio"
    btn.disabled = false
    result.style.display = "block"
  }
}


/* =========================
EXPORT CSV
========================= */

async function exportPortfolioCSV(){
  if(!db) return
  const assets = await getAssets()
  if(!assets.length){ alert("No assets to export."); return }

  const rows = [["Date","Name","Ticker","Broker","Type","Quantity","Price","Currency"]]

  assets.forEach(a => {
    /* Each asset may have multiple buy transactions */
    const txns = a.transactions || [{ date: a.date, qty: a.quantity, price: a.buyPrice }]
    txns.forEach(t => {
      rows.push([
        t.date || a.date || "",
        a.name || "",
        a.ticker || "",
        a.broker || "",
        a.type || "",
        t.qty ?? a.quantity ?? "",
        t.price ?? a.buyPrice ?? "",
        a.currency || "EUR"
      ])
    })
  })

  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n")
  const blob = new Blob([csv], { type: "text/csv" })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement("a")
  a.href     = url
  a.download = `portfolio_export_${new Date().toISOString().slice(0,10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/* =========================
APP STARTUP
========================= */

function startApp(){

loadAssets()

if(navigator.onLine){

updatePrices()
updateMutualFundNAV()
recordPortfolioSnapshot()

}

setInterval(()=>{

if(navigator.onLine && db){

updatePrices()
recordPortfolioSnapshot()

}

},300000)

/* Mutual funds once per day */
setInterval(updateMutualFundNAV,86400000)
}
/* =========================
FORM + TABS ENGINE
========================= */

function parseNumber(value){
return Number(value||0)
}

function bindAssetForm(){

let saveBtn=document.getElementById("saveAsset")
if(!saveBtn) return

saveBtn.onclick=()=>{

if(!db) return

let name=document.getElementById("assetName")?.value?.trim()
let ticker=document.getElementById("assetTicker")?.value?.trim().toUpperCase()
let broker=document.getElementById("assetBroker")?.value||""
let type=document.getElementById("assetType")?.value||"Other"
let currency=document.getElementById("assetCurrency")?.value||"EUR"
let quantity=parseNumber(document.getElementById("assetQty")?.value)
let buyPrice=parseNumber(document.getElementById("assetPrice")?.value)
let buyDate=document.getElementById("assetDate")?.value||""

if(!name || quantity<=0 || buyPrice<0){
return
}

let buyPriceEUR=convertToEUR(buyPrice,currency)

saveAsset({
name,
ticker,
broker,
type,
currency,
quantity,
buyPrice,
buyPriceEUR,
currentPrice:buyPrice,
buyDate
})

document.getElementById("assetName").value=""
document.getElementById("assetTicker").value=""
document.getElementById("assetQty").value=""
document.getElementById("assetPrice").value=""
document.getElementById("assetDate").value=""

loadAssets()

}

}
/* =========================
CSV IMPORT ENGINE
========================= */

function bindCSVImport(){

let btn=document.getElementById("importCSV")
let fileInput=document.getElementById("csvFile")
let exportBtn=document.getElementById("exportCSV")
if(exportBtn) exportBtn.onclick = exportPortfolioCSV

if(!btn || !fileInput) return

btn.onclick=()=>{

let file=fileInput.files[0]
if(!file) return

let reader=new FileReader()

reader.onload=(e)=>{

let text=e.target.result
let rows=text.split("\n").map(r=>r.trim()).filter(r=>r)

if(rows.length<=1) return

let header=rows.shift().split(",")

rows.forEach(row=>{

let cols=row.split(/[\t,]+/)
if(cols[1]=="Name") return
let buy=parseMoney(cols[6])
let qty=parseMoney(cols[5])
let cur=cols[7]||"EUR"

let hasDate = cols.length === 8

let asset={
name: hasDate ? cols[1] : cols[0],
ticker: hasDate ? cols[2] : cols[1],
broker: hasDate ? cols[3] : cols[2] || "",
type: hasDate ? cols[4] : cols[3] || "Other",
quantity: qty,
buyPrice: buy,
currency: cur,
buyPriceEUR: convertToEUR(buy,cur),
currentPrice: buy,
buyDate: hasDate ? cols[0] : new Date().toISOString().split("T")[0]
}

saveAsset(asset)

})

loadAssets()

}

reader.readAsText(file)

}

}
function bindTabs(){

document.querySelectorAll(".tabBtn").forEach(btn=>{

btn.onclick=()=>{

document.querySelectorAll(".tabBtn").forEach(b=>b.classList.remove("active"))
document.querySelectorAll(".tabContent").forEach(tab=>tab.classList.remove("active"))

btn.classList.add("active")

let tabId=btn.dataset.tab
let tab=document.getElementById(tabId)
if(tab) tab.classList.add("active")

if(tabId==="insightsTab"){
drawCharts(lastPortfolio)
drawGrowthChart()
renderInsightsSummary(lastPortfolio)
renderTopMovers(lastPortfolio)
}

}

})

}
/*FilterLogic*/
function applyFilters(rows){
const asset = document.getElementById("filterAsset")?.value.toLowerCase().trim()
const type  = document.getElementById("filterType")?.value
const growth= document.getElementById("filterGrowth")?.value

return rows.filter(r=>{
  if(asset){
    const dn = resolveDisplayName(r).toLowerCase()
    const ticker = (r.key||"").toLowerCase()
    if(!dn.includes(asset) && !ticker.includes(asset)) return false
  }
  if(type && r.type!=type) return false
  if(growth=="positive" && r.profitEUR<=0) return false
  if(growth=="negative" && r.profitEUR>=0) return false
  return true
})
}
bindAssetForm()
bindTabs()
bindCSVImport()
bindSearchDropdown()

document.getElementById("sortAssets")?.addEventListener("change", ()=>loadAssets())
document.getElementById("filterType")?.addEventListener("change", ()=>loadAssets())
document.getElementById("filterGrowth")?.addEventListener("change", ()=>loadAssets())

if(typeof initDB==="function"){
initDB()
}
