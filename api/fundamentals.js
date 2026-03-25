/* CapIntel — api/fundamentals.js — Finnhub */

/* ── SYMBOL RESOLUTION ── */
/* Use Finnhub /search to resolve correct symbol for any NSE ticker */
async function resolveSymbol(nseTicker, apiKey) {
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/search?q=${encodeURIComponent(nseTicker)}`,
      { headers: { "X-Finnhub-Token": apiKey, "Accept": "application/json" } }
    )
    if (!r.ok) return null
    const d = await r.json()
    const results = (d.result || []).filter(r => r.type === "Common Stock")

    /* Priority 1: exact match on displaySymbol */
    const exact = results.find(r => r.displaySymbol === nseTicker)
    if (exact) return exact.symbol

    /* Priority 2: symbol ends with the NSE ticker on NSE exchange */
    const nse = results.find(r =>
      r.symbol === `NSE:${nseTicker}` ||
      (r.exchange === "NSE" && r.displaySymbol === nseTicker)
    )
    if (nse) return nse.symbol

    /* Priority 3: first Common Stock result that contains ticker name */
    const partial = results.find(r =>
      r.symbol?.includes(nseTicker) || r.displaySymbol?.includes(nseTicker)
    )
    if (partial) return partial.symbol

    return null
  } catch(e) { return null }
}

/* EUR/USD ticker mapping */
function toEurTicker(key) {
  const map = {
    "SEMI": "CHIP.PA", "EWG2": "EWG2.SG", "DFNS": "DFNS.L",
    "IWDA": "IWDA.L",  "EIMI": "EIMI.L",  "SSLV": "SSLV.L",
    "SGLN": "SGLN.L",  "VUSA": "VUSA.L",  "CSPX": "CSPX.L"
  }
  return map[key] || key
}

/* ── FINNHUB FETCH ── */
async function fetchFinnhub(symbol, apiKey) {
  const BASE = "https://finnhub.io/api/v1"
  const h = { "X-Finnhub-Token": apiKey, "Accept": "application/json" }
  try {
    const [r1, r2] = await Promise.all([
      fetch(`${BASE}/stock/profile2?symbol=${encodeURIComponent(symbol)}`, { headers: h }),
      fetch(`${BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`, { headers: h })
    ])
    const profile  = r1.ok ? await r1.json() : {}
    const metricR  = r2.ok ? await r2.json() : {}
    const m = metricR.metric || {}

    /* If profile has no name AND metric has no keys — ticker not found */
    if (!profile.name && Object.keys(m).length < 3) return null

    const n = v => (typeof v === "number" && isFinite(v)) ? v : null
    const pct = v => n(v) !== null ? v / 100 : null  /* Finnhub returns % not decimal */

    return {
      trailingPE:      n(m.peBasicExclExtraTTM)       ?? n(m.peTTM)           ?? n(m.peAnnual),
      priceToBook:     n(m.pbAnnual)                   ?? n(m.pbQuarterly),
      roe:             pct(m.roeTTM)                   ?? pct(m.roeAnnual),
      roa:             pct(m.roaTTM),
      profitMargins:   pct(m.netProfitMarginTTM),
      operatingMargins:pct(m.operatingMarginTTM),
      debtToEquity:    n(m["totalDebt/totalEquityAnnual"]) ?? n(m["longTermDebt/equityAnnual"]),
      revenueGrowth:   pct(m.revenueGrowthTTMYoy)     ?? pct(m.revenueGrowth3Y),
      earningsGrowth:  pct(m.epsGrowthTTMYoy)         ?? pct(m.epsGrowth3Y),
      currentRatio:    n(m.currentRatioAnnual),
      sector:          profile.finnhubIndustry || profile.sector || null,
      industry:        profile.finnhubIndustry || null,
      marketCap:       n(profile.marketCapitalization),
      /* Debug: store raw keys present so we can diagnose */
      _metricKeys:     Object.keys(m).slice(0, 20),
      _profileName:    profile.name || null,
    }
  } catch(e) { return null }
}

/* ── SCORER ── */
function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }
  const sigs = []; let score = 50, fields = 0

  if (f.trailingPE != null) {
    fields++
    if      (f.trailingPE <= 0)  { score -= 15; sigs.push(`Negative P/E`) }
    else if (f.trailingPE < 12)  { score += 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE < 20)  { score += 8;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — fair`) }
    else if (f.trailingPE < 35)  { score += 2 }
    else if (f.trailingPE < 60)  { score -= 5;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — elevated`) }
    else                         { score -= 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — very high`) }
  }
  if (f.priceToBook != null) {
    fields++
    if      (f.priceToBook < 0)  { score -= 10 }
    else if (f.priceToBook < 1.5){ score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x`) }
    else if (f.priceToBook < 3)  { score += 4 }
    else if (f.priceToBook > 6)  { score -= 8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }
  if (f.roe != null) {
    fields++
    const r = f.roe * 100
    if      (r > 25) { score += 15; sigs.push(`ROE ${r.toFixed(0)}% — excellent`) }
    else if (r > 15) { score += 10; sigs.push(`ROE ${r.toFixed(0)}% — good`) }
    else if (r > 8)  { score += 4 }
    else if (r > 0)  { score -= 5;  sigs.push(`ROE ${r.toFixed(0)}% — weak`) }
    else             { score -= 15; sigs.push(`Negative ROE`) }
  }
  if (f.debtToEquity != null) {
    fields++
    const de = f.debtToEquity
    if      (de < 0.2) { score += 10; sigs.push(`Low debt D/E ${de.toFixed(2)}`) }
    else if (de < 0.5) { score += 6 }
    else if (de < 1.0) { score += 0 }
    else if (de < 2.0) { score -= 8;  sigs.push(`High debt D/E ${de.toFixed(1)}`) }
    else               { score -= 15; sigs.push(`Excessive debt D/E ${de.toFixed(1)}`) }
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
    if      (g > 25) { score += 12; sigs.push(`EPS +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score += 6 }
    else if (g > 0)  { score += 2 }
    else if (g > -15){ score -= 8 }
    else             { score -= 15; sigs.push(`EPS severely declining`) }
  }
  if (f.profitMargins != null) {
    fields++
    const m = f.profitMargins * 100
    if      (m > 25) { score += 10; sigs.push(`Margins ${m.toFixed(0)}% — excellent`) }
    else if (m > 15) { score += 6;  sigs.push(`Margins ${m.toFixed(0)}% — good`) }
    else if (m > 8)  { score += 2 }
    else if (m > 0)  { score -= 3 }
    else             { score -= 12; sigs.push(`Negative margins`) }
  }

  if (fields === 0) return { score: 50, signals: [], grade: "UNKNOWN", hasData: false, display: null }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score >= 70 ? "STRONG" : score >= 50 ? "FAIR" : score >= 30 ? "WEAK" : "POOR"
  const fmt = (v, mult=1, dec=1, suf="") => v != null ? (v*mult).toFixed(dec)+suf : "N/A"
  return {
    score, grade, signals: sigs.slice(0, 4), hasData: true,
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

function scoreGoalAlignment(pos, sector, goals) {
  let score = 50; const sigs = []
  if (pos.currency === "INR") {
    score += 10; sigs.push("India — home purchase fund")
    const good = ["bank","financial","nbfc","insurance","software","it","technology",
                  "pharma","healthcare","consumer","fmcg","capital goods","industrial",
                  "machinery","engineering","chemicals","ratings","analytics","food"]
    const bad  = ["utilities","power","oil","gas","metals","mining","telecom","cement"]
    const s = (sector || "").toLowerCase()
    if (good.some(g => s.includes(g))) { score += 12; sigs.push(`Quality sector: ${sector}`) }
    if (bad.some(b =>  s.includes(b))) { score -= 8;  sigs.push(`Cyclical sector`) }
  } else {
    score += 10; sigs.push("EUR/USD — retirement corpus")
  }
  const eur = pos.totalCurrentEUR || 0
  if      (eur < 30)  { score -= 20; sigs.push("Under €30 — negligible") }
  else if (eur < 100) { score -= 8;  sigs.push("Under €100 — underfunded") }
  const retireYrs = (goals.retireAge || 50) - 36
  if (retireYrs >= 10) score += 6
  return { score: Math.max(0, Math.min(100, Math.round(score))), signals: sigs }
}

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
      reasoning="Poor fundamentals — weak business metrics confirm exit"
      action=`Sell all ${pos.qty||""} shares. Business quality insufficient for long-term hold.`
    } else if (isBuy && fundScore >= 55) {
      verdict="ADD"; priority=composite>=72?"HIGH":"MEDIUM"
      reasoning="Strong technicals + solid fundamentals = quality entry point"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)}) — builds to meaningful size`
        : `Add €200–300 — underfunded quality position`
    } else if (isSell && fundScore >= 60) {
      verdict="HOLD"; priority="MEDIUM"
      reasoning="Weak technicals but strong fundamentals — temporary dip in quality business"
      action=`Hold. Strong business metrics contradict sell signal. Add if RSI drops below 35.`
    } else if (isSell && fundScore >= 40) {
      verdict="REVIEW"; priority="LOW"
      reasoning="Bearish technicals + mediocre fundamentals — monitor closely"
      action=`Hold but watch carefully. Exit if price breaks 52-week low or next quarter's earnings disappoint.`
    } else if (isSell) {
      verdict="EXIT"; priority="HIGH"
      reasoning="Bearish technicals + weak fundamentals = confirmed exit"
      action=`Sell all ${pos.qty||""} shares. Both signals confirm exit. Redeploy to stronger position.`
    } else if (isBuy && fundScore >= 40) {
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
    /* No fundamental data — technicals only */
    if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning="Technical BUY signal — no Finnhub data for this ticker"
      const qty = Math.max(1, Math.round(5000/(cur||1)))
      action = pos.currency==="INR"
        ? `Add ${qty} shares at ₹${cur.toFixed(0)} — verify fundamentals on Screener.in first`
        : `Add €150 — verify fundamentals before larger commitment`
    } else if (isSell) {
      verdict="REVIEW"; priority="MEDIUM"
      reasoning="Technical SELL — no fundamental data to confirm. Verify on Screener.in before exiting."
      action=`Check fundamentals on Screener.in for ${pos.key} before deciding. Do not exit purely on technicals.`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning="Neutral technicals — no Finnhub fundamental data for this ticker"
      action=`Hold. Verify fundamentals on Screener.in before adding or exiting.`
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
  if (!apiKey) return res.status(500).json({ error: "FINNHUB_API_KEY not set" })

  const { positions, techMap, goals, debug } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const results = {}
  const debugInfo = {}  /* only populated when debug:true is sent */

  const BATCH = 3
  for (let i = 0; i < positions.length; i += BATCH) {
    const batch = positions.slice(i, i + BATCH)
    await Promise.all(batch.map(async pos => {
      if (pos.type === "MutualFund") return
      const key = pos.key || ""

      /* Resolve Finnhub symbol */
      let symbol
      if (pos.currency === "INR") {
        /* Always use Finnhub search — most reliable way to get correct symbol */
        symbol = await resolveSymbol(key, apiKey)
        if (!symbol) {
          /* Final fallback: try NSE:TICKER directly */
          symbol = `NSE:${key}`
        }
      } else {
        if (key.includes("-USD")) return  /* crypto — skip */
        symbol = toEurTicker(key)
      }

      if (debug) debugInfo[key] = { resolvedSymbol: symbol }

      const f = await fetchFinnhub(symbol, apiKey)

      if (debug && f) {
        debugInfo[key].finnhubProfileName = f._profileName
        debugInfo[key].sampleMetricKeys   = f._metricKeys
        debugInfo[key].peValue            = f.trailingPE
        debugInfo[key].roeValue           = f.roe
      }

      const { score: fundScore, signals: fundSigs, grade, hasData, display } = scoreFundamentals(f)
      const tech      = techMap?.[key] || {}
      const techScore = tech.score ?? 50; const techVerdict = tech.verdict ?? "HOLD"
      const { score: goalScore, signals: goalSigs } = scoreGoalAlignment(pos, f?.sector, goals||{})
      const { verdict, action, priority, composite, reasoning } =
        getVerdict(techScore, techVerdict, fundScore, hasData, goalScore, pos)

      results[key] = {
        verdict, action, priority, composite, reasoning,
        scores:       { technical: techScore, fundamental: fundScore, goalAlign: goalScore },
        signals:      { technical: tech.signals||[], fundamental: fundSigs, goalAlign: goalSigs },
        fundamentals: display || { pe:"N/A", pb:"N/A", roe:"N/A", de:"N/A", revGrow:"N/A", margins:"N/A", sector:"N/A", grade:"UNKNOWN" }
      }
    }))
    if (i + BATCH < positions.length) await new Promise(r => setTimeout(r, 250))
  }

  return res.status(200).json({
    results,
    ...(debug ? { debugInfo } : {}),
    computedAt: new Date().toISOString()
  })
}
