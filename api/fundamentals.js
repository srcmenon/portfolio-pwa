/* ============================================================
   CapIntel — api/fundamentals.js   FREE — no Claude, no credits

   Fetches fundamental data from Financial Modeling Prep (FMP).
   FMP free tier: 250 calls/day, resets midnight UTC.
   Cache TTL: 7 days (fundamentals are quarterly — no need to refresh daily).

   For each position fetches:
   P/E, P/B, ROE, D/E, Revenue Growth, EPS Growth,
   Profit Margins, Current Ratio, Sector, Industry

   Scores each position on 3 dimensions:
   1. Fundamental score (0-100)
   2. Technical score   (from _techMap, sent by client)
   3. Goal alignment    (computed from investor goals)

   Composite → ADD / EXIT / HOLD / REVIEW verdict
   ============================================================ */

/* ── FMP TICKER RESOLVER ── */
function toFMPTicker(pos) {
  const t = pos.key || ""
  if (!t || pos.type === "MutualFund") return null
  if (t.includes("-USD")) return t.split("-")[0]  /* BTC-USD → BTC */
  /* Indian NSE stocks: append .NS for FMP */
  if (pos.currency === "INR") {
    const base = t.replace(/\.(NS|BO)$/, "")
    return base + ".NS"
  }
  /* EUR ETFs/stocks: FMP uses exchange suffix */
  if (t.includes(".")) return t  /* already has suffix e.g. CHIP.PA */
  if (pos.currency === "USD") return t
  if (pos.currency === "EUR") {
    if (pos.type === "ETF" || pos.type === "Commodity") return t + ".L"
    return t
  }
  return t
}

/* ── FMP API FETCH ── */
async function fetchFMPFundamentals(ticker, apiKey) {
  try {
    /* FMP profile endpoint — returns key ratios + sector + industry */
    const r1 = await fetch(
      `https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${apiKey}`,
      { headers: { "Accept": "application/json" } }
    )
    const profile = r1.ok ? await r1.json() : []
    const p = profile?.[0] || {}

    /* FMP key metrics endpoint — returns ROE, D/E, revenue growth etc */
    const r2 = await fetch(
      `https://financialmodelingprep.com/api/v3/key-metrics-ttm/${ticker}?apikey=${apiKey}`,
      { headers: { "Accept": "application/json" } }
    )
    const metrics = r2.ok ? await r2.json() : []
    const m = metrics?.[0] || {}

    /* FMP income growth endpoint */
    const r3 = await fetch(
      `https://financialmodelingprep.com/api/v3/financial-growth/${ticker}?limit=1&apikey=${apiKey}`,
      { headers: { "Accept": "application/json" } }
    )
    const growth = r3.ok ? await r3.json() : []
    const g = growth?.[0] || {}

    const n = v => (typeof v === "number" && isFinite(v)) ? v : null

    return {
      trailingPE:      n(p.pe)                    ?? n(m.peRatioTTM),
      priceToBook:     n(p.priceToBookRatio)       ?? n(m.pbRatioTTM),
      roe:             n(m.roeTTM),                /* already decimal e.g. 0.17 */
      debtToEquity:    n(m.debtToEquityTTM),
      revenueGrowth:   n(g.revenueGrowth),         /* decimal e.g. 0.12 */
      earningsGrowth:  n(g.netIncomeGrowth),
      profitMargins:   n(m.netProfitMarginTTM),    /* decimal */
      operatingMargins:n(m.operatingProfitMarginTTM),
      currentRatio:    n(m.currentRatioTTM),
      sector:          p.sector   || null,
      industry:        p.industry || null,
      marketCap:       n(p.mktCap),
      beta:            n(p.beta),
    }
  } catch(e) { return null }
}

