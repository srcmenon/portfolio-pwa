/* =========================
GLOBAL STATE
========================= */

let allocationChartInstance = null
let currencyChartInstance = null
let growthChartInstance = null
let priceUpdateRunning = false

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
EUR:1,
USD:0.92,
INR:0.011
}

async function updateFX(){

try{

let r = await fetch("https://api.exchangerate.host/latest?base=EUR")
let data = await r.json()

if(data && data.rates){
FX.USD = 1/(data.rates.USD || 1)
FX.INR = 1/(data.rates.INR || 1)
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

function convertToEUR(value,currency){

if(!currency || currency==="EUR") return value
if(!FX[currency]) return value

return value*FX[currency]

}

function convertFromEUR(value,currency){

if(currency==="EUR") return value
if(!FX[currency]) return value

return value/FX[currency]

}

/* =========================
DATABASE ENGINE
========================= */

function getAssets(){

return new Promise(resolve=>{

if(!db){
resolve([])
return
}

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

function calculatePosition(list){

let totalQty=0
let totalCost=0
let lastDate=""

list.forEach(a=>{

let buyEUR=a.buyPriceEUR || convertToEUR(a.buyPrice||0,a.currency)

totalQty+=a.quantity||0
totalCost+=buyEUR*(a.quantity||0)

if(a.buyDate && a.buyDate>lastDate) lastDate=a.buyDate

})

let avgBuy= totalQty ? totalCost/totalQty : 0

let currentPrice=list[0].currentPrice || avgBuy
let currentEUR=convertToEUR(currentPrice,list[0].currency)

let value=currentEUR*totalQty
let pl=(currentEUR-avgBuy)*totalQty

return{
qty:totalQty,
avgBuy,
currentPrice,
value,
pl,
lastDate
}

}

function calculatePortfolioTotal(groups){

let total=0

Object.values(groups).forEach(list=>{
let pos=calculatePosition(list)
total+=pos.value
})

return total

}

/* =========================
UI RENDER ENGINE
========================= */

async function loadAssets(){

if(!db) return

let assets=await getAssets()
let groups=groupAssets(assets)

renderPortfolioTable(groups)
renderPortfolioSummary(groups)

if(document.getElementById("insightsTab")?.classList.contains("active")){
drawCharts()
}

}

function renderPortfolioTable(groups){

let table=document.querySelector("#assetTable tbody")
if(!table) return

table.innerHTML=""

Object.keys(groups).forEach(ticker=>{

let list=groups[ticker]
let pos=calculatePosition(list)

let plClass="neutral"
if(pos.pl>0) plClass="profit"
else if(pos.pl<0) plClass="loss"

let eurValue=convertToEUR(pos.currentPrice,list[0].currency)

let groupId="grp_"+ticker

let row=document.createElement("tr")

row.innerHTML=`
<td>
<span class="toggleBtn" data-target="${groupId}">▶</span>
${list[0].name || ticker}
</td>
<td>${pos.qty}</td>
<td>${formatCurrency(pos.avgBuy,list[0].currency)}</td>
<td>
${formatCurrency(pos.currentPrice,list[0].currency)}
<br>
<span class="eurValue">${formatCurrency(eurValue,"EUR")}</span>
</td>
<td class="${plClass}">${formatCurrency(pos.pl,"EUR")}</td>
<td>${pos.lastDate||""}</td>
`

table.appendChild(row)

list.forEach(a=>{

let sub=document.createElement("tr")
sub.className="subRow "+groupId
sub.style.display="none"

let currentEUR=convertToEUR(a.currentPrice||0,a.currency)
let buyEUR=a.buyPriceEUR || convertToEUR(a.buyPrice||0,a.currency)

let pl=(currentEUR-buyEUR)*(a.quantity||0)

let subClass="neutral"
if(pl>0) subClass="profit"
else if(pl<0) subClass="loss"

sub.innerHTML=`
<td style="padding-left:30px">↳ ${a.buyDate||""}</td>
<td>${a.quantity}</td>
<td>${formatCurrency(a.buyPrice,a.currency)}</td>
<td>${formatCurrency(a.currentPrice,a.currency)}</td>
<td class="${subClass}">${formatCurrency(pl,"EUR")}</td>
<td><button onclick="deleteAsset(${a.id})">❌</button></td>
`

table.appendChild(sub)

})

})

setupToggleButtons()

}

function renderPortfolioSummary(groups){

let total=calculatePortfolioTotal(groups)
let inr=convertFromEUR(total,"INR")

let countEl=document.getElementById("assetCount")
let valueEl=document.getElementById("totalValue")

if(countEl) countEl.innerText=Object.keys(groups).length

if(valueEl){

valueEl.innerHTML=`
${formatCurrency(total,"EUR")}
<br>
<span class="inrValue">${formatCurrency(inr,"INR")}</span>
`

}

}

function setupToggleButtons(){

document.querySelectorAll(".toggleBtn").forEach(btn=>{

btn.onclick=()=>{

let target=btn.dataset.target
let rows=document.querySelectorAll("."+target)

let open=rows[0].style.display==="table-row"

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

async function fetchPrice(ticker){

try{

let r=await fetch("/api/price?ticker="+ticker)
let data=await r.json()

return Number(data.price)||null

}catch(e){

console.log("Price fetch failed",ticker)
return null

}

}

async function updatePrices(){

if(priceUpdateRunning || !db) return
priceUpdateRunning=true

let assets=await getAssets()

for(let a of assets){

if(!a.ticker) continue

let price=await fetchPrice(a.ticker)

if(price!==null){

let tx=db.transaction("assets","readwrite")
tx.objectStore("assets").put({...a,currentPrice:price})

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

function drawCharts(){

if(!db) return

let tx=db.transaction("assets","readonly")
let store=tx.objectStore("assets")

store.getAll().onsuccess=(e)=>{

let assets=e.target.result

let allocation={}
let currencies={}

assets.forEach(a=>{

let value=(a.currentPrice||0)*(a.quantity||0)

allocation[a.type]=(allocation[a.type]||0)+value
currencies[a.currency]=(currencies[a.currency]||0)+value

})

if(allocationChartInstance) allocationChartInstance.destroy()
if(currencyChartInstance) currencyChartInstance.destroy()

allocationChartInstance=new Chart(
document.getElementById("allocationChart"),
{
type:"pie",
data:{labels:Object.keys(allocation),
datasets:[{data:Object.values(allocation)}]}
}
)

currencyChartInstance=new Chart(
document.getElementById("currencyChart"),
{
type:"pie",
data:{labels:Object.keys(currencies),
datasets:[{data:Object.values(currencies)}]}
}
)

}

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
recordPortfolioSnapshot()
}

setInterval(()=>{
if(navigator.onLine && db){
updatePrices()
recordPortfolioSnapshot()
}
},300000)

}
