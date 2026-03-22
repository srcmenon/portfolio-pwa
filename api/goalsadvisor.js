/* ============================================================
   CapIntel — api/goals-advisor.js   (Vercel Serverless Function)

   AI-powered daily portfolio advisor aligned to the user's goals.
   Uses Claude + web_search to get real market context before advising.

   Called once per day when the app opens — cached in localStorage
   by date so it does NOT re-call on every tab switch.

   Returns structured advice per position:
   - BUY  → which asset, how much (€ or shares), why now
   - HOLD → hold until when / what condition to review
   - TRIM → exact shares/% to sell, target weight after trim
   - SELL → sell all, reason, tax note

   Also returns goal alignment scores and market context summary.
   ============================================================ */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST")    return res.status(405).json({ error:"POST only" })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({ error:"ANTHROPIC_API_KEY not set" })

  const { portfolio, goals } = req.body || {}
  if(!portfolio?.length) return res.status(400).json({ error:"portfolio required" })
  if(!goals)             return res.status(400).json({ error:"goals required" })

  const model    = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"
  const totalEUR = portfolio.reduce((s,p) => s+(p.totalCurrentEUR||0), 0)
  const totalBuy = portfolio.reduce((s,p) => s+(p.totalBuyEUR||0), 0)
  const retireYearsLeft = goals.retireAge - 36
  const homeYearsLeft   = goals.homeYear - new Date().getFullYear()

  /* Build compact but complete portfolio lines */
  const lines = portfolio
    .sort((a,b) => (b.totalCurrentEUR||0) - (a.totalCurrentEUR||0))
    .map(p => {
      const wt   = totalEUR > 0 ? ((p.totalCurrentEUR||0)/totalEUR*100).toFixed(1) : "0"
      const sign = (p.growth||0) >= 0 ? "+" : ""
      const pl   = (p.profitEUR||0) >= 0 ? "+" : ""
      return [
        `${p.name}`,
        `ticker:${p.key}`,
        `type:${p.type}`,
        `ccy:${p.currency}`,
        `qty:${p.qty || p.quantity || 0}`,
        `buyPrice:${(p.avgBuy||p.buyPrice||0).toFixed(2)}`,
        `currentPrice:${(p.currentPrice||0).toFixed(2)}`,
        `value:€${(p.totalCurrentEUR||0).toFixed(0)}`,
        `weight:${wt}%`,
        `growth:${sign}${(p.growth||0).toFixed(1)}%`,
        `PL:${pl}€${Math.abs(p.profitEUR||0).toFixed(0)}`
      ].join(" | ")
    })
    .join("\n")

  const systemPrompt =
    `You are a sophisticated portfolio advisor. You have web search capability.
     Use it to get TODAY's actual market data before advising.
     Respond with ONLY raw JSON — no markdown, no prose outside the JSON.`

  const userPrompt = `
INVESTOR PROFILE:
- Age: 36, German tax resident, Indian origin
- Goal 1: Buy home in India in ${homeYearsLeft} years (${goals.homeYear}), budget ₹${goals.homeBudget} lakhs
- Goal 2: Retire at age ${goals.retireAge} (${retireYearsLeft} years from now)
- Target retirement corpus: €${goals.corpus.toLocaleString()}
- Monthly EUR investment capacity: €${goals.monthly}
- Risk profile: Aggressive growth, comfortable with 6-month drawdowns
- Tax: Germany 26.375% on all gains; India LTCG 12.5% (first ₹1.25L/yr free), STCG 20%

PORTFOLIO TOTAL: €${totalEUR.toFixed(0)} invested | €${totalBuy.toFixed(0)} cost basis | ${portfolio.length} positions

POSITIONS:
${lines}

STEP 1 — SEARCH for current market context:
Search for: "Nifty 50 level today March 2026", "India small cap valuation 2026", "EUR USD exchange rate today", "global market outlook March 2026"
Use results to understand: Is this a good time to buy India? Are valuations stretched? Any macro risks?

STEP 2 — Generate advice for EVERY position above. For each position give:
- verdict: exactly one of BUY / HOLD / TRIM / SELL
- If BUY: specify addAmount in EUR (or shares if INR stock) and the ideal entry level
- If HOLD: specify holdUntil as a condition ("until RSI < 40", "until FY27 results", "12 months", "until ₹X price") — NOT just "hold"
- If TRIM: specify trimQty (exact number of shares to sell) and targetWeight% after trimming
- If SELL: specify all shares, reason must be specific

STEP 3 — Goal alignment: for each advice, tag which goal it serves:
- "HOME_FUND" = proceeds go to India home corpus
- "RETIREMENT" = grows EUR retirement corpus  
- "CLEANUP" = removes noise/complexity
- "REBALANCE" = fixes concentration

Return ONLY this JSON:
{
  "marketContext": {
    "nifty50": "current level and trend",
    "smallCapValuation": "stretched/fair/cheap + PE",
    "globalMacro": "key risk or opportunity in 1 sentence",
    "eurInr": "current rate",
    "bestTimeToActNow": "yes/no + reason in 1 sentence"
  },
  "advice": [
    {
      "name": "position name",
      "ticker": "ticker",
      "verdict": "BUY|HOLD|TRIM|SELL",
      "currentPrice": 0.0,
      "currentValue": "€X",
      "growth": "+X%",
      "action": "Specific action: e.g. Buy 20 shares at ₹780 or below | Trim 43 shares, keep 43 | Sell all 5 shares | Hold until ₹900 or 12 months",
      "reason": "1-2 sentences grounded in current market data from your search",
      "goalAlignment": "HOME_FUND|RETIREMENT|CLEANUP|REBALANCE",
      "taxNote": "1 sentence on tax impact",
      "urgency": "This week|This month|Next quarter|No rush",
      "holdUntil": "only for HOLD verdict — specific condition or date"
    }
  ],
  "goalSummary": {
    "retirementOnTrack": true,
    "homeCorpusOnTrack": true,
    "projectedCorpusAtRetirement": "€X if current plan maintained",
    "biggestRisk": "1 sentence",
    "topPriorityAction": "The single most important thing to do this week"
  },
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
        tools: [{
          type: "web_search_20250305",
          name: "web_search"
        }],
        messages: [{ role:"user", content:userPrompt }]
      })
    })

    const rawText = await r.text()
    if(!r.ok) return res.status(500).json({
      error: `Anthropic API error (HTTP ${r.status})`,
      detail: rawText.slice(0,500)
    })

    let data
    try { data = JSON.parse(rawText) }
    catch(e) { return res.status(500).json({ error:"Failed to parse Anthropic response" }) }

    if(data.error) return res.status(500).json({ error: data.error.message || "API error" })

    /* Extract final text block (after tool use) */
    const text = (data.content||[])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n").trim()

    if(!text) return res.status(500).json({ error:"Empty response", stop_reason: data.stop_reason })

    /* Extract outermost JSON object */
    const start = text.indexOf("{")
    if(start === -1) return res.status(500).json({ error:"No JSON in response", raw:text.slice(0,400) })

    let depth=0, end=-1
    for(let i=start; i<text.length; i++){
      if(text[i]==="{")        depth++
      else if(text[i]==="}"){ depth--; if(depth===0){ end=i; break } }
    }
    if(end===-1) return res.status(500).json({ error:"JSON truncated", stop_reason:data.stop_reason })

    let result
    try { result = JSON.parse(text.slice(start, end+1)) }
    catch(e) { return res.status(500).json({ error:"Parse failed: "+e.message, raw:text.slice(start,start+500) }) }

    return res.status(200).json(result)

  } catch(e) {
    return res.status(500).json({ error:"Handler error: "+e.message })
  }
}
