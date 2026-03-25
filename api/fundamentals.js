/* ============================================================
   CapIntel — api/fundamentals.js   FREE — no Claude, no credits

   Fetches fundamentals using Yahoo Finance v8 chart API
   (same endpoint as price.js — confirmed working from Vercel).
   Also tries Yahoo v11 finance/quoteSummary with crumb workaround.

   Falls back gracefully — scoring uses whatever data is available.
   ============================================================ */

async function fetchYahooV8(ticker) {
  try {
    const r = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1mo`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    )
    const d = await r.json()
    const meta = d.chart?.result?.[0]?.meta
    if (!meta) return null
    return {
      trailingPE:   meta.trailingPE              ?? null,
      trailingEps:  meta.epsTrailingTwelveMonths  ?? null,
      forwardEps:   meta.epsForward               ?? null,
      marketCap:    meta.marketCap                ?? null,
      /* v8 does not return ROE, D/E, margins — those need quoteSummary */
      priceToBook:  null,
      roe:          null,
      debtToEquity: null,
      revenueGrowth:null,
      earningsGrowth:null,
      profitMargins:null,
      sector:       null,
      industry:     null,
    }
  } catch(e) { return null }
}

/* Try Yahoo Finance v7 quote endpoint — works for some fields server-side */
async function fetchYahooV7(ticker) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`,
      { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }
    )
    const d = await r.json()
    const q = d.quoteResponse?.result?.[0]
    if (!q) return null
    const n = v => (typeof v === "number" ? v : null)
    return {
      trailingPE:    n(q.trailingPE),
      priceToBook:   n(q.priceToBook),
      roe:           null,
      debtToEquity:  null,
      revenueGrowth: null,
      earningsGrowth:null,
      profitMargins: null,
      sector:        q.sector   || null,
      industry:      q.industry || null,
      marketCap:     n(q.marketCap),
      trailingEps:   n(q.epsTrailingTwelveMonths),
      forwardEps:    n(q.epsForward),
    }
  } catch(e) { return null }
}

/* Merge both sources — take best available value from each */
async function fetchQuote(ticker) {
  const [v8, v7] = await Promise.all([fetchYahooV8(ticker), fetchYahooV7(ticker)])
  if (!v8 && !v7) return null
  const pick = (a, b) => a ?? b ?? null
  return {
    trailingPE:    pick(v7?.trailingPE,    v8?.trailingPE),
    priceToBook:   pick(v7?.priceToBook,   null),
    roe:           null,
    debtToEquity:  null,
    revenueGrowth: null,
    earningsGrowth:null,
    profitMargins: null,
    sector:        pick(v7?.sector,        null),
    industry:      pick(v7?.industry,      null),
    marketCap:     pick(v7?.marketCap,     v8?.marketCap),
    trailingEps:   pick(v7?.trailingEps,   v8?.trailingEps),
    forwardEps:    pick(v7?.forwardEps,    v8?.forwardEps),
  }
}

