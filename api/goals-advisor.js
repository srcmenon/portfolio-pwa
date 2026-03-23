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
    `You are a high-performance portfolio manager advising an aggressive growth investor.
     Your mandate is maximum wealth creation aligned to specific goals — NOT capital preservation.
     Unnecessary caution, hedging language, or generic "diversify" advice is explicitly forbidden.
     Every suggestion must be profit-driven, technically grounded, and time-specific.
     Do NOT add disclaimers. Do NOT say "consult a financial advisor".
     The investor is 36, aggressive, has 14 years, and wants to grow wealth — not protect it.
     Respond ONLY with raw JSON. No text outside the JSON object.`

  const userPrompt = `
INVESTOR — READ THIS CAREFULLY BEFORE ADVISING:
- Age 36, German tax resident, Indian origin
- HARD GOAL 1: Own home in India in ${homeYrs} years (${goals.homeYear}). Budget ₹${goals.homeBudget} lakhs.
- HARD GOAL 2: Retire at ${goals.retireAge} with €${(goals.corpus||270000).toLocaleString()} corpus. ${retYrs} years left.
- Monthly investment capacity: €${goals.monthly||600}/month new money
- Total portfolio NOW: €${totalEUR.toFixed(0)} | Cost basis: €${totalBuy.toFixed(0)} | True return: ${totalBuy > 0 ? (((totalEUR-totalBuy)/totalBuy)*100).toFixed(1) : 0}%
- Tax: Germany 26.375% flat | India LTCG 12.5% (first ₹1.25L/yr free), STCG (<1yr) 20%
- Risk tolerance: AGGRESSIVE. Accepts 6-12 month drawdowns for superior long-term returns.
- Philosophy: Every rupee sitting in an underperforming position is a wasted rupee. Time IS money.

MANDATE:
This investor does not want to hear "be careful" or "consider the risks".
They want to know: What to DO, exactly, TODAY — to grow this portfolio to €${(goals.corpus||270000).toLocaleString()} by age ${goals.retireAge}
and accumulate ₹${goals.homeBudget} lakhs for a home by ${goals.homeYear}.

CURRENT ALLOCATION ANALYSIS (identify imbalances):
- If India MF weight > 40%: over-concentrated in one geography, recommend rebalancing
- If small-cap MF weight > 20%: redundant cluster, consolidate aggressively
- If EUR/global weight < 30%: under-invested globally, this investor earns EUR — must grow EUR corpus
- If commodities/gold < 5%: underweight as inflation hedge
- If single position > 8%: concentration risk unless it's a core world ETF

ALL ${portfolio.length} POSITIONS WITH REAL TECHNICALS:
(Format: Name | Ticker | EUR Value | Weight | Growth | P&L | Qty | RSI14 | Trend | vs50DMA | vs200DMA | 52wkHigh% | 52wkLow% | 6M momentum | 1Y momentum)

${positionLines}

TECHNICAL DECISION RULES — apply strictly:
RSI < 35 + ABOVE_200DMA + strong fundamentals = STRONG BUY opportunity
RSI 35-50 + ABOVE_200DMA = BUY on dips, accumulate
RSI 50-65 + ABOVE_200DMA = HOLD, let it run
RSI 65-75 + near 52wk high = TRIM 30-50% to lock profits
RSI > 75 OR BELOW_200DMA + broken thesis = SELL
BELOW_200DMA + RSI < 40 + strong long-term thesis = HOLD (do not panic sell)
EUR value < €100 = SELL immediately — noise positions destroy focus
Weight > 6% (non-ETF) = TRIM to 3-4% to free capital for better opportunities

ADVICE REQUIREMENTS:
1. Give verdict for EVERY position. No position left unadvised.
2. For TRIM: state exact number of shares AND what to do with proceeds (which asset to buy)
3. For BUY: state exact entry price, position size in EUR/INR, and which goal it serves
4. For HOLD: state a specific numeric trigger to reassess (not "monitor") — e.g. "Hold until RSI>72 then trim 30%" or "Hold until price recovers to ₹X, then exit"
5. For SELL: state where to redeploy the proceeds immediately
6. Flag any REBALANCING needed: if too much India, push to EUR. If too much small-cap MF, push to index.

NEW OPPORTUNITIES — what this portfolio is MISSING relative to goals:
- Consider: Nifty 50 index fund (if not enough India index exposure), S&P 500 ETF or MSCI World, European mid-cap, gold ETF increase, semiconductor ETF, healthcare ETF, emerging market ex-India
- For each: specify monthly SIP amount from the €${goals.monthly||600}/month budget OR one-time amount from SELL/TRIM proceeds
- Be specific about WHICH ETF/fund, on WHICH exchange, and WHAT amount monthly

Return ONLY this JSON (every field required, no nulls):
{
  "portfolioHealth": {
    "indiaWeight": "X%",
    "globalWeight": "X%",
    "commodityWeight": "X%",
    "biggestConcentration": "position name at X%",
    "rebalanceUrgency": "Critical|High|Normal",
    "summary": "2 sentences: what is the single biggest structural problem and the single biggest opportunity in this portfolio TODAY"
  },
  "marketSummary": "3 sentences: aggregate RSI signal across portfolio, how many positions above vs below 200DMA, and the single most important market-level action to take this week",
  "advice": [
    {
      "ticker": "TICKER",
      "name": "Full name",
      "verdict": "BUY|HOLD|TRIM|SELL",
      "currentPrice": "₹X or €X",
      "weight": "X.X%",
      "growth": "+X% or -X%",
      "rsi": 45,
      "trend": "ABOVE_200DMA|BELOW_200DMA|UNKNOWN",
      "action": "Precise: e.g. 'Trim 43 of 86 shares at ₹1,270. Proceeds ₹54,610 → deploy into HDFCBANK (RSI=42, near 52wk low). Reduces SOBHA weight from 2.8% to 1.4%' OR 'Buy ₹30,000 at ₹780 or below. RSI=38, price is 31% below 52-week high, 200DMA at ₹760 holding as support. Grows HDFCBANK to meaningful ₹58k position.' OR 'Hold. RSI=52, ABOVE_200DMA, 6M momentum +18%. Reassess only if RSI exceeds 73 or drops below 200DMA (currently at ₹X).'",
      "reason": "2 sentences: technical basis (cite actual numbers) + goal basis (which goal and how much closer it gets you)",
      "redeploy": "Where proceeds go if SELL or TRIM. 'N/A' for BUY/HOLD.",
      "goalAlignment": "HOME_FUND|RETIREMENT|CLEANUP|REBALANCE",
      "taxNote": "Specific: e.g. 'Held >1yr — LTCG at 12.5%, gain ₹X is within ₹1.25L annual exemption' or 'STCG applies if sold now — wait 3 months for LTCG threshold'",
      "urgency": "This week|This month|Next quarter|No rush"
    }
  ],
  "newOpportunities": [
    {
      "name": "Full asset name",
      "ticker": "TICKER.EXCHANGE",
      "exchange": "NSE|LSE|XETRA|NYSE|BSE",
      "suggestedAmount": "€X/month SIP" or "One-time €X from [POSITION] trim proceeds",
      "reason": "2 sentences: what gap it fills + specific return expectation or historical performance + which goal",
      "goalAlignment": "HOME_FUND|RETIREMENT|REBALANCE",
      "urgency": "Start now|Start this month|Start next quarter"
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
