let db;

function initDB(){

let request = indexedDB.open("portfolioDB",1);

request.onupgradeneeded = e => {

db = e.target.result;

db.createObjectStore("assets",{keyPath:"id",autoIncrement:true});
db.createObjectStore("transactions",{keyPath:"id",autoIncrement:true});
db.createObjectStore("dividends",{keyPath:"id",autoIncrement:true});
db.createObjectStore("portfolioHistory", {
keyPath: "timestamp"
});
};
request.onupgradeneeded = (event) => {

db = event.target.result;

if(!db.objectStoreNames.contains("assets")){
db.createObjectStore("assets",{keyPath:"id",autoIncrement:true});
}

if(!db.objectStoreNames.contains("portfolioHistory")){
db.createObjectStore("portfolioHistory",{keyPath:"timestamp"});
}

};
request.onsuccess = e => db = e.target.result;

}
