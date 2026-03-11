export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({error:"POST only"})

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({error:"ANTHROPIC_API_KEY not set"})

  const { portfolio, totalValue, totalReturn } = req.body || {}
  if(!portfolio || !portfolio.length) return res.status(400).json({error:"Portfolio required"})

  const snap = portfolio
    .sort((a,b) => b.totalCurrentEUR - a.totalCurrentEUR)
    .slice(0, 8)
    .map(p => `${p.name} (${p.type}): €${p.totalCurrentEUR.toFixed(0)}, ${p.growth.toFixed(1)}%`)
    .join("\n")

  const prompt = `You are a concise investment analyst. Search for current data and reply in SHORT bullet points only — no paragraphs, no explanations. Max 400 words total.

Portfolio top holdings:
${snap}
Total: €${(totalValue||0).toFixed(0)}, Return: ${(totalReturn||0).toFixed(2)}%

Search and return ONLY these data points:
- Nifty 50: level, RSI, above/below 200MA?
- S&P 500: level, RSI, trend
- DAX: level, trend
- VIX: current reading
- Gold: price, trend (up/down)
- Brent oil: price, trend
- EUR/INR: rate, 30d change
- USD/INR: rate
- RBI rate: current, stance
- ECB rate: current, stance
- FII India flows: last 2 weeks net buy/sell
- Indian small/mid cap P/E: cheap or expensive vs history?
- Top 1 geopolitical risk for India markets
- Top 1 geopolitical risk for Europe markets
- Best investment opportunity right now in 1 sentence

Be extremely brief. Numbers only where possible.`

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
        messages: [{ role: "user", content: prompt }]
      })
    })

    const raw = await r.text()
    if(!r.ok) return res.status(500).json({error:"Search API error", detail: raw.slice(0,300)})

    const data = JSON.parse(raw)
    const marketData = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")

    return res.status(200).json({ marketData })

  } catch(e) {
    return res.status(500).json({error:"Market search error", detail: e.message})
  }
}
