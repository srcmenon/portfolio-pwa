export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({error:"POST only"})

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({error:"ANTHROPIC_API_KEY not set"})

  const { movers } = req.body || {}
  if(!movers || !Object.keys(movers).length)
    return res.status(400).json({error:"Movers data required"})

  /* Build a concise representation of each section */
  const sections = []
  if(movers.gainers?.length)
    sections.push(`TOP % GAINERS:\n${movers.gainers.map(p =>
      `  ${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR?.toFixed(0)}, now €${p.totalCurrentEUR?.toFixed(0)}, +${p.growth?.toFixed(2)}%, P/L +€${p.profitEUR?.toFixed(0)}`
    ).join("\n")}`)

  if(movers.losers?.length)
    sections.push(`TOP % LOSERS:\n${movers.losers.map(p =>
      `  ${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR?.toFixed(0)}, now €${p.totalCurrentEUR?.toFixed(0)}, ${p.growth?.toFixed(2)}%, P/L €${p.profitEUR?.toFixed(0)}`
    ).join("\n")}`)

  if(movers.absGainers?.length)
    sections.push(`TOP ABSOLUTE PROFIT (€):\n${movers.absGainers.map(p =>
      `  ${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR?.toFixed(0)}, now €${p.totalCurrentEUR?.toFixed(0)}, +${p.growth?.toFixed(2)}%, P/L +€${p.profitEUR?.toFixed(0)}`
    ).join("\n")}`)

  if(movers.absLosers?.length)
    sections.push(`TOP ABSOLUTE LOSS (€):\n${movers.absLosers.map(p =>
      `  ${p.name} (${p.type}, ${p.currency}): invested €${p.totalBuyEUR?.toFixed(0)}, now €${p.totalCurrentEUR?.toFixed(0)}, ${p.growth?.toFixed(2)}%, P/L €${p.profitEUR?.toFixed(0)}`
    ).join("\n")}`)

  const prompt = `You are a seasoned portfolio strategist advising a German tax-resident investor with Indian and European equity exposure.

TAX CONTEXT:
- Germany: Abgeltungsteuer 26.375% flat on ALL capital gains (no holding-period relief). Loss harvesting rarely makes sense.
- India: LTCG (>1yr): 12.5% above ₹1.25L annual exemption. STCG (<1yr): 20%.
- Investor philosophy: Patient long-term thinker. Willing to pay taxes on genuine profits. Dislikes tax-loss harvesting just for the sake of it. Will sell/buy only when fundamentally justified.

HERE ARE THE INVESTOR'S CURRENT TOP MOVERS FROM THEIR OWN PORTFOLIO:

${sections.join("\n\n")}

For EACH stock listed above, provide a CONCISE recommendation object. Use only your training knowledge about these companies — do NOT invent data.

Respond ONLY with a valid JSON array (no markdown, no explanations outside JSON):

[
  {
    "name": "Exact name as listed above",
    "verdict": "BUY" | "HOLD" | "SELL" | "TRIM",
    "confidence": "High" | "Medium" | "Low",
    "reason": "1–2 sentences: fundamental outlook + why this verdict",
    "taxNote": "1 sentence: tax implication specific to this position (Germany or India)",
    "urgency": "Immediate" | "Next earnings" | "No rush"
  }
]

Rules:
- TRIM = reduce position partially (take some profits without full exit)
- Be direct. No generic boilerplate. Reference the specific stock.
- Tax note must reference the ACTUAL gain/loss and jurisdiction.
- Never recommend selling a loss solely to harvest tax. Only if fundamentals are broken.
- For high-confidence gainers that are still cheap, recommend HOLD or BUY MORE.
- For stocks with large unrealised gains and deteriorating fundamentals, suggest TRIM.`

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2500,
        messages: [{ role: "user", content: prompt }]
      })
    })

    const raw = await r.text()
    if(!r.ok) return res.status(500).json({error:"Recommendation API error", detail: raw.slice(0,300)})

    const data = JSON.parse(raw)
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim()

    /* Strip possible markdown fences */
    const clean = text.replace(/^```json\s*/i,"").replace(/^```\s*/,"").replace(/\s*```$/,"").trim()

    let recommendations
    try { recommendations = JSON.parse(clean) }
    catch(e) { return res.status(500).json({error:"JSON parse failed", raw: clean.slice(0,400)}) }

    return res.status(200).json({ recommendations })

  } catch(e) {
    return res.status(500).json({error:"Recommend error", detail: e.message})
  }
}
