/* ============================================================
   CapIntel — api/fundamentals.js

   Uses yahoo-finance2 npm package which handles Yahoo Finance's
   internal session/crumb management — works from Vercel serverless.
   No API keys required. Covers all NSE/BSE stocks with full
   fundamental data: P/E, P/B, ROE, D/E, margins, growth.

   Ticker format: HDFCBANK.NS, LTFOODS.NS, BERGEPAINT.NS
   ============================================================ */

import yf from "yahoo-finance2"

/* yahoo-finance2 ESM/CJS interop — handle both export shapes */
const yahooFinance = yf.default || yf

/* ── TICKER RESOLVER ── */
function toYahooTicker(pos) {
  const t = (pos.key || "").replace(/\.(NS|BO)$/, "")
  if (!t || pos.type === "MutualFund") return null
  if (t.includes("-USD")) return null  /* crypto — skip */

  if (pos.currency === "INR") return `${t}.NS`

  /* EUR/USD — map known ETF symbols */
  const eurMap = {
    "SEMI": "CHIP.PA", "EWG2": "EWG2.SG", "DFNS": "DFNS.L",
    "IWDA": "IWDA.L",  "EIMI": "EIMI.L",  "SSLV": "SSLV.L",
    "SGLN": "SGLN.L",  "VUSA": "VUSA.L",  "CSPX": "CSPX.L"
  }
  return eurMap[t] || t
}

/* ── YAHOO FINANCE FETCH ── */
async function fetchYahooFundamentals(ticker) {
  try {
    const quote = await yahooFinance.quoteSummary(ticker, {
      modules: [
        "financialData",
        "defaultKeyStatistics",
        "summaryDetail",
        "assetProfile"
      ]
    })

    if (!quote) return null

    const fd  = quote.financialData       || {}
    const ks  = quote.defaultKeyStatistics || {}
    const sd  = quote.summaryDetail       || {}
    const ap  = quote.assetProfile        || {}

    const n = v => (typeof v === "number" && isFinite(v)) ? v : null

    return {
      /* Valuation */
      trailingPE:      n(sd.trailingPE)        ?? n(ks.forwardPE),
      priceToBook:     n(ks.priceToBook),
      enterpriseValue: n(ks.enterpriseValue),

      /* Profitability */
      roe:             n(fd.returnOnEquity),    /* decimal e.g. 0.17 */
      roa:             n(fd.returnOnAssets),
      profitMargins:   n(fd.profitMargins),
      operatingMargins:n(fd.operatingMargins),
      grossMargins:    n(fd.grossMargins),
      ebitdaMargins:   n(fd.ebitdaMargins),

      /* Leverage */
      debtToEquity:    n(fd.debtToEquity),      /* already ratio, not % */
      currentRatio:    n(fd.currentRatio),
      quickRatio:      n(fd.quickRatio),

      /* Growth */
      revenueGrowth:   n(fd.revenueGrowth),     /* decimal e.g. 0.12 */
      earningsGrowth:  n(fd.earningsGrowth),
      revenuePerShare: n(fd.revenuePerShare),

      /* EPS */
      trailingEps:     n(ks.trailingEps),
      forwardEps:      n(ks.forwardEps),

      /* Company info */
      sector:          ap.sector         || null,
      industry:        ap.industry       || null,
      marketCap:       n(sd.marketCap),
      beta:            n(ks.beta),
      bookValue:       n(ks.bookValue),

      /* Recommendation */
      recommendationKey: fd.recommendationKey || null,
      targetHighPrice:   n(fd.targetHighPrice),
      targetLowPrice:    n(fd.targetLowPrice),
      targetMeanPrice:   n(fd.targetMeanPrice),
      numberOfAnalysts:  n(fd.numberOfAnalystOpinions),
    }
  } catch(e) {
    /* Log for Vercel diagnostics */
    console.error(`[yahoo-finance2] ${ticker}: ${e.message}`)
    return null
  }
}

