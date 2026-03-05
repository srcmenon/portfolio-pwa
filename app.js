if ('serviceWorker' in navigator) {
navigator.serviceWorker.register('sw.js');
}

initDB();

document.getElementById("addAsset").onclick = () => {

let name = prompt("Asset name");
let qty = parseFloat(prompt("Quantity"));
let price = parseFloat(prompt("Buy price"));

let tx = db.transaction("assets","readwrite");

tx.objectStore("assets").add({
name:name,
quantity:qty,
buyPrice:price,
currentPrice:price
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
</tr>`;

table.innerHTML += row;

});

document.getElementById("assetCount").innerText = req.result.length;
document.getElementById("totalValue").innerText = "€" + total.toFixed(2);

};

}

setTimeout(loadAssets,500);