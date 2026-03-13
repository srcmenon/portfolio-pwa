export default async function handler(req, res) {
  const { ticker, range } = req.query
  if(!ticker) return res.status(400).json({error:"Ticker required"})

  try{
    /* If range requested, fetch historical chart data */
    if(range){
      const intervalMap = {"5d":"1d","1mo":"1d","6mo":"1wk","1y":"1mo","5y":"3mo"}
      const interval = intervalMap[range] || "1d"
      const r = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`
      )
      const data = await r.json()
      const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v=>v!=null)
      if(!closes?.length) return res.status(404).json({error:"No data"})
      const first = closes[0], last = closes[closes.length-1]
      const rangePct = first>0 ? ((last-first)/first)*100 : null
      return res.status(200).json({rangePct, first, last})
    }

    /* Default: current price + 1D change */
    const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${ticker}`)
    const data = await r.json()
    const result = data.chart?.result
    if(!result) return res.status(404).json({error:"Price not found"})
    const meta = result[0]?.meta
    const price = meta?.regularMarketPrice
    const previousClose = meta?.chartPreviousClose || meta?.previousClose || null
    const changePercent = (previousClose && price) ? ((price-previousClose)/previousClose)*100 : null
    const marketState = meta?.marketState || "CLOSED"
    res.status(200).json({price, changePercent, previousClose, marketState})
  }catch(e){
    res.status(500).json({error:"Price fetch failed"})
  }
}
