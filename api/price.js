/* ============================================================
   CapIntel — api/price.js   (Vercel Serverless Function)
   Yahoo Finance price proxy. Three modes:

   1. Current price:  GET /api/price?ticker=NVDA
      Returns: { price, changePercent, previousClose, marketState }

   2. Range summary:  GET /api/price?ticker=NVDA&range=1y
      Returns: { rangePct, first, last }
      Used by the Performance chips in the asset table.

   3. Full history:   GET /api/price?ticker=NVDA&range=1y&history=true
      Returns: { timestamps: [ms,...], closes: [val,...] }
      Used by the category growth charts to build real per-asset
      historical curves rather than proportional approximations.

   Interval mapping (same for modes 2 and 3):
   5d  → 1d  |  1mo → 1d  |  3mo → 1wk
   6mo → 1wk |  1y  → 1mo |  5y  → 3mo  |  max → 3mo
   ============================================================ */

export default async function handler(req, res) {
  const { ticker, range, history } = req.query
  if(!ticker) return res.status(400).json({ error: "Ticker required" })

  const intervalMap = {
    "5d":"1d", "1mo":"1d", "3mo":"1wk",
    "6mo":"1wk", "1y":"1mo", "5y":"3mo", "max":"3mo"
  }

  try{
    /* ── MODES 2 & 3: historical data ── */
    if(range){
      const interval = intervalMap[range] || "1d"
      const r    = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`
      )
      const data = await r.json()
      const result = data.chart?.result?.[0]
      if(!result) return res.status(404).json({ error: "No historical data" })

      const rawTimestamps = result.timestamp || []
      const rawCloses     = result.indicators?.quote?.[0]?.close || []

      /* Zip timestamps + closes, strip nulls (market holidays / missing bars) */
      const pairs = rawTimestamps
        .map((ts, i) => ({ ts: ts * 1000, close: rawCloses[i] }))
        .filter(p => p.close != null)

      if(!pairs.length) return res.status(404).json({ error: "No data points" })

      /* Mode 3: return full time series for category chart building */
      if(history === "true"){
        return res.status(200).json({
          timestamps: pairs.map(p => p.ts),
          closes:     pairs.map(p => p.close)
        })
      }

      /* Mode 2: return summary % change only */
      const first    = pairs[0].close
      const last     = pairs[pairs.length - 1].close
      const rangePct = first > 0 ? ((last - first) / first) * 100 : null
      return res.status(200).json({ rangePct, first, last })
    }

    /* ── MODE 1: current price ── */
    const r    = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${ticker}`)
    const data = await r.json()
    const result = data.chart?.result
    if(!result) return res.status(404).json({ error: "Price not found" })

    const meta          = result[0]?.meta
    const price         = meta?.regularMarketPrice
    const previousClose = meta?.chartPreviousClose || meta?.previousClose || null
    const changePercent = (previousClose && price)
      ? ((price - previousClose) / previousClose) * 100 : null
    const marketState   = meta?.marketState || "CLOSED"

    res.status(200).json({ price, changePercent, previousClose, marketState })

  }catch(e){
    res.status(500).json({ error: "Price fetch failed" })
  }
}
