/* ============================================================
   CapIntel — api/fundamentals.js  (Vercel Serverless)

   Scoring weights (long-term investor profile):
     Technical:   25%  (short-term signal, less weight for 4-14yr goals)
     Fundamental: 50%  (primary signal for quality)
     Goal:        25%  (gap-urgency aware)

   Sector-aware scoring:
     - Financial (banks/NBFC): D/E penalty halved, margin scoring skipped
     - Cyclicals (steel/metals/energy): PE thresholds adjusted
     - STCG tax status factored into EXIT verdicts
   ============================================================ */

function toYahooTicker(key, currency, type) {
  if (!key) return null
  if (key.includes("-USD"))               return null
  if (key.includes("."))                  return key
  if (key === "SEMI")                     return "CHIP.PA"
  if (key === "EWG2")                     return "EWG2.SG"
  if (currency === "USD")                 return key
  if (currency === "EUR") {
    const t = (type || "").toLowerCase()
    if (t === "etf" || t === "commodity") return key + ".L"
    return key
  }
  return key + ".NS"
}

function isFinancialSector(sector) {
  return sector && (
    sector.toLowerCase().includes("financial") ||
    sector.toLowerCase().includes("bank") ||
    sector.toLowerCase().includes("insurance")
  )
}
function isCyclicalSector(sector) {
  return sector && (
    sector.toLowerCase().includes("material") ||
    sector.toLowerCase().includes("steel") ||
    sector.toLowerCase().includes("metal") ||
    sector.toLowerCase().includes("energy") ||
    sector.toLowerCase().includes("mining")
  )
}

