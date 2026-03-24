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

  const { portfolio, goals, techMap: clientTechMap } = req.body || {}
  if (!portfolio?.length) return res.status(400).json({ error: "portfolio required" })
  if (!goals)             return res.status(400).json({ error: "goals required" })

  const model    = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"
  const totalEUR = portfolio.reduce((s, p) => s + (p.totalCurrentEUR || 0), 0)
  const totalBuy = portfolio.reduce((s, p) => s + (p.totalBuyEUR || 0), 0)

  /* Use pre-computed technicals from client (window._techMap) if available.
     This avoids duplicate Yahoo Finance fetching — the free technicals engine
     already computed RSI/MACD/BB/ADX for all positions. Fall back to
     lightweight fetch only for positions missing from client map. */
  const techMap = {}

  if (clientTechMap && Object.keys(clientTechMap).length > 0) {
    /* Client already computed full technicals — use them directly */
    Object.entries(clientTechMap).forEach(([key, t]) => {
      if (!t) return
      techMap[key] = {
        rsi14:         t.rsi     !== null ? t.rsi     : "N/A",
        trend:         t.sma200  ? (t.currentPrice > t.sma200 ? "ABOVE_200DMA" : "BELOW_200DMA") : (t.trend || "UNKNOWN"),
        vsS50:         t.sma50   ? ((t.currentPrice - t.sma50)  / t.sma50  * 100).toFixed(1) + "%" : "N/A",
        vsS200:        t.sma200  ? ((t.currentPrice - t.sma200) / t.sma200 * 100).toFixed(1) + "%" : "N/A",
        pctFrom52High: t.pctFrom52High !== null ? t.pctFrom52High.toFixed(1) + "%" : "N/A",
        pctFrom52Low:  t.pctFrom52Low  !== null ? t.pctFrom52Low.toFixed(1)  + "%" : "N/A",
        momentum6m:    t.mom6m   !== null ? t.mom6m.toFixed(1)  + "%" : "N/A",
        momentum1y:    t.mom1y   !== null ? t.mom1y.toFixed(1)  + "%" : "N/A",
        macd:          t.macd    ? (t.macd.bullish ? "bullish" : "bearish") : "N/A",
        bb:            t.bb      ? `${t.bb.pct.toFixed(0)}% BB position` : "N/A",
        adx:           t.adx     ? `ADX ${t.adx.adx} (${t.adx.trending?"trending":"sideways"})` : "N/A",
        score:         t.score   ?? null,
        signals:       (t.signals||[]).join(", ") || "N/A"
      }
    })
  } else {
    /* Fallback: fetch lightweight technicals for top 30 only */
    const targets = portfolio
      .filter(p => p.type !== "MutualFund" && resolveYahooTicker(p))
      .sort((a, b) => (b.totalCurrentEUR || 0) - (a.totalCurrentEUR || 0))
      .slice(0, 30)

    await Promise.all(targets.map(async pos => {
      const symbol = resolveYahooTicker(pos)
      const closes = await fetchHistory(symbol)
      if (!closes || closes.length < 20) return
      const cur    = pos.currentPrice || closes[closes.length - 1]
      const high52 = Math.max(...closes)
      const low52  = Math.min(...closes)
      const sma50  = calcSMA(closes, 50)
      const sma200 = calcSMA(closes, 200)
      const rsi    = calcRSI(closes)
      const mom6m  = closes.length > 126 ? ((closes[closes.length-1]-closes[closes.length-127])/closes[closes.length-127]*100) : null
      const mom1y  = closes.length > 1   ? ((closes[closes.length-1]-closes[0])/closes[0]*100) : null
      techMap[pos.key] = {
        rsi14:         rsi !== null ? rsi : "N/A",
        trend:         sma200 ? (cur > sma200 ? "ABOVE_200DMA" : "BELOW_200DMA") : "UNKNOWN",
        vsS50:         sma50  ? ((cur-sma50)/sma50*100).toFixed(1)+"%" : "N/A",
        vsS200:        sma200 ? ((cur-sma200)/sma200*100).toFixed(1)+"%" : "N/A",
        pctFrom52High: ((cur-high52)/high52*100).toFixed(1)+"%",
        pctFrom52Low:  ((cur-low52)/low52*100).toFixed(1)+"%",
        momentum6m:    mom6m  !== null ? mom6m.toFixed(1)+"%" : "N/A",
        momentum1y:    mom1y  !== null ? mom1y.toFixed(1)+"%" : "N/A",
        macd: "N/A", bb: "N/A", adx: "N/A", score: null, signals: "N/A"
      }
    }))
  }

  /* Build prompt lines — top 30 by EUR value to stay within token budget */
  const topPositions = portfolio
    .sort((a, b) => (b.totalCurrentEUR || 0) - (a.totalCurrentEUR || 0))
    .slice(0, 30)

  const positionLines = topPositions
    .map(pos => {
      const wt   = totalEUR > 0 ? ((pos.totalCurrentEUR || 0) / totalEUR * 100).toFixed(1) : "0"
      const sign = (pos.growth || 0) >= 0 ? "+" : ""
      const t    = techMap[pos.key]
      const techStr = t
        ? [
            `RSI=${t.rsi14}`,
            `trend=${t.trend}`,
            `vs50=${t.vsS50}`,
            `vs200=${t.vsS200}`,
            `52wkH=${t.pctFrom52High}`,
            `mom6m=${t.momentum6m}`,
            `MACD=${t.macd}`,
            `BB=${t.bb}`,
            `${t.adx}`,
            t.score !== null ? `score=${t.score}/100` : "",
            t.signals && t.signals !== "N/A" ? `signals:[${t.signals}]` : ""
          ].filter(Boolean).join(", ")
        : `type=${pos.type} (NAV-based)`
      return `${pos.name} | ${pos.key} | €${(pos.totalCurrentEUR||0).toFixed(0)} | wt=${wt}% | ${sign}${(pos.growth||0).toFixed(1)}% | PL=€${(pos.profitEUR||0).toFixed(0)} | qty=${pos.qty||0} | ${techStr}`
    })
    .join("\n")

  /* Noise positions (under €100) — summarised, not individually listed */
  const noisePositions = portfolio
    .filter(p => (p.totalCurrentEUR||0) < 100 && p.type !== "MutualFund")
  const noiseLine = noisePositions.length
    ? `\nNOISE POSITIONS (${noisePositions.length} positions under €100, combined €${noisePositions.reduce((s,p)=>s+(p.totalCurrentEUR||0),0).toFixed(0)}): ${noisePositions.map(p=>p.key).join(", ")} — verdict SELL ALL, reason: too small to impact portfolio, sell and consolidate.`
    : ""

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
This investor wants to know: What to DO, exactly, TODAY — to grow this portfolio to €${(goals.corpus||270000).toLocaleString()} by age ${goals.retireAge}
and accumulate ₹${goals.homeBudget} lakhs for a home by ${goals.homeYear}.

