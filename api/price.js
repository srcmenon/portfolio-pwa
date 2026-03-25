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

    /* Yahoo's marketState for non-US exchanges (especially .NS) is unreliable —
       it often returns "CLOSED" even when NSE/BSE is open.
       Detect market state locally using IST time for Indian tickers,
       and CET/CEST for European tickers. Fall back to Yahoo for US. */
    let marketState = meta?.marketState || "CLOSED"

    const isNSE = ticker.endsWith(".NS") || ticker.endsWith(".BO")
    const isEUR = ticker.endsWith(".DE") || ticker.endsWith(".PA") ||
                  ticker.endsWith(".L")  || ticker.endsWith(".SG") ||
                  ticker.endsWith(".MC") || ticker.endsWith(".MI")

    if (isNSE) {
      /* NSE hours: Mon–Fri 09:15–15:30 IST (UTC+5:30) */
      const now = new Date()
      const istOffset = 5.5 * 60  /* IST = UTC+5:30 in minutes */
      const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + istOffset) % (24 * 60)
      const istDay = new Date(now.getTime() + istOffset * 60000).getUTCDay()
      const isWeekday = istDay >= 1 && istDay <= 5
      const afterOpen  = istMinutes >= 9 * 60 + 15   /* 09:15 IST */
      const beforeClose= istMinutes <= 15 * 60 + 30  /* 15:30 IST */
      marketState = (isWeekday && afterOpen && beforeClose) ? "REGULAR" : "CLOSED"
    } else if (isEUR) {
      /* XETRA/LSE hours: Mon–Fri 08:00–17:30 CET (UTC+1 / UTC+2 DST) */
      const now = new Date()
      /* Approximate CET offset — CET is UTC+1, CEST is UTC+2 */
      const month = now.getUTCMonth() + 1  /* 1-12 */
      const cetOffset = (month >= 4 && month <= 10) ? 2 * 60 : 1 * 60
      const cetMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + cetOffset) % (24 * 60)
      const cetDay = new Date(now.getTime() + cetOffset * 60000).getUTCDay()
      const isWeekday = cetDay >= 1 && cetDay <= 5
      const afterOpen  = cetMinutes >= 8 * 60
      const beforeClose= cetMinutes <= 17 * 60 + 30
      marketState = (isWeekday && afterOpen && beforeClose) ? "REGULAR" : "CLOSED"
    }
    /* US tickers: trust Yahoo's marketState — it's accurate for NYSE/NASDAQ */

    res.status(200).json({ price, changePercent, previousClose, marketState })

  }catch(e){
    res.status(500).json({ error: "Price fetch failed" })
  }
}
