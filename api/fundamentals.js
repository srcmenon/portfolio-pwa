/* ============================================================
   CapIntel — api/fundamentals.js   FREE — no external calls

   PURE SCORING ENDPOINT — receives pre-fetched fundamental data
   from the client browser (which has Yahoo Finance session cookies)
   and returns scored verdicts.

   No external HTTP calls made here. All data comes from the request body.

   Scores each position on:
   1. Technical score    (from window._techMap, sent by client)
   2. Fundamental score  (P/E, P/B, ROE, D/E, revenue/earnings growth, margins)
   3. Goal alignment     (India home fund vs EUR retirement corpus)

   Composite → ADD / EXIT / HOLD / REVIEW verdict
   ============================================================ */

function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: ["No fundamental data"], grade: "UNKNOWN" }

  const sigs = []
  let score  = 50

  if (f.trailingPE != null) {
    if      (f.trailingPE <= 0)  { score -= 15; sigs.push(`Negative P/E — losses`) }
    else if (f.trailingPE < 12)  { score += 12; sigs.push(`Low P/E ${f.trailingPE.toFixed(1)}x`) }
    else if (f.trailingPE < 20)  { score += 8;  sigs.push(`Fair P/E ${f.trailingPE.toFixed(1)}x`) }
    else if (f.trailingPE < 35)  { score += 2 }
    else if (f.trailingPE < 60)  { score -= 5;  sigs.push(`High P/E ${f.trailingPE.toFixed(1)}x`) }
    else                         { score -= 12; sigs.push(`Very high P/E ${f.trailingPE.toFixed(1)}x`) }
  }

  if (f.priceToBook != null) {
    if      (f.priceToBook < 0)  { score -= 10 }
    else if (f.priceToBook < 1.5){ score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x near book`) }
    else if (f.priceToBook < 3)  { score += 4 }
    else if (f.priceToBook > 6)  { score -= 8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }

  if (f.roe != null) {
    const r = f.roe * 100
    if      (r > 25) { score += 15; sigs.push(`Excellent ROE ${r.toFixed(0)}%`) }
    else if (r > 15) { score += 10; sigs.push(`Good ROE ${r.toFixed(0)}%`) }
    else if (r > 8)  { score += 4 }
    else if (r > 0)  { score -= 5;  sigs.push(`Weak ROE ${r.toFixed(0)}%`) }
    else             { score -= 15; sigs.push(`Negative ROE`) }
  }

  if (f.debtToEquity != null) {
    if      (f.debtToEquity < 0.2) { score += 10; sigs.push(`Low debt D/E ${f.debtToEquity.toFixed(2)}`) }
    else if (f.debtToEquity < 0.5) { score += 5 }
    else if (f.debtToEquity < 1)   { score -= 3 }
    else if (f.debtToEquity < 2)   { score -= 8;  sigs.push(`High debt D/E ${f.debtToEquity.toFixed(1)}`) }
    else                           { score -= 15; sigs.push(`Excessive debt D/E ${f.debtToEquity.toFixed(1)}`) }
  }

  if (f.revenueGrowth != null) {
    const g = f.revenueGrowth * 100
    if      (g > 20) { score += 12; sigs.push(`Revenue +${g.toFixed(0)}%`) }
    else if (g > 10) { score += 7;  sigs.push(`Revenue +${g.toFixed(0)}%`) }
    else if (g > 0)  { score += 2 }
    else             { score -= 10; sigs.push(`Revenue shrinking ${g.toFixed(0)}%`) }
  }

  if (f.earningsGrowth != null) {
    const g = f.earningsGrowth * 100
    if      (g > 25) { score += 12; sigs.push(`Earnings +${g.toFixed(0)}%`) }
    else if (g > 10) { score += 6 }
    else if (g > 0)  { score += 1 }
    else             { score -= 10; sigs.push(`Earnings declining ${g.toFixed(0)}%`) }
  }

  if (f.profitMargins != null) {
    const m = f.profitMargins * 100
    if      (m > 20) { score += 8;  sigs.push(`Strong margins ${m.toFixed(0)}%`) }
    else if (m > 10) { score += 4 }
    else if (m < 0)  { score -= 12; sigs.push(`Negative margins`) }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score>=70?"STRONG":score>=50?"FAIR":score>=30?"WEAK":"POOR"

  /* Format display */
  const pe  = f.trailingPE     != null ? f.trailingPE.toFixed(1)+"x"        : "N/A"
  const pb  = f.priceToBook    != null ? f.priceToBook.toFixed(1)+"x"        : "N/A"
  const roe = f.roe            != null ? (f.roe*100).toFixed(1)+"%"           : "N/A"
  const de  = f.debtToEquity   != null ? f.debtToEquity.toFixed(2)           : "N/A"
  const rev = f.revenueGrowth  != null ? (f.revenueGrowth*100).toFixed(1)+"%" : "N/A"
  const mar = f.profitMargins  != null ? (f.profitMargins*100).toFixed(1)+"%" : "N/A"

  return { score, signals: sigs.slice(0,3), grade, display: {pe,pb,roe,de,rev,mar} }
}

function scoreGoalAlignment(pos, goals) {
  let score = 50; const sigs = []
  const retireYrs = (goals.retireAge||50) - 36

  if (pos.currency === "INR") {
    score += 10; sigs.push("India — home fund aligned")
    const goodSectors = ["financial","bank","finance","technology","software","consumer",
                         "healthcare","pharma","infrastructure","capital goods","it services","nbfc"]
    const badSectors  = ["power","telecom","oil","gas","commodity","coal","mining"]
    const ind = (pos.industry||pos.sector||"").toLowerCase()
    if (goodSectors.some(s=>ind.includes(s))) { score+=10; sigs.push("High-quality sector") }
    if (badSectors.some(s=>ind.includes(s)))  { score-=8;  sigs.push("Cyclical/PSU sector") }
  } else {
    score+=10; sigs.push("EUR/USD — retirement aligned")
  }

  if      ((pos.totalCurrentEUR||0) < 30)  { score-=20; sigs.push("Too small to impact goal") }
  else if ((pos.totalCurrentEUR||0) < 100) { score-=8 }
  if (retireYrs >= 10) score += 5

  return { score: Math.max(0,Math.min(100,Math.round(score))), signals: sigs }
}

function getVerdict(techScore, techVerdict, fundScore, goalScore, pos) {
  const composite = Math.round(techScore*0.40 + fundScore*0.35 + goalScore*0.25)
  const isBuy  = techVerdict==="BUY"||techVerdict==="STRONG BUY"
  const isSell = techVerdict==="SELL"||techVerdict==="TRIM"
  const cur    = pos.currentPrice || 0

  let verdict, action, priority

  if (isBuy && fundScore >= 45) {
    verdict="ADD"; priority=composite>=70?"HIGH":"MEDIUM"
    const addQty = Math.max(1, Math.round(5000/(cur||1)))
    action = pos.currency==="INR"
      ? `Add ${addQty} shares at ₹${cur.toFixed(0)} (≈₹${(addQty*cur).toFixed(0)}) — builds to meaningful position`
      : `Add €200 — underfunded quality holding worth building`
  } else if (isSell || fundScore < 30) {
    verdict="EXIT"; priority=(fundScore<20||isSell)?"HIGH":"MEDIUM"
    action=`Sell all — weak fundamentals + technicals confirm exit. Redeploy to stronger position.`
  } else if (techVerdict==="HOLD" && fundScore>=40) {
    verdict="HOLD"; priority="LOW"
    action=`Hold — quality business, wait for better technical entry. Review if RSI drops below 40.`
  } else {
    verdict="REVIEW"; priority="LOW"
    action=`Mixed signals — hold and reassess next month.`
  }

  return { verdict, action, priority, composite }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" })

  const { positions, fundamentalsData, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const results = {}

  positions.forEach(pos => {
    /* Use pre-fetched fundamental data from client browser */
    const f = fundamentalsData?.[pos.key] || null
    const { score: fundScore, signals: fundSigs, grade, display } = scoreFundamentals(f)

    const tech        = techMap?.[pos.key] || {}
    const techScore   = tech.score   ?? 50
    const techVerdict = tech.verdict ?? "HOLD"
    const techSigs    = tech.signals ?? []

    /* Enrich pos with sector from fundamentals */
    const enriched = { ...pos, industry: f?.industry, sector: f?.sector }
    const { score: goalScore, signals: goalSigs } = scoreGoalAlignment(enriched, goals||{})

    const { verdict, action, priority, composite } =
      getVerdict(techScore, techVerdict, fundScore, goalScore, pos)

    results[pos.key] = {
      verdict, action, priority, composite,
      scores:       { technical: techScore, fundamental: fundScore, goalAlign: goalScore },
      signals:      { technical: techSigs,  fundamental: fundSigs,  goalAlign: goalSigs },
      fundamentals: {
        pe:      display?.pe      || "N/A",
        pb:      display?.pb      || "N/A",
        roe:     display?.roe     || "N/A",
        de:      display?.de      || "N/A",
        revGrow: display?.rev     || "N/A",
        margins: display?.mar     || "N/A",
        sector:  f?.sector        || "N/A",
        grade
      }
    }
  })

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
