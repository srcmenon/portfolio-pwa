/* ============================================================
   CapIntel — api/fundamentals.js

   Finnhub institutional-grade fundamentals API.
   Free tier: 60 calls/minute. No cookies, no scraping.
   Works reliably from Vercel server-side.

   TICKER FORMAT:
   - Indian NSE: "NSE:HDFCBANK", "NSE:BERGEPAINT"
   - US stocks:  "AAPL", "GOOGL", "ISRG"
   - EUR stocks: "CHIP.PA", "IWDA.L", "EWG2.SG"

   TWO ENDPOINTS PER STOCK:
   1. /stock/profile2  → sector, industry, marketCap
   2. /stock/metric    → 117 fundamental metrics (PE, PB, ROE, D/E, margins, growth)

   KEY METRIC FIELDS (confirmed from Finnhub docs):
   - peBasicExclExtraTTM   P/E TTM
   - pbAnnual              Price/Book
   - roeTTM                Return on Equity (%) — divide by 100
   - totalDebt/totalEquityAnnual  Debt/Equity
   - revenueGrowthTTMYoy   Revenue growth YoY (%)
   - epsGrowthTTMYoy       EPS growth YoY (%)
   - netProfitMarginTTM    Net margin (%) — divide by 100

   SCORING: Three dimensions, composited to ADD/EXIT/HOLD/REVIEW
   1. Fundamental score (0-100) — P/E, P/B, ROE, D/E, growth, margins
   2. Technical score   (0-100) — from client _techMap
   3. Goal alignment    (0-100) — computed from investor goals config

   CACHE: 7 days — fundamentals are quarterly reports
   ============================================================ */

/* ── TICKER RESOLVER ── */
/* Known mismatches: NSE display ticker → Finnhub symbol */
const NSE_TICKER_MAP = {
  "LTFOODS":     "NSE:LTOL",
  "ENGINERSIN":  "NSE:ENGINERSIN",  /* verify */
  "KIRLPNU":     "NSE:KIRLPNU",
  "BERGEPAINT":  "NSE:BRGR",
  "SUNDARMFIN":  "NSE:SFL",
  "HDFCBANK":    "NSE:HDFCB",
  "HINDUNILVR":  "NSE:HLL",
  "SHRIRAMFIN":  "NSE:SHFL",
  "PERSISTENT":  "NSE:PSYS",
  "NATIONALUM":  "NSE:NATL",
  "CRISIL":      "NSE:CRISIL",
  "NMDC":        "NSE:NMDC",
  "POWERGRID":   "NSE:PGRD",
  "IDFCFIRSTB":  "NSE:IDFCFB",
  "RECLTD":      "NSE:RECL",
  "SBIN":        "NSE:SBI",
  "CDSL":        "NSE:CDSL",
  "OFSS":        "NSE:OFSS",
}

