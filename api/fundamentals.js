/* ============================================================
   CapIntel — api/fundamentals.js

   Uses Apify actor akash9078/indian-stocks-financial-data-scraper
   which runs on Apify's residential IPs — not blocked by Yahoo/Screener.

   Input:  { symbol: "HDFCBANK" }
   Output: { roe, stockPE, bookValue, roce, growth.sales.ttm,
             growth.profit.ttm, shareholding, ... }

   Runs sequentially — one stock per Apify call.
   Cache TTL: 7 days (fundamentals are quarterly).
   Cost: ~$0.00005/run * 35 stocks = $0.00175 per full analysis.
   ============================================================ */

const ACTOR_ID = "akash9078~indian-stocks-financial-data-scraper"
const BASE_URL = "https://api.apify.com/v2"

/* ── Fetch one stock from Apify ── */
async function fetchApifyFundamentals(symbol, apiToken) {
  try {
    const url = `${BASE_URL}/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${apiToken}&timeout=60`
    const r = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ stockSymbol: symbol })
    })
    if (!r.ok) {
      console.error(`[apify] ${symbol} HTTP ${r.status}`)
      return null
    }
    const items = await r.json()
    const d = items?.[0]
    if (!d) return null

    console.log(`[apify] ${symbol} pe=${d.stockPE} roe=${d.roe} roce=${d.roce}`)

    const n = v => {
      if (v == null) return null
      const num = parseFloat(String(v).replace(/,/g, "").replace(/%/g, ""))
      return isFinite(num) ? num : null
    }

    /* Parse sales/profit growth — Apify returns "12%" or "12" */
    const salesGrowthTTM   = n(d.growth?.sales?.ttm)
    const profitGrowthTTM  = n(d.growth?.profit?.ttm)

    /* Convert % values to decimals for consistent scoring */
    return {
      trailingPE:      n(d.stockPE),
      priceToBook:     n(d.bookValue) && n(d.currentPrice)
                         ? n(d.currentPrice) / n(d.bookValue) : null,
      roe:             d.roe   != null ? n(d.roe)  / 100 : null,
      roce:            d.roce  != null ? n(d.roce) / 100 : null,
      revenueGrowth:   salesGrowthTTM  != null ? salesGrowthTTM  / 100 : null,
      earningsGrowth:  profitGrowthTTM != null ? profitGrowthTTM / 100 : null,
      /* Screener doesn't directly give margins — use ROCE as proxy for profitability */
      profitMargins:   null,
      debtToEquity:    null,
      sector:          null,
      industry:        null,
      /* Extra context for display */
      marketCap:       n(d.marketCap),
      dividendYield:   n(d.dividendYield),
      promoterHolding: n(d.shareholding?.promoters),
    }
  } catch(e) {
    console.error(`[apify] ${symbol}: ${e.message}`)
    return null
  }
}

/* ── For EUR/USD stocks — use Yahoo Finance v8 chart meta (already works) ── */
async function fetchYahooBasic(ticker) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    )
    const d = await r.json()
    const m = d.chart?.result?.[0]?.meta
    if (!m) return null
    const n = v => (typeof v === "number" && isFinite(v)) ? v : null
    return {
      trailingPE:    n(m.trailingPE),
      priceToBook:   null,
      roe:           null,
      revenueGrowth: null,
      earningsGrowth:null,
      profitMargins: null,
      debtToEquity:  null,
      sector:        null,
      industry:      null,
    }
  } catch(e) { return null }
}

/* ── Fundamental scorer (0-100) ── */
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
  if (f.roce != null) {
    fields++
    const r = f.roce * 100
    if      (r > 20) { score += 8;  sigs.push(`ROCE ${r.toFixed(0)}% — strong`) }
    else if (r > 12) { score += 4 }
    else if (r < 8)  { score -= 8;  sigs.push(`ROCE ${r.toFixed(0)}% — weak`) }
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
  /* Promoter holding as quality signal */
  if (f.promoterHolding != null) {
    if      (f.promoterHolding > 60) { score += 5;  sigs.push(`Promoter ${f.promoterHolding.toFixed(0)}% — high conviction`) }
    else if (f.promoterHolding < 30) { score -= 5;  sigs.push(`Low promoter holding ${f.promoterHolding.toFixed(0)}%`) }
  }

  if (fields === 0) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 70 ? "STRONG" : score >= 50 ? "FAIR" : score >= 30 ? "WEAK" : "POOR"
  const fmt = (v, mult=1, dec=1, suf="") => v != null ? (v*mult).toFixed(dec)+suf : "N/A"

  return {
    score, grade, signals: sigs.slice(0, 4), hasData: true,
    display: {
      pe:      fmt(f.trailingPE,    1,   1, "x"),
      pb:      fmt(f.priceToBook,   1,   1, "x"),
      roe:     fmt(f.roe,           100, 1, "%"),
      roce:    fmt(f.roce,          100, 1, "%"),
      de:      "N/A",
      revGrow: fmt(f.revenueGrowth, 100, 1, "%"),
      margins: "N/A",
      sector:  f.sector || "N/A",
      grade,
      promoter: f.promoterHolding ? `${f.promoterHolding.toFixed(0)}%` : null
    }
  }
}

