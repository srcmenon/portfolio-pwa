/* ============================================================
   CapIntel — api/price.js   (Vercel Serverless Function)
   Yahoo Finance price proxy. Called from the browser because
   Yahoo Finance blocks direct browser requests (CORS).

   Two modes depending on query params:

   1. Current price (no ?range param)
      GET /api/price?ticker=NVDA
      Returns: { price, changePercent, previousClose, marketState }
      - price          : current market price in the ticker's native currency
      - changePercent  : % change vs previous close (used for 1D chip)
      - previousClose  : yesterday's closing price
      - marketState    : "REGULAR" | "PRE" | "POST" | "CLOSED"

   2. Historical range change (with ?range param)
      GET /api/price?ticker=NVDA&range=1y
      Returns: { rangePct, first, last }
      - rangePct : % change from first to last close in the range
      - first    : first close price in the range
      - last     : most recent close price
      Supported ranges: 5d (1W), 1mo (1M), 6mo (6M), 1y (1Y), 5y (5Y)

   Interval mapping for historical mode:
   5d  → 1d  (daily bars for a week)
   1mo → 1d  (daily bars for a month)
   6mo → 1wk (weekly bars for 6 months)
   1y  → 1mo (monthly bars for a year)
   5y  → 3mo (quarterly bars for 5 years)

   Errors: returns HTTP 400/404/500 with { error: "message" }
   ============================================================ */

export default async function handler(req, res) {
  const { ticker, range } = req.query
  if(!ticker) return res.status(400).json({ error: "Ticker required" })

  try{
    /* ── HISTORICAL RANGE MODE ── */
    if(range){
      /* Map user-facing range to Yahoo chart interval for reasonable data density */
      const intervalMap = {
        "5d":  "1d",   /* 1 week   → daily bars    */
        "1mo": "1d",   /* 1 month  → daily bars    */
        "6mo": "1wk",  /* 6 months → weekly bars   */
        "1y":  "1mo",  /* 1 year   → monthly bars  */
        "5y":  "3mo"   /* 5 years  → quarterly bars */
      }
      const interval = intervalMap[range] || "1d"

      const r = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`
      )
      const data = await r.json()

      /* Extract closing price series, filtering out null values (market holidays) */
      const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close
        ?.filter(v => v != null)

      if(!closes?.length) return res.status(404).json({ error: "No historical data" })

      const first    = closes[0]
      const last     = closes[closes.length - 1]
      const rangePct = first > 0 ? ((last - first) / first) * 100 : null

      return res.status(200).json({ rangePct, first, last })
    }

    /* ── CURRENT PRICE MODE ── */
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}`
    )
    const data = await r.json()
    const result = data.chart?.result
    if(!result) return res.status(404).json({ error: "Price not found" })

    const meta          = result[0]?.meta
    const price         = meta?.regularMarketPrice
    /* chartPreviousClose is more reliable than previousClose for ETFs/non-US */
    const previousClose = meta?.chartPreviousClose || meta?.previousClose || null
    const changePercent = (previousClose && price)
      ? ((price - previousClose) / previousClose) * 100
      : null
    const marketState   = meta?.marketState || "CLOSED"

    res.status(200).json({ price, changePercent, previousClose, marketState })

  }catch(e){
    res.status(500).json({ error: "Price fetch failed" })
  }
}