async function resolveNSETicker(nseTicker, apiKey) {
  /* First try the known mapping */
  if (NSE_TICKER_MAP[nseTicker]) return NSE_TICKER_MAP[nseTicker]

  /* Fall back: use Finnhub symbol search to find the correct symbol */
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/search?q=${encodeURIComponent(nseTicker)}&exchange=NS`,
      { headers: { "X-Finnhub-Token": apiKey, "Accept": "application/json" } }
    )
    if (!r.ok) return `NSE:${nseTicker}`  /* fallback to direct format */
    const d = await r.json()
    const results = d.result || []

    /* Find exact match on displaySymbol or description */
    const exact = results.find(r =>
      r.displaySymbol === nseTicker ||
      r.symbol === `NSE:${nseTicker}` ||
      r.symbol?.endsWith(`:${nseTicker}`)
    )
    if (exact?.symbol) return exact.symbol

    /* Best partial match */
    const partial = results.find(r =>
      r.type === "Common Stock" &&
      (r.displaySymbol?.includes(nseTicker) || r.description?.toUpperCase().includes(nseTicker))
    )
    if (partial?.symbol) return partial.symbol

    return `NSE:${nseTicker}`  /* fallback */
  } catch(e) {
    return `NSE:${nseTicker}`
  }
}

function toFinnhubTicker(pos) {
  const t = (pos.key || "").replace(/\.(NS|BO)$/, "")
  if (!t || pos.type === "MutualFund") return null

  /* EUR/USD — map known ETF/stock symbols */
  if (pos.currency !== "INR") {
    if (t === "SEMI")  return "CHIP.PA"
    if (t === "EWG2")  return "EWG2.SG"
    if (t === "DFNS")  return "DFNS.L"
    if (t === "IWDA")  return "IWDA.L"
    if (t === "EIMI")  return "EIMI.L"
    if (t === "SSLV")  return "SSLV.L"
    if (t === "SGLN")  return "SGLN.L"
    if (t.includes("-USD")) return null
    return t
  }

  /* INR — return the key for async resolution */
  return t  /* will be resolved via resolveNSETicker() */
}

/* ── FINNHUB API FETCH ── */
async function fetchFinnhub(symbol, apiKey) {
  const BASE = "https://finnhub.io/api/v1"
  const headers = {
    "X-Finnhub-Token": apiKey,
    "Accept":          "application/json"
  }

  try {
    /* Parallel fetch — profile + metrics */
    const [r1, r2] = await Promise.all([
      fetch(`${BASE}/stock/profile2?symbol=${encodeURIComponent(symbol)}`, { headers }),
      fetch(`${BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`, { headers })
    ])

    const profile = r1.ok ? await r1.json() : {}
    const metricRes = r2.ok ? await r2.json() : {}
    const m = metricRes.metric || {}

    /* Check if we got any real data — empty response means ticker not covered */
    if (!profile.name && Object.keys(m).length === 0) return null

    const n = v => (typeof v === "number" && isFinite(v) && v !== 0) ? v : null

    /* ROE and margins come as percentages from Finnhub — convert to decimal */
    const pctToDecimal = v => n(v) !== null ? v / 100 : null

    return {
      /* Valuation */
      trailingPE:      n(m.peBasicExclExtraTTM)    ?? n(m.peTTM)            ?? n(m.peAnnual),
      priceToBook:     n(m.pbAnnual)                ?? n(m.pbQuarterly),

      /* Profitability */
      roe:             pctToDecimal(m.roeTTM)        ?? pctToDecimal(m.roeAnnual),
      roa:             pctToDecimal(m.roaTTM)        ?? pctToDecimal(m.roaAnnual),
      profitMargins:   pctToDecimal(m.netProfitMarginTTM),
      operatingMargins:pctToDecimal(m.operatingMarginTTM),
      grossMargins:    pctToDecimal(m.grossMarginTTM),

      /* Leverage */
      debtToEquity:    n(m["totalDebt/totalEquityAnnual"]) ??
                       n(m["longTermDebt/equityAnnual"]),

      /* Growth */
      revenueGrowth:   pctToDecimal(m.revenueGrowthTTMYoy)  ??
                       pctToDecimal(m.revenueGrowth3Y),
      earningsGrowth:  pctToDecimal(m.epsGrowthTTMYoy)      ??
                       pctToDecimal(m.epsGrowth3Y),

      /* Liquidity */
      currentRatio:    n(m.currentRatioAnnual),

      /* Company info */
      sector:          profile.finnhubIndustry  || profile.sector || null,
      industry:        profile.finnhubIndustry  || null,
      marketCap:       n(profile.marketCapitalization),
      beta:            n(m.beta),

      /* 52-week context */
      week52High:      n(m["52WeekHigh"]),
      week52Low:       n(m["52WeekLow"]),
      week52Return:    pctToDecimal(m["52WeekPriceReturnDaily"]),
    }
  } catch(e) {
    console.error(`Finnhub fetch failed for ${symbol}:`, e.message)
    return null
  }
}

/* ── FUNDAMENTAL SCORER (0-100) ── */
function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  const sigs = []
  let score = 50
  let fields = 0  /* count how many real data points we have */

  /* P/E — valuation */
  if (f.trailingPE != null) {
    fields++
    if      (f.trailingPE <= 0)  { score -= 15; sigs.push(`Negative P/E — loss-making`) }
    else if (f.trailingPE < 12)  { score += 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE < 20)  { score += 8;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — fair value`) }
    else if (f.trailingPE < 35)  { score += 2 }
    else if (f.trailingPE < 60)  { score -= 5;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — elevated`) }
    else                         { score -= 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — very high`) }
  }

  /* P/B — balance sheet quality */
  if (f.priceToBook != null) {
    fields++
    if      (f.priceToBook < 0)  { score -= 10; sigs.push(`Negative book value`) }
    else if (f.priceToBook < 1.5){ score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x — near book value`) }
    else if (f.priceToBook < 3)  { score += 4 }
    else if (f.priceToBook > 6)  { score -= 8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }

  /* ROE — how well management uses capital */
  if (f.roe != null) {
    fields++
    const r = f.roe * 100
    if      (r > 25) { score += 15; sigs.push(`ROE ${r.toFixed(0)}% — excellent capital efficiency`) }
    else if (r > 15) { score += 10; sigs.push(`ROE ${r.toFixed(0)}% — good`) }
    else if (r > 8)  { score += 4 }
    else if (r > 0)  { score -= 5;  sigs.push(`ROE ${r.toFixed(0)}% — weak`) }
    else             { score -= 15; sigs.push(`Negative ROE — destroying value`) }
  }

  /* D/E — financial risk */
  if (f.debtToEquity != null) {
    fields++
    const de = f.debtToEquity
    if      (de < 0.2) { score += 10; sigs.push(`Low debt D/E ${de.toFixed(2)} — fortress balance sheet`) }
    else if (de < 0.5) { score += 6 }
    else if (de < 1.0) { score += 0 }
    else if (de < 2.0) { score -= 8;  sigs.push(`High debt D/E ${de.toFixed(1)}`) }
    else               { score -= 15; sigs.push(`Excessive debt D/E ${de.toFixed(1)} — high risk`) }
  }

  /* Revenue growth — business momentum */
  if (f.revenueGrowth != null) {
    fields++
    const g = f.revenueGrowth * 100
    if      (g > 20) { score += 12; sigs.push(`Revenue +${g.toFixed(0)}% YoY — strong growth`) }
    else if (g > 10) { score += 7;  sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score += 2 }
    else if (g > -5) { score -= 5;  sigs.push(`Revenue flat/slightly declining`) }
    else             { score -= 12; sigs.push(`Revenue declining ${g.toFixed(0)}% YoY`) }
  }

  /* EPS growth — earnings quality */
  if (f.earningsGrowth != null) {
    fields++
    const g = f.earningsGrowth * 100
    if      (g > 25) { score += 12; sigs.push(`EPS +${g.toFixed(0)}% YoY — strong earnings growth`) }
    else if (g > 10) { score += 6;  sigs.push(`EPS +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score += 2 }
    else if (g > -15){ score -= 8;  sigs.push(`EPS declining ${g.toFixed(0)}%`) }
    else             { score -= 15; sigs.push(`EPS declining severely ${g.toFixed(0)}%`) }
  }

  /* Net profit margin — business quality */
  if (f.profitMargins != null) {
    fields++
    const m = f.profitMargins * 100
    if      (m > 25) { score += 10; sigs.push(`Excellent margins ${m.toFixed(0)}%`) }
    else if (m > 15) { score += 6;  sigs.push(`Good margins ${m.toFixed(0)}%`) }
    else if (m > 8)  { score += 2 }
    else if (m > 0)  { score -= 3 }
    else             { score -= 12; sigs.push(`Negative margins — unprofitable`) }
  }

  if (fields === 0) {
    return { score: 50, signals: ["No fundamental data from Finnhub for this ticker"], grade: "UNKNOWN", hasData: false, display: null }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 70 ? "STRONG" : score >= 50 ? "FAIR" : score >= 30 ? "WEAK" : "POOR"

  const fmt = (v, mult=1, dec=1, suf="", fallback="N/A") =>
    v != null ? (v * mult).toFixed(dec) + suf : fallback

  return {
    score, grade,
    signals: sigs.slice(0, 4),
    hasData: true,
    display: {
      pe:      fmt(f.trailingPE,   1,   1, "x"),
      pb:      fmt(f.priceToBook,  1,   1, "x"),
      roe:     fmt(f.roe,          100, 1, "%"),
      de:      fmt(f.debtToEquity, 1,   2, ""),
      revGrow: fmt(f.revenueGrowth,100, 1, "%"),
      margins: fmt(f.profitMargins,100, 1, "%"),
      sector:  f.sector || "N/A",
      grade
    }
  }
}

