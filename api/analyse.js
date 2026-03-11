export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({error:"POST only"})

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({error:"ANTHROPIC_API_KEY not set"})

  const { portfolio, totalValue, totalReturn, marketData } = req.body || {}
  if(!portfolio || !marketData) return res.status(400).json({error:"Portfolio and marketData required"})

  const snap = portfolio.map(p =>
    `${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR.toFixed(0)}, current €${p.totalCurrentEUR.toFixed(0)}, return ${p.growth.toFixed(1)}%, P/L €${p.profitEUR.toFixed(0)}`
  ).join("\n")

  const systemPrompt = `You are a senior CFA-level portfolio manager and investment analyst. You specialise in:
- Fundamental analysis: P/E, forward P/E, PEG, EV/EBITDA, Piotroski F-Score, D/E, ROE, ROCE, EPS growth, DCF
- Technical analysis: 50/200-day moving averages, RSI, MACD, Bollinger Bands, support/resistance, volume trends
- Global macro: interest rate cycles, currency flows, commodity cycles, geopolitical risk
- Indian markets: Nifty/Sensex dynamics, SEBI rules, FII/DII flows, mutual fund categories
- European markets: ECB policy, DAX dynamics, German investment taxation

The user is a GERMAN TAX RESIDENT with Indian equity exposure. Always factor in:
- Germany: Abgeltungsteuer 26.375% flat tax on capital gains and dividends. ETF Vorabpauschale applies each Jan.
- India: LTCG on equity >1yr = 12.5% above ₹1.25 lakh/year exemption. STCG <1yr = 20%. Dividends taxed at income slab rate.
- Key implication: In India, hold equity >1 year to qualify for LTCG. Use the ₹1.25 lakh annual exemption strategically. In Germany, avoid unnecessary churn — each sale triggers 26.375% tax. Consider tax-loss harvesting on German-held loss positions before year end.

Be specific, cite exact numbers, and think deeply before concluding. No vague advice.`

  const analysisPrompt = `LIVE MARKET DATA:
${marketData}

PORTFOLIO SNAPSHOT:
Total Value: €${(totalValue||0).toFixed(0)}
Total Return: ${(totalReturn||0).toFixed(2)}%

FULL HOLDINGS:
${snap}

Using the market data above, perform a deep multi-factor analysis and produce the following:

## 1. DAILY INVESTMENT SUGGESTION (€1,000)

Think through: Which asset class is most favourable right now given macro conditions? Which specific instrument offers the best risk-adjusted return over 1-3 years?

Provide:
- **Asset:** Name + ticker
- **Fundamental case:** P/E vs sector average, EPS growth rate, PEG ratio, D/E ratio, ROE — is it cheap or expensive on these metrics?
- **Technical case:** Price vs 50-day MA and 200-day MA (above/below by how much?), RSI level (overbought/oversold?), MACD signal (bullish/bearish crossover?), key support level to watch
- **Macro tailwind:** What macro factor specifically helps this asset right now?
- **Target:** Entry range, 12-month target, 3-year target
- **Risks:** Top 3 specific risks
- **Tax note:** Net return after Abgeltungsteuer if held 3 years, or Indian LTCG if applicable

## 2. PORTFOLIO RESTRUCTURING

**SELL — Up to 2 candidates:**
For each:
- Name + reason (cite the specific metric: P/E too high vs peers? RSI overbought? Broken 200-day MA? Thesis changed?)
- Approximate tax cost: Indian STCG or LTCG? German Abgeltungsteuer? Is it worth selling despite tax?
- What to do with proceeds

**BUY MORE / REPLACE — Up to 2 candidates:**
For each:
- Name + why now (undervalued on which metric? Technical setup?)
- How it improves portfolio: reduces concentration risk? adds a missing sector? better quality?

**STRUCTURAL IMBALANCE:**
What is the single biggest structural risk in this portfolio right now? (e.g. INR concentration, small-cap overweight, sector clustering) — and exact steps to fix it

## 3. TECHNICAL PICTURE — TOP 5 HOLDINGS BY VALUE

For each of the top 5 holdings by current EUR value:
| Holding | vs 50-day MA | vs 200-day MA | RSI | MACD | Support | Resistance | Verdict |
Format as a readable list, not a table. Be specific with numbers.

## 4. MARKET TRENDS & PORTFOLIO IMPACT

**Gold & Silver:** Current price → trend → impact on gold ETF holdings in this portfolio → action
**Oil & Energy:** Brent price → direction → impact on ONGC/OIL/COALINDIA → action  
**INR/EUR Rate:** Current rate → trend → impact on EUR value of Indian holdings → hedge or not?
**Interest Rates (RBI + ECB):** Current stance → impact on LICHSGFIN/PFC/RECLTD/banking stocks → action
**FII/DII Flows:** Net direction → what it signals for Indian market near term
**Indian Small/Mid Cap Valuations:** P/E vs historical average → overvalued or cheap? → increase or reduce allocation?
**Key Geopolitical Risks:** Top 2 specific risks ranked by impact on THIS portfolio specifically`

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 12000,
        thinking: { type: "enabled", budget_tokens: 8000 },
        system: systemPrompt,
        messages: [{ role: "user", content: analysisPrompt }]
      })
    })

    if(!r.ok){
      const err = await r.text()
      console.error("analyse failed:", err)
      return res.status(500).json({error:"Analysis failed", detail: err})
    }

    const data = await r.json()
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n\n")

    if(!text) return res.status(500).json({error:"Empty analysis response"})

    return res.status(200).json({ analysis: text })

  } catch(e) {
    console.error("analyse error:", e)
    return res.status(500).json({error:"Analysis error", detail: e.message})
  }
}
