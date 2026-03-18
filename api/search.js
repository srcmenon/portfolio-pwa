/* ============================================================
   CapIntel — api/search.js   (Vercel Serverless Function)
   Proxies Yahoo Finance symbol search to the browser.
   Browser can't call Yahoo directly (CORS blocked).

   GET /api/search?q=Amadeus
   Returns: [ { symbol, name, exchange, type }, ... ]
   ============================================================ */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  const { q } = req.query
  if(!q || q.length < 2) return res.status(400).json({ results: [] })

  try{
    const r = await fetch(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&enableFuzzyQuery=false&enableEnhancedTrivialQuery=true`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    )
    const data = await r.json()
    const quotes = (data.quotes || [])
      .filter(q => q.symbol && q.shortname || q.longname)
      .slice(0, 8)
      .map(q => ({
        symbol:   q.symbol,
        name:     q.shortname || q.longname || q.symbol,
        exchange: q.exchange  || "",
        type:     q.quoteType || "EQUITY"
      }))
    res.status(200).json({ results: quotes })
  }catch(e){
    res.status(500).json({ results: [], error: e.message })
  }
}