TOP ${topPositions.length} POSITIONS BY VALUE WITH REAL TECHNICALS:
(Name | Ticker | EUR Value | Weight | Growth | P&L | Qty | RSI14 | Trend | vs50DMA | vs200DMA | 52wkHigh% | 52wkLow% | 6M momentum | 1Y momentum)
${positionLines}
${noiseLine}

TECHNICAL DECISION RULES — apply strictly:
RSI < 35 + ABOVE_200DMA = STRONG BUY
RSI 35-50 + ABOVE_200DMA = BUY on dips
RSI 50-65 + ABOVE_200DMA = HOLD, let it run
RSI 65-75 + near 52wk high = TRIM 30-50%
RSI > 75 OR BELOW_200DMA + broken thesis = SELL
Weight > 6% non-ETF = TRIM to 3-4%
EUR value < €100 = SELL (noise)

REQUIRED: Generate advice for all top ${topPositions.length} positions + a bulk SELL verdict for the ${noisePositions.length} noise positions.
For TRIM: state exact share count AND where to redeploy proceeds.
For BUY: state entry price and amount.
For HOLD: state specific numeric trigger to reassess.
For SELL: state where to redeploy.

Also suggest 4-5 NEW OPPORTUNITIES missing from portfolio relative to goals.

Return ONLY this JSON (keep each field concise — max 2 sentences per field):
{
  "portfolioHealth": {
    "indiaWeight": "X%",
    "globalWeight": "X%",
    "commodityWeight": "X%",
    "biggestConcentration": "name at X%",
    "rebalanceUrgency": "Critical|High|Normal",
    "summary": "2 sentences max"
  },
  "marketSummary": "2 sentences: aggregate RSI signal and key action this week",
  "advice": [
    {
      "ticker": "TICKER",
      "name": "Name",
      "verdict": "BUY|HOLD|TRIM|SELL",
      "currentPrice": "₹X or €X",
      "weight": "X.X%",
      "growth": "+X%",
      "rsi": 45,
      "trend": "ABOVE_200DMA|BELOW_200DMA|UNKNOWN",
      "action": "Precise 1-sentence instruction with exact qty/price/amount",
      "reason": "1-2 sentences: technical basis (cite RSI/DMA numbers) + which goal",
      "redeploy": "Where proceeds go if SELL/TRIM, else N/A",
      "goalAlignment": "HOME_FUND|RETIREMENT|CLEANUP|REBALANCE",
      "taxNote": "1 sentence specific tax implication",
      "urgency": "This week|This month|Next quarter|No rush"
    }
  ],
  "newOpportunities": [
    {
      "name": "Full name",
      "ticker": "TICKER.EXCHANGE",
      "exchange": "NSE|LSE|XETRA|NYSE",
      "suggestedAmount": "€X/month SIP or €X lump sum",
      "reason": "2 sentences: gap it fills + goal",
      "goalAlignment": "HOME_FUND|RETIREMENT|REBALANCE",
      "urgency": "Start now|Start this month|Next quarter"
    }
  ],
  "generatedAt": "${new Date().toISOString()}"
}`

  /* ── TWO-MODEL PIPELINE (cost optimisation) ──────────────────
     Stage 1 (Haiku — cheap): Summarise ALL positions into compact flags
     Stage 2 (Sonnet — quality): Strategic advice using Stage 1 summary
     This cuts cost ~65% vs sending full data directly to Sonnet */

  const callAnthropic = async (model, system, user, maxTokens) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: { "Content-Type":"application/json", "x-api-key":apiKey, "anthropic-version":"2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role:"user", content:user }] })
    })
    const raw = await r.text()
    if (!r.ok) throw new Error(`API ${r.status}: ${raw.slice(0,200)}`)
    const d = JSON.parse(raw)
    if (d.error) throw new Error(d.error.message)
    return (d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").trim()
  }

  const extractJSON = (text, bracket="{") => {
    const close = bracket === "{" ? "}" : "]"
    const start = text.indexOf(bracket)
    if (start === -1) throw new Error("No JSON found")
    let depth = 0, end = -1
    for (let i = start; i < text.length; i++) {
      if (text[i] === bracket) depth++
      else if (text[i] === close) { depth--; if (depth === 0) { end = i; break } }
    }
    if (end === -1) throw new Error("JSON truncated")
    return JSON.parse(text.slice(start, end + 1))
  }

  try {
    /* ── STAGE 1: Haiku pre-processes ALL positions cheaply ── */
    const haiku = "claude-haiku-4-5-20251001"
    const allLines = portfolio
      .sort((a,b)=>(b.totalCurrentEUR||0)-(a.totalCurrentEUR||0))
      .map(pos => {
        const wt = totalEUR>0?((pos.totalCurrentEUR||0)/totalEUR*100).toFixed(1):"0"
        const t  = techMap[pos.key]
        const tech = t ? `RSI=${t.rsi14},${t.trend},vs200=${t.vsS200},52wkH=${t.pctFrom52High},mom6m=${t.momentum6m}` : `type=${pos.type},NAV`
        return `${pos.key}|€${(pos.totalCurrentEUR||0).toFixed(0)}|wt=${wt}%|${(pos.growth||0).toFixed(1)}%|qty=${pos.qty||0}|${tech}`
      }).join("\n")

    const haiku_summary = await callAnthropic(haiku,
      "You are a portfolio screener. Output ONLY a JSON array. No text outside JSON.",
      `Scan these ${portfolio.length} positions and classify each.
