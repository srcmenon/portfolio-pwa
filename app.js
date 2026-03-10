/* =========================
GLOBAL STATE
========================= */

let allocationChartInstance = null
let currencyChartInstance = null
let growthChartInstance = null
let priceUpdateRunning = false
let allocationBarChartInstance=null
window.addEventListener("DOMContentLoaded",()=>{

let d=document.getElementById("assetDate")

if(d){
d.value=new Date().toISOString().split("T")[0]
}

})
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

/* Render UI */

renderPortfolioTable(portfolio)

renderPortfolioSummary(portfolio)

renderPortfolioReturn(portfolio)

/* Charts */

drawPortfolioAllocation(portfolio)

if(document.getElementById("insightsTab")?.classList.contains("active")){
drawCharts(portfolio)
drawGrowthChart()
}

}

function renderPortfolioTable(portfolio){

let table=document.querySelector("#assetTable tbody")
if(!table) return

table.innerHTML=""

portfolio.forEach(pos=>{

let plClass="neutral"

if(pos.profitEUR>0) plClass="profit"
else if(pos.profitEUR<0) plClass="loss"

let groupId="grp_"+pos.key

let row=document.createElement("tr")

row.innerHTML=`

<td>
<span class="toggleBtn" data-target="${groupId}">▶</span>
${pos.name}
</td>

<td>${pos.qty.toFixed(3)}</td>

<td>
${formatCurrency(pos.avgBuy,pos.currency)}
<br>
<span class="eurValue">${formatCurrency(convertToEUR(pos.avgBuy,pos.currency),"EUR")}</span>
</td>

<td>
${formatCurrency(pos.currentPrice,pos.currency)}
<br>
<span class="eurValue">${formatCurrency(convertToEUR(pos.currentPrice,pos.currency),"EUR")}</span>
</td>

<td>
${formatCurrency(pos.totalBuyLocal,pos.currency)}
<br>
<span class="eurValue">${formatCurrency(pos.totalBuyEUR,"EUR")}</span>
</td>

<td>
${formatCurrency(pos.totalCurrentLocal,pos.currency)}
<br>
<span class="eurValue">${formatCurrency(pos.totalCurrentEUR,"EUR")}</span>
</td>

<td class="${plClass}">
${formatCurrency(pos.profitLocal,pos.currency)}
<br>
<span class="eurValue">${formatCurrency(pos.profitEUR,"EUR")}</span>
</td>

<td class="${plClass}">
${pos.growth.toFixed(2)}%
</td>

<td>${pos.type || ""}</td>

<td>${pos.lastDate || ""}</td>

`

table.appendChild(row)

/* Transaction history rows */

pos.list.forEach(a=>{

let sub=document.createElement("tr")

sub.className="subRow "+groupId
sub.style.display="none"

sub.innerHTML=`

<td style="padding-left:30px">↳ ${a.buyDate || ""}</td>

<td>${a.quantity}</td>

<td>${formatCurrency(a.buyPrice,a.currency)}</td>

<td>${formatCurrency(a.currentPrice || a.buyPrice,a.currency)}</td>

<td colspan="4">${a.broker || ""}</td>

<td>
<button onclick="deleteAsset(${a.id})">❌</button>
</td>

`

table.appendChild(sub)

})

})

setupToggleButtons()

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

/* must contain exactly NAV structure */
if(parts.length < 6) continue

const schemeCode = parts[0].trim()
const schemeName = parts[3].toLowerCase()
const nav = parseFloat(parts[4])

if(
!schemeCode ||
isNaN(nav) ||
nav <= 0
) continue

/* accept only growth NAVs */
if(
schemeCode &&
nav &&
schemeName.includes("growth") &&
!schemeName.includes("idcw") &&
!schemeName.includes("dividend") &&
!schemeName.includes("payout") &&
!schemeName.includes("bonus")
){
navMap[schemeCode] = nav
}

const assets = await getAssets()

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

if(!t) return null

/* Crypto */
if(t.includes("-USD")) return t

/* Mutual funds handled separately */
if(asset.type==="MutualFund") return null

/* US stocks */
const us = ["AMZN","GOOGL","MU","ISRG","GE"]
if(us.includes(t)) return t

/* LSE ETFs */
const lse = ["IWDA","EIMI","WTAI","SSLV","DFNS","SEMI"]
if(lse.includes(t)) return t + ".L"

/* EU ETC */
if(t==="EWG2") return "EWG2.DE"

/* Default → assume NSE */
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

function drawCharts(portfolio){

let allocation={}
let currencies={}

portfolio.forEach(p=>{

allocation[p.type]=(allocation[p.type]||0)+p.totalCurrentEUR
currencies[p.currency]=(currencies[p.currency]||0)+p.totalCurrentEUR

})

if(allocationChartInstance) allocationChartInstance.destroy()
if(currencyChartInstance) currencyChartInstance.destroy()

allocationChartInstance=new Chart(
document.getElementById("allocationChart"),
{
type:"pie",
data:{
labels:Object.keys(allocation),
datasets:[{data:Object.values(allocation)}]
}
}
)

currencyChartInstance=new Chart(
document.getElementById("currencyChart"),
{
type:"pie",
data:{
labels:Object.keys(currencies),
datasets:[{data:Object.values(currencies)}]
}
}
)

}
function drawPortfolioAllocation(portfolio){

let allocation={}

portfolio.forEach(p=>{

let type=p.type || "Other"

allocation[type]=(allocation[type]||0)+p.totalCurrentEUR

})

let labels=Object.keys(allocation)
let values=Object.values(allocation)

if(allocationBarChartInstance)
allocationBarChartInstance.destroy()

allocationBarChartInstance=new Chart(
document.getElementById("portfolioAllocationChart"),
{
type:"bar",
data:{
labels,
datasets:[{
label:"Portfolio Allocation (€)",
data:values
}]
}
}
)

}
function drawGrowthChart(){

if(!db) return

let tx=db.transaction("portfolioHistory","readonly")
let store=tx.objectStore("portfolioHistory")

store.getAll().onsuccess=(e)=>{

let history=e.target.result

history.sort((a,b)=>a.timestamp-b.timestamp)

let labels=history.map(h=>new Date(h.timestamp).toLocaleString())
let values=history.map(h=>h.value)

if(growthChartInstance) growthChartInstance.destroy()

growthChartInstance=new Chart(
document.getElementById("growthChart"),
{
type:"line",
data:{
labels,
datasets:[{
label:"Portfolio Value",
data:values,
borderColor:"#3498db",
fill:false
}]
}
}
)

}

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

let asset={
name:cols[1],
ticker:cols[2],
broker:cols[3]||"",
type:cols[4]||"Other",
quantity:qty,
buyPrice:buy,
currency:cur,
buyPriceEUR:convertToEUR(buy,cur),
currentPrice:buy,
buyDate:cols[0]||""
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
drawCharts()
drawGrowthChart()
}

}

})

}
/*FilterLogic*/
function applyFilters(rows){

let asset=document.getElementById("filterAsset")?.value.toLowerCase()
let type=document.getElementById("filterType")?.value
let growth=document.getElementById("filterGrowth")?.value

return rows.filter(r=>{

if(asset && !r.name.toLowerCase().includes(asset)) return false

if(type && r.type!=type) return false

if(growth=="positive" && r.profitEUR<=0) return false
if(growth=="negative" && r.profitEUR>=0) return false

return true

})

}
bindAssetForm()
bindTabs()
bindCSVImport()

document.getElementById("sortAssets")?.addEventListener("change", () => {
loadAssets()
})

if(typeof initDB==="function"){
initDB()
}
