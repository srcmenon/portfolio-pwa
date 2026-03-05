if ('serviceWorker' in navigator) {
navigator.serviceWorker.register('sw.js');
}

initDB();

document.getElementById("addAsset").onclick = () => {

let name = prompt("Asset name");
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

let pl = (a.currentPrice - a.buyPrice) * a.quantity;
total += a.currentPrice * a.quantity;

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
setTimeout(loadAssets,500);
