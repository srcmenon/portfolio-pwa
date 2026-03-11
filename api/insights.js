export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({error:"POST only"})

  const { portfolio, totalValue, totalReturn } = req.body || {}
  if(!portfolio || !portfolio.length) return res.status(400).json({error:"Portfolio required"})

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({error:"ANTHROPIC_API_KEY not set"})

  const snap = portfolio.map(p =>
    `${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR.toFixed(0)}, current €${p.totalCurrentEUR.toFixed(0)}, return ${p.growth.toFixed(1)}%, P/L €${p.profitEUR.toFixed(0)}`
  ).join("\n")

  const topHoldings = [...portfolio]
    .sort((a,b) => b.totalCurrentEUR - a.totalCurrentEUR)
    .slice(0, 10)
    .map(p => p.name)
    .join(", ")

  /* ── STEP 1: Web search to gather live market data ── */
  const searchPrompt = `Search the web thoroughly and gather the following live market data. Be exhaustive and precise. Return ALL data you find in structured form.

PORTFOLIO CONTEXT:
Total Value: €${(totalValue||0).toFixed(0)}, Return: ${(totalReturn||0).toFixed(2)}%
Top holdings: ${topHoldings}

SEARCH FOR ALL OF THE FOLLOWING:

1. TECHNICAL INDICATORS (search for each):
- Nifty 50 current level, 50-day MA, 200-day MA, RSI, MACD signal
- Sensex current level and trend
- S&P 500 current level, 50-day MA, 200-day MA, RSI
- DAX (Germany) current level and momentum
- VIX (fear index) current reading

2. FUNDAMENTAL DATA for these specific stocks in the portfolio:
${portfolio.filter(p=>p.type==="Stock"||p.type==="ETF").slice(0,8).map(p=>p.name).join(", ")}
For each: P/E ratio, EPS (TTM), EPS growth, PEG ratio, D/E ratio, 52-week high/low

3. MACRO & COMMODITIES:
- Gold spot price (USD/oz) and trend (50-day, 200-day MA)
- Silver spot price and trend
- Brent crude oil price and OPEC outlook
- EUR/INR and USD/INR current rates and 30-day trend
- EUR/USD current rate
- US 10-year Treasury yield
- India 10-year bond yield
- RBI and ECB latest interest rate decisions

4. GEOPOLITICAL & MARKET NEWS:
- Top 3 geopolitical risks affecting Indian markets right now
- Top 3 factors affecting European/German markets
- Any major earnings surprises from holdings in the portfolio
- FII/DII flows in Indian markets (last week)
- Any upcoming key events (Fed meetings, RBI policy, elections, earnings)

5. SECTOR TRENDS:
- Indian small cap / mid cap fund flows and valuations (are they expensive or cheap?)
- Global semiconductor sector outlook
- Indian PSU sector outlook (relevant given PSU holdings)
- Defense sector outlook (global and India)
- Gold ETF vs physical gold demand trends`

  let marketData = ""

  try {
    const searchRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 6000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: searchPrompt }]
      })
    })

    if(searchRes.ok){
      const searchData = await searchRes.json()
      marketData = (searchData.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n\n")
    } else {
      const errText = await searchRes.text()
      console.error("Search step failed:", errText)
      marketData = "Live market data unavailable — proceed with general knowledge."
    }
  } catch(e) {
    console.error("Search step error:", e)
    marketData = "Live market data unavailable — proceed with general knowledge."
  }

  /* ── STEP 2: Deep thinking analysis on gathered data ── */
  const analysisSystemPrompt = `You are a senior portfolio manager and CFA-level investment analyst with deep expertise in:
- Fundamental analysis: DCF, P/E, PEG, EV/EBITDA, Piotroski F-Score, Altman Z-Score, D/E, ROE, ROCE, EPS growth
- Technical analysis: Moving averages (50/200-day), RSI, MACD, Bollinger Bands, support/resistance levels, volume analysis, trend strength
- Global macro: Interest rate cycles, currency flows, commodity super-cycles, geopolitical risk premiums
- Indian markets: SEBI regulations, FII/DII dynamics, Indian mutual fund categories, AMFI data
- European/German markets: ECB policy, Vorabpauschale ETF taxation, German Abgeltungsteuer

The user is a German tax resident with Indian equity exposure.
Tax rules to always factor in:
- Germany: Abgeltungsteuer 26.375% on gains/dividends. ETF Vorabpauschale applies annually.
- India: LTCG equity >1yr: 12.5% above ₹1.25 lakh exemption. STCG <1yr: 20%. Dividends taxed at income slab.
- Strategy implication: Prefer long-term holds in India to benefit from LTCG. In Germany, avoid unnecessary churn. Consider tax-loss harvesting on loss positions.

Deliver DEEP, SPECIFIC, ACTIONABLE analysis. Never give vague advice. Always cite specific numbers, ratios, and levels. Think through multiple scenarios before concluding.`

  const analysisPrompt = `LIVE MARKET DATA GATHERED:
${marketData}

FULL PORTFOLIO:
Total Value: €${(totalValue||0).toFixed(0)}
Total Return: ${(totalReturn||0).toFixed(2)}%

${snap}

Using the live market data above AND your deep expertise in fundamental and technical analysis, provide a comprehensive investment analysis with these exact sections:

## 1. DAILY INVESTMENT SUGGESTION (€1,000)

Use fundamentals + technicals + macro to identify the single best opportunity:
- State the specific asset (name + ticker)
- Fundamental case: P/E vs sector average, EPS growth trajectory, PEG ratio, D/E, ROE
- Technical case: Current price vs 50/200-day MA, RSI reading, MACD signal, key support level
- Macro tailwind/headwind
- Entry rationale and target price range (1-3 year horizon)
- Risk factors (max 3)
- German tax angle: Abgeltungsteuer impact on net return

## 2. PORTFOLIO RESTRUCTURING

**SELL CANDIDATES (up to 2):**
For each: specific reason (broken technicals? overvalued on P/E? better alternative?), estimated Indian/German tax cost of selling, and what to do with proceeds.

**BUY / INCREASE CANDIDATES (up to 2):**
For each: why now (undervalued on which metric?), how it improves portfolio balance.

**STRUCTURAL IMBALANCE:**
Identify the single biggest structural risk in this portfolio (concentration, currency, sector) and precise steps to fix it.

## 3. TECHNICAL PICTURE — KEY HOLDINGS

For the top 5 holdings by value, provide:
- Current price vs 50-day MA and 200-day MA (above/below, % gap)
- RSI level (overbought >70, oversold <30)
- MACD signal (bullish/bearish crossover?)
- Key support and resistance levels
- Overall technical verdict: Uptrend / Downtrend / Consolidating

## 4. MARKET TRENDS & PORTFOLIO IMPACT

For each macro factor, state: current reading → direction → specific impact on this portfolio → action:
- **Gold & Silver:** price level, trend, impact on gold ETF holdings
- **Oil/Fuel:** Brent level, direction, impact on energy/PSU holdings (ONGC, OIL, COALINDIA, NLCINDIA)
- **INR/EUR rate:** current level, trend, impact on EUR-denominated returns from Indian holdings
- **Interest rates:** RBI + ECB stance, impact on rate-sensitive holdings (LICHSGFIN, PFC, RECLTD)
- **Geopolitical risks:** specific risks ranked by impact on this portfolio
- **Indian small/mid cap valuations:** expensive or cheap? Should allocation increase or decrease?

Be ruthlessly specific. Cite actual numbers from the market data. No vague statements.`

  try {
    const analysisRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 10000 },
        system: analysisSystemPrompt,
        messages: [{ role: "user", content: analysisPrompt }]
      })
    })

    if(!analysisRes.ok){
      const err = await analysisRes.text()
      console.error("Analysis step failed:", err)
      return res.status(500).json({error:"Analysis step failed", detail: err})
    }

    const analysisData = await analysisRes.json()

    const text = (analysisData.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n\n")

    if(!text){
      return res.status(500).json({error:"Empty analysis response", raw: JSON.stringify(analysisData.content?.map(b=>b.type))})
    }

    return res.status(200).json({ analysis: text, marketDataSnapshot: marketData.slice(0, 500) + "..." })

  } catch(e) {
    console.error("Analysis error:", e)
    return res.status(500).json({error:"Analysis failed", detail: e.message})
  }
}