/* ── Goal alignment scorer (0-100) ── */
function scoreGoalAlignment(pos, goals) {
  let score = 50; const sigs = []
  if (pos.currency === "INR") {
    score += 10; sigs.push("India — home fund aligned")
  } else {
    score += 10; sigs.push("EUR/USD — retirement corpus")
  }
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
  const isBuy  = techVerdict === "BUY" || techVerdict === "STRONG BUY"
  const isSell = techVerdict === "SELL" || techVerdict === "TRIM"
  const cur    = pos.currentPrice || 0
  let verdict, action, priority, reasoning

  if (fundHasData) {
    if (fundScore < 30) {
      verdict="EXIT"; priority="HIGH"
      reasoning="Poor fundamentals confirm exit"
      action=`Sell all ${pos.qty||""} shares — weak business metrics confirmed by data.`
    } else if (isBuy && fundScore >= 55) {
      verdict="ADD"; priority=composite>=72?"HIGH":"MEDIUM"
      reasoning="Strong technicals + solid fundamentals — quality entry"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)}) — builds to meaningful size`
        : `Add €200–300 — underfunded quality position`
    } else if (isSell && fundScore >= 60) {
      verdict="HOLD"; priority="MEDIUM"
      reasoning="Weak technicals but strong fundamentals — temporary dip in quality business"
      action=`Hold. Fundamentals (ROE, growth) contradict sell signal. Add if RSI drops below 35.`
    } else if (isSell && fundScore >= 40) {
      verdict="REVIEW"; priority="LOW"
      reasoning="Bearish technicals + average fundamentals — monitor closely"
      action=`Hold. Exit if price breaks 52-week low or next quarter earnings disappoint.`
    } else if (isSell) {
      verdict="EXIT"; priority="HIGH"
      reasoning="Bearish technicals + weak fundamentals — confirmed exit"
      action=`Sell all ${pos.qty||""} shares. Both signals confirm exit. Redeploy to stronger position.`
    } else if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning="Technical BUY with fair fundamentals"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)})`
        : `Add €150–200`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning="Consolidating with solid fundamentals — wait for better entry"
      action=`Hold. Quality business in consolidation. Add if RSI drops below 42.`
    }
  } else {
    if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning="Technical BUY — verify fundamentals on Screener.in"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} — verify on Screener.in first`
        : `Add €150 — verify fundamentals first`
    } else if (isSell) {
      verdict="REVIEW"; priority="MEDIUM"
      reasoning="Technical SELL — check Screener.in before exiting"
      action=`Check Screener.in for ${pos.key} fundamentals before exiting.`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning="Neutral — verify on Screener.in"
      action=`Hold. Check fundamentals on Screener.in.`
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

  const apiToken = process.env.APIFY_API_TOKEN
  if (!apiToken) return res.status(500).json({ error: "APIFY_API_TOKEN not set in Vercel env vars" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const results = {}

  /* Run all in parallel — each Apify actor starts simultaneously,
     total time = single actor run time (~15-20s), not 35×10s = 350s */
  const eligible = positions.filter(p =>
    p.type !== "MutualFund" && !(p.key||"").includes("-USD")
  )

  await Promise.all(eligible.map(async pos => {
    let f = null
    if (pos.currency === "INR") {
      const symbol = (pos.key || "").replace(/\.(NS|BO)$/, "")
      f = await fetchApifyFundamentals(symbol, apiToken)
    } else {
      const eurMap = { SEMI:"CHIP.PA", EWG2:"EWG2.SG", DFNS:"DFNS.L", IWDA:"IWDA.L", EIMI:"EIMI.L" }
      const ticker = eurMap[pos.key] || pos.key
      f = await fetchYahooBasic(ticker)
    }

    const fund = scoreFundamentals(f)
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
  }))

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
