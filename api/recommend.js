/* ============================================================
   CapIntel — api/recommend.js   (Vercel Serverless Function)

   Sends the full portfolio to Claude for actionable BUY/TRIM/SELL
   recommendations. Key design decisions vs naive growth-% analysis:

   - Per-position WEIGHT (% of total) so Claude reasons about sizing
   - Cluster pre-aggregation: redundant MF groups are collapsed into
     one summary line before sending, reducing tokens and making the
     cluster redundancy obvious to Claude without repeating it 7 times
   - Noise flagging: positions <€50 are tagged [NOISE] — Claude is
     instructed to flag them all as SELL without individual analysis
   - Tax rules for both Germany (Abgeltungsteuer 26.375%) and India
     (LTCG 12.5%, STCG 20%) embedded in the prompt
   - max_tokens set to 8192 — with ~100 positions the response can be
     large; 4096 was causing JSON truncation errors

   Input:  POST { portfolio: [{name,key,type,currency,
                               totalBuyEUR,totalCurrentEUR,growth,profitEUR}] }
   Output: { recommendations: [{name,verdict,confidence,reason,
                                 taxNote,urgency,targetWeight}],
             model_used, total_eur }
   ============================================================ */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST")    return res.status(405).json({ error:"POST only" })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if(!apiKey) return res.status(500).json({ error:"ANTHROPIC_API_KEY not set" })

  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6"
  const { portfolio } = req.body || {}
  if(!portfolio?.length) return res.status(400).json({ error:"portfolio data required" })

  const totalEUR = portfolio.reduce((s, p) => s + (p.totalCurrentEUR || 0), 0)

  /* ── Assign each position to a cluster category ── */
  function getCluster(p){
    if(p.type === "MutualFund"){
      const n = p.name.toLowerCase()
      if(n.includes("small cap"))  return "Small Cap MF"
      if(n.includes("mid cap") || n.includes("midcap")) return "Mid Cap MF"
      if(n.includes("gold") || n.includes("commodit"))  return "Gold/Commodity MF"
      if(n.includes("flexi") || n.includes("multi cap") || n.includes("multicap")) return "Flexi/Multi Cap MF"
      if(n.includes("infra") || n.includes("psu"))       return "Thematic MF"
      if(n.includes("index") || n.includes("nifty"))     return "Index MF"
      return "Other MF"
    }
    return `${p.type}_${p.currency}`
  }

  /* ── Group positions by cluster ── */
  const clusters = {}
  portfolio.forEach(p => {
    const c = getCluster(p)
    if(!clusters[c]) clusters[c] = []
    clusters[c].push(p)
  })

  /* ── Build prompt lines — collapse MF clusters into summary lines,
         keep individual stocks as-is ── */
  const lines = []

  Object.entries(clusters).forEach(([clusterName, members]) => {
    const isMFCluster = members[0].type === "MutualFund"

    if(isMFCluster && members.length > 1){
      /* Collapse the whole MF cluster into one summary line.
         List individual fund names so Claude can identify the best one to keep. */
      const clusterTotal  = members.reduce((s, p) => s + (p.totalCurrentEUR || 0), 0)
      const clusterBuy    = members.reduce((s, p) => s + (p.totalBuyEUR || 0), 0)
      const clusterGrowth = clusterBuy > 0 ? ((clusterTotal - clusterBuy) / clusterBuy) * 100 : 0
      const clusterWeight = totalEUR > 0 ? (clusterTotal / totalEUR * 100).toFixed(1) : "0.0"
      const sign          = clusterGrowth >= 0 ? "+" : ""
      const fundNames     = members
        .sort((a, b) => (b.totalCurrentEUR||0) - (a.totalCurrentEUR||0))
        .map(p => `${p.name} (€${(p.totalCurrentEUR||0).toFixed(0)})`)
        .join(", ")
      lines.push(
        `[CLUSTER: ${clusterName} — ${members.length} funds] weight=${clusterWeight}%, ` +
        `total invested €${clusterBuy.toFixed(0)}, now €${clusterTotal.toFixed(0)}, ` +
        `${sign}${clusterGrowth.toFixed(1)}%. Funds: ${fundNames}`
      )
    } else {
      /* Individual positions (stocks, ETFs, single MF) — one line each */
      members.forEach(p => {
        const weight   = totalEUR > 0 ? (p.totalCurrentEUR / totalEUR * 100).toFixed(1) : "0.0"
        const sign     = p.growth >= 0 ? "+" : ""
        const noise    = p.totalCurrentEUR < 50 ? " [NOISE: <€50]" : ""
        lines.push(
          `${p.name} (${p.type}, ${p.currency})${noise}: ` +
          `weight=${weight}%, invested €${(p.totalBuyEUR||0).toFixed(0)}, ` +
          `now €${(p.totalCurrentEUR||0).toFixed(0)}, ` +
          `${sign}${(p.growth||0).toFixed(1)}%, P/L ${sign}€${(p.profitEUR||0).toFixed(0)}`
        )
      })
    }
  })

  const systemPrompt =
    `You are a portfolio analyst. Respond with ONLY a raw JSON array — ` +
    `no prose, no markdown, no explanation. Start with [ and end with ].`

  const userPrompt = `
Investor profile:
- German tax resident, age 36. Goal: buy home in India in 5-6 years, retire by 50.
- Risk: moderate-high, can hold through 6-month drawdowns.
- Philosophy: long-term accumulation, not a trader.

Tax rules:
- Germany: 26.375% flat on all gains (Abgeltungsteuer), no holding-period exemption.
- India LTCG (>1yr): 12.5%, first ₹1.25L/year exempt. STCG (<1yr): 20%.

Total portfolio: €${totalEUR.toFixed(0)}

Portfolio positions:
${lines.join("\n")}

RULES — apply strictly:
1. MF CLUSTERS: For any [CLUSTER] line with 3+ funds in the same category, recommend SELL for ALL except the best 1 (largest + best-performing). Reason: "Redundant cluster — consolidate to 1 fund, same exposure with lower complexity."
2. NOISE: Flag every [NOISE <€50] position as SELL. Reason: "Too small to impact portfolio."
3. CONCENTRATION: Any single position >8% needs TRIM unless it is a core world ETF (IWDA, VWCE).
4. BUY must include targetWeight (e.g. "grow to 4-5%").
5. Never SELL just because a position is down — only if thesis is broken or it is noise/redundant.
6. Omit HOLD — unlisted positions are understood as holds.
7. Keep reason to 1-2 sentences. Keep taxNote to 1 sentence.

Return JSON array only:
[{"name":"...","verdict":"BUY|TRIM|SELL","confidence":"High|Medium|Low",
  "reason":"...","taxNote":"...","urgency":"Immediate|Next quarter|No rush",
  "targetWeight":"..."}]`

  try{
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "x-api-key":       apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,   /* raised from 4096 — large portfolios need more room */
        system:   systemPrompt,
        messages: [{ role:"user", content:userPrompt }]
      })
    })

    const rawText = await r.text()
    if(!r.ok) return res.status(500).json({
      error: `Anthropic API error (HTTP ${r.status})`,
      detail: rawText.slice(0, 500)
    })

    let data
    try{ data = JSON.parse(rawText) }
    catch(e){ return res.status(500).json({ error:"Failed to parse Anthropic response", raw:rawText.slice(0,300) }) }

    if(data.error) return res.status(500).json({ error:data.error.message||"API error", type:data.error.type })

    const text = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").trim()
    if(!text) return res.status(500).json({ error:"Empty response", stop_reason:data.stop_reason })

    /* Robustly extract the JSON array from the response */
    const start = text.indexOf("[")
    if(start === -1) return res.status(500).json({ error:"No JSON array in response", raw:text.slice(0,600) })

    let depth=0, end=-1
    for(let i=start; i<text.length; i++){
      if(text[i]==="[")       depth++
      else if(text[i]==="]"){ depth--; if(depth===0){ end=i; break } }
    }
    if(end===-1) return res.status(500).json({
      error: "JSON array truncated — response too long. Try again.",
      stop_reason: data.stop_reason
    })

    let recommendations
    try{ recommendations = JSON.parse(text.slice(start, end+1)) }
    catch(e){ return res.status(500).json({
      error: "JSON parse failed: "+e.message,
      raw:   text.slice(start, start+400)
    }) }

    return res.status(200).json({ recommendations, model_used:model, total_eur:totalEUR })

  }catch(e){
    return res.status(500).json({ error:"Handler error: "+e.message })
  }
}
