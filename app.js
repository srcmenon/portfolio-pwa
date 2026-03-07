let allocationChartInstance = null;
let currencyChartInstance = null;
let priceUpdateRunning = false;
let growthChartInstance = null;
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

let positionValue = currentPrice * totalQty;
let positionPL = (currentPrice - avgBuy) * totalQty;

portfolioTotal += convertToEUR(positionValue, list[0].currency);

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
<td>${avgBuy.toFixed(2)}</td>
<td>${currentPrice.toFixed(2)}</td>
<td class="${plClass}">${positionPL.toFixed(2)}</td>
<td>${lastDate || ""}</td>
`;

table.appendChild(mainRow);

/* SUBROWS */

list.forEach(a=>{

let sub = document.createElement("tr");

sub.className = "subRow " + groupId;

sub.style.display = "none";

let pl = ((a.currentPrice || 0) - (a.buyPrice || 0)) * (a.quantity || 0);
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

let countEl = document.getElementById("assetCount");
let valueEl = document.getElementById("totalValue");

/* count unique asset groups instead of transactions */

let assetCount = Object.keys(groups).length;

if(countEl) countEl.innerText = assetCount;
if(valueEl) valueEl.innerText = "€" + portfolioTotal.toFixed(2);

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
return value * (FX[currency] || 1);

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

tx.objectStore("assets").add({
name:name,
ticker:ticker,
broker:broker,
type:type,
quantity:qty,
buyPrice:price,
currentPrice:price,
currency:currency,
buyDate:buyDate
});

/* run UI updates only after DB commit */

tx.oncomplete = () => {

loadAssets();     // refresh table
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
let value = (a.currentPrice || 0) * (a.quantity || 0);
total += convertToEUR(value,a.currency);
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
function drawGrowthChart(){

let canvas = document.getElementById("growthChart");
if(!canvas) return;

let tx = db.transaction("portfolioHistory","readonly");
let store = tx.objectStore("portfolioHistory");

let req = store.getAll();

req.onsuccess = () => {

let history = req.result;

history.sort((a,b)=>a.timestamp-b.timestamp);

let labels = history.map(h=>{
let d = new Date(h.timestamp);
return d.toLocaleString();
});

let values = history.map(h=>h.value);

if(growthChartInstance){ growthChartInstance.destroy(); }  growthChartInstance = new Chart(canvas,{
type:"line",
data:{
labels:labels,
datasets:[{
label:"Portfolio Value",
data:values,
borderColor:"#3498db",
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