/* ── GOAL ALIGNMENT SCORER (0-100) ── */
function scoreGoalAlignment(pos, sector, goals) {
  let score = 50
  const sigs = []
  const retireYrs  = (goals.retireAge  || 50) - 36
  const homeBudget = goals.homeBudget  || 8000000  /* ₹80L */

  if (pos.currency === "INR") {
    score += 10
    sigs.push("India — home purchase fund")

    /* High-quality sectors get bonus */
    const goodSectors = [
      "banks","financial services","nbfc","insurance","asset management",
      "software & it services","technology","it","pharmaceuticals","healthcare services",
      "consumer goods","fmcg","retailing",
      "capital goods","industrial machinery","engineering",
      "chemicals","specialty chemicals",
      "ratings & research","analytics"
    ]
    const badSectors = [
      "utilities","power","oil & gas","metals","mining",
      "telecom","cement","real estate"
    ]
    const s = (sector || "").toLowerCase()
    if (goodSectors.some(g => s.includes(g))) { score += 12; sigs.push(`Quality sector: ${sector}`) }
    if (badSectors.some(b => s.includes(b)))  { score -= 8;  sigs.push(`Cyclical sector: ${sector}`) }

  } else {
    score += 10
    sigs.push(`EUR/USD — retirement corpus (${retireYrs}yr horizon)`)
  }

  /* Size penalty — too small to meaningfully serve either goal */
  const eur = pos.totalCurrentEUR || 0
  if      (eur < 30)  { score -= 20; sigs.push("Under €30 — negligible size") }
  else if (eur < 100) { score -= 8;  sigs.push("Under €100 — underfunded") }
  else if (eur < 500) { score -= 3 }

  /* Long horizon bonus for aggressive growth */
  if (retireYrs >= 10) score += 6

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    signals: sigs
  }
}

