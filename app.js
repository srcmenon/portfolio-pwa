let allocationChartInstance = null;
let currencyChartInstance = null;
let priceUpdateRunning = false;
let growthChartInstance = null;
function formatCurrency(value, currency){

let symbol = "";

if(currency === "EUR") symbol = "€";
if(currency === "USD") symbol = "$";
if(currency === "INR") symbol = "₹";

return symbol + Number(value).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});

}
if ('serviceWorker' in navigator) {
navigator.serviceWorker.register('sw.js');
}
let FX = {
EUR:1,
USD:0.92,
INR:0.011
};
async function updateFX(){

try{

let r = await fetch("https://api.exchangerate.host/latest?base=EUR");

let data = await r.json();

if(data && data.rates){
FX.USD = 1 / (data.rates.USD || 1);
FX.INR = 1 / (data.rates.INR || 1);
}

}catch(e){

console.log("FX update failed, using cached rates");

}

}
initDB();
updateFX();
setInterval(updateFX,3600000);

function loadAssets(){

if(!db) return;

let tx = db.transaction("assets","readonly");
let store = tx.objectStore("assets");
let req = store.getAll();

req.onsuccess = () => {

let table = document.querySelector("#assetTable tbody");
if(!table) return;

table.innerHTML = "";

let assets = req.result;

/* GROUP BY TICKER */

let groups = {};

assets.forEach(a=>{
let key = a.ticker || a.name;

if(!groups[key]) groups[key] = [];

groups[key].push(a);
});

let portfolioTotal = 0;

/* RENDER GROUPS */

Object.keys(groups).forEach(ticker=>{

let list = groups[ticker];

/* CALCULATE POSITION TOTALS */

let totalQty = 0;
let totalCost = 0;
let lastDate = "";

list.forEach(a=>{

totalQty += (a.quantity || 0);
totalCost += (a.quantity || 0) * (a.buyPrice || 0);

if(a.buyDate && a.buyDate > lastDate){
lastDate = a.buyDate;
}

});

let avgBuy = totalQty ? totalCost / totalQty : 0;

let currentPrice = list[0].currentPrice || avgBuy;

/* convert to EUR for portfolio math */

let currentEUR = convertToEUR(currentPrice, list[0].currency);
let avgBuyEUR = convertToEUR(avgBuy, list[0].currency);

let positionValue = currentEUR * totalQty;
let positionPL = (currentEUR - avgBuyEUR) * totalQty;
portfolioTotal += positionValue;
  
let portfolioINR = convertFromEUR(portfolioTotal,"INR");

let plClass = "neutral";

if(positionPL > 0) plClass = "profit";
else if(positionPL < 0) plClass = "loss";

/* MAIN ROW */

let groupId = "grp_" + ticker;

let mainRow = document.createElement("tr");
mainRow.className = "mainRow";

mainRow.innerHTML = `
<td>
<span class="toggleBtn" data-target="${groupId}">▶</span>
${list[0].name || ticker}
</td>
<td>${totalQty}</td>

let eurValue = convertToEUR(currentPrice, list[0].currency);

mainRow.innerHTML = `
<td>
<span class="toggleBtn" data-target="${groupId}">▶</span>
${list[0].name || ticker}
</td>
<td>${totalQty}</td>
<td>${formatCurrency(avgBuy, list[0].currency)}</td>
<td>
${formatCurrency(currentPrice, list[0].currency)}
<br>
<span class="eurValue">${formatCurrency(eurValue,"EUR")}</span>
</td>
<td class="${plClass}">${formatCurrency(positionPL,"EUR")}</td>
<td>${lastDate || ""}</td>
`;
<td class="${plClass}">${positionPL.toFixed(2)}</td>
<td>${lastDate || ""}</td>
`;

table.appendChild(mainRow);

/* SUBROWS */

list.forEach(a=>{

let sub = document.createElement("tr");

sub.className = "subRow " + groupId;

sub.style.display = "none";

let currentEUR = convertToEUR(a.currentPrice || 0, a.currency); let buyEUR = a.buyPriceEUR || convertToEUR(a.buyPrice || 0, a.currency);  let pl = (currentEUR - buyEUR) * (a.quantity || 0);
if(Math.abs(pl) < 0.01) pl = 0;
let subClass = "neutral";

if(pl > 0) subClass = "profit";
else if(pl < 0) subClass = "loss";
sub.innerHTML = `
<td style="padding-left:30px">↳ ${a.buyDate || ""}</td>
<td>${a.quantity}</td>
<td>${(a.buyPrice || 0).toFixed(2)}</td>
<td>${(a.currentPrice || 0).toFixed(2)}</td>
<td class="${subClass}">${pl.toFixed(2)}</td>
<td>
<button onclick="deleteAsset(${a.id})">❌</button>
</td>
`;

table.appendChild(sub);

});

});

/* UPDATE SUMMARY */
let portfolioINR = convertFromEUR(portfolioTotal,"INR");
let countEl = document.getElementById("assetCount");
let valueEl = document.getElementById("totalValue");

/* count unique asset groups instead of transactions */

let assetCount = Object.keys(groups).length;

if(countEl) countEl.innerText = assetCount;
if(valueEl){

valueEl.innerHTML =
`${formatCurrency(portfolioTotal,"EUR")}
<br>
<span class="inrValue">${formatCurrency(portfolioINR,"INR")}</span>`;

}

/* TOGGLE LOGIC */

document.querySelectorAll(".toggleBtn").forEach(btn=>{

btn.onclick = ()=>{

let target = btn.dataset.target;

let rows = document.querySelectorAll("." + target);

let open = rows[0].style.display === "table-row";

rows.forEach(r=>{
r.style.display = open ? "none" : "table-row";
});

btn.textContent = open ? "▶" : "▼";

};

});

/* UPDATE CHARTS IF TAB OPEN */

if(document.getElementById("insightsTab")?.classList.contains("active")){
drawCharts();
}

};

}
function deleteAsset(id){

let tx = db.transaction("assets","readwrite");

tx.objectStore("assets").delete(id);

loadAssets();

}
function editAsset(id){

let newQty = prompt("New quantity");
let newPrice = prompt("New buy price");

let tx = db.transaction("assets","readwrite");

let store = tx.objectStore("assets");

let req = store.get(id);

req.onsuccess = () => {

let asset = req.result;

asset.quantity = newQty;
asset.buyPrice = newPrice;

store.put(asset);

loadAssets();

};

}
async function fetchPrice(ticker){

try{

let r = await fetch("/api/price?ticker=" + ticker);

if(!r.ok){
throw new Error("API request failed");
}

let data = await r.json();

if(!data || data.price === undefined || data.price === null){
console.log("Price not available for", ticker);
return null;
}

let price = Number(data.price);

if(isNaN(price)){
console.log("Invalid price format for", ticker, data.price);
return null;
}

console.log("Price received:", ticker, price);

return price;

}catch(e){

console.log("Price fetch failed", ticker, e);
return null;

}

}

