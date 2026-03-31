/* ============================================================
   CapIntel — api/fundamentals.js  (Vercel Serverless)

   Data sources:
   1. NSE India API  → PE, sector PE, sector, industry  (auto, free)
   2. manualFunds    → ROE, D/E, margins, growth, P/B   (user-entered from Screener.in)

   Flow:
   - Receive { positions, techMap, goals, manualFunds } from app.js
   - For Indian (.NS/.BO) stocks: fetch PE from NSE, merge with manualFunds
   - For EUR/USD stocks: score from manualFunds only (or neutral if none)
   - Score each position → verdict + signals + display fields
   - Return { results, computedAt }

   vercel.json maxDuration: 30s
   ============================================================ */

/* ── NSE session (cookies expire ~4 min) ── */
let nseSession = null

const NSE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Referer": "https://www.nseindia.com/",
  "Connection": "keep-alive"
}

async function getNSESession() {
  if (nseSession && (Date.now() - nseSession.ts) < 4 * 60 * 1000) return nseSession
  const r = await fetch("https://www.nseindia.com/", {
    headers: {
      "User-Agent": NSE_HEADERS["User-Agent"],
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9"
    }
  })
  const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  const cookie = setCookie.map(c => c.split(";")[0]).join("; ")
  if (!cookie) throw new Error("No cookies from NSE")
  nseSession = { cookie, ts: Date.now() }
  return nseSession
}

async function fetchNSEQuote(symbol) {
  const { cookie } = await getNSESession()
  const url = "https://www.nseindia.com/api/quote-equity?symbol=" + encodeURIComponent(symbol)
  const r = await fetch(url, { headers: { ...NSE_HEADERS, "Cookie": cookie } })
  if (!r.ok) throw new Error("HTTP " + r.status)
  return await r.json()
}

/* ── Merge NSE auto data + manual Screener data ── */
function mergeData(nseData, manual) {
  const n = v => { const num = parseFloat(v); return isFinite(num) && num !== 0 ? num : null }
  return {
    /* NSE auto */
    trailingPE:    nseData ? n(nseData.metadata?.pdSymbolPe)  : null,
    sectorPE:      nseData ? n(nseData.metadata?.pdSectorPe)  : null,
    sector:        nseData ? (nseData.industryInfo?.sector || null) : null,
    industry:      nseData ? (nseData.industryInfo?.basicIndustry || null) : null,
    /* Manual from Screener.in — values stored as plain % numbers (e.g. 18.5 for 18.5%) */
    roe:           manual?.roe          != null ? manual.roe          / 100 : null,
    debtToEquity:  manual?.de           != null ? manual.de           : null,
    profitMargins: manual?.margins      != null ? manual.margins      / 100 : null,
    revenueGrowth: manual?.revGrowth    != null ? manual.revGrowth    / 100 : null,
    earningsGrowth:manual?.profitGrowth != null ? manual.profitGrowth / 100 : null,
    priceToBook:   manual?.pb           != null ? manual.pb           : null,
    /* Staleness metadata */
    manualUpdatedAt: manual?.updatedAt  || null,
  }
}