/* ── COMPOSITE VERDICT ── */
function getVerdict(techScore, techVerdict, fundScore, fundHasData, goalScore, pos) {
  /* If no fundamental data: weight technicals 65%, goal 35% */
  const composite = fundHasData
    ? Math.round(techScore * 0.40 + fundScore * 0.35 + goalScore * 0.25)
    : Math.round(techScore * 0.65 + goalScore * 0.35)

  const isBuy      = techVerdict === "BUY" || techVerdict === "STRONG BUY"
  const isSell     = techVerdict === "SELL" || techVerdict === "TRIM"
  const isHold     = techVerdict === "HOLD"
  const cur        = pos.currentPrice || 0
  const currency   = pos.currency || "INR"

  let verdict, action, priority, reasoning

  /* ── KEY DECISION RULE ──
     Technicals tell you WHEN. Fundamentals tell you WHAT.
     A bad technical on a great business = temporary dip, HOLD.
     A bad fundamental on any technical   = exit, no matter the signal.
     A good technical on a great business = ADD.
  */

  if (fundHasData) {
    if (fundScore < 30) {
      /* Weak fundamentals override everything — exit regardless of technicals */
      verdict="EXIT"; priority="HIGH"
      reasoning = "Poor fundamentals confirm exit — weak business metrics"
      action = `Sell all ${pos.qty||""} shares. Business quality insufficient for long-term holding.`
    } else if (isBuy && fundScore >= 55) {
      /* Strong technicals + decent/good fundamentals = clear ADD */
      verdict="ADD"; priority=composite>=72?"HIGH":"MEDIUM"
      reasoning = "Strong technical momentum + solid fundamentals = quality entry"
      const addQty = Math.max(1, Math.round(5000 / (cur||1)))
      action = currency === "INR"
        ? `Add ${addQty} shares at ₹${cur.toFixed(0)} (≈₹${(addQty*cur).toFixed(0)}) — builds to meaningful size`
        : `Add €200-300 — underfunded quality position`
    } else if (isSell && fundScore >= 60) {
      /* Technicals bearish BUT strong fundamentals — this is a dip in a quality business */
      verdict="HOLD"; priority="MEDIUM"
      reasoning = "Weak technicals but strong fundamentals — temporary dip in quality business"
      action = `Hold. Strong business metrics (ROE, growth) contradict sell signal. Add only if RSI drops below 35 and holds there.`
    } else if (isSell && fundScore >= 40) {
      /* Mixed — weak technicals, mediocre fundamentals */
      verdict="REVIEW"; priority="LOW"
      reasoning = "Bearish technicals + average fundamentals — monitor closely"
      action = `Hold but watch closely. If price breaks 52-week low, exit. If fundamentals deteriorate next quarter, exit.`
    } else if (isSell && fundScore < 40) {
      verdict="EXIT"; priority="HIGH"
      reasoning = "Bearish technicals + weak fundamentals = clear exit"
      action = `Sell all ${pos.qty||""} shares. Both technicals and fundamentals confirm exit.`
    } else if (isHold && fundScore >= 55) {
      verdict="HOLD"; priority="LOW"
      reasoning = "Consolidating with solid fundamentals — wait for better entry"
      action = `Hold. Quality business in consolidation phase. Consider adding if RSI drops below 42.`
    } else {
      verdict="REVIEW"; priority="LOW"
      reasoning = "Mixed signals across technicals and fundamentals"
      action = `Hold current position. Reassess after next quarterly earnings.`
    }
  } else {
    /* No fundamental data — technicals-only verdict */
    if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning = "Technical BUY signal (no fundamental data available)"
      const addQty = Math.max(1, Math.round(5000/(cur||1)))
      action = currency==="INR"
        ? `Add ${addQty} shares at ₹${cur.toFixed(0)} — technical signal positive. Verify fundamentals on Screener.in before committing large capital.`
        : `Add €200 — technical signal positive. Verify fundamentals before large add.`
    } else if (isSell) {
      verdict="REVIEW"; priority="MEDIUM"
      reasoning = "Technical SELL signal but no fundamental data to confirm"
      action = `Do not exit purely on technicals without checking fundamentals. Check Screener.in for ${pos.key} before deciding.`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning = "Neutral technicals, no fundamental data"
      action = `Hold. Check fundamentals on Screener.in before adding or exiting.`
    }
  }

  return { verdict, action, priority, composite, reasoning }
}

