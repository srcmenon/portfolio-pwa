/* =========================
GLOBAL STATE
========================= */

let allocationChartInstance = null
let currencyChartInstance = null
let growthChartInstance = null
let priceUpdateRunning = false
let allocationBarChartInstance=null

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

let currentPrice=list[0].currentPrice || list[0].buyPrice || avgBuy
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

let assets = await getAssets()
let groups = groupAssets(assets)

/* Convert groups to sortable array */

let rows = Object.keys(groups).map(key => {

let list = groups[key]
let pos = calculatePosition(list)

let qty = pos.qty
let avgBuy = pos.avgBuy

let currentPrice = pos.currentPrice
let currentEUR = convertToEUR(currentPrice,list[0].currency)

let investedValue = avgBuy * qty
let currentValue = currentEUR * qty

let profit = currentValue - investedValue
let growth = investedValue > 0 ? (profit/investedValue)*100 : 0

return {
key,
list,
pos,
qty,
profit,
growth,
value:currentValue
}

})

/* Sorting */

let sortType = document.getElementById("sortAssets")?.value || "name"

rows.sort((a,b)=>{

if(sortType==="name") return a.key.localeCompare(b.key)
if(sortType==="profit") return b.profit-a.profit
if(sortType==="growth") return b.growth-a.growth
if(sortType==="value") return b.value-a.value
if(sortType==="qty") return b.qty-a.qty

return 0

})

/* rebuild sorted groups */

let sortedGroups={}
rows.forEach(r=>{
sortedGroups[r.key]=r.list
})

renderPortfolioTable(sortedGroups)
renderPortfolioSummary(sortedGroups)
renderPortfolioReturn(sortedGroups)
drawPortfolioAllocation()

if(document.getElementById("insightsTab")?.classList.contains("active")){
drawCharts()
drawGrowthChart()
}

}

function renderPortfolioTable(groups){

let table=document.querySelector("#assetTable tbody")
if(!table) return

table.innerHTML=""

Object.keys(groups).forEach(ticker=>{

let list=groups[ticker]
let pos=calculatePosition(list)

let qty=pos.qty
let avgBuy=pos.avgBuy
let currentPrice=pos.currentPrice

let currency=list[0].currency || "EUR"

let buyEUR=convertToEUR(avgBuy,currency)
let currentEUR=convertToEUR(currentPrice,currency)

let totalBuyLocal=avgBuy*qty
let totalCurrentLocal=currentPrice*qty

let totalBuyEUR=buyEUR*qty
let totalCurrentEUR=currentEUR*qty

let profitEUR=totalCurrentEUR-totalBuyEUR
let profitLocal=totalCurrentLocal-totalBuyLocal

let growth=totalBuyEUR>0 ? (profitEUR/totalBuyEUR)*100 : 0

let plClass="neutral"
if(profitEUR>0) plClass="profit"
else if(profitEUR<0) plClass="loss"

let groupId="grp_"+ticker

let row=document.createElement("tr")

row.innerHTML=`
<td>
<span class="toggleBtn" data-target="${groupId}">▶</span>
${list[0].name || ticker}
</td>

<td>${qty.toFixed(3)}</td>

<td>
${formatCurrency(avgBuy,currency)}
<br>
<span class="eurValue">${formatCurrency(buyEUR,"EUR")}</span>
</td>

<td>
${formatCurrency(currentPrice,currency)}
<br>
<span class="eurValue">${formatCurrency(currentEUR,"EUR")}</span>
</td>

<td>
${formatCurrency(totalBuyLocal,currency)}
<br>
<span class="eurValue">${formatCurrency(totalBuyEUR,"EUR")}</span>
</td>

<td>
${formatCurrency(totalCurrentLocal,currency)}
<br>
<span class="eurValue">${formatCurrency(totalCurrentEUR,"EUR")}</span>
</td>

<td class="${plClass}">
${formatCurrency(profitLocal,currency)}
<br>
<span class="eurValue">${formatCurrency(profitEUR,"EUR")}</span>
</td>

<td class="${plClass}">
${growth.toFixed(2)}%
</td>

<td>${list[0].type || ""}</td>

<td>${pos.lastDate || ""}</td>
`

table.appendChild(row)

/* Sub rows for transaction history */

list.forEach(a=>{

let sub=document.createElement("tr")
sub.className="subRow "+groupId
sub.style.display="none"

sub.innerHTML=`
<td style="padding-left:30px">↳ ${a.buyDate || ""}</td>
<td>${a.quantity}</td>
<td>${formatCurrency(a.buyPrice,a.currency)}</td>
<td>${formatCurrency(a.currentPrice || a.buyPrice,a.currency)}</td>
<td>${a.broker || ""}</td>
<td>
<button onclick="deleteAsset(${a.id})">❌</button>
</td>
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

function renderPortfolioReturn(groups){

let returnEl=document.getElementById("portfolioReturn")
if(!returnEl) return

let invested=0
let current=0

Object.values(groups).forEach(list=>{

let pos=calculatePosition(list)

invested+=pos.avgBuy*pos.qty
current+=pos.value

})

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

let r = await fetch("https://www.amfiindia.com/spages/NAVAll.txt")
let text = await r.text()

let lines = text.split("\n")

let navMap={}

lines.forEach(line=>{

let parts=line.split(";")

if(parts.length>4){

let schemeName=parts[3]?.trim()
let nav=parseFloat(parts[4])

if(schemeName && nav){
navMap[schemeName.toLowerCase()]=nav
}

}

})

let assets=await getAssets()

assets.forEach(a=>{

if(a.type!=="MutualFund") return

let name=a.name?.toLowerCase()

let nav=null

Object.keys(navMap).forEach(key=>{
if(name && key.includes(name.substring(0,12))){
nav=navMap[key]
}
})

if(nav){

let tx=db.transaction("assets","readwrite")

tx.objectStore("assets").put({
...a,
currentPrice:nav
})

}

})

loadAssets()

}catch(e){

console.log("MF NAV update failed")

}

}
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
function drawPortfolioAllocation(){

if(!db) return

let tx=db.transaction("assets","readonly")
let store=tx.objectStore("assets")

store.getAll().onsuccess=(e)=>{

let assets=e.target.result

let allocation={}

assets.forEach(a=>{

let value=(a.currentPrice||a.buyPrice||0)*(a.quantity||0)

let eur=convertToEUR(value,a.currency)

let type=a.type||"Other"

allocation[type]=(allocation[type]||0)+eur

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
updateMutualFundNAV()
recordPortfolioSnapshot()

}

},300000)

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
currentPrice:0,
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

bindAssetForm()
bindTabs()
bindCSVImport()

document.getElementById("sortAssets")?.addEventListener("change", () => {
loadAssets()
})

if(typeof initDB==="function"){
initDB()
}
