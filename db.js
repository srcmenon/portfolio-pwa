let db;

function initDB(){

let request = indexedDB.open("portfolioDB",3);

request.onupgradeneeded = (event) => {

db = event.target.result;

/* ASSETS */

if(!db.objectStoreNames.contains("assets")){
db.createObjectStore("assets",{keyPath:"id",autoIncrement:true});
}

/* TRANSACTIONS */

if(!db.objectStoreNames.contains("transactions")){
db.createObjectStore("transactions",{keyPath:"id",autoIncrement:true});
}

/* DIVIDENDS */

if(!db.objectStoreNames.contains("dividends")){
db.createObjectStore("dividends",{keyPath:"id",autoIncrement:true});
}

/* PORTFOLIO HISTORY */

if(!db.objectStoreNames.contains("portfolioHistory")){
db.createObjectStore("portfolioHistory",{keyPath:"timestamp"});
}

};

request.onsuccess = e => db = e.target.result;

}
