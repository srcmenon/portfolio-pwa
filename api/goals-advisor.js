/* ============================================================
   CapIntel — api/goals-advisor.js   (Vercel Serverless Function)

   Fetches real technical indicators from Yahoo Finance for every
   non-MF position, then sends enriched data to Claude for
   goal-aligned BUY / HOLD / TRIM / SELL advice.

   Technical indicators computed here (not guessed by AI):
   - RSI-14 (Wilder's smoothed)
   - Price vs 50-day SMA and 200-day SMA
   - 52-week high/low % position
   - 6-month and 1-year momentum %
   - Trend: above/below 200 DMA
   ============================================================ */

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains  += diff
    else          losses -= diff
  }
  let avgGain = gains  / period
  let avgLoss = losses / period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period
  }
  if (avgLoss === 0) return 100
  return Math.round(100 - 100 / (1 + avgGain / avgLoss))
}

function calcSMA(closes, period) {
  if (closes.length < period) return null
  return closes.slice(-period).reduce((s, v) => s + v, 0) / period
}

async function fetchHistory(ticker) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    )
    const data = await r.json()
    const result = data.chart?.result?.[0]
    if (!result) return null
    const timestamps = result.timestamp || []
    const closes = result.indicators?.quote?.[0]?.close || []
    return timestamps
      .map((ts, i) => ({ ts: ts * 1000, close: closes[i] }))
      .filter(p => p.close != null)
      .map(p => p.close)
  } catch (e) { return null }
}