/* ── MAIN HANDLER ── */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" })

  const apiKey = process.env.FINNHUB_API_KEY
  if (!apiKey) return res.status(500).json({ error: "FINNHUB_API_KEY not set in Vercel environment variables" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const results = {}

  /* Process in batches of 3 — Finnhub free tier: 60 calls/min, 2 calls per position */
  const BATCH = 3
  for (let i = 0; i < positions.length; i += BATCH) {
    const batch = positions.slice(i, i + BATCH)

    await Promise.all(batch.map(async pos => {
      const baseKey = toFinnhubTicker(pos)
      if (!baseKey) return  /* MutualFund or crypto — skip */

      /* Resolve final Finnhub symbol */
      let ticker
      if (pos.currency === "INR") {
        ticker = await resolveNSETicker(baseKey, apiKey)
      } else {
        ticker = baseKey
      }

      const f = await fetchFinnhub(ticker, apiKey)
      const { score: fundScore, signals: fundSigs, grade, hasData, display } = scoreFundamentals(f)

      const tech        = techMap?.[pos.key] || {}
      const techScore   = tech.score   ?? 50
      const techVerdict = tech.verdict ?? "HOLD"
      const techSigs    = (tech.signals || []).slice(0, 3)

      const { score: goalScore, signals: goalSigs } =
        scoreGoalAlignment(pos, f?.sector, goals || {})

      const { verdict, action, priority, composite, reasoning } =
        getVerdict(techScore, techVerdict, fundScore, hasData, goalScore, pos)

      results[pos.key] = {
        verdict, action, priority, composite, reasoning,
        scores:  { technical: techScore, fundamental: fundScore, goalAlign: goalScore },
        signals: { technical: techSigs, fundamental: fundSigs, goalAlign: goalSigs },
        fundamentals: display || {
          pe: "N/A", pb: "N/A", roe: "N/A", de: "N/A",
          revGrow: "N/A", margins: "N/A",
          sector: "N/A", grade: "UNKNOWN"
        }
      }
    }))

    /* Small delay between batches to stay within rate limits */
    if (i + BATCH < positions.length) {
      await new Promise(r => setTimeout(r, 200))
    }
  }

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