function scoreFundamentals(f) {
  if (!f) return { score: 50, signals: ["No data — scored neutral"], grade: "UNKNOWN" }

  const sigs = []
  let score  = 50
  let hasData = false

  if (f.trailingPE != null) {
    hasData = true
    if      (f.trailingPE <= 0)  { score -= 15; sigs.push(`Negative P/E — losses`) }
    else if (f.trailingPE < 12)  { score += 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE < 20)  { score += 8;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — fair value`) }
    else if (f.trailingPE < 35)  { score += 2 }
    else if (f.trailingPE < 60)  { score -= 5;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — elevated`) }
    else                         { score -= 12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — very high`) }
  }

  if (f.priceToBook != null) {
    hasData = true
    if      (f.priceToBook < 0)  { score -= 10 }
    else if (f.priceToBook < 1.5){ score += 8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x`) }
    else if (f.priceToBook < 3)  { score += 4 }
    else if (f.priceToBook > 6)  { score -= 8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }

  /* EPS growth proxy — compare trailing vs forward EPS */
  if (f.trailingEps != null && f.forwardEps != null && f.trailingEps > 0) {
    hasData = true
    const epsGrowth = (f.forwardEps - f.trailingEps) / Math.abs(f.trailingEps) * 100
    if      (epsGrowth > 20) { score += 10; sigs.push(`EPS growth est +${epsGrowth.toFixed(0)}%`) }
    else if (epsGrowth > 5)  { score += 5 }
    else if (epsGrowth < 0)  { score -= 8;  sigs.push(`EPS declining est ${epsGrowth.toFixed(0)}%`) }
  }

  /* If no fundamental data at all, keep neutral */
  if (!hasData) return { score: 50, signals: ["Fundamental data unavailable"], grade: "UNKNOWN" }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score>=70?"STRONG":score>=50?"FAIR":score>=30?"WEAK":"POOR"

  const pe  = f.trailingPE  != null ? f.trailingPE.toFixed(1)+"x"  : "N/A"
  const pb  = f.priceToBook != null ? f.priceToBook.toFixed(1)+"x" : "N/A"
  const roe = "N/A"
  const de  = "N/A"
  const rev = "N/A"
  const mar = "N/A"

  return { score, signals: sigs.slice(0,3), grade, display: {pe,pb,roe,de,rev,mar} }
}

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
    score+=10; sigs.push("EUR/USD — retirement aligned")
  }
  if      ((pos.totalCurrentEUR||0) < 30)  { score-=20; sigs.push("Too small for goals") }
  else if ((pos.totalCurrentEUR||0) < 100) { score-=8 }
  if (retireYrs >= 10) score += 5
  return { score: Math.max(0,Math.min(100,Math.round(score))), signals: sigs }
}

function getVerdict(techScore, techVerdict, fundScore, goalScore, pos) {
  const composite = Math.round(techScore*0.40 + fundScore*0.35 + goalScore*0.25)
  const isBuy  = techVerdict==="BUY"||techVerdict==="STRONG BUY"
  const isSell = techVerdict==="SELL"||techVerdict==="TRIM"
  const cur    = pos.currentPrice || 0
  let verdict, action, priority

  if (isBuy && fundScore >= 45) {
    verdict="ADD"; priority=composite>=70?"HIGH":"MEDIUM"
    const addQty = Math.max(1, Math.round(5000/(cur||1)))
    action = pos.currency==="INR"
      ? `Add ${addQty} shares at ₹${cur.toFixed(0)} (≈₹${(addQty*cur).toFixed(0)})`
      : `Add €200 — underfunded quality holding`
  } else if (isSell || fundScore < 30) {
    verdict="EXIT"; priority=(fundScore<20||isSell)?"HIGH":"MEDIUM"
    action=`Sell all — weak signals confirm exit. Redeploy to stronger position.`
  } else if (techVerdict==="HOLD" && fundScore>=40) {
    verdict="HOLD"; priority="LOW"
    action=`Hold — wait for better technical entry. Review if RSI drops below 40.`
  } else {
    verdict="REVIEW"; priority="LOW"
    action=`Mixed signals — hold and reassess next month.`
  }
  return { verdict, action, priority, composite }
}

function resolveYahoo(pos) {
  const t = pos.key || ""
  if (!t || pos.type==="MutualFund") return null
  if (t.includes("-USD")||t.includes(".")) return t
  if (t==="SEMI") return "CHIP.PA"
  if (t==="EWG2") return "EWG2.SG"
  if (pos.currency==="USD") return t
  if (pos.currency==="EUR") return (pos.type==="ETF"||pos.type==="Commodity")?t+".L":t
  return t+".NS"
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error:"POST only" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error:"positions required" })

  const results = {}
  const BATCH = 5

  for (let i=0; i<positions.length; i+=BATCH) {
    const batch = positions.slice(i, i+BATCH)
    await Promise.all(batch.map(async pos => {
      const sym = resolveYahoo(pos)
      if (!sym) return

      const f = await fetchQuote(sym)
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
        fundamentals: {
          pe:      display?.pe  || "N/A",
          pb:      display?.pb  || "N/A",
          roe:     "N/A", de:"N/A", revGrow:"N/A", margins:"N/A",
          sector:  f?.sector    || "N/A",
          grade
        }
      }
    }))
  }

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}
