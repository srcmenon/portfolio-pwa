/* ============================================================
   CapIntel — api/fundamentals.js  (Vercel Serverless)

   Fetches fundamentals for ALL portfolio positions via the
   Oracle Always Free VM running yahoo-finance2 (not blocked).

   Flow:
     1. Resolve each pos.key → Yahoo ticker (mirrors resolveTicker in app.js)
     2. Single batch POST to Oracle VM /fundamentals/batch
     3. Score each result → verdict / signals / display fields
     4. Return { results, computedAt }

   No Apify. No direct Yahoo calls from Vercel (blocked on AWS IPs).
   100% free. Typical latency: 5–10s for 30+ tickers.
   ============================================================ */

/* ── Mirror app.js resolveTicker() logic ── */
function toYahooTicker(key, currency, type) {
  if (!key) return null
  if (key.includes("-USD"))          return key           // Crypto — skip fundamentals
  if (key.includes("."))             return key           // already has exchange suffix
  if (key === "SEMI")                return "CHIP.PA"     // Amundi Semiconductors
  if (key === "EWG2")                return "EWG2.SG"     // EUWAX Gold II
  if (currency === "USD")            return key           // US stocks
  if (currency === "EUR") {
    const t = (type || "").toLowerCase()
    if (t === "etf" || t === "commodity") return key + ".L"
    return key                                            // EUR stocks (US-listed fractions)
  }
  return key + ".NS"                                      // default: NSE India
}

/* ── Batch fetch from Oracle VM ── */
async function fetchOracleBatch(tickers) {
  const baseUrl = process.env.FUNDAMENTALS_URL
  if (!baseUrl) {
    console.error("[oracle] FUNDAMENTALS_URL env var not set")
    return {}
  }
  try {
    const r = await fetch(`${baseUrl}/fundamentals/batch`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ tickers })
    })
    if (!r.ok) { console.error(`[oracle] HTTP ${r.status}`); return {} }
    const data = await r.json()
    console.log(`[oracle] fetched ${Object.keys(data.results||{}).length}/${tickers.length} tickers`)
    return data.results || {}
  } catch(e) {
    console.error(`[oracle] ${e.message}`)
    return {}
  }
}