async function updatePrices(){

if(priceUpdateRunning) return;

priceUpdateRunning = true;

let tx = db.transaction("assets","readonly");
let store = tx.objectStore("assets");

let req = store.getAll();

req.onsuccess = async () => {

let assets = req.result;

for (let a of assets){

if(!a.ticker) continue;

try{

let price = await fetchPrice(a.ticker);

if(price !== null && price !== undefined){

let tx2 = db.transaction("assets","readwrite");
let store2 = tx2.objectStore("assets");

a.currentPrice = price;

store2.put(a);

}

}catch(e){

console.log("Price update error:", a.ticker, e);

}

}

loadAssets();

/* release guard */

priceUpdateRunning = false;

};

}

function convertToEUR(value, currency){

if(!currency) return value;

if(currency === "EUR") return value;

if(!FX[currency]) return value;

return value * FX[currency];

}
function convertFromEUR(value, currency){

if(currency === "EUR") return value;

if(!FX[currency]) return value;

return value / FX[currency];

}
function calculateAllocation(assets){

let allocation = {};

assets.forEach(a=>{

let value = (a.currentPrice || 0) * (a.quantity || 0);
let type = a.type || "Other";

allocation[type] = (allocation[type] || 0) + value;

});

return allocation;

}
window.addEventListener("load", () => {

let saveBtn = document.getElementById("saveAsset");

if(saveBtn){
saveBtn.onclick = () => {

let name = document.getElementById("assetName").value.trim();
name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
if(!name) return;

let ticker = document.getElementById("assetTicker").value.trim().toUpperCase();
let broker = document.getElementById("assetBroker").value;
let type = document.getElementById("assetType").value;

let qty = parseFloat(document.getElementById("assetQty").value) || 0;
let price = parseFloat(document.getElementById("assetPrice").value) || 0;

let currency = document.getElementById("assetCurrency").value;
let buyDate = document.getElementById("assetDate").value;

let tx = db.transaction("assets","readwrite");

let eurBuyPrice = convertToEUR(price, currency);

tx.objectStore("assets").add({
name:name,
ticker:ticker,
broker:broker,
type:type,
quantity:qty,
buyPrice:price,
buyPriceEUR:eurBuyPrice,
currentPrice:price,
currency:currency,
buyDate:buyDate
});

/* run UI updates only after DB commit */

tx.oncomplete = () => {

updatePrices();   // fetch real market price

};

/* reset form */

document.getElementById("assetBroker").value="";
document.getElementById("assetType").value="";
document.getElementById("assetCurrency").value="EUR";
document.getElementById("assetDate").value="";
document.getElementById("assetName").value="";
document.getElementById("assetTicker").value="";
document.getElementById("assetQty").value="";
document.getElementById("assetPrice").value="";

};
}

loadAssets();

if(navigator.onLine){

updatePrices();
recordPortfolioSnapshot();   // take first snapshot immediately

setInterval(()=>{
if(navigator.onLine){
updatePrices();
recordPortfolioSnapshot();
}
},300000);

}

});