/* ── FUNDAMENTAL SCORER (0-100) ── */
function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  const sigs = []; let score = 50, fields = 0

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
    else if (f.priceToBook < 1.5){ score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x — near book`) }
    else if (f.priceToBook < 3)  { score += 4 }
    else if (f.priceToBook > 6)  { score -= 8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }

  /* ROE — capital efficiency */
  if (f.roe != null) {
    fields++
    const r = f.roe * 100
    if      (r > 25) { score += 15; sigs.push(`ROE ${r.toFixed(0)}% — excellent`) }
    else if (r > 15) { score += 10; sigs.push(`ROE ${r.toFixed(0)}% — good`) }
    else if (r > 8)  { score += 4 }
    else if (r > 0)  { score -= 5;  sigs.push(`ROE ${r.toFixed(0)}% — weak`) }
    else             { score -= 15; sigs.push(`Negative ROE — destroying equity`) }
  }

  /* D/E — financial risk */
  if (f.debtToEquity != null) {
    fields++
    /* Yahoo returns D/E as percentage (e.g. 45.2 means 0.45) for some stocks */
    const de = f.debtToEquity > 10 ? f.debtToEquity / 100 : f.debtToEquity
    if      (de < 0.2) { score += 10; sigs.push(`Low debt D/E ${de.toFixed(2)}`) }
    else if (de < 0.5) { score += 6 }
    else if (de < 1.0) { score += 0 }
    else if (de < 2.0) { score -= 8;  sigs.push(`High debt D/E ${de.toFixed(1)}`) }
    else               { score -= 15; sigs.push(`Excessive debt D/E ${de.toFixed(1)}`) }
  }

  /* Revenue growth */
  if (f.revenueGrowth != null) {
    fields++
    const g = f.revenueGrowth * 100
    if      (g > 20) { score += 12; sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score += 7;  sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score += 2 }
    else if (g > -5) { score -= 5;  sigs.push(`Revenue declining slightly`) }
    else             { score -= 12; sigs.push(`Revenue declining ${g.toFixed(0)}%`) }
  }

  /* Earnings growth */
  if (f.earningsGrowth != null) {
    fields++
    const g = f.earningsGrowth * 100
    if      (g > 25) { score += 12; sigs.push(`Earnings +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score += 6 }
    else if (g > 0)  { score += 2 }
    else if (g > -15){ score -= 8;  sigs.push(`Earnings declining ${g.toFixed(0)}%`) }
    else             { score -= 15; sigs.push(`Earnings declining sharply`) }
  }

  /* Profit margins */
  if (f.profitMargins != null) {
    fields++
    const m = f.profitMargins * 100
    if      (m > 25) { score += 10; sigs.push(`Margins ${m.toFixed(0)}% — excellent`) }
    else if (m > 15) { score += 6;  sigs.push(`Margins ${m.toFixed(0)}% — good`) }
    else if (m > 8)  { score += 2 }
    else if (m > 0)  { score -= 3 }
    else             { score -= 12; sigs.push(`Negative margins — unprofitable`) }
  }

  /* Analyst consensus bonus */
  if (f.recommendationKey && f.numberOfAnalysts >= 3) {
    const rec = f.recommendationKey.toLowerCase()
    if      (rec === "strong_buy" || rec === "buy") { score += 5; sigs.push(`Analysts: ${f.numberOfAnalysts} recommend BUY`) }
    else if (rec === "strong_sell" || rec === "sell"){ score -= 5; sigs.push(`Analysts: ${f.numberOfAnalysts} recommend SELL`) }
  }

  if (fields === 0) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 70 ? "STRONG" : score >= 50 ? "FAIR" : score >= 30 ? "WEAK" : "POOR"

  const fmt = (v, mult=1, dec=1, suf="") => v != null ? (v*mult).toFixed(dec)+suf : "N/A"
  const fmtDE = v => {
    if (v == null) return "N/A"
    const de = v > 10 ? v / 100 : v
    return de.toFixed(2)
  }

  return {
    score, grade, signals: sigs.slice(0, 4), hasData: true,
    display: {
      pe:      fmt(f.trailingPE,    1,   1, "x"),
      pb:      fmt(f.priceToBook,   1,   1, "x"),
      roe:     fmt(f.roe,           100, 1, "%"),
      de:      fmtDE(f.debtToEquity),
      revGrow: fmt(f.revenueGrowth, 100, 1, "%"),
      margins: fmt(f.profitMargins, 100, 1, "%"),
      sector:  f.sector || "N/A",
      grade,
      targetPrice: f.targetMeanPrice ? `₹${f.targetMeanPrice.toFixed(0)}` : null,
      analysts:    f.numberOfAnalysts || null,
      recommendation: f.recommendationKey || null
    }
  }
}