async function fetchOracleBatch(tickers) {
  const baseUrl = process.env.FUNDAMENTALS_URL
  if (!baseUrl) { console.error("[oracle] FUNDAMENTALS_URL not set"); return {} }
  try {
    const r = await fetch(`${baseUrl}/fundamentals/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tickers })
    })
    if (!r.ok) { console.error(`[oracle] HTTP ${r.status}`); return {} }
    const data = await r.json()
    console.log(`[oracle] fetched=${data.fetched} cached=${data.cached}`)
    return data.results || {}
  } catch(e) {
    console.error(`[oracle] ${e.message}`)
    return {}
  }
}

function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  const sigs = []
  let score = 50, fields = 0
  const financial = isFinancialSector(f.sector)
  const cyclical  = isCyclicalSector(f.sector)

  /* P/E — sector-adjusted */
  if (f.trailingPE != null) {
    fields++
    const pe = f.trailingPE
    if (cyclical) {
      if      (pe <= 0)  { score -= 10; sigs.push("Negative P/E — loss-making") }
      else if (pe < 6)   { score -= 5;  sigs.push(`P/E ${pe.toFixed(1)}x — very low, peak cycle risk`) }
      else if (pe < 12)  { score += 6;  sigs.push(`P/E ${pe.toFixed(1)}x — reasonable for cyclical`) }
      else if (pe < 20)  { score += 4 }
      else if (pe < 35)  { score += 1 }
      else if (pe < 60)  { score -= 5;  sigs.push(`P/E ${pe.toFixed(1)}x — elevated`) }
      else               { score -= 10; sigs.push(`P/E ${pe.toFixed(1)}x — very high`) }
    } else {
      if      (pe <= 0)  { score -= 15; sigs.push("Negative P/E — loss-making") }
      else if (pe < 12)  { score += 12; sigs.push(`P/E ${pe.toFixed(1)}x — undervalued`) }
      else if (pe < 20)  { score += 8;  sigs.push(`P/E ${pe.toFixed(1)}x — fair value`) }
      else if (pe < 35)  { score += 2 }
      else if (pe < 60)  { score -= 5;  sigs.push(`P/E ${pe.toFixed(1)}x — elevated`) }
      else               { score -= 12; sigs.push(`P/E ${pe.toFixed(1)}x — very high`) }
    }
  }

  /* P/B */
  if (f.priceToBook != null) {
    fields++
    const pb = f.priceToBook
    if      (pb < 0)   { score -= 10 }
    else if (pb < 1.5) { score += 8;  sigs.push(`P/B ${pb.toFixed(1)}x — below book`) }
    else if (pb < 3)   { score += 4 }
    else if (pb > 8)   { score -= 10; sigs.push(`High P/B ${pb.toFixed(1)}x`) }
    else if (pb > 5)   { score -= 5;  sigs.push(`P/B ${pb.toFixed(1)}x — rich`) }
  }

  /* ROE */
  if (f.roe != null) {
    fields++
    const r = f.roe * 100
    if      (r > 25) { score += 18; sigs.push(`ROE ${r.toFixed(0)}% — excellent`) }
    else if (r > 15) { score += 12; sigs.push(`ROE ${r.toFixed(0)}% — good`) }
    else if (r > 8)  { score += 5 }
    else if (r > 0)  { score -= 5;  sigs.push(`ROE ${r.toFixed(0)}% — weak`) }
    else             { score -= 18; sigs.push("Negative ROE") }
  }

  /* Profit margins — skip for financial sector */
  if (f.profitMargins != null && !financial) {
    fields++
    const m = f.profitMargins * 100
    if      (m > 20) { score += 12; sigs.push(`Net margin ${m.toFixed(0)}% — excellent`) }
    else if (m > 10) { score += 7;  sigs.push(`Net margin ${m.toFixed(0)}%`) }
    else if (m > 5)  { score += 2 }
    else if (m > 0)  { score -= 2 }
    else             { score -= 12; sigs.push(`Negative margin ${m.toFixed(0)}%`) }
  }

  /* D/E — halved penalty for financial sector */
  if (f.debtToEquity != null) {
    fields++
    const de = f.debtToEquity
    if (financial) {
      if      (de < 100) { score += 3 }
      else if (de < 300) { score += 0 }
      else if (de < 500) { score -= 3;  sigs.push(`D/E ${de.toFixed(0)}% — high even for financials`) }
      else               { score -= 8;  sigs.push(`D/E ${de.toFixed(0)}% — very high leverage`) }
    } else {
      if      (de < 20)  { score += 10; sigs.push(`D/E ${de.toFixed(0)}% — very low debt`) }
      else if (de < 60)  { score += 5 }
      else if (de < 120) { score -= 5 }
      else               { score -= 14; sigs.push(`D/E ${de.toFixed(0)}% — high debt`) }
    }
  }

  /* Revenue growth */
  if (f.revenueGrowth != null) {
    fields++
    const g = f.revenueGrowth * 100
    if      (g > 20) { score += 14; sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score += 8;  sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score += 2 }
    else if (g > -5) { score -= 6 }
    else             { score -= 14; sigs.push(`Revenue declining ${g.toFixed(0)}%`) }
  }

  /* Earnings growth */
  if (f.earningsGrowth != null) {
    fields++
    const g = f.earningsGrowth * 100
    if      (g > 30) { score += 14; sigs.push(`Profit +${g.toFixed(0)}% YoY`) }
    else if (g > 15) { score += 8;  sigs.push(`Profit +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score += 3 }
    else if (g > -15){ score -= 8;  sigs.push("Profit declining") }
    else             { score -= 16; sigs.push("Profit declining sharply") }
  }

  if (fields === 0) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 72 ? "STRONG" : score >= 52 ? "FAIR" : score >= 35 ? "WEAK" : "POOR"
  const fmt = (v, mult=1, dec=1, suf="") => v != null ? (v*mult).toFixed(dec)+suf : "N/A"

  return {
    score, grade, signals: sigs.slice(0, 4), hasData: true,
   display: {
      pe:      fmt(f.trailingPE, 1, 1, "x"),
      pb:      fmt(f.priceToBook, 1, 1, "x"),
      roe:     fmt(f.roe, 100, 1, "%"),
      roce:    "N/A",
      de:      f.debtToEquity != null ? `${f.debtToEquity.toFixed(0)}%` : "N/A",
      revGrow: fmt(f.revenueGrowth, 100, 1, "%"),
      margins: !financial ? fmt(f.profitMargins, 100, 1, "%") : "N/A (bank)",
      sector:  f.sector || f.industry || "N/A",
      grade,
      targetMeanPrice:         f.targetMeanPrice         || null,
      recommendationKey:       f.recommendationKey       || null,
      numberOfAnalystOpinions: f.numberOfAnalystOpinions || null,
    }
  }
}

