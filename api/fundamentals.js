/* ============================================================
   CapIntel — api/fundamentals.js   FREE — no Claude, no credits

   Fetches fundamental data using two sources:
   1. Yahoo Finance v8 chart API (same endpoint as price.js — works from Vercel)
      Returns: trailingPE, EPS, 52wk data embedded in chart meta
   2. Screener.in public page scrape for Indian stocks
      Returns: P/E, P/B, ROE, D/E, sales growth, profit growth

   Combined with pre-computed technicals + goal alignment scoring.
   ============================================================ */

/* ── YAHOO FINANCE (v8 chart meta — same endpoint that works for prices) ── */
async function fetchYahooMeta(ticker) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    )
    const d = await r.json()
    const meta = d.chart?.result?.[0]?.meta
    if (!meta) return null
    return {
      trailingPE:  meta.trailingPE  || null,
      epsTrailing: meta.epsTrailingTwelveMonths || null,
      epsForward:  meta.epsForward  || null,
      marketCap:   meta.marketCap   || null,
      sector:      null,  /* not in chart API */
      industry:    null,
    }
  } catch(e) { return null }
}

/* ── SCREENER.IN SCRAPE (for Indian .NS stocks) ── */
async function fetchScreenerFundamentals(ticker) {
  /* Only for Indian NSE stocks */
  if (!ticker.endsWith(".NS") && !ticker.endsWith(".BO")) return null

  const symbol = ticker.replace(/\.(NS|BO)$/, "")
  try {
    /* Screener.in has a public JSON API for company data */
    const r = await fetch(
      `https://www.screener.in/api/company/${symbol}/`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; portfolio-tracker/1.0)",
          "Accept":     "application/json",
          "Referer":    "https://www.screener.in/"
        }
      }
    )
    if (!r.ok) return null
    const d = await r.json()

    /* Screener returns ratios array: [{name, value, ...}] */
    const ratios = {}
    ;(d.ratios || []).forEach(section => {
      ;(section.ratios || []).forEach(ratio => {
        const key = (ratio.name || "").toLowerCase().replace(/[^a-z0-9]/g, "_")
        const val = parseFloat(ratio.latest || ratio.value) || null
        if (key && val !== null) ratios[key] = val
      })
    })

    /* Map Screener ratio names to our fields */
    return {
      trailingPE:      ratios["price_to_earning"] || ratios["p_e_ratio"] || null,
      priceToBook:     ratios["price_to_book_value"] || ratios["p_b_ratio"] || null,
      roe:             ratios["return_on_equity"] ? ratios["return_on_equity"] / 100 : null,
      debtToEquity:    ratios["debt_to_equity"] || null,
      revenueGrowth:   ratios["sales_growth_3yrs"] ? ratios["sales_growth_3yrs"] / 100 :
                       ratios["revenue_growth"] ? ratios["revenue_growth"] / 100 : null,
      earningsGrowth:  ratios["profit_growth_3yrs"] ? ratios["profit_growth_3yrs"] / 100 :
                       ratios["earnings_growth"] ? ratios["earnings_growth"] / 100 : null,
      profitMargins:   ratios["net_profit_margin"] ? ratios["net_profit_margin"] / 100 :
                       ratios["profit_margin"] ? ratios["profit_margin"] / 100 : null,
      operatingMargins:ratios["operating_profit_margin"] ? ratios["operating_profit_margin"] / 100 : null,
      currentRatio:    ratios["current_ratio"] || null,
      sector:          d.sector_name || null,
      industry:        d.industry_name || null,
      marketCap:       d.market_cap || null,
    }
  } catch(e) { return null }
}

/* ── MERGE: Yahoo meta + Screener ── */
async function fetchQuote(ticker) {
  const [yahoo, screener] = await Promise.all([
    fetchYahooMeta(ticker),
    fetchScreenerFundamentals(ticker)
  ])

  if (!yahoo && !screener) return null

  /* Screener takes priority for Indian stocks; Yahoo fills gaps */
  return {
    trailingPE:      screener?.trailingPE      ?? yahoo?.trailingPE      ?? null,
    forwardPE:       null,
    priceToBook:     screener?.priceToBook                               ?? null,
    roe:             screener?.roe                                        ?? null,
    debtToEquity:    screener?.debtToEquity                              ?? null,
    revenueGrowth:   screener?.revenueGrowth                             ?? null,
    earningsGrowth:  screener?.earningsGrowth                            ?? null,
    profitMargins:   screener?.profitMargins                             ?? null,
    operatingMargins:screener?.operatingMargins                          ?? null,
    currentRatio:    screener?.currentRatio                              ?? null,
    marketCap:       screener?.marketCap       ?? yahoo?.marketCap       ?? null,
    sector:          screener?.sector                                     ?? null,
    industry:        screener?.industry                                   ?? null,
    trailingEps:     yahoo?.epsTrailing                                  ?? null,
    forwardEps:      yahoo?.epsForward                                   ?? null,
  }
}