function resolveYahooTicker(pos) {
  const t = pos.key || ""
  if (!t) return null
  if (t.includes("-USD")) return t
  if (pos.type === "MutualFund") return null
  if (t.includes(".")) return t
  if (t === "SEMI")  return "CHIP.PA"
  if (t === "EWG2")  return "EWG2.SG"
  if (pos.currency === "USD") return t
  if (pos.currency === "EUR") {
    const type = (pos.type || "").toLowerCase()
    return (type === "etf" || type === "commodity") ? t + ".L" : t
  }
  return t + ".NS"
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" })

  const { portfolio, goals } = req.body || {}
  if (!portfolio?.length) return res.status(400).json({ error: "portfolio required" })
  if (!goals)             return res.status(400).json({ error: "goals required" })

  const model    = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"
  const totalEUR = portfolio.reduce((s, p) => s + (p.totalCurrentEUR || 0), 0)
  const totalBuy = portfolio.reduce((s, p) => s + (p.totalBuyEUR || 0), 0)

  /* Fetch technicals for all non-MF positions in parallel (capped at 40 by value) */
  const targets = portfolio
    .filter(p => p.type !== "MutualFund" && resolveYahooTicker(p))
    .sort((a, b) => (b.totalCurrentEUR || 0) - (a.totalCurrentEUR || 0))
    .slice(0, 40)

  const techMap = {}
  await Promise.all(targets.map(async pos => {
    const symbol = resolveYahooTicker(pos)
    const closes = await fetchHistory(symbol)
    if (!closes || closes.length < 20) return

    const cur       = pos.currentPrice || closes[closes.length - 1]
    const high52    = Math.max(...closes)
    const low52     = Math.min(...closes)
    const sma50     = calcSMA(closes, 50)
    const sma200    = calcSMA(closes, 200)
    const rsi14     = calcRSI(closes)
    const closes6m  = closes.slice(-126)
    const mom6m     = closes6m.length > 1
      ? ((closes6m[closes6m.length - 1] - closes6m[0]) / closes6m[0]) * 100 : null
    const mom1y     = closes.length > 1
      ? ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100 : null

    techMap[pos.key] = {
      rsi14:         rsi14 !== null ? rsi14 : "N/A",
      trend:         sma200 ? (cur > sma200 ? "ABOVE_200DMA" : "BELOW_200DMA") : "UNKNOWN",
      vsS50:         sma50  ? ((cur - sma50)  / sma50  * 100).toFixed(1) + "%" : "N/A",
      vsS200:        sma200 ? ((cur - sma200) / sma200 * 100).toFixed(1) + "%" : "N/A",
      pctFrom52High: ((cur - high52) / high52 * 100).toFixed(1) + "%",
      pctFrom52Low:  ((cur - low52)  / low52  * 100).toFixed(1) + "%",
      momentum6m:    mom6m  !== null ? mom6m.toFixed(1)  + "%" : "N/A",
      momentum1y:    mom1y  !== null ? mom1y.toFixed(1)  + "%" : "N/A"
    }
  }))

  /* Build prompt lines */
  const positionLines = portfolio
    .sort((a, b) => (b.totalCurrentEUR || 0) - (a.totalCurrentEUR || 0))
    .map(pos => {
      const wt   = totalEUR > 0 ? ((pos.totalCurrentEUR || 0) / totalEUR * 100).toFixed(1) : "0"
      const sign = (pos.growth || 0) >= 0 ? "+" : ""
      const t    = techMap[pos.key]
      const techStr = t
        ? `RSI14=${t.rsi14}, trend=${t.trend}, vs50DMA=${t.vsS50}, vs200DMA=${t.vsS200}, 52wkHigh=${t.pctFrom52High}, 52wkLow=${t.pctFrom52Low}, mom6m=${t.momentum6m}, mom1y=${t.momentum1y}`
        : `type=${pos.type} (NAV-based, no price technicals)`
      return `${pos.name} | ${pos.key} | €${(pos.totalCurrentEUR||0).toFixed(0)} | wt=${wt}% | ${sign}${(pos.growth||0).toFixed(1)}% | PL=€${(pos.profitEUR||0).toFixed(0)} | qty=${pos.qty||0} | ${techStr}`
    })
    .join("\n")

  const homeYrs = (goals.homeYear || 2030) - new Date().getFullYear()
  const retYrs  = (goals.retireAge || 50) - 36

  const systemPrompt =
    `You are a senior portfolio manager with real technical analysis data already computed.
     Make specific, actionable, technically-grounded decisions for every position.
     Respond ONLY with raw JSON — absolutely no text outside the JSON object.`

  const userPrompt = `
INVESTOR PROFILE:
- Age 36, German tax resident, Indian origin
- Goal 1: Buy home in India in ${homeYrs} years (${goals.homeYear}), budget ₹${goals.homeBudget} lakhs
- Goal 2: Retire at ${goals.retireAge} (${retYrs} years). Target corpus: €${(goals.corpus||270000).toLocaleString()}
- Monthly EUR investment: €${goals.monthly||600}
- Current portfolio: €${totalEUR.toFixed(0)} | Cost basis: €${totalBuy.toFixed(0)}
- Tax: Germany 26.375% flat | India LTCG 12.5% (₹1.25L/yr free), STCG 20%
- Risk: Aggressive, 6-month drawdown tolerance

TECHNICAL RULES TO APPLY:
- RSI > 70 = overbought → consider TRIM or SELL
- RSI < 30 = oversold → consider BUY if thesis intact
- BELOW_200DMA = bear trend → cautious, only hold if strong fundamental thesis
- 52wkHigh% near 0% = at peak → avoid adding, consider trimming
- 52wkHigh% < -35% = deep correction → evaluate if thesis broken or opportunity
- Weight > 5% = concentrated → review for trim unless it is core index ETF
- EUR value < €100 = noise position → SELL to simplify

ALL ${portfolio.length} PORTFOLIO POSITIONS WITH REAL TECHNICALS:
${positionLines}

GENERATE:

1. Verdict for EVERY position above. Use actual RSI/DMA numbers in your reasoning.
   - BUY: where to add and at what price/level
   - HOLD: specific condition or timeframe to review next
   - TRIM: EXACT shares to sell and new weight after trimming
   - SELL: all shares, specific technical + fundamental reason

2. 5-6 NEW OPPORTUNITIES not currently in portfolio:
   - What is missing relative to goals?
   - Gold (more)? European small cap? Indian index fund? Global bonds? Healthcare ETF?
   - Specify exact ticker, exchange, and monthly SIP amount or lump sum

Return ONLY this JSON:
{
  "marketSummary": "3 sentences covering: aggregate portfolio RSI signal, how many positions are above/below 200DMA, overall India vs global positioning, and one key risk or opportunity right now",
  "advice": [
    {
      "ticker": "TICKER",
      "name": "Name",
      "verdict": "BUY|HOLD|TRIM|SELL",
      "currentPrice": "₹X",
      "weight": "X.X%",
      "growth": "+X%",
      "rsi": 45,
      "trend": "ABOVE_200DMA",
      "action": "Specific instruction: e.g. 'Trim 43 of 86 shares → reduces weight from 2.8% to 1.4%' or 'Hold — review if RSI crosses 72 or price falls below 200DMA at ₹X' or 'Buy ₹25,000 in tranches at ₹780 or below (RSI=38, near 52-week low at ₹750)'",
      "reason": "2 sentences referencing actual RSI/DMA values from data + how it serves the investor's specific goals",
      "goalAlignment": "HOME_FUND|RETIREMENT|CLEANUP|REBALANCE",
      "taxNote": "1 sentence on specific Indian or German tax implication",
      "urgency": "This week|This month|Next quarter|No rush"
    }
  ],
  "newOpportunities": [
    {
      "name": "Asset full name",
      "ticker": "TICKER.EXCHANGE",
      "exchange": "NSE|LSE|XETRA|NYSE|BSE",
      "suggestedAmount": "€X/month SIP or one-time €X",
      "reason": "Why this fills a specific gap vs goals. 2 sentences.",
      "goalAlignment": "HOME_FUND|RETIREMENT|REBALANCE"
    }
  ],
  "generatedAt": "${new Date().toISOString()}"
}`

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system:  systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    })

    const rawText = await r.text()
    if (!r.ok) return res.status(500).json({ error: `API error ${r.status}`, detail: rawText.slice(0,500) })

    let data
    try { data = JSON.parse(rawText) }
    catch (e) { return res.status(500).json({ error: "Failed to parse Anthropic response" }) }

    if (data.error) return res.status(500).json({ error: data.error.message || "API error" })

    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim()
    if (!text) return res.status(500).json({ error: "Empty response" })

    const start = text.indexOf("{")
    if (start === -1) return res.status(500).json({ error: "No JSON", raw: text.slice(0,400) })

    let depth = 0, end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{")       depth++
      else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) return res.status(500).json({ error: "JSON truncated" })

    let result
    try { result = JSON.parse(text.slice(start, end + 1)) }
    catch (e) { return res.status(500).json({ error: "Parse failed: " + e.message }) }

    return res.status(200).json(result)

  } catch (e) {
    return res.status(500).json({ error: "Handler error: " + e.message })
  }
}