/* ── Goal gap urgency (0.8–1.8 multiplier) ── */
function goalGapUrgency(pos, goals) {
  const g = goals || {}
  const now = new Date()

  if (pos.currency === "INR") {
    const homeTargetINR = (g.homeBudget || 80) * 100000
    const monthsLeft    = Math.max(1, ((g.homeYear || 2030) - now.getFullYear()) * 12)
    const totalMonths   = 168  /* 14yr reference horizon */
    const timeElapsed   = 1 - (monthsLeft / totalMonths)
    /* Sum all INR positions to estimate total home fund */
    const fundedPct     = (pos.totalCurrentLocal || 0) / homeTargetINR
    if      (fundedPct < timeElapsed * 0.5) return 1.8
    else if (fundedPct < timeElapsed * 0.8) return 1.4
    else if (fundedPct < timeElapsed)       return 1.1
    else                                    return 0.9
  }

  const corpusTarget = g.corpus || 270000
  const retireAge    = g.retireAge || 50
  const currentAge   = 36
  const yearsLeft    = Math.max(1, retireAge - currentAge)
  const timeElapsed2 = 1 - (yearsLeft / 14)
  const fundedPct2   = (pos.totalCurrentEUR || 0) / corpusTarget
  if      (fundedPct2 < timeElapsed2 * 0.5) return 1.8
  else if (fundedPct2 < timeElapsed2 * 0.8) return 1.4
  else if (fundedPct2 < timeElapsed2)       return 1.1
  else                                       return 0.9
}

/* ── Goal alignment scorer (0–100) ── */
function scoreGoalAlignment(pos, goals) {
  let score = 50; const sigs = []
  const urgency = goalGapUrgency(pos, goals)

  if (pos.currency === "INR") {
    score += Math.round(15 * urgency)
    if      (urgency >= 1.8) sigs.push("Home goal severely behind — priority ADD")
    else if (urgency >= 1.4) sigs.push("Home goal behind target — add selectively")
    else if (urgency >= 1.1) sigs.push("Home goal slightly behind")
    else                     sigs.push("India — home fund on track")
  } else {
    score += Math.round(12 * urgency)
    if      (urgency >= 1.8) sigs.push("Retirement corpus severely behind")
    else if (urgency >= 1.4) sigs.push("Retirement corpus behind — priority ADD")
    else if (urgency >= 1.1) sigs.push("Retirement corpus slightly behind")
    else                     sigs.push("EUR/USD — retirement on track")
  }

  const eur = pos.totalCurrentEUR || 0
  if      (eur < 30)  { score -= 20; sigs.push("Under €30 — negligible") }
  else if (eur < 100) { score -= 8;  sigs.push("Under €100 — underfunded") }
  else if (eur > 500) { score += 5;  sigs.push(`€${eur.toFixed(0)} — meaningful position`) }

  return {
    score:   Math.max(0, Math.min(100, Math.round(score))),
    signals: sigs,
    urgency
  }
}

