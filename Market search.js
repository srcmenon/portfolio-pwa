export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({error:"POST only"})

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({error:"ANTHROPIC_API_KEY not set"})

  const { portfolio, totalValue, totalReturn } = req.body || {}
  if(!portfolio || !portfolio.length) return res.status(400).json({error:"Portfolio required"})

  const topStocks = portfolio
    .filter(p => p.type === "Stock" || p.type === "ETF")
    .sort((a,b) => b.totalCurrentEUR - a.totalCurrentEUR)
    .slice(0, 8)
    .map(p => p.name)
    .join(", ")

  const hasPSU    = portfolio.some(p => ["ONGC","OIL","COALINDIA","NLCINDIA","PFC","RECLTD","BEL","SAIL"].includes(p.key))
  const hasGold   = portfolio.some(p => p.name.toLowerCase().includes("gold"))
  const hasSilver = portfolio.some(p => p.name.toLowerCase().includes("silver"))

  const searchPrompt = `Search the web and gather precise, current market data. Return all numbers you find exactly as found.

Search for ALL of the following:

1. INDEX LEVELS & TECHNICALS:
- Nifty 50: current level, 50-day MA, 200-day MA, RSI (14-day), MACD
- Sensex: current level and recent trend
- S&P 500: current level, 50-day MA, 200-day MA, RSI
- DAX Germany: current level and momentum
- VIX: current reading and what it signals

2. FUNDAMENTALS for these stocks: ${topStocks}
For each find: P/E ratio, forward P/E, EPS (TTM), EPS growth YoY, PEG ratio, D/E ratio, ROE, 52-week high and low

3. COMMODITIES & CURRENCIES:
- Gold spot price USD/oz, 50-day MA, 200-day MA, RSI
${hasSilver ? "- Silver spot price and trend" : ""}
- Brent crude oil price and OPEC+ latest decision
- EUR/INR current rate and 30-day change
- USD/INR current rate and trend
- EUR/USD current rate
- US 10-year Treasury yield
- India 10-year bond yield

4. MACRO & POLICY:
- RBI latest interest rate decision and stance
- ECB latest interest rate decision and stance
- FII net flows in Indian markets last 2 weeks
- DII net flows in Indian markets last 2 weeks
- Any major upcoming events: Fed meeting, RBI policy, key earnings

5. SECTOR OUTLOOK:
- Indian small cap / mid cap: current valuations, P/E vs historical average, overbought or cheap?
${hasPSU ? "- Indian PSU sector: current momentum and government capex pipeline" : ""}
- Global semiconductor sector: supply/demand, cycle position
- Indian defense sector: order book and budget allocation update
- Any major geopolitical events affecting India or Europe markets

Return all data in clear structured format with numbers wherever available.`

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 5000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: searchPrompt }]
      })
    })

    if(!r.ok){
      const err = await r.text()
      console.error("market-search failed:", err)
      return res.status(500).json({error:"Market search failed", detail: err})
    }

    const data = await r.json()
    const marketData = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n\n")

    return res.status(200).json({ marketData })

  } catch(e) {
    console.error("market-search error:", e)
    return res.status(500).json({error:"Market search error", detail: e.message})
  }
}