Rules: RSI<35+ABOVE_200DMA=BUY, RSI35-50+ABOVE=BUY_DIP, RSI50-65+ABOVE=HOLD, RSI65-75+near52wkHigh=TRIM, RSI>75 OR BELOW_200DMA=SELL, EUR<100=SELL_NOISE, wt>6%nonETF=TRIM_HEAVY
${allLines}
Return JSON array: [{"ticker":"X","flag":"BUY|BUY_DIP|HOLD|TRIM|TRIM_HEAVY|SELL|SELL_NOISE","rsi":45,"trend":"ABOVE_200DMA","weight":"X%","growth":"+X%","eurValue":"€X"}]`,
      4096
    )

    let flags
    try { flags = extractJSON(haiku_summary, "[") }
    catch(e) { flags = [] }

    /* Build compact summary for Sonnet — only actionable positions in full */
    const actionable = flags.filter(f => f.flag !== "HOLD") // Sonnet focuses on non-holds
    const holds = flags.filter(f => f.flag === "HOLD")
    const sellNoise = flags.filter(f => f.flag === "SELL_NOISE")

    const sonnetLines = actionable.map(f => {
      const pos = portfolio.find(p => p.key === f.ticker) || {}
      const t   = techMap[f.ticker]
      return `${f.ticker}|${pos.name||f.ticker}|${f.eurValue}|wt=${f.weight}|${f.growth}|qty=${pos.qty||0}|RSI=${f.rsi}|${f.trend}|vs50=${t?.vsS50||"N/A"}|vs200=${t?.vsS200||"N/A"}|52wkH=${t?.pctFrom52High||"N/A"}|mom6m=${t?.momentum6m||"N/A"}|FLAG=${f.flag}`
    }).join("\n")

    const holdSummary = holds.length
      ? `\nHOLD positions (${holds.length}, no immediate action needed): ${holds.map(f=>`${f.ticker}(${f.weight},RSI=${f.rsi})`).join(", ")}`
      : ""

    /* ── STAGE 2: Sonnet strategic advice on actionable positions only ── */
    const text2 = await callAnthropic(model, systemPrompt,
      userPrompt.replace(
        `TOP ${topPositions.length} POSITIONS BY VALUE WITH REAL TECHNICALS:\n(Name | Ticker | EUR Value | Weight | Growth | P&L | Qty | RSI14 | Trend | vs50DMA | vs200DMA | 52wkHigh% | 52wkLow% | 6M momentum | 1Y momentum)\n${positionLines}\n${noiseLine}`,
        `PRE-SCREENED ACTIONABLE POSITIONS (${actionable.length} positions requiring action):
${sonnetLines}
${holdSummary}
BULK SELL NOISE (${sellNoise.length} positions under €100, combined ≈€${sellNoise.reduce((s,f)=>{const p=portfolio.find(x=>x.key===f.ticker);return s+(p?.totalCurrentEUR||0)},0).toFixed(0)}): ${sellNoise.map(f=>f.ticker).join(", ")} — verdict SELL ALL, redeploy to IWDA or HDFCBANK.`
      ),
      6144
    )

    const result = extractJSON(text2, "{")
    return res.status(200).json(result)

  } catch (e) {
    return res.status(500).json({ error: "Handler error: " + e.message })
  }
}