/* ── Fundamental scorer (0–100) ── */
function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }
  const sigs = []; let score = 50, fields = 0

  if (f.trailingPE != null) {
    fields++
    if      (f.trailingPE <= 0)  { score -= 15; sigs.push("Negative P/E — loss-making") }
    else if (f.trailingPE < 12)  { score += 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE < 20)  { score += 8;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — fair`) }
    else if (f.trailingPE < 35)  { score += 2 }
    else if (f.trailingPE < 60)  { score -= 5;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — elevated`) }
    else                         { score -= 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — very high`) }
  }
  if (f.priceToBook != null) {
    fields++
    if      (f.priceToBook < 0)   { score -= 10 }
    else if (f.priceToBook < 1.5) { score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x`) }
    else if (f.priceToBook < 3)   { score += 4 }
    else if (f.priceToBook > 6)   { score -= 8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }
  if (f.roe != null) {
    fields++
    const r = f.roe * 100
    if      (r > 25) { score += 15; sigs.push(`ROE ${r.toFixed(0)}% — excellent`) }
    else if (r > 15) { score += 10; sigs.push(`ROE ${r.toFixed(0)}% — good`) }
    else if (r > 8)  { score += 4 }
    else if (r > 0)  { score -= 5;  sigs.push(`ROE ${r.toFixed(0)}% — weak`) }
    else             { score -= 15; sigs.push("Negative ROE") }
  }
  if (f.profitMargins != null) {
    fields++
    const m = f.profitMargins * 100
    if      (m > 20) { score += 10; sigs.push(`Net margin ${m.toFixed(0)}% — excellent`) }
    else if (m > 10) { score += 5;  sigs.push(`Net margin ${m.toFixed(0)}%`) }
    else if (m > 0)  { score += 1 }
    else             { score -= 10; sigs.push(`Negative margin ${m.toFixed(0)}%`) }
  }
  if (f.debtToEquity != null) {
    fields++
    const de = f.debtToEquity
    if      (de < 30)  { score += 8;  sigs.push(`D/E ${de.toFixed(0)}% — low debt`) }
    else if (de < 80)  { score += 3 }
    else if (de < 150) { score -= 3 }
    else               { score -= 10; sigs.push(`D/E ${de.toFixed(0)}% — high debt`) }
  }
  if (f.revenueGrowth != null) {
    fields++
    const g = f.revenueGrowth * 100
    if      (g > 20) { score += 12; sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score += 7;  sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score += 2 }
    else if (g > -5) { score -= 5 }
    else             { score -= 12; sigs.push(`Revenue declining ${g.toFixed(0)}%`) }
  }
  if (f.earningsGrowth != null) {
    fields++
    const g = f.earningsGrowth * 100
    if      (g > 25) { score += 12; sigs.push(`Profit +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score += 6 }
    else if (g > 0)  { score += 2 }
    else if (g > -15){ score -= 8;  sigs.push("Profit declining") }
    else             { score -= 15; sigs.push("Profit declining sharply") }
  }

  if (fields === 0) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 70 ? "STRONG" : score >= 50 ? "FAIR" : score >= 30 ? "WEAK" : "POOR"
  const fmt   = (v, mult=1, dec=1, suf="") => v != null ? (v*mult).toFixed(dec)+suf : "N/A"

  return {
    score, grade, signals: sigs.slice(0, 4), hasData: true,
    display: {
      pe:      fmt(f.trailingPE,    1,   1, "x"),
      pb:      fmt(f.priceToBook,   1,   1, "x"),
      roe:     fmt(f.roe,           100, 1, "%"),
      roce:    "N/A",
      de:      f.debtToEquity != null ? `${f.debtToEquity.toFixed(0)}%` : "N/A",
      revGrow: fmt(f.revenueGrowth, 100, 1, "%"),
      margins: fmt(f.profitMargins, 100, 1, "%"),
      sector:  f.sector || f.industry || "N/A",
      grade,
    }
  }
}

/* ── Goal alignment scorer (0–100) ── */
function scoreGoalAlignment(pos, goals) {
  let score = 50; const sigs = []
  if (pos.currency === "INR") { score += 10; sigs.push("India — home fund aligned") }
  else                        { score += 10; sigs.push("EUR/USD — retirement corpus") }
  const eur = pos.totalCurrentEUR || 0
  if      (eur < 30)  { score -= 20; sigs.push("Under €30 — negligible") }
  else if (eur < 100) { score -= 8;  sigs.push("Under €100 — underfunded") }
  if ((goals.retireAge || 50) - 36 >= 10) score += 6
  return { score: Math.max(0, Math.min(100, Math.round(score))), signals: sigs }
}

/* ── Composite verdict ── */
function getVerdict(techScore, techVerdict, fundScore, fundHasData, goalScore, pos) {
  const composite = fundHasData
    ? Math.round(techScore*0.40 + fundScore*0.35 + goalScore*0.25)
    : Math.round(techScore*0.65 + goalScore*0.35)
  const isBuy  = techVerdict === "BUY"  || techVerdict === "STRONG BUY"
  const isSell = techVerdict === "SELL" || techVerdict === "TRIM"
  const cur    = pos.currentPrice || 0
  let verdict, action, priority, reasoning

  if (fundHasData) {
    if (fundScore < 30) {
      verdict="EXIT";   priority="HIGH"
      reasoning="Poor fundamentals confirm exit"
      action=`Sell all ${pos.qty||""} shares — weak business metrics confirmed by data.`
    } else if (isBuy && fundScore >= 55) {
      verdict="ADD";    priority=composite>=72?"HIGH":"MEDIUM"
      reasoning="Strong technicals + solid fundamentals — quality entry"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)}) — builds to meaningful size`
        : `Add €200–300 — underfunded quality position`
    } else if (isSell && fundScore >= 60) {
      verdict="HOLD";   priority="MEDIUM"
      reasoning="Weak technicals but strong fundamentals — temporary dip in quality business"
      action="Hold. Fundamentals (ROE, growth) contradict sell signal. Add if RSI drops below 35."
    } else if (isSell && fundScore >= 40) {
      verdict="REVIEW"; priority="LOW"
      reasoning="Bearish technicals + average fundamentals — monitor closely"
      action="Hold. Exit if price breaks 52-week low or next quarter earnings disappoint."
    } else if (isSell) {
      verdict="EXIT";   priority="HIGH"
      reasoning="Bearish technicals + weak fundamentals — confirmed exit"
      action=`Sell all ${pos.qty||""} shares. Both signals confirm exit. Redeploy to stronger position.`
    } else if (isBuy) {
      verdict="ADD";    priority="MEDIUM"
      reasoning="Technical BUY with fair fundamentals"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)})`
        : `Add €150–200`
    } else {
      verdict="HOLD";   priority="LOW"
      reasoning="Consolidating with solid fundamentals — wait for better entry"
      action="Hold. Quality business in consolidation. Add if RSI drops below 42."
    }
  } else {
    if (isBuy) {
      verdict="ADD";    priority="MEDIUM"
      reasoning="Technical BUY — fundamentals unavailable from Yahoo"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} — verify on Screener.in first`
        : `Add €150 — verify fundamentals first`
    } else if (isSell) {
      verdict="REVIEW"; priority="MEDIUM"
      reasoning="Technical SELL — check Screener.in before exiting"
      action=`Check Screener.in for ${pos.key} fundamentals before exiting.`
    } else {
      verdict="HOLD";   priority="LOW"
      reasoning="Neutral — fundamentals unavailable"
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

  /* Skip MFs and crypto (no Yahoo fundamentals) */
  const eligible = positions.filter(p =>
    p.type !== "MutualFund" && !(p.key||"").includes("-USD")
  )

  /* Resolve each key → Yahoo ticker, build reverse map for lookup */
  const keyToYahoo = {}   // posKey → yahooTicker
  for (const pos of eligible) {
    const yt = toYahooTicker(pos.key, pos.currency, pos.type)
    if (yt) keyToYahoo[pos.key] = yt
  }

  /* Single batch call to Oracle VM */
  const uniqueTickers = [...new Set(Object.values(keyToYahoo))]
  const oracleData    = uniqueTickers.length ? await fetchOracleBatch(uniqueTickers) : {}

  /* Score and build results */
  const results = {}
  for (const pos of eligible) {
    const yt   = keyToYahoo[pos.key]
    const raw  = yt ? (oracleData[yt] || null) : null
    const fund = scoreFundamentals(raw)
    const tech = techMap?.[pos.key] || {}
    const goal = scoreGoalAlignment(pos, goals || {})
    const out  = getVerdict(tech.score??50, tech.verdict??"HOLD", fund.score, fund.hasData, goal.score, pos)

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