/* ── GOAL ALIGNMENT SCORER (0-100) ── */
function scoreGoalAlignment(pos, sector, goals) {
  let score = 50; const sigs = []
  const retireYrs = (goals.retireAge || 50) - 36

  if (pos.currency === "INR") {
    score += 10; sigs.push("India — home purchase fund")
    const good = ["bank","financial","nbfc","insurance","software","it services","technology",
                  "pharma","healthcare","consumer","fmcg","capital goods","industrial",
                  "machinery","engineering","chemicals","ratings","analytics","food","beverages"]
    const bad  = ["utilities","power generation","oil","gas","metals","mining","telecom","cement","coal"]
    const s = (sector || "").toLowerCase()
    if (good.some(g => s.includes(g))) { score += 12; sigs.push(`Quality sector: ${sector}`) }
    if (bad.some(b =>  s.includes(b))) { score -= 8;  sigs.push(`Cyclical sector: ${sector}`) }
  } else {
    score += 10; sigs.push("EUR/USD — retirement corpus")
  }

  const eur = pos.totalCurrentEUR || 0
  if      (eur < 30)  { score -= 20; sigs.push("Under €30 — negligible size") }
  else if (eur < 100) { score -= 8;  sigs.push("Under €100 — underfunded") }
  if (retireYrs >= 10) score += 6

  return { score: Math.max(0, Math.min(100, Math.round(score))), signals: sigs }
}

/* ── COMPOSITE VERDICT ── */
function getVerdict(techScore, techVerdict, fundScore, fundHasData, goalScore, pos) {
  const composite = fundHasData
    ? Math.round(techScore * 0.40 + fundScore * 0.35 + goalScore * 0.25)
    : Math.round(techScore * 0.65 + goalScore * 0.35)

  const isBuy  = techVerdict === "BUY" || techVerdict === "STRONG BUY"
  const isSell = techVerdict === "SELL" || techVerdict === "TRIM"
  const cur    = pos.currentPrice || 0

  let verdict, action, priority, reasoning

  if (fundHasData) {
    if (fundScore < 30) {
      verdict="EXIT"; priority="HIGH"
      reasoning="Poor fundamentals — weak business metrics confirm exit"
      action=`Sell all ${pos.qty||""} shares. Fundamentals confirm business quality is insufficient.`
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
      action=`Hold. Strong fundamentals contradict sell signal. Consider adding if RSI drops below 35.`
    } else if (isSell && fundScore >= 40) {
      verdict="REVIEW"; priority="LOW"
      reasoning="Bearish technicals + average fundamentals — monitor closely"
      action=`Hold but watch carefully. Exit if price breaks 52-week low or next earnings disappoint.`
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
      action=`Hold. Quality business in consolidation. Consider adding if RSI drops below 42.`
    }
  } else {
    if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning="Technical BUY — fundamental data unavailable from Yahoo Finance"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} — verify on Screener.in before large commitment`
        : `Add €150 — verify fundamentals before larger commitment`
    } else if (isSell) {
      verdict="REVIEW"; priority="MEDIUM"
      reasoning="Technical SELL — no fundamental data to confirm. Check Screener.in first."
      action=`Verify fundamentals on Screener.in for ${pos.key} before exiting. Do not sell purely on technicals.`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning="Neutral technicals — fundamental data unavailable"
      action=`Hold. Check fundamentals on Screener.in before adding or exiting.`
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

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const results = {}
  const BATCH = 3  /* yahoo-finance2 is fast but be respectful */

  for (let i = 0; i < positions.length; i += BATCH) {
    const batch = positions.slice(i, i + BATCH)
    await Promise.all(batch.map(async pos => {
      const ticker = toYahooTicker(pos)
      if (!ticker) return

      const f = await fetchYahooFundamentals(ticker)
      const { score: fundScore, signals: fundSigs, grade, hasData, display } = scoreFundamentals(f)
      const tech      = techMap?.[pos.key] || {}
      const techScore = tech.score ?? 50
      const techVerdict = tech.verdict ?? "HOLD"
      const { score: goalScore, signals: goalSigs } = scoreGoalAlignment(pos, f?.sector, goals||{})
      const { verdict, action, priority, composite, reasoning } =
        getVerdict(techScore, techVerdict, fundScore, hasData, goalScore, pos)

      results[pos.key] = {
        verdict, action, priority, composite, reasoning,
        scores:       { technical: techScore, fundamental: fundScore, goalAlign: goalScore },
        signals:      { technical: tech.signals||[], fundamental: fundSigs, goalAlign: goalSigs },
        fundamentals: display || { pe:"N/A", pb:"N/A", roe:"N/A", de:"N/A", revGrow:"N/A", margins:"N/A", sector:"N/A", grade:"UNKNOWN" }
      }
    }))
    if (i + BATCH < positions.length) await new Promise(r => setTimeout(r, 150))
  }

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
