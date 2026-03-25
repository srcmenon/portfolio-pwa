/* ============================================================
   CapIntel — api/fundamentals.js   FREE — no Claude, no credits

   Fetches fundamental data from Yahoo Finance quote API for
   small/noise positions, combines with pre-computed technicals,
   and scores each position across 3 dimensions:

   1. TECHNICAL SCORE (0-100)  — from client _techMap (already computed)
   2. FUNDAMENTAL SCORE (0-100) — P/E vs sector, ROE, D/E, EPS growth,
                                   revenue growth, profit margins
   3. GOAL SCORE (0-100)       — alignment to investor goals:
                                   retire at 50, home in 2030, EUR corpus

   COMPOSITE → ADD or EXIT verdict:
   - Technical BUY/HOLD + Fundamental >40 → ADD (underfunded quality position)
   - Technical SELL/TRIM OR Fundamental <30 → EXIT (weak, free the capital)
   - Mixed signals → REVIEW (hold, do not add or sell yet)
   ============================================================ */

/* ── YAHOO FINANCE QUOTE FIELDS ── */
async function fetchQuote(ticker) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })
    const d = await r.json()
    const meta = d.chart?.result?.[0]?.meta
    if (!meta) return null

    /* Also fetch summary detail for fundamentals */
    const q2 = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}&fields=trailingPE,forwardPE,priceToBook,returnOnEquity,debtToEquity,revenueGrowth,earningsGrowth,profitMargins,operatingMargins,currentRatio,marketCap,trailingEps,forwardEps,sector,industry`,
      { headers: { "User-Agent": "Mozilla/5.0" } }
    )
    const d2 = await q2.json()
    const q  = d2.quoteResponse?.result?.[0] || {}

    return {
      trailingPE:      q.trailingPE     || null,
      forwardPE:       q.forwardPE      || null,
      priceToBook:     q.priceToBook    || null,
      roe:             q.returnOnEquity || null,   /* decimal e.g. 0.17 = 17% */
      debtToEquity:    q.debtToEquity   || null,
      revenueGrowth:   q.revenueGrowth  || null,  /* decimal e.g. 0.12 = 12% */
      earningsGrowth:  q.earningsGrowth || null,
      profitMargins:   q.profitMargins  || null,
      operatingMargins:q.operatingMargins || null,
      currentRatio:    q.currentRatio   || null,
      marketCap:       q.marketCap      || null,
      sector:          q.sector         || null,
      industry:        q.industry       || null,
      trailingEps:     q.trailingEps    || null,
      forwardEps:      q.forwardEps     || null,
    }
  } catch(e) { return null }
}

/* ── FUNDAMENTAL SCORER (0-100) ── */
function scoreFundamentals(f, currency) {
  if (!f) return { score: 50, signals: ["No fundamental data available"], grade: "UNKNOWN" }

  const sigs = []
  let score  = 50  /* neutral start */

  /* P/E ratio — lower is better for value, but not negative */
  if (f.trailingPE !== null) {
    if      (f.trailingPE <= 0)   { score -= 15; sigs.push(`Negative P/E (losses)`) }
    else if (f.trailingPE < 12)   { score += 12; sigs.push(`Low P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE < 20)   { score += 8;  sigs.push(`Fair P/E ${f.trailingPE.toFixed(1)}x`) }
    else if (f.trailingPE < 30)   { score += 2 }
    else if (f.trailingPE < 50)   { score -= 5;  sigs.push(`High P/E ${f.trailingPE.toFixed(1)}x`) }
    else                          { score -= 12; sigs.push(`Very high P/E ${f.trailingPE.toFixed(1)}x`) }
  }

  /* P/B ratio */
  if (f.priceToBook !== null) {
    if      (f.priceToBook < 0)   { score -= 10; sigs.push(`Negative book value`) }
    else if (f.priceToBook < 1.5) { score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x — trading near book`) }
    else if (f.priceToBook < 3)   { score += 4 }
    else if (f.priceToBook < 5)   { score -= 2 }
    else                          { score -= 8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }

  /* ROE — quality of the business */
  if (f.roe !== null) {
    const roePct = f.roe * 100
    if      (roePct > 25) { score += 15; sigs.push(`Excellent ROE ${roePct.toFixed(0)}%`) }
    else if (roePct > 15) { score += 10; sigs.push(`Good ROE ${roePct.toFixed(0)}%`) }
    else if (roePct > 8)  { score += 4 }
    else if (roePct > 0)  { score -= 5;  sigs.push(`Weak ROE ${roePct.toFixed(0)}%`) }
    else                  { score -= 15; sigs.push(`Negative ROE — burning equity`) }
  }

  /* Debt/Equity — lower is safer */
  if (f.debtToEquity !== null) {
    if      (f.debtToEquity < 20)  { score += 10; sigs.push(`Low debt ${f.debtToEquity.toFixed(0)}%`) }
    else if (f.debtToEquity < 50)  { score += 5 }
    else if (f.debtToEquity < 100) { score -= 3 }
    else if (f.debtToEquity < 200) { score -= 8;  sigs.push(`High debt ${f.debtToEquity.toFixed(0)}%`) }
    else                           { score -= 15; sigs.push(`Very high debt ${f.debtToEquity.toFixed(0)}%`) }
  }

  /* Revenue growth */
  if (f.revenueGrowth !== null) {
    const rev = f.revenueGrowth * 100
    if      (rev > 25) { score += 12; sigs.push(`Revenue growing ${rev.toFixed(0)}% YoY`) }
    else if (rev > 10) { score += 7;  sigs.push(`Revenue growing ${rev.toFixed(0)}% YoY`) }
    else if (rev > 0)  { score += 2 }
    else               { score -= 10; sigs.push(`Revenue shrinking ${rev.toFixed(0)}% YoY`) }
  }

  /* Earnings growth */
  if (f.earningsGrowth !== null) {
    const eg = f.earningsGrowth * 100
    if      (eg > 30) { score += 12; sigs.push(`Earnings +${eg.toFixed(0)}% YoY`) }
    else if (eg > 10) { score += 6 }
    else if (eg > 0)  { score += 1 }
    else              { score -= 10; sigs.push(`Earnings declining ${eg.toFixed(0)}%`) }
  }

  /* Profit margins */
  if (f.profitMargins !== null) {
    const pm = f.profitMargins * 100
    if      (pm > 20) { score += 8; sigs.push(`Strong margins ${pm.toFixed(0)}%`) }
    else if (pm > 10) { score += 4 }
    else if (pm > 0)  { score += 1 }
    else              { score -= 12; sigs.push(`Negative margins — unprofitable`) }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 70 ? "STRONG" : score >= 50 ? "FAIR" : score >= 30 ? "WEAK" : "POOR"

  return { score, signals: sigs.slice(0,3), grade, meta: f }
}

/* ── GOAL ALIGNMENT SCORER (0-100) ── */
function scoreGoalAlignment(pos, goals) {
  /* Investor: age 36, retire at goals.retireAge, home in goals.homeYear
     EUR portfolio builds retirement corpus
     INR portfolio builds home fund + post-retirement life */
  let score = 50
  const sigs = []
  const homeYrs  = (goals.homeYear  || 2030) - new Date().getFullYear()
  const retireYrs= (goals.retireAge || 50)   - 36

  if (pos.currency === "INR") {
    /* India positions serve home fund + post-retirement INR life */
    score += 10  /* base: aligned to home goal */
    sigs.push(`India position — home fund aligned`)

    /* Sector bonuses for long-term India themes */
    const goodSectors = ["financial","bank","finance","tech","software",
                         "consumer","healthcare","pharma","infra","capital goods"]
    const badSectors  = ["power utility","telecom","oil gas","commodit"]
    const industry = (pos.industry || pos.sector || "").toLowerCase()
    if (goodSectors.some(s => industry.includes(s))) {
      score += 10; sigs.push(`Strong sector for India growth`)
    }
    if (badSectors.some(s => industry.includes(s))) {
      score -= 8;  sigs.push(`Cyclical/PSU sector — lower priority`)
    }
  } else {
    /* EUR/USD positions serve retirement corpus */
    score += 10
    sigs.push(`EUR/USD — retirement corpus aligned`)
    if (homeYrs < 5) { score -= 5 }   /* home is close, need more INR */
  }

  /* Small position penalty — too small to meaningfully serve either goal */
  if ((pos.totalCurrentEUR || 0) < 50)  { score -= 15; sigs.push(`Too small to impact goal`) }
  else if ((pos.totalCurrentEUR||0) < 100) { score -= 5 }

  /* Time horizon bonus — aggressive growth assets fit long horizon */
  if (retireYrs >= 10) score += 5

  score = Math.max(0, Math.min(100, Math.round(score)))
  return { score, signals: sigs }
}

/* ── COMPOSITE VERDICT ── */
function getVerdict(techScore, techVerdict, fundScore, goalScore, pos) {
  const composite = Math.round(
    techScore  * 0.40 +
    fundScore  * 0.35 +
    goalScore  * 0.25
  )

  const isBuySignal  = techVerdict === "BUY" || techVerdict === "STRONG BUY"
  const isHoldSignal = techVerdict === "HOLD"
  const isSellSignal = techVerdict === "SELL" || techVerdict === "TRIM"

  let verdict, action, priority

  if (isBuySignal && fundScore >= 45) {
    verdict  = "ADD"
    priority = composite >= 70 ? "HIGH" : "MEDIUM"
    const curINR = pos.currentPrice || 0
    const addQty = Math.round(5000 / curINR) || 1   /* ₹5,000 incremental buy */
    action = pos.currency === "INR"
      ? `Add ${addQty} shares at ₹${curINR.toFixed(0)} (≈₹${(addQty*curINR).toFixed(0)}) — builds to meaningful position`
      : `Add €200 to this position — underfunded quality holding`
  }
  else if (isSellSignal || fundScore < 30) {
    verdict  = "EXIT"
    priority = fundScore < 20 || isSellSignal ? "HIGH" : "MEDIUM"
    action   = `Sell all ${pos.qty || ""} shares — redeploy to stronger conviction position`
  }
  else if (isHoldSignal && fundScore >= 40) {
    verdict  = "HOLD"
    priority = "LOW"
    action   = `Hold — watch for better entry before adding. Review if technicals turn bearish.`
  }
  else {
    verdict  = "REVIEW"
    priority = "LOW"
    action   = `Mixed signals — hold and reassess next month`
  }

  return { verdict, action, priority, composite }
}

/* ── RESOLVER (mirrors app.js) ── */
function resolveYahoo(pos) {
  const t = pos.key || ""
  if (!t) return null
  if (pos.type === "MutualFund") return null
  if (t.includes("-USD")) return t
  if (t.includes(".")) return t
  if (t === "SEMI") return "CHIP.PA"
  if (t === "EWG2") return "EWG2.SG"
  if (pos.currency === "USD") return t
  if (pos.currency === "EUR") return (pos.type === "ETF" || pos.type === "Commodity") ? t+".L" : t
  return t + ".NS"
}

/* ── MAIN HANDLER ── */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const results = {}

  /* Fetch fundamentals in batches of 5 — avoid rate limits */
  const BATCH = 5
  for (let i = 0; i < positions.length; i += BATCH) {
    const batch = positions.slice(i, i + BATCH)
    await Promise.all(batch.map(async pos => {
      const sym = resolveYahoo(pos)
      if (!sym) return

      /* Fetch fundamentals */
      const fund = await fetchQuote(sym)
      const { score: fundScore, signals: fundSigs, grade, meta } =
        scoreFundamentals(fund, pos.currency)

      /* Use pre-computed technical score from client */
      const tech = techMap?.[pos.key] || {}
      const techScore   = tech.score   ?? 50
      const techVerdict = tech.verdict ?? "HOLD"
      const techSigs    = tech.signals ?? []

      /* Goal alignment */
      const enrichedPos = { ...pos, industry: meta?.industry, sector: meta?.sector }
      const { score: goalScore, signals: goalSigs } =
        scoreGoalAlignment(enrichedPos, goals || {})

      /* Composite verdict */
      const { verdict, action, priority, composite } =
        getVerdict(techScore, techVerdict, fundScore, goalScore, pos)

      results[pos.key] = {
        verdict, action, priority, composite,
        scores: {
          technical:   techScore,
          fundamental: fundScore,
          goalAlign:   goalScore
        },
        signals: {
          technical:   techSigs,
          fundamental: fundSigs,
          goalAlign:   goalSigs
        },
        fundamentals: {
          pe:      meta?.trailingPE     ? meta.trailingPE.toFixed(1)+"x"    : "N/A",
          pb:      meta?.priceToBook    ? meta.priceToBook.toFixed(1)+"x"   : "N/A",
          roe:     meta?.roe            ? (meta.roe*100).toFixed(1)+"%"      : "N/A",
          de:      meta?.debtToEquity   ? meta.debtToEquity.toFixed(0)+"%"  : "N/A",
          revGrow: meta?.revenueGrowth  ? (meta.revenueGrowth*100).toFixed(1)+"%" : "N/A",
          margins: meta?.profitMargins  ? (meta.profitMargins*100).toFixed(1)+"%" : "N/A",
          sector:  meta?.sector         || "N/A",
          grade
        }
      }
    }))
  }

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
