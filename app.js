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

function loadAssets(){

let tx = db.transaction("assets","readonly");
let store = tx.objectStore("assets");
let req = store.getAll();

req.onsuccess = () => {

let table = document.querySelector("#assetTable tbody");
if(!table) return;
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

let countEl = document.getElementById("assetCount");
let valueEl = document.getElementById("totalValue");

if(countEl) countEl.innerText = req.result.length;
if(valueEl) valueEl.innerText = "€" + total.toFixed(2);

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

if(!data.quoteResponse.result.length) return null;

let result = data.quoteResponse.result[0];
if(!result) return null;
return result.regularMarketPrice || null;

}catch(e){

console.log("Price fetch failed", ticker);

return null;

}

}
async function updatePrices(){

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

console.log("Price fetch failed for", a.ticker);

}

}

loadAssets();

};

}

function convertToEUR(value, currency){

if(!currency) return value;
return value * (FX[currency] || 1);

}

function calculateAllocation(assets){

let allocation = {};

assets.forEach(a=>{
allocation[a.type] = (allocation[a.type] || 0) + a.currentPrice * a.quantity;
});

return allocation;

}
window.addEventListener("load", () => {

let saveBtn = document.getElementById("saveAsset");

if(saveBtn){
saveBtn.onclick = () => {

let name = document.getElementById("assetName").value;
if(!name) return;

let ticker = document.getElementById("assetTicker").value;
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

loadAssets();

document.getElementById("assetName").value="";
document.getElementById("assetTicker").value="";
document.getElementById("assetQty").value="";
document.getElementById("assetPrice").value="";
};
}

loadAssets();

if(navigator.onLine){
setInterval(()=>{
if(navigator.onLine){
updatePrices();
}
},300000);
}

});