/* ── FUNDAMENTAL SCORER (0-100) ── */
function scoreFundamentals(f, currency) {
  if (!f) return { score: 50, signals: ["No fundamental data available"], grade: "UNKNOWN" }

  const sigs = []
  let score  = 50

  if (f.trailingPE !== null) {
    if      (f.trailingPE <= 0)  { score -= 15; sigs.push(`Negative P/E — losses`) }
    else if (f.trailingPE < 12)  { score += 12; sigs.push(`Low P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE < 20)  { score += 8;  sigs.push(`Fair P/E ${f.trailingPE.toFixed(1)}x`) }
    else if (f.trailingPE < 35)  { score += 2 }
    else if (f.trailingPE < 60)  { score -= 5;  sigs.push(`High P/E ${f.trailingPE.toFixed(1)}x`) }
    else                         { score -= 12; sigs.push(`Very high P/E ${f.trailingPE.toFixed(1)}x`) }
  }

  if (f.priceToBook !== null) {
    if      (f.priceToBook < 0)  { score -= 10 }
    else if (f.priceToBook < 1.5){ score += 8; sigs.push(`P/B ${f.priceToBook.toFixed(1)}x — near book value`) }
    else if (f.priceToBook < 3)  { score += 4 }
    else if (f.priceToBook > 6)  { score -= 8; sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }

  if (f.roe !== null) {
    const roePct = f.roe * 100
    if      (roePct > 25) { score += 15; sigs.push(`Excellent ROE ${roePct.toFixed(0)}%`) }
    else if (roePct > 15) { score += 10; sigs.push(`Good ROE ${roePct.toFixed(0)}%`) }
    else if (roePct > 8)  { score += 4 }
    else if (roePct > 0)  { score -= 5;  sigs.push(`Weak ROE ${roePct.toFixed(0)}%`) }
    else                  { score -= 15; sigs.push(`Negative ROE`) }
  }

  if (f.debtToEquity !== null) {
    if      (f.debtToEquity < 0.2) { score += 10; sigs.push(`Low debt D/E ${f.debtToEquity.toFixed(2)}`) }
    else if (f.debtToEquity < 0.5) { score += 5 }
    else if (f.debtToEquity < 1)   { score -= 3 }
    else if (f.debtToEquity < 2)   { score -= 8;  sigs.push(`High debt D/E ${f.debtToEquity.toFixed(1)}`) }
    else                           { score -= 15; sigs.push(`Very high debt D/E ${f.debtToEquity.toFixed(1)}`) }
  }

  if (f.revenueGrowth !== null) {
    const rev = f.revenueGrowth * 100
    if      (rev > 20) { score += 12; sigs.push(`Revenue +${rev.toFixed(0)}% growth`) }
    else if (rev > 10) { score += 7;  sigs.push(`Revenue +${rev.toFixed(0)}% growth`) }
    else if (rev > 0)  { score += 2 }
    else               { score -= 10; sigs.push(`Revenue shrinking ${rev.toFixed(0)}%`) }
  }

  if (f.earningsGrowth !== null) {
    const eg = f.earningsGrowth * 100
    if      (eg > 25) { score += 12; sigs.push(`Earnings +${eg.toFixed(0)}% growth`) }
    else if (eg > 10) { score += 6 }
    else if (eg > 0)  { score += 1 }
    else              { score -= 10; sigs.push(`Earnings declining ${eg.toFixed(0)}%`) }
  }

  if (f.profitMargins !== null) {
    const pm = f.profitMargins * 100
    if      (pm > 20) { score += 8;  sigs.push(`Strong margins ${pm.toFixed(0)}%`) }
    else if (pm > 10) { score += 4 }
    else if (pm < 0)  { score -= 12; sigs.push(`Negative margins — unprofitable`) }
  }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 70 ? "STRONG" : score >= 50 ? "FAIR" : score >= 30 ? "WEAK" : "POOR"

  return { score, signals: sigs.slice(0,3), grade, meta: f }
}

/* ── GOAL ALIGNMENT SCORER (0-100) ── */
function scoreGoalAlignment(pos, goals) {
  let score = 50
  const sigs = []
  const retireYrs = (goals.retireAge || 50) - 36

  if (pos.currency === "INR") {
    score += 10
    sigs.push("India position — home fund aligned")
    const goodSectors = ["financial","bank","finance","technology","software",
                         "consumer","healthcare","pharma","infrastructure","capital goods",
                         "it services","nbfc"]
    const badSectors  = ["power","telecom","oil","gas","commodity","coal","mining"]
    const ind = (pos.industry || pos.sector || "").toLowerCase()
    if (goodSectors.some(s => ind.includes(s))) { score += 10; sigs.push("High-quality sector") }
    if (badSectors.some(s =>  ind.includes(s))) { score -= 8;  sigs.push("Cyclical/PSU sector") }
  } else {
    score += 10
    sigs.push("EUR/USD — retirement corpus aligned")
  }

  if      ((pos.totalCurrentEUR||0) < 30)  { score -= 20; sigs.push("Too small to impact goal") }
  else if ((pos.totalCurrentEUR||0) < 100) { score -= 8 }
  if (retireYrs >= 10) score += 5

  return { score: Math.max(0,Math.min(100,Math.round(score))), signals: sigs }
}

/* ── COMPOSITE VERDICT ── */
function getVerdict(techScore, techVerdict, fundScore, goalScore, pos) {
  const composite = Math.round(techScore*0.40 + fundScore*0.35 + goalScore*0.25)
  const isBuy  = techVerdict === "BUY" || techVerdict === "STRONG BUY"
  const isSell = techVerdict === "SELL" || techVerdict === "TRIM"
  const cur    = pos.currentPrice || 0

  let verdict, action, priority

  if (isBuy && fundScore >= 45) {
    verdict  = "ADD"
    priority = composite >= 70 ? "HIGH" : "MEDIUM"
    const addQty = Math.max(1, Math.round(5000 / (cur||1)))
    action = pos.currency === "INR"
      ? `Add ${addQty} shares at ₹${cur.toFixed(0)} (≈₹${(addQty*cur).toFixed(0)}) — builds to meaningful position`
      : `Add €200 — underfunded quality holding, worth building`
  } else if (isSell || fundScore < 30) {
    verdict  = "EXIT"
    priority = (fundScore < 20 || isSell) ? "HIGH" : "MEDIUM"
    action   = `Sell all ${pos.qty || ""} shares — weak fundamentals + technicals confirm exit. Redeploy to stronger position.`
  } else if (techVerdict === "HOLD" && fundScore >= 40) {
    verdict  = "HOLD"
    priority = "LOW"
    action   = `Hold — good business but wait for better technical entry. Review if RSI drops below 40.`
  } else {
    verdict  = "REVIEW"
    priority = "LOW"
    action   = `Mixed signals — hold current position, reassess next month.`
  }

  return { verdict, action, priority, composite }
}

function resolveYahoo(pos) {
  const t = pos.key || ""
  if (!t) return null
  if (pos.type === "MutualFund") return null
  if (t.includes("-USD")) return t
  if (t.includes(".")) return t
  if (t === "SEMI") return "CHIP.PA"
  if (t === "EWG2") return "EWG2.SG"
  if (pos.currency === "USD") return t
  if (pos.currency === "EUR") return (pos.type==="ETF"||pos.type==="Commodity") ? t+".L" : t
  return t + ".NS"
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const results = {}

  /* Batch of 4 to avoid rate limiting Screener.in */
  const BATCH = 4
  for (let i = 0; i < positions.length; i += BATCH) {
    const batch = positions.slice(i, i + BATCH)
    await Promise.all(batch.map(async pos => {
      const sym  = resolveYahoo(pos)
      if (!sym) return

      const fund = await fetchQuote(sym)
      const { score: fundScore, signals: fundSigs, grade, meta } =
        scoreFundamentals(fund, pos.currency)

      const tech        = techMap?.[pos.key] || {}
      const techScore   = tech.score   ?? 50
      const techVerdict = tech.verdict ?? "HOLD"
      const techSigs    = tech.signals ?? []

      const enriched = { ...pos, industry: meta?.industry, sector: meta?.sector }
      const { score: goalScore, signals: goalSigs } =
        scoreGoalAlignment(enriched, goals || {})

      const { verdict, action, priority, composite } =
        getVerdict(techScore, techVerdict, fundScore, goalScore, pos)

      /* Format display values */
      const pe  = meta?.trailingPE     != null ? meta.trailingPE.toFixed(1)+"x"     : "N/A"
      const pb  = meta?.priceToBook    != null ? meta.priceToBook.toFixed(1)+"x"    : "N/A"
      const roe = meta?.roe            != null ? (meta.roe*100).toFixed(1)+"%"       : "N/A"
      const de  = meta?.debtToEquity   != null ? meta.debtToEquity.toFixed(2)       : "N/A"
      const rev = meta?.revenueGrowth  != null ? (meta.revenueGrowth*100).toFixed(1)+"%" : "N/A"
      const marg= meta?.profitMargins  != null ? (meta.profitMargins*100).toFixed(1)+"%" : "N/A"

      results[pos.key] = {
        verdict, action, priority, composite,
        scores:       { technical: techScore, fundamental: fundScore, goalAlign: goalScore },
        signals:      { technical: techSigs,  fundamental: fundSigs,  goalAlign: goalSigs },
        fundamentals: { pe, pb, roe, de, revGrow: rev, margins: marg,
                        sector: meta?.sector || "N/A", grade }
      }
    }))
  }

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
