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

  /* Deduplicate across all four sections — each stock appears once */
  const seen = new Set()
  const allMovers = []
  const sections = { gainers:"TOP % GAINERS", losers:"TOP % LOSERS", absGainers:"TOP ABSOLUTE PROFIT", absLosers:"TOP ABSOLUTE LOSS" }

  for(const [key, label] of Object.entries(sections)){
    const list = movers[key] || []
    list.forEach(p => {
      if(!seen.has(p.name)){
        seen.add(p.name)
        const sign = (key==="gainers"||key==="absGainers") ? "+" : ""
        allMovers.push(
          `${p.name} [${label}] (${p.type}, ${p.currency}): ` +
          `invested €${(p.totalBuyEUR||0).toFixed(0)}, ` +
          `now €${(p.totalCurrentEUR||0).toFixed(0)}, ` +
          `${sign}${(p.growth||0).toFixed(2)}%, P/L ${sign}€${(p.profitEUR||0).toFixed(0)}`
        )
      }
    })
  }

  const systemPrompt = `You are a portfolio analyst. You MUST respond with ONLY a raw JSON array — no prose, no markdown fences, no explanation before or after. Start your response with [ and end with ].`

  const userPrompt = `Investor profile: German tax resident, Indian + European equity exposure. Patient long-term investor who pays taxes on genuine profits and avoids tax-loss harvesting unless fundamentally justified.

Tax rules:
- Germany Abgeltungsteuer: 26.375% flat on all capital gains regardless of holding period.
- India LTCG over 1yr: 12.5% above ₹1.25L annual exemption. STCG under 1yr: 20%.

Portfolio movers to analyse:
${allMovers.join("\n")}

Return a JSON array with one object per stock above. Use exactly these fields:
[
  {
    "name": "exact stock name as listed",
    "verdict": "BUY or HOLD or TRIM or SELL",
    "confidence": "High or Medium or Low",
    "reason": "1-2 sentences on fundamental outlook and why this verdict",
    "taxNote": "1 sentence on tax impact for this specific position",
    "urgency": "Immediate or Next earnings or No rush"
  }
]

TRIM means reduce position size partially. Only recommend SELL if fundamentals are broken. Never recommend SELL purely for tax saving.`

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
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }]
      })
    })

    const rawText = await r.text()

    /* Always surface the raw API error if the request itself failed */
    if(!r.ok){
      return res.status(500).json({
        error: "Anthropic API error (HTTP " + r.status + ")",
        detail: rawText.slice(0, 500)
      })
    }

    let data
    try { data = JSON.parse(rawText) }
    catch(e){ return res.status(500).json({error:"Failed to parse Anthropic response", raw: rawText.slice(0,300)}) }

    /* Check for API-level error in body (e.g. model not found, overloaded) */
    if(data.error){
      return res.status(500).json({error: data.error.message || "API error", type: data.error.type})
    }

    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim()

    if(!text){
      return res.status(500).json({
        error: "Empty response from model",
        stop_reason: data.stop_reason,
        usage: data.usage
      })
    }

    /* Extract JSON array — find first [ and its matching closing ] by bracket depth */
    const start = text.indexOf("[")
    if(start === -1){
      return res.status(500).json({
        error: "No JSON array in response",
        stop_reason: data.stop_reason,
        raw: text.slice(0, 600)
      })
    }

    let depth = 0, end = -1
    for(let i = start; i < text.length; i++){
      if(text[i] === "[") depth++
      else if(text[i] === "]"){ depth--; if(depth === 0){ end = i; break } }
    }

    if(end === -1){
      return res.status(500).json({
        error: "JSON array not closed — likely truncated (max_tokens hit)",
        stop_reason: data.stop_reason,
        partial: text.slice(start, start + 400)
      })
    }

    const clean = text.slice(start, end + 1)

    let recommendations
    try { recommendations = JSON.parse(clean) }
    catch(e){
      return res.status(500).json({
        error: "JSON parse failed: " + e.message,
        raw: clean.slice(0, 400)
      })
    }

    return res.status(200).json({ recommendations })

  } catch(e) {
    return res.status(500).json({error: "Handler error: " + e.message})
  }
}
