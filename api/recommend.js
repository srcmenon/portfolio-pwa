/* ============================================================
   CapIntel — api/recommend.js   (Vercel Serverless Function)
   AI-powered portfolio position analysis using Claude.

   What this does differently from naive growth-% analysis:
   - Sends each position's WEIGHT (% of total portfolio) so
     Claude can assess concentration and sizing, not just P/L.
   - Clusters similar positions (e.g. 7 small cap MFs) so
     Claude can flag redundancy, not just individual performance.
   - Sends total portfolio value so Claude can give context-
     aware sizing advice ("add more" only makes sense relative
     to current weight).
   - Flags positions under €50 as noise — Claude is told these
     are not worth individual sell decisions, just consolidation.
   - Tax context is included for both German and Indian rules.

   Input (POST body):
     { portfolio: [ { name, key, type, currency, totalBuyEUR,
                      totalCurrentEUR, growth, profitEUR } ] }

   Output:
     { recommendations: [ { name, verdict, confidence,
                             reason, taxNote, urgency,
                             targetWeight } ],
       model_used }
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

  /* ── Compute total portfolio value and per-position weight ── */
  const totalEUR = portfolio.reduce((s, p) => s + (p.totalCurrentEUR || 0), 0)

  /* ── Detect thematic clusters (e.g. 7 small cap MFs = same exposure) ── */
  const clusterCounts = {}
  portfolio.forEach(p => {
    const cat = p.type === "MutualFund"
      ? (p.name.toLowerCase().includes("small cap")  ? "Small Cap MF"
       : p.name.toLowerCase().includes("mid cap")    ? "Mid Cap MF"
       : p.name.toLowerCase().includes("gold")       ? "Gold MF"
       : "Other MF")
      : `${p.type}_${p.currency}`
    clusterCounts[cat] = (clusterCounts[cat] || 0) + 1
  })

  /* ── Build one line per position with full context ── */
  const stockLines = portfolio.map(p => {
    const weight    = totalEUR > 0 ? ((p.totalCurrentEUR / totalEUR) * 100).toFixed(1) : "0.0"
    const sign      = p.growth >= 0 ? "+" : ""
    const cat       = p.type === "MutualFund"
      ? (p.name.toLowerCase().includes("small cap") ? "Small Cap MF"
       : p.name.toLowerCase().includes("mid cap")   ? "Mid Cap MF"
       : p.name.toLowerCase().includes("gold")      ? "Gold MF"
       : "Other MF")
      : `${p.type}_${p.currency}`
    const clusterNote = clusterCounts[cat] > 1 ? ` [CLUSTER: ${clusterCounts[cat]} in ${cat}]` : ""
    const sizeNote    = p.totalCurrentEUR < 50 ? " [NOISE: <€50]" : ""
    return `${p.name} (${p.type}, ${p.currency})${clusterNote}${sizeNote}: weight=${weight}% of portfolio, invested €${(p.totalBuyEUR||0).toFixed(0)}, now €${(p.totalCurrentEUR||0).toFixed(0)}, ${sign}${(p.growth||0).toFixed(1)}%, P/L ${sign}€${(p.profitEUR||0).toFixed(0)}`
  })

  const systemPrompt = `You are a portfolio analyst. You MUST respond with ONLY a raw JSON array — no prose, no markdown, no explanation. Start with [ and end with ].`

  const userPrompt = `
Investor: German tax resident, 36 years old, Indian + European equity exposure.
Goal: Wealth accumulation for 10-15 years, retire before 50, buy house in India in 8-10 years.
Risk: Moderate-high. Willing to hold through 6-month drawdowns.
Philosophy: Patient long-term investor, not a trader.

Tax rules:
- Germany (Abgeltungsteuer): 26.375% flat on all capital gains, no holding-period exemption.
- India LTCG >1yr: 12.5% tax, first ₹1.25L per year exempt. STCG <1yr: 20%.
- For Indian positions held >1yr with small gains, tax cost of selling is low.

Total portfolio value: €${totalEUR.toFixed(0)}

Portfolio (one line per position, with weight and cluster info):
${stockLines.join("\n")}

ANALYSIS RULES:
1. CLUSTER REDUNDANCY: If a cluster label shows 5+ positions in the same category (e.g. "7 in Small Cap MF"), flag ALL of them as SELL except the top 1-2 by size. State: "Redundant — consolidate to 1-2 funds." Same exposure, multiple expense ratios is pure waste.
2. NOISE POSITIONS [NOISE <€50]: Flag ALL of these as SELL. A position that is <€50 in a €${totalEUR.toFixed(0)} portfolio cannot move the needle and just creates complexity. Dismiss them.
3. CONCENTRATION: Any single position >8% of portfolio needs a TRIM rationale unless it's a core ETF (IWDA, VWCE) or world-class compounder.
4. POSITION SIZING: If recommending BUY, state a target weight (e.g. "grow to 3-4% of portfolio"). Never say "buy more" without context.
5. QUALITY FILTER: PSU metals (SAIL, NMDC, NATIONALUM), pure cyclical commodities, and loss-making speculative stocks should be flagged if position is too small to justify.
6. NEVER recommend SELL just because a stock is down. Thesis must be broken.
7. NEVER recommend HOLD — positions not listed are understood as holds.

Return ONLY actionable recommendations (BUY, TRIM, or SELL):
[
  {
    "name": "exact name as listed",
    "verdict": "BUY or TRIM or SELL",
    "confidence": "High or Medium or Low",
    "reason": "1-2 sentences: specific reasoning — mention weight%, cluster issue, or thesis",
    "taxNote": "1 sentence on tax impact in the relevant jurisdiction",
    "urgency": "Immediate or Next quarter or No rush",
    "targetWeight": "e.g. 0% (exit) or 3-4% (add to this level) — required for BUY/TRIM"
  }
]`

  try{
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: { "Content-Type":"application/json", "x-api-key":apiKey, "anthropic-version":"2023-06-01" },
      body:    JSON.stringify({ model, max_tokens:4096, system:systemPrompt, messages:[{ role:"user", content:userPrompt }] })
    })

    const rawText = await r.text()
    if(!r.ok) return res.status(500).json({ error:`Anthropic API error (HTTP ${r.status})`, detail:rawText.slice(0,500) })

    let data
    try{ data = JSON.parse(rawText) }
    catch(e){ return res.status(500).json({ error:"Failed to parse Anthropic response", raw:rawText.slice(0,300) }) }

    if(data.error) return res.status(500).json({ error:data.error.message||"API error", type:data.error.type })

    const text  = (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\n").trim()
    if(!text) return res.status(500).json({ error:"Empty response", stop_reason:data.stop_reason })

    const start = text.indexOf("[")
    if(start === -1) return res.status(500).json({ error:"No JSON array in response", raw:text.slice(0,600) })

    let depth=0, end=-1
    for(let i=start; i<text.length; i++){
      if(text[i]==="[") depth++
      else if(text[i]==="]"){ depth--; if(depth===0){ end=i; break } }
    }
    if(end===-1) return res.status(500).json({ error:"JSON array truncated", stop_reason:data.stop_reason })

    let recommendations
    try{ recommendations = JSON.parse(text.slice(start, end+1)) }
    catch(e){ return res.status(500).json({ error:"JSON parse failed: "+e.message, raw:text.slice(start, start+400) }) }

    return res.status(200).json({ recommendations, model_used:model, total_eur:totalEUR })

  }catch(e){
    return res.status(500).json({ error:"Handler error: "+e.message })
  }
}
