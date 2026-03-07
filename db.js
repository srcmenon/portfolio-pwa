let db;

function initDB(){

let request = indexedDB.open("portfolioDB",1);

request.onupgradeneeded = (event) => {

db = event.target.result;

if(!db.objectStoreNames.contains("assets")){
db.createObjectStore("assets",{keyPath:"id",autoIncrement:true});
}

if(!db.objectStoreNames.contains("portfolioHistory")){
db.createObjectStore("portfolioHistory",{keyPath:"timestamp"});
}

};

request.onsuccess = (event) => {

db = event.target.result;

/* start app only after DB is ready */

loadAssets();
updatePrices();
recordPortfolioSnapshot();

};

}
