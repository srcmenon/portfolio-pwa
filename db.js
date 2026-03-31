/* ============================================================
   CapIntel — db.js
   IndexedDB initialisation. Loaded before app.js in index.html.

   Creates (or opens) a database called "portfolioDB" at version 2.
   Object stores:

   1. "assets"         — keyPath: "id" (auto-increment). One row per lot.
   2. "portfolioHistory" — keyPath: "timestamp". Portfolio snapshots.
   3. "manualFundamentals" — keyPath: "symbol". Manually entered
      fundamental data per stock (ROE, D/E, margins, growth, P/B).
      Added in version 2.
   ============================================================ */

let db;

function initDB(){
  const request = indexedDB.open("portfolioDB", 2);  /* bumped to 2 */

  request.onupgradeneeded = event => {
    db = event.target.result;

    if(!db.objectStoreNames.contains("assets")){
      db.createObjectStore("assets", { keyPath:"id", autoIncrement:true });
    }
    if(!db.objectStoreNames.contains("portfolioHistory")){
      db.createObjectStore("portfolioHistory", { keyPath:"timestamp" });
    }
    /* NEW in v2 — manual fundamentals entered by user from Screener.in */
    if(!db.objectStoreNames.contains("manualFundamentals")){
      db.createObjectStore("manualFundamentals", { keyPath:"symbol" });
    }
  };

  request.onsuccess = event => {
    db = event.target.result;
    if(typeof startApp === "function"){
      startApp();
    }
  };

  request.onerror = event => {
    console.error("IndexedDB failed to open:", request.error);
  };
}
