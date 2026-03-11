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

  /* Only send top 10 holdings to keep prompt small */
  const snap = portfolio
    .sort((a,b) => b.totalCurrentEUR - a.totalCurrentEUR)
    .slice(0, 10)
    .map(p => `${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR.toFixed(0)}, current €${p.totalCurrentEUR.toFixed(0)}, ${p.growth.toFixed(1)}%, P/L €${p.profitEUR.toFixed(0)}`)
    .join("\n")

  const prompt = `You are a CFA-level portfolio analyst. User is German tax resident with Indian equity exposure.
Tax: Germany Abgeltungsteuer 26.375%. India LTCG >1yr 12.5% above ₹1.25L, STCG 20%.

MARKET DATA:
${marketData}

TOP HOLDINGS:
${snap}
Total: €${(totalValue||0).toFixed(0)}, Return: ${(totalReturn||0).toFixed(2)}%

Provide concise analysis in these exact sections:

## 1. INVEST €1,000 NOW
Best single opportunity. State: asset name+ticker, why (valuation + technical), 1-3yr target, tax note.

## 2. PORTFOLIO ACTIONS
**Sell:** 1-2 positions with specific reason and tax cost
**Buy/Add:** 1-2 positions with specific reason
**Fix:** One structural imbalance

## 3. TECHNICAL SNAPSHOT
For top 5 holdings: vs 200MA (above/below), RSI, verdict (bullish/bearish/neutral)

## 4. MARKET IMPACT
Gold, Oil, INR/EUR, rates, FII flows — one line each: direction + impact on portfolio

Be specific with numbers. Max 600 words.`

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
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      })
    })

    const raw = await r.text()
    if(!r.ok) return res.status(500).json({error:"Analysis API error", detail: raw.slice(0,300)})

    const data = JSON.parse(raw)
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")

    if(!text) return res.status(500).json({error:"Empty response"})
    return res.status(200).json({ analysis: text })

  } catch(e) {
    return res.status(500).json({error:"Analysis error", detail: e.message})
  }
}
