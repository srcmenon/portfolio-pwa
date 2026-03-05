let db;

function initDB(){

let request = indexedDB.open("portfolioDB",1);

request.onupgradeneeded = e => {

db = e.target.result;

db.createObjectStore("assets",{keyPath:"id",autoIncrement:true});
db.createObjectStore("transactions",{keyPath:"id",autoIncrement:true});
db.createObjectStore("dividends",{keyPath:"id",autoIncrement:true});

};

request.onsuccess = e => db = e.target.result;

}