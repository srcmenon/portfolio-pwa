export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({error:"POST only"})

  const { portfolio, totalValue, totalReturn } = req.body || {}
  if(!portfolio || !portfolio.length) return res.status(400).json({error:"Portfolio required"})

  /* Build a concise portfolio snapshot for the prompt */
  const snap = portfolio.map(p =>
    `${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR.toFixed(0)}, current €${p.totalCurrentEUR.toFixed(0)}, return ${p.growth.toFixed(1)}%`
  ).join("\n")

  const systemPrompt = `You are a professional investment analyst and portfolio advisor.
The user is a German tax resident who also holds Indian mutual funds and stocks subject to Indian capital gains tax.
Key tax context:
- Germany: Dividends and capital gains are subject to Abgeltungsteuer (25% + solidarity surcharge ~26.375% total). ETFs under the German Vorabpauschale regime have special treatment.
- India: Equity mutual funds and stocks held >1 year: LTCG 12.5% on gains above ₹1.25 lakh. Short term (<1 year): STCG 20%. Dividends in India are taxed as per the individual's slab rate.
- Practical advice: Factor in taxes when computing real net gains. Avoid churning positions unless the net gain after tax justifies it.

Always give concrete, actionable, specific advice — not generic platitudes. Use real ticker names, fund names, and specific reasoning based on current market data you will search for.
Structure your response in clean sections with clear headers.
Be direct and honest — if a position looks weak, say so.`

  const userPrompt = `Here is my current portfolio (all values in EUR equivalent):
Total Portfolio Value: €${(totalValue||0).toFixed(0)}
Total Return: ${(totalReturn||0).toFixed(2)}%

Holdings:
${snap}

Please provide a deep analysis with THREE sections:

## 1. DAILY INVESTMENT SUGGESTION (€1,000)
Search for current market conditions, valuations, and trends.
Suggest the single best use of €1,000 right now from these options:
- A specific stock (with P/E ratio, recent momentum, catalyst)
- A specific ETF (with rationale and current market tailwinds)
- Adding to an existing position in my portfolio (if it's undervalued)
- Holding cash (if market conditions are unfavourable)
Include: specific ticker, entry rationale, target horizon (1-3 years), tax implications for a German resident.

## 2. PORTFOLIO RESTRUCTURING
Scan my portfolio and identify:
a) UP TO 2 positions to SELL — explain why (overvalued, broken thesis, better alternatives), rough tax cost of selling
b) UP TO 2 positions to BUY MORE or REPLACE with — specific alternatives with reasoning
c) One structural imbalance (e.g. over-concentration in a sector/currency) and how to fix it

## 3. MARKET TRENDS IMPACT ON MY PORTFOLIO
Search for the latest on: gold/silver prices, oil/fuel prices, interest rates, INR/EUR exchange rate, and any major Indian/European market news.
For each trend, state: current direction, whether it helps or hurts my portfolio, and what (if anything) to do about it.

Keep each section tight and specific. No padding.`

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "interleaved-thinking-2025-05-14"
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 4000,
        thinking: { type: "enabled", budget_tokens: 8000 },
        system: systemPrompt,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: userPrompt }]
      })
    })

    if(!response.ok){
      const err = await response.text()
      return res.status(500).json({error:"Claude API error", detail: err})
    }

    const data = await response.json()

    /* Extract text blocks only */
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n\n")

    return res.status(200).json({ analysis: text })

  } catch(e) {
    return res.status(500).json({error: "Insights fetch failed", detail: e.message})
  }
}
