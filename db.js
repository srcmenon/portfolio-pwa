/* ============================================================
   CapIntel — db.js
   IndexedDB initialisation. Loaded before app.js in index.html.

   Creates (or opens) a database called "portfolioDB" at version 1.
   Two object stores are created on first run:

   1. "assets"
      - keyPath: "id" (auto-incremented integer)
      - Stores individual buy lots. One row per purchase.
      - Fields: name, ticker, broker, type, currency,
                quantity, buyPrice, buyPriceEUR,
                currentPrice (updated by price engine), buyDate

   2. "portfolioHistory"
      - keyPath: "timestamp" (Unix ms, set at record time)
      - Stores periodic snapshots of total portfolio value in EUR.
      - Fields: timestamp, value (total EUR), cats (per-category breakdown)
      - Used as the data source for the Growth Chart.
      - See recordPortfolioSnapshot() in app.js for how cats is written.

   On success: calls startApp() from app.js to boot the UI.
   The `db` global is referenced throughout app.js for all transactions.
   ============================================================ */

let db;  /* global DB handle — set in onsuccess below, used everywhere in app.js */

function initDB(){
  const request = indexedDB.open("portfolioDB", 1);

  /* onupgradeneeded fires when the DB is first created (version 0 → 1)
     or when the version number is bumped in future.
     This is the only place object stores should be created or modified. */
  request.onupgradeneeded = event => {
    db = event.target.result;

    /* Create assets store if it doesn't already exist */
    if(!db.objectStoreNames.contains("assets")){
      db.createObjectStore("assets", { keyPath:"id", autoIncrement:true });
    }

    /* Create portfolioHistory store if it doesn't already exist */
    if(!db.objectStoreNames.contains("portfolioHistory")){
      db.createObjectStore("portfolioHistory", { keyPath:"timestamp" });
    }
  };

  /* onsuccess: DB opened successfully (and any upgrade is complete).
     Assign the handle and boot the app. */
  request.onsuccess = event => {
    db = event.target.result;
    if(typeof startApp === "function"){
      startApp();
    }
  };

  request.onerror = event => {
    console.error("IndexedDB failed to open:", request.error);
  };
}let db;

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

if(typeof startApp === "function"){
startApp();
}

};

request.onerror = (event) => {
console.error("IndexedDB failed to open:", request.error);
};

}