/* ── Fundamental scorer (0–100) ── */
function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }
  const sigs = []; let score = 50, fields = 0

  if (f.trailingPE != null) {
    fields++
    /* Show vs sector PE if available */
    const vsStr = f.sectorPE ? ` vs sector ${f.sectorPE.toFixed(0)}x` : ""
    if      (f.trailingPE <= 0)  { score -= 15; sigs.push("Negative P/E — loss-making") }
    else if (f.trailingPE < 12)  { score += 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — undervalued${vsStr}`) }
    else if (f.trailingPE < 20)  { score += 8;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — fair${vsStr}`) }
    else if (f.trailingPE < 35)  { score += 2 }
    else if (f.trailingPE < 60)  { score -= 5;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — elevated${vsStr}`) }
    else                         { score -= 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — very high`) }

    /* Bonus/penalty for PE vs sector average */
    if (f.sectorPE && f.sectorPE > 0) {
      const discount = (f.sectorPE - f.trailingPE) / f.sectorPE
      if      (discount >  0.25) { score += 8;  sigs.push(`${Math.round(discount*100)}% below sector PE — cheap vs peers`) }
      else if (discount > 0.10)  { score += 4 }
      else if (discount < -0.25) { score -= 6;  sigs.push(`${Math.round(-discount*100)}% above sector PE — expensive vs peers`) }
    }
  }
  if (f.priceToBook != null) {
    fields++
    if      (f.priceToBook < 0)   { score -= 10 }
    else if (f.priceToBook < 1.5) { score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x — below book`) }
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
    if      (de < 0.3)  { score += 8;  sigs.push(`D/E ${de.toFixed(2)} — very low debt`) }
    else if (de < 0.8)  { score += 3 }
    else if (de < 1.5)  { score -= 3 }
    else                { score -= 10; sigs.push(`D/E ${de.toFixed(2)} — high debt`) }
  }
  if (f.revenueGrowth != null) {
    fields++
    const g = f.revenueGrowth * 100
    if      (g > 20) { score += 12; sigs.push(`Revenue +${g.toFixed(0)}% — strong growth`) }
    else if (g > 10) { score += 7;  sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score += 2 }
    else if (g > -5) { score -= 5 }
    else             { score -= 12; sigs.push(`Revenue declining ${g.toFixed(0)}%`) }
  }
  if (f.earningsGrowth != null) {
    fields++
    const g = f.earningsGrowth * 100
    if      (g > 25) { score += 12; sigs.push(`Profit +${g.toFixed(0)}% — strong growth`) }
    else if (g > 10) { score += 6 }
    else if (g > 0)  { score += 2 }
    else if (g > -15){ score -= 8;  sigs.push("Profit declining") }
    else             { score -= 15; sigs.push("Profit declining sharply") }
  }

  if (fields === 0) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 70 ? "STRONG" : score >= 50 ? "FAIR" : score >= 30 ? "WEAK" : "POOR"
  const fmt   = (v, mult=1, dec=1, suf="") => v != null ? (v*mult).toFixed(dec)+suf : "N/A"

  /* Staleness warning in display */
  let staleNote = null
  if (f.manualUpdatedAt) {
    const days = Math.floor((Date.now() - f.manualUpdatedAt) / (1000*60*60*24))
    if      (days >= 120) staleNote = `🔴 Manual data ${days}d old — re-enter from Screener.in`
    else if (days >= 90)  staleNote = `⚠️ Manual data ${days}d old — refresh soon`
  }

  return {
    score, grade, signals: sigs.slice(0, 4), hasData: true,
    display: {
      pe:      fmt(f.trailingPE, 1, 1, "x") + (f.sectorPE ? ` (sector ${f.sectorPE.toFixed(0)}x)` : ""),
      pb:      fmt(f.priceToBook, 1, 1, "x"),
      roe:     fmt(f.roe, 100, 1, "%"),
      roce:    "N/A",
      de:      f.debtToEquity != null ? f.debtToEquity.toFixed(2) : "N/A",
      revGrow: fmt(f.revenueGrowth,  100, 1, "%"),
      margins: fmt(f.profitMargins,  100, 1, "%"),
      sector:  f.sector || f.industry || "N/A",
      grade,
      staleNote,
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
      action=`Sell all ${pos.qty||""} shares — weak business metrics confirmed.`
    } else if (isBuy && fundScore >= 55) {
      verdict="ADD";    priority=composite>=72?"HIGH":"MEDIUM"
      reasoning="Strong technicals + solid fundamentals — quality entry"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)})`
        : `Add €200–300`
    } else if (isSell && fundScore >= 60) {
      verdict="HOLD";   priority="MEDIUM"
      reasoning="Weak technicals but strong fundamentals — dip in quality business"
      action="Hold. Fundamentals contradict sell signal. Add if RSI drops below 35."
    } else if (isSell && fundScore >= 40) {
      verdict="REVIEW"; priority="LOW"
      reasoning="Bearish technicals + average fundamentals — monitor closely"
      action="Hold. Exit if price breaks 52-week low or earnings disappoint."
    } else if (isSell) {
      verdict="EXIT";   priority="HIGH"
      reasoning="Bearish technicals + weak fundamentals — confirmed exit"
      action=`Sell all ${pos.qty||""} shares. Both signals confirm exit.`
    } else if (isBuy) {
      verdict="ADD";    priority="MEDIUM"
      reasoning="Technical BUY with fair fundamentals"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)}`
        : `Add €150–200`
    } else {
      verdict="HOLD";   priority="LOW"
      reasoning="Consolidating with solid fundamentals — wait for better entry"
      action="Hold. Quality business in consolidation. Add if RSI drops below 42."
    }
  } else {
    if (isBuy) {
      verdict="ADD";    priority="MEDIUM"
      reasoning="Technical BUY — add fundamentals via ✏️ for full scoring"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} — verify on Screener.in first`
        : `Add €150 — verify fundamentals first`
    } else if (isSell) {
      verdict="REVIEW"; priority="MEDIUM"
      reasoning="Technical SELL — add fundamentals via ✏️ before exiting"
      action=`Check Screener.in for ${pos.key} before exiting.`
    } else {
      verdict="HOLD";   priority="LOW"
      reasoning="Neutral — add fundamentals via ✏️ for better verdict"
      action="Hold. Enter fundamentals from Screener.in for full analysis."
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

  const { positions, techMap, goals, manualFunds } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  /* Skip MFs and crypto */
  const eligible = positions.filter(p =>
    p.type !== "MutualFund" && !(p.key||"").includes("-USD")
  )

  /* Fetch NSE data for Indian stocks in parallel */
  const nseDataMap = {}
  await Promise.all(
    eligible
      .filter(p => p.currency === "INR" || (p.key||"").match(/\.(NS|BO)$/))
      .map(async pos => {
        const symbol = (pos.key||"").replace(/\.(NS|BO)$/, "").toUpperCase()
        try {
          nseDataMap[pos.key] = await fetchNSEQuote(symbol)
          const pe = nseDataMap[pos.key]?.metadata?.pdSymbolPe
          console.log(`[nse] ${pos.key} pe=${pe}`)
        } catch(e) {
          console.error(`[nse] ${pos.key}: ${e.message}`)
          nseDataMap[pos.key] = null
        }
      })
  )

  /* Score each position */
  const results = {}
  for (const pos of eligible) {
    const nse    = nseDataMap[pos.key] || null
    const manual = manualFunds?.[pos.key] || null
    const merged = mergeData(nse, manual)
    const fund   = scoreFundamentals(merged)
    const tech   = techMap?.[pos.key] || {}
    const goal   = scoreGoalAlignment(pos, goals || {})
    const out    = getVerdict(tech.score??50, tech.verdict??"HOLD", fund.score, fund.hasData, goal.score, pos)

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