async function recordPortfolioSnapshot(){

let tx = db.transaction("assets","readonly");
let store = tx.objectStore("assets");
let req = store.getAll();

req.onsuccess = () => {

let assets = req.result;

let total = 0;

assets.forEach(a=>{

let price = Number(a.currentPrice) || 0;
let qty = Number(a.quantity) || 0;

let value = price * qty;

let currency = a.currency || "EUR";

total += convertToEUR(value,currency);

});

let tx2 = db.transaction("portfolioHistory","readwrite");
let store2 = tx2.objectStore("portfolioHistory");

store2.put({
timestamp: Date.now(),
value: total
});

};

}
window.addEventListener("load", () => {
let brokerSelect = document.getElementById("assetBroker");
let currencySelect = document.getElementById("assetCurrency");

if(brokerSelect && currencySelect){

brokerSelect.onchange = () => {

let broker = brokerSelect.value;

currencySelect.innerHTML = "";

if(broker === "KITE"){

currencySelect.innerHTML = `<option value="INR">INR</option>`;
currencySelect.value = "INR";

}

else if(
broker === "TRADEREPUBLIC" ||
broker === "SCALABLE" ||
broker === "ETORO"
){

currencySelect.innerHTML = `<option value="EUR">EUR</option>`;
currencySelect.value = "EUR";

}

else{

currencySelect.innerHTML = `
<option value="EUR">EUR</option>
<option value="USD">USD</option>
<option value="INR">INR</option>
`;

}

};

}
document.querySelectorAll(".tabBtn").forEach(btn => {

btn.onclick = () => {

document.querySelectorAll(".tabBtn").forEach(b => b.classList.remove("active"));
document.querySelectorAll(".tabContent").forEach(c => c.classList.remove("active"));

btn.classList.add("active");

let target = document.getElementById(btn.dataset.tab);
if(target){
target.classList.add("active");
}

drawCharts();
drawGrowthChart();
};

});

});
function calculateAllocationByType(assets){

let result = {};

assets.forEach(a=>{

let type = a.type || "Other";
let value = (a.currentPrice || 0) * (a.quantity || 0);

result[type] = (result[type] || 0) + value;

});

return result;

}
function calculateCurrencyExposure(assets){

let result = {};

assets.forEach(a=>{

let currency = a.currency || "Unknown";
let value = (a.currentPrice || 0) * (a.quantity || 0);

result[currency] = (result[currency] || 0) + value;

});

return result;

}
function calculatePortfolioReturn(history){

if(!history || history.length < 2) return null;

/* ensure sorted */

history = [...history].sort((a,b)=>a.timestamp-b.timestamp);

let first = history[0];
let last = history[history.length-1];

if(!first.value || !last.value) return null;

/* elapsed time in years */

let years = (last.timestamp - first.timestamp) / (1000*60*60*24*365);

if(years <= 0) return null;

/* total return */

let totalReturn = (last.value / first.value) - 1;

/* annualized return */

let annualizedReturn = Math.pow(1 + totalReturn, 1/years) - 1;

return {
total: totalReturn,
annual: annualizedReturn
};

}
function formatINR(value){

return Number(value).toLocaleString("en-IN",{
minimumFractionDigits:2,
maximumFractionDigits:2
});

}
function drawGrowthChart(){

if(!db) return;
let canvas = document.getElementById("growthChart");
if(!canvas) return;

let tx = db.transaction("portfolioHistory","readonly");
let store = tx.objectStore("portfolioHistory");

let req = store.getAll();

req.onsuccess = () => {

let history = req.result;

if(!history || history.length === 0) return;

/* sort snapshots */

history.sort((a,b)=>a.timestamp-b.timestamp);

/* prepare chart data */

let labels = history.map(h=>{
let d = new Date(h.timestamp);
return d.toLocaleString();
});

let values = history.map(h=>h.value);

/* calculate return */

let result = calculatePortfolioReturn(history);
let el = document.getElementById("portfolioReturn");

if(el){

if(result){

let total = (result.total*100).toFixed(2);
let annual = (result.annual*100).toFixed(2);

el.innerText = `Total: ${total}% | Annualized: ${annual}%`;

}else{

el.innerText = "Waiting for more history...";

}

}

/* draw chart */

if(growthChartInstance){
growthChartInstance.destroy();
}

growthChartInstance = new Chart(canvas,{
type:"line",
data:{
labels:labels,
datasets:[{
label:"Portfolio Value",
data:values,
borderColor:"#3498db",
backgroundColor:"#3498db",
pointRadius:5,
pointHoverRadius:7,
fill:false
}]
},
options:{
responsive:true,
plugins:{
legend:{display:true}
}
}
});

};

}
function drawCharts(){

if(!db) return;
let allocCanvas = document.getElementById("allocationChart");
let currCanvas = document.getElementById("currencyChart");

if(!allocCanvas || !currCanvas) return;
let tx = db.transaction("assets","readonly");
let store = tx.objectStore("assets");
let req = store.getAll();

req.onsuccess = () => {

let assets = req.result;

let allocation = calculateAllocationByType(assets);
let currencies = calculateCurrencyExposure(assets);

if(allocationChartInstance){
allocationChartInstance.destroy();
}

if(currencyChartInstance){
currencyChartInstance.destroy();
}

allocationChartInstance = new Chart(document.getElementById("allocationChart"),{
type:"pie",
data:{
labels:Object.keys(allocation),
datasets:[{
data:Object.values(allocation),
backgroundColor:[
"#2ecc71",
"#3498db",
"#f39c12",
"#e74c3c",
"#9b59b6"
]
}]
}
});

currencyChartInstance = new Chart(document.getElementById("currencyChart"),{
type:"pie",
data:{
labels:Object.keys(currencies),
datasets:[{
data:Object.values(currencies),
backgroundColor:[
"#2ecc71",
"#3498db",
"#f39c12",
"#e74c3c",
"#9b59b6"
]
}]
}
});

};

}
