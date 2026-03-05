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

FX.USD = 1 / data.rates.USD;
FX.INR = 1 / data.rates.INR;

}catch(e){

console.log("FX update failed, using cached rates");

}

}
initDB();
updateFX();

document.getElementById("addAsset").onclick = () => {

let name = prompt("Asset name");
if(!name) return;
let ticker = prompt("Ticker (example: NVDA)");
let broker = prompt("Broker (Kite / Scalable / TradeRepublic / eToro)");
let type = prompt("Asset type (Stock / ETF / Crypto / Mutual Fund)");
let qty = parseFloat(prompt("Quantity"));
let price = parseFloat(prompt("Buy price"));
let currency = prompt("Currency (EUR / USD / INR)");
let buyDate = prompt("Buy date (YYYY-MM-DD)");

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

loadAssets();

};
function loadAssets(){

let tx = db.transaction("assets","readonly");
let store = tx.objectStore("assets");
let req = store.getAll();

req.onsuccess = () => {

let table = document.querySelector("#assetTable tbody");
table.innerHTML = "";

let total = 0;

req.result.forEach(a=>{
  
let pl = ((a.currentPrice || 0) - (a.buyPrice || 0)) * (a.quantity || 0);
let value = (a.currentPrice || 0) * (a.quantity || 0);
total += convertToEUR(value, a.currency);

let row = `<tr>
<td>${a.name}</td>
<td>${a.quantity}</td>
<td>${a.buyPrice}</td>
<td>${a.currentPrice}</td>
<td>${pl.toFixed(2)}</td>
<td><button onclick="deleteAsset(${a.id})">❌</button></td>
</tr>`;

table.innerHTML += row;

});

document.getElementById("assetCount").innerText = req.result.length;
document.getElementById("totalValue").innerText = "€" + total.toFixed(2);

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

let url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + ticker;

let r = await fetch(url);

let data = await r.json();

return data.quoteResponse.result[0].regularMarketPrice;

}catch(e){

console.log("Price fetch failed", ticker);

return null;

}

}
async function updatePrices(){

let tx = db.transaction("assets","readwrite");
let store = tx.objectStore("assets");

let req = store.getAll();

req.onsuccess = async () => {

let assets = req.result;

for (let a of assets){

try{

let price = await fetchPrice(a.ticker);

a.currentPrice = price;

store.put(a);

}catch(e){

console.log("Price fetch failed for", a.ticker);

}

}

loadAssets();

};

}

function convertToEUR(value, currency){

return value * (FX[currency] || 1);

}

function calculateAllocation(assets){

let allocation = {};

assets.forEach(a=>{
allocation[a.type] = (allocation[a.type] || 0) + a.currentPrice * a.quantity;
});

return allocation;

}
setTimeout(loadAssets,500);
if(navigator.onLine){
setTimeout(updatePrices,2000);
}
