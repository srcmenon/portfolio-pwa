/* ============================================================
   CapIntel — api/analyse.js   (Vercel Serverless Function)
   Step 2 of 2 in the AI Market Intelligence flow.

   Receives live market data (from market-search.js) + full portfolio
   snapshot and produces a structured investment analysis.

   IMPORTANT PROMPT DESIGN PRINCIPLES:
   - Never force a sell recommendation. Sell only if thesis is broken,
     not because price is temporarily down.
   - Temporary drawdowns in quality compounders (GE Aerospace, ISRG,
     TSM, AMZN etc.) are opportunities to add, not exit signals.
   - All advice must be anchored to the investor's actual goals:
     5-6yr India home purchase, retire by 50, long-term accumulation.
   - Tax cost of selling (26.375% Germany) must be factored in —
     selling a winner is expensive and needs a strong replacement thesis.
   ============================================================ */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST")    return res.status(405).json({ error:"POST only" })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({ error:"ANTHROPIC_API_KEY not set" })

  const { portfolio, totalValue, totalReturn, marketData } = req.body || {}
  if(!portfolio || !marketData) return res.status(400).json({ error:"Portfolio and marketData required" })

  /* Send top 15 holdings (by EUR value) for richer context */
  const snap = portfolio
    .sort((a, b) => b.totalCurrentEUR - a.totalCurrentEUR)
    .slice(0, 15)
    .map(p =>
      `${p.name} (${p.type}, ${p.currency}): ` +
      `invested €${p.totalBuyEUR.toFixed(0)}, ` +
      `current €${p.totalCurrentEUR.toFixed(0)}, ` +
      `${p.growth >= 0 ? "+" : ""}${p.growth.toFixed(1)}%, ` +
      `P/L €${p.profitEUR.toFixed(0)}`
    ).join("\n")

  const prompt = `You are a CFA-level portfolio analyst advising a long-term investor.

INVESTOR PROFILE:
- Age 36, German tax resident, plans to move back to India at age 41-42.
- Goal 1: Buy a home in India in 5-6 years.
- Goal 2: Retire at age 50 on passive income.
- Philosophy: Long-term wealth accumulation, NOT trading. Patient compounder.
- Risk: Moderate-high. Comfortable holding through 6-12 month drawdowns.

TAX RULES (critical — factor into every sell/trim suggestion):
- Germany Abgeltungsteuer: 26.375% flat on ALL realised gains. No holding-period exemption.
  Selling a winner is expensive. A sell suggestion must overcome this cost.
- India LTCG (>1yr): 12.5% tax, first ₹1.25L/year exempt. STCG (<1yr): 20%.

CURRENT MARKET DATA:
${marketData}

PORTFOLIO TOP HOLDINGS (€${(totalValue||0).toFixed(0)} total, ${(totalReturn||0).toFixed(2)}% total return):
${snap}

ANALYSIS INSTRUCTIONS — read carefully before writing:

1. SELL ONLY IF THESIS IS BROKEN. A position being temporarily down is NOT a sell signal
   for a long-term investor — it may be a buy opportunity. Only recommend selling if:
   (a) the underlying business has structurally deteriorated, OR
   (b) the position is so small (<€100) it cannot meaningfully impact the portfolio.
   Never manufacture a sell just to appear balanced.

2. QUALITY COMPOUNDERS — treat with patience. Positions like GE Aerospace (aviation
   supercycle), Intuitive Surgical (surgical robotics monopoly), Taiwan Semiconductor
   (AI chip foundry), Amazon, Alphabet — these are world-class businesses with 5-10yr
   tailwinds. A 15-20% drawdown in these is normal. Do not suggest selling them unless
   the long-term thesis has changed.

3. INVEST €1,000: Recommend where to deploy fresh capital TODAY based on current
   valuations and market data. Consider the investor's EUR base and India home goal.

4. STRUCTURAL FIXES: Look at concentration, currency exposure (lives in EUR for 5-6
   more years), and whether the portfolio is positioned for the stated goals.

5. INDIA HOME GOAL: In 5-6 years the investor needs INR liquidity. Comment on whether
   the India holdings (MFs + stocks) are appropriately positioned for this timeline.

Provide your analysis in these sections:

## 1. WHERE TO INVEST €1,000 NOW
Best single opportunity given current market data. Name the asset, explain valuation
rationale, state a 2-3yr expected outcome, and give the tax note.

## 2. PORTFOLIO ACTIONS
**Add to / Buy:** 1-2 positions worth increasing, with specific reasoning from market data.
**Trim (if warranted):** Only if a position is genuinely oversized OR thesis has changed.
  If nothing needs trimming, say "No trims needed — hold positions and let compounders run."
**Structural fix:** One concrete structural change that aligns the portfolio better with
  the 5-6yr India home goal or the retire-by-50 objective.

## 3. MARKET CONDITIONS FOR YOUR PORTFOLIO
Using the live market data, give a 1-line verdict on each:
- India equities: bullish / cautious / neutral + why
- Global tech: bullish / cautious / neutral + why
- EUR/INR outlook: implication for repatriating gains
- Key risk to watch in next 3 months

## 4. INDIA HOME GOAL CHECK
Are the India MF and stock holdings on track to contribute meaningfully to a home
purchase in 5-6 years? What should the investor do (or not do) right now regarding
these Indian holdings?

Be specific with numbers. Max 700 words. No generic advice — everything must reference
the live market data or specific holdings named above.`

  try{
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",  /* upgraded from sonnet-4-5 for better reasoning */
        max_tokens: 3000,                 /* raised — 700 words + structure needs room */
        messages:   [{ role:"user", content:prompt }]
      })
    })

    const raw = await r.text()
    if(!r.ok) return res.status(500).json({ error:"Analysis API error", detail:raw.slice(0,300) })

    const data = JSON.parse(raw)
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")

    if(!text) return res.status(500).json({ error:"Empty response" })
    return res.status(200).json({ analysis: text })

  }catch(e){
    return res.status(500).json({ error:"Analysis error", detail:e.message })
  }
}