/* ── Verdict — Tech 25% / Fund 50% / Goal 25% ── */
function getVerdict(techScore, techVerdict, fundScore, fundHasData, goalScore, pos, urgency) {
  const composite = fundHasData
    ? Math.round(techScore * 0.25 + fundScore * 0.50 + goalScore * 0.25)
    : Math.round(techScore * 0.40 + goalScore * 0.60)

  const isBuy  = techVerdict === "BUY"  || techVerdict === "STRONG BUY"
  const isSell = techVerdict === "SELL" || techVerdict === "TRIM"
  const cur    = pos.currentPrice || 0
  const isSTCG = pos.taxType === "STCG"
  let verdict, action, priority, reasoning

  if (fundHasData) {
    if (fundScore < 30) {
      if (isSTCG && fundScore >= 20) {
        verdict="REVIEW"; priority="MEDIUM"
        reasoning="Weak fundamentals — but STCG applies, hold until LTCG conversion"
        action=`Hold until 1yr from buy date to save ~20% STCG tax. Reassess on next earnings.`
      } else {
        verdict="EXIT"; priority="HIGH"
        reasoning="Poor fundamentals — exit"
        action=`Sell all ${pos.qty||""} shares. Weak metrics confirmed.${isSTCG?" STCG tax ~20% applies.":""}`
      }
    } else if (isBuy && fundScore >= 55 && urgency >= 1.4) {
      verdict="ADD"; priority="HIGH"
      reasoning="Strong technicals + solid fundamentals + goal behind target — priority entry"
      const qty = Math.max(1, Math.round(7000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)}) — goal urgency HIGH`
        : `Add €300–400 — retirement corpus behind target`
    } else if (isBuy && fundScore >= 55) {
      verdict="ADD"; priority=composite>=75?"HIGH":"MEDIUM"
      reasoning="Strong technicals + solid fundamentals — quality entry"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)})`
        : `Add €200–300`
    } else if (isSell && fundScore >= 65) {
      verdict="HOLD"; priority="MEDIUM"
      reasoning="Weak technicals but strong fundamentals — quality business in temporary dip"
      action="Hold. Strong fundamentals override sell signal. Add if RSI drops below 35."
    } else if (isSell && fundScore >= 42) {
      verdict="REVIEW"; priority="LOW"
      reasoning="Bearish technicals + average fundamentals — monitor"
      action=`Hold. Exit only if 52-week low breaks or earnings disappoint.${isSTCG?" STCG — consider waiting for LTCG.":""}`
    } else if (isSell) {
      verdict="EXIT"; priority="HIGH"
      reasoning="Bearish technicals + weak fundamentals — confirmed exit"
      action=`Sell all ${pos.qty||""} shares. Both signals confirm exit.${isSTCG?" Note: STCG ~20% tax.":""}`
    } else if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning="Technical BUY with fair fundamentals"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)}`
        : `Add €150–200`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning="Consolidating — quality business, wait for better entry"
      action="Hold. Add on RSI < 42 or next earnings beat."
    }
  } else {
    if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning="Technical BUY — verify fundamentals on Screener.in"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} — verify Screener.in first`
        : `Add €150 — verify fundamentals first`
    } else if (isSell) {
      verdict="REVIEW"; priority="MEDIUM"
      reasoning="Technical SELL — check fundamentals before exiting"
      action=`Check Screener.in for ${pos.key} before exiting.`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning="Neutral — fundamental data unavailable"
      action="Hold. Check fundamentals on Screener.in."
    }
  }

  return { verdict, action, priority, composite, reasoning }
}

/* ── Main handler ── */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const eligible = positions.filter(p =>
    p.type !== "MutualFund" && !(p.key||"").includes("-USD")
  )

  const keyToYahoo = {}
  for (const pos of eligible) {
    const yt = toYahooTicker(pos.key, pos.currency, pos.type)
    if (yt) keyToYahoo[pos.key] = yt
  }

  const uniqueTickers = [...new Set(Object.values(keyToYahoo))]
  const oracleData    = uniqueTickers.length ? await fetchOracleBatch(uniqueTickers) : {}

  const results = {}
  for (const pos of eligible) {
    const yt   = keyToYahoo[pos.key]
    const raw  = yt ? (oracleData[yt] || null) : null
    const fund = scoreFundamentals(raw)
    const tech = techMap?.[pos.key] || {}
    const goal = scoreGoalAlignment(pos, goals || {})
    const out  = getVerdict(
      tech.score ?? 50, tech.verdict ?? "HOLD",
      fund.score, fund.hasData,
      goal.score, pos, goal.urgency
    )

    results[pos.key] = {
      ...out,
      scores:       { technical: tech.score??50, fundamental: fund.score, goalAlign: goal.score },
      signals:      { technical: tech.signals||[], fundamental: fund.signals, goalAlign: goal.signals },
      fundamentals: fund.display || {
        pe:"N/A", pb:"N/A", roe:"N/A", roce:"N/A", de:"N/A",
        revGrow:"N/A", margins:"N/A", sector:"N/A", grade:"UNKNOWN"
      }
    }
  }

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
