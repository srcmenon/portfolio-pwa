export default async function handler(req, res) {

  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({error:"POST only"})

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({error:"ANTHROPIC_API_KEY not set"})

  /* Model read from env var — update ANTHROPIC_MODEL in Vercel dashboard
     when Anthropic releases a new version. No code redeploy needed. */
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"

  const { portfolio, movers } = req.body || {}

  let stockLines = []

  if(portfolio && portfolio.length){
    portfolio.forEach(p => {
      const sign = p.growth >= 0 ? "+" : ""
      stockLines.push(
        `${p.name} (${p.type}, ${p.currency}): invested €${(p.totalBuyEUR||0).toFixed(0)}, now €${(p.totalCurrentEUR||0).toFixed(0)}, ${sign}${(p.growth||0).toFixed(2)}%, P/L ${sign}€${(p.profitEUR||0).toFixed(0)}`
      )
    })
  } else if(movers && Object.keys(movers).length){
    const seen = new Set()
    const sections = { gainers:"TOP % GAINERS", losers:"TOP % LOSERS", absGainers:"TOP ABSOLUTE PROFIT", absLosers:"TOP ABSOLUTE LOSS" }
    for(const [key, label] of Object.entries(sections)){
      ;(movers[key] || []).forEach(p => {
        if(!seen.has(p.name)){
          seen.add(p.name)
          const sign = (key==="gainers"||key==="absGainers") ? "+" : ""
          stockLines.push(`${p.name} [${label}] (${p.type}, ${p.currency}): invested €${(p.totalBuyEUR||0).toFixed(0)}, now €${(p.totalCurrentEUR||0).toFixed(0)}, ${sign}${(p.growth||0).toFixed(2)}%, P/L ${sign}€${(p.profitEUR||0).toFixed(0)}`)
        }
      })
    }
  } else {
    return res.status(400).json({error:"portfolio or movers data required"})
  }

  if(!stockLines.length) return res.status(400).json({error:"No stocks to analyse"})

  const systemPrompt = `You are a portfolio analyst. You MUST respond with ONLY a raw JSON array — no prose, no markdown fences, no explanation before or after. Start your response with [ and end with ].`

  const userPrompt = `Investor profile: German tax resident, Indian and European equity exposure. Patient long-term investor. Pays taxes on genuine profits. Avoids tax-loss harvesting unless fundamentally justified.

Tax rules:
- Germany Abgeltungsteuer: 26.375% flat on all capital gains regardless of holding period.
- India LTCG over 1yr: 12.5% above Rs 1.25L annual exemption. STCG under 1yr: 20%.

Full portfolio to analyse (Indian Mutual Funds excluded):
${stockLines.join("\n")}

Decide for each position: is action warranted (BUY more, TRIM, or SELL)?
ONLY include positions where you recommend BUY, TRIM, or SELL.
DO NOT include HOLD recommendations — unlisted positions are understood to be holds.

Return a JSON array of only the actionable recommendations:
[
  {
    "name": "exact name as listed above",
    "verdict": "BUY or TRIM or SELL",
    "confidence": "High or Medium or Low",
    "reason": "1-2 sentences: fundamental outlook and why this specific action now",
    "taxNote": "1 sentence on the tax impact in the relevant jurisdiction",
    "urgency": "Immediate or Next earnings or No rush"
  }
]

Rules:
- BUY = strong fundamental case to add to position
- TRIM = reduce partially, take some profit (overvalued or position too large)
- SELL = exit fully (fundamentals broken, thesis invalid)
- Never recommend SELL purely for tax saving
- Be direct and stock-specific. No boilerplate.
- Only return positions where action is clearly warranted`

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] })
    })

    const rawText = await r.text()
    if(!r.ok) return res.status(500).json({ error: "Anthropic API error (HTTP " + r.status + ")", detail: rawText.slice(0,500) })

    let data
    try { data = JSON.parse(rawText) }
    catch(e){ return res.status(500).json({error:"Failed to parse Anthropic response", raw: rawText.slice(0,300)}) }

    if(data.error) return res.status(500).json({error: data.error.message || "API error", type: data.error.type})

    const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").trim()
    if(!text) return res.status(500).json({error:"Empty response", stop_reason: data.stop_reason, model_used: model})

    const start = text.indexOf("[")
    if(start === -1) return res.status(500).json({error:"No JSON array in response", model_used: model, raw: text.slice(0,600)})

    let depth=0, end=-1
    for(let i=start; i<text.length; i++){
      if(text[i]==="[") depth++
      else if(text[i]==="]"){ depth--; if(depth===0){end=i; break} }
    }
    if(end===-1) return res.status(500).json({error:"JSON array truncated", stop_reason: data.stop_reason})

    let recommendations
    try { recommendations = JSON.parse(text.slice(start, end+1)) }
    catch(e){ return res.status(500).json({error:"JSON parse failed: "+e.message, raw: text.slice(start, start+400)}) }

    return res.status(200).json({ recommendations, model_used: model })

  } catch(e) {
    return res.status(500).json({error:"Handler error: "+e.message})
  }
}
