export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({error:"POST only"})

  const { portfolio, totalValue, totalReturn } = req.body || {}
  if(!portfolio || !portfolio.length) return res.status(400).json({error:"Portfolio required"})

  const snap = portfolio.map(p =>
    `${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR.toFixed(0)}, current €${p.totalCurrentEUR.toFixed(0)}, return ${p.growth.toFixed(1)}%`
  ).join("\n")

  const systemPrompt = `You are a professional investment analyst and portfolio advisor.
The user is a German tax resident who also holds Indian mutual funds and stocks subject to Indian capital gains tax.
Key tax context:
- Germany: Capital gains and dividends subject to Abgeltungsteuer (~26.375% total). ETFs subject to Vorabpauschale.
- India: Equity LTCG (>1 year) 12.5% above ₹1.25 lakh. STCG 20%. Dividends taxed at slab rate.
Always give concrete, actionable, specific advice — not generic platitudes. Use real ticker names and specific reasoning.
Structure your response with these exact section headers:
## 1. DAILY INVESTMENT SUGGESTION (€1,000)
## 2. PORTFOLIO RESTRUCTURING  
## 3. MARKET TRENDS IMPACT`

  const userPrompt = `My portfolio (EUR equivalent):
Total Value: €${(totalValue||0).toFixed(0)}
Total Return: ${(totalReturn||0).toFixed(2)}%

Holdings:
${snap}

Search for current market conditions and provide:

## 1. DAILY INVESTMENT SUGGESTION (€1,000)
Best use of €1,000 right now — specific stock, ETF, or existing position. Include ticker, P/E or valuation metric, catalyst, 1-3 year horizon, and German tax angle.

## 2. PORTFOLIO RESTRUCTURING
a) Up to 2 positions to SELL with reasoning and estimated tax cost
b) Up to 2 positions to BUY MORE or swap into
c) One structural imbalance to fix

## 3. MARKET TRENDS IMPACT
Gold/silver, oil, interest rates, INR/EUR rate, key India and Europe market news — state direction, portfolio impact, and action if any.

Be specific and direct.`

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 4000,
        system: systemPrompt,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: userPrompt }]
      })
    })

    if(!response.ok){
      const err = await response.text()
      console.error("Anthropic error:", err)
      return res.status(500).json({error:"Claude API error", detail: err})
    }

    const data = await response.json()

    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n\n")

    if(!text){
      return res.status(500).json({error:"No text response from Claude", raw: JSON.stringify(data.content)})
    }

    return res.status(200).json({ analysis: text })

  } catch(e) {
    console.error("Insights error:", e)
    return res.status(500).json({error: "Insights fetch failed", detail: e.message})
  }
}