/* ── FUNDAMENTAL SCORER (0-100) ── */
function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: ["No fundamental data"], grade: "UNKNOWN", display: null }

  const sigs = []
  let score  = 50
  let hasData = false

  if (f.trailingPE != null) {
    hasData = true
    if      (f.trailingPE <= 0)  { score -= 15; sigs.push(`Negative P/E — loss-making`) }
    else if (f.trailingPE < 12)  { score += 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE < 20)  { score += 8;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — fair`) }
    else if (f.trailingPE < 35)  { score += 2 }
    else if (f.trailingPE < 60)  { score -= 5;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — elevated`) }
    else                         { score -= 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — very high`) }
  }

  if (f.priceToBook != null) {
    hasData = true
    if      (f.priceToBook < 0)  { score -= 10 }
    else if (f.priceToBook < 1.5){ score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x — near book`) }
    else if (f.priceToBook < 3)  { score += 4 }
    else if (f.priceToBook > 6)  { score -= 8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }

  if (f.roe != null) {
    hasData = true
    const r = f.roe * 100
    if      (r > 25) { score += 15; sigs.push(`Excellent ROE ${r.toFixed(0)}%`) }
    else if (r > 15) { score += 10; sigs.push(`Good ROE ${r.toFixed(0)}%`) }
    else if (r > 8)  { score += 4 }
    else if (r > 0)  { score -= 5;  sigs.push(`Weak ROE ${r.toFixed(0)}%`) }
    else             { score -= 15; sigs.push(`Negative ROE`) }
  }

  if (f.debtToEquity != null) {
    hasData = true
    const de = f.debtToEquity
    if      (de < 0.2) { score += 10; sigs.push(`Low debt D/E ${de.toFixed(2)}`) }
    else if (de < 0.5) { score += 5 }
    else if (de < 1)   { score -= 3 }
    else if (de < 2)   { score -= 8;  sigs.push(`High debt D/E ${de.toFixed(1)}`) }
    else               { score -= 15; sigs.push(`Excessive debt D/E ${de.toFixed(1)}`) }
  }

  if (f.revenueGrowth != null) {
    hasData = true
    const g = f.revenueGrowth * 100
    if      (g > 20) { score += 12; sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score += 7;  sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score += 2 }
    else             { score -= 10; sigs.push(`Revenue shrinking ${g.toFixed(0)}%`) }
  }

  if (f.earningsGrowth != null) {
    hasData = true
    const g = f.earningsGrowth * 100
    if      (g > 25) { score += 12; sigs.push(`Earnings +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score += 6 }
    else if (g > 0)  { score += 1 }
    else             { score -= 10; sigs.push(`Earnings declining ${g.toFixed(0)}%`) }
  }

  if (f.profitMargins != null) {
    hasData = true
    const m = f.profitMargins * 100
    if      (m > 20) { score += 8;  sigs.push(`Strong margins ${m.toFixed(0)}%`) }
    else if (m > 10) { score += 4 }
    else if (m < 0)  { score -= 12; sigs.push(`Negative margins`) }
  }

  if (!hasData) return { score: 50, signals: ["No FMP data for this ticker"], grade: "UNKNOWN", display: null }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score>=70?"STRONG":score>=50?"FAIR":score>=30?"WEAK":"POOR"

  const fmt = (v, suffix="", mult=1, dec=1) =>
    v != null ? (v*mult).toFixed(dec) + suffix : "N/A"

  const display = {
    pe:      fmt(f.trailingPE,    "x", 1, 1),
    pb:      fmt(f.priceToBook,   "x", 1, 1),
    roe:     fmt(f.roe,           "%", 100, 1),
    de:      fmt(f.debtToEquity,  "",  1,   2),
    revGrow: fmt(f.revenueGrowth, "%", 100, 1),
    margins: fmt(f.profitMargins, "%", 100, 1),
    sector:  f.sector || "N/A",
    grade
  }

  return { score, signals: sigs.slice(0,3), grade, display }
}

/* ── GOAL ALIGNMENT SCORER (0-100) ── */
function scoreGoalAlignment(pos, goals) {
  let score = 50; const sigs = []
  const retireYrs = (goals.retireAge||50) - 36

  if (pos.currency === "INR") {
    score += 10; sigs.push("India — home fund aligned")
    const good = ["financial","bank","finance","technology","software","consumer",
                  "healthcare","pharma","infrastructure","capital goods","it","nbfc"]
    const bad  = ["power","telecom","oil","gas","commodity","coal","mining"]
    const ind  = (pos.industry||pos.sector||"").toLowerCase()
    if (good.some(s=>ind.includes(s))) { score+=10; sigs.push("Quality sector") }
    if (bad.some(s=>ind.includes(s)))  { score-=8;  sigs.push("Cyclical/PSU") }
  } else {
    score+=10; sigs.push("EUR/USD — retirement corpus aligned")
  }

  if      ((pos.totalCurrentEUR||0) < 30)  { score-=20; sigs.push("Too small to move the needle") }
  else if ((pos.totalCurrentEUR||0) < 100) { score-=8 }
  if (retireYrs >= 10) score += 5

  return { score: Math.max(0,Math.min(100,Math.round(score))), signals: sigs }
}

/* ── COMPOSITE VERDICT ── */
function getVerdict(techScore, techVerdict, fundScore, goalScore, pos) {
  const composite = Math.round(techScore*0.40 + fundScore*0.35 + goalScore*0.25)
  const isBuy     = techVerdict==="BUY"||techVerdict==="STRONG BUY"
  const isSell    = techVerdict==="SELL"||techVerdict==="TRIM"
  const cur       = pos.currentPrice || 0
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
    action=`Hold — good business, wait for better entry. Review when RSI drops below 40.`
  } else {
    verdict="REVIEW"; priority="LOW"
    action=`Mixed signals — hold current position, reassess next month.`
  }
  return { verdict, action, priority, composite }
}

/* ── MAIN HANDLER ── */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error:"POST only" })

  const apiKey = process.env.FMP_API_KEY
  if (!apiKey) return res.status(500).json({ error:"FMP_API_KEY not set in Vercel environment" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error:"positions required" })

  const results = {}

  /* Batch of 3 to respect FMP rate limits on free tier */
  const BATCH = 3
  for (let i=0; i<positions.length; i+=BATCH) {
    const batch = positions.slice(i, i+BATCH)
    await Promise.all(batch.map(async pos => {
      const fmpTicker = toFMPTicker(pos)
      if (!fmpTicker) return

      const f = await fetchFMPFundamentals(fmpTicker, apiKey)
      const { score: fundScore, signals: fundSigs, grade, display } = scoreFundamentals(f)

      const tech        = techMap?.[pos.key] || {}
      const techScore   = tech.score   ?? 50
      const techVerdict = tech.verdict ?? "HOLD"
      const techSigs    = tech.signals ?? []

      const enriched = { ...pos, industry: f?.industry, sector: f?.sector }
      const { score: goalScore, signals: goalSigs } = scoreGoalAlignment(enriched, goals||{})
      const { verdict, action, priority, composite } =
        getVerdict(techScore, techVerdict, fundScore, goalScore, pos)

      results[pos.key] = {
        verdict, action, priority, composite,
        scores:       { technical:techScore, fundamental:fundScore, goalAlign:goalScore },
        signals:      { technical:techSigs,  fundamental:fundSigs,  goalAlign:goalSigs },
        fundamentals: display || {
          pe:"N/A", pb:"N/A", roe:"N/A", de:"N/A",
          revGrow:"N/A", margins:"N/A", sector:"N/A", grade
        }
      }
    }))
  }

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
