export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  /* Resolve yahoo-finance2 — inspect every possible export shape */
  const mod = await import("yahoo-finance2")
  const YF  = mod.default
  const instance = (typeof YF === "function") ? new YF() : YF

  /* Find quoteSummary wherever it lives */
  const quoteSummary =
    (typeof instance.quoteSummary === "function")           ? instance.quoteSummary.bind(instance) :
    (typeof YF.quoteSummary       === "function")           ? YF.quoteSummary.bind(YF) :
    (typeof mod.quoteSummary      === "function")           ? mod.quoteSummary :
    (instance.prototype?.quoteSummary)                      ? instance.prototype.quoteSummary.bind(instance) :
    null

  console.log("[yf2 debug] mod keys:", Object.keys(mod),
    "| YF type:", typeof YF,
    "| instance keys:", Object.getOwnPropertyNames(Object.getPrototypeOf(instance||{})).slice(0,8),
    "| quoteSummary found:", !!quoteSummary)

  if (!quoteSummary) {
    return res.status(500).json({ error: "yahoo-finance2 quoteSummary not found — check Vercel logs" })
  }

  const results = {}
  const BATCH = 3

  for (let i = 0; i < positions.length; i += BATCH) {
    const batch = positions.slice(i, i + BATCH)
    await Promise.all(batch.map(async pos => {
      if (pos.type === "MutualFund" || (pos.key||"").includes("-USD")) return
      const ticker = toYahooTicker(pos)
      if (!ticker) return

      const f    = await fetchFundamentals(quoteSummary, ticker)
      const fund = scoreFundamentals(f)
      const tech = techMap?.[pos.key] || {}
      const goal = scoreGoalAlignment(pos, f?.sector, goals || {})
      const out  = getVerdict(tech.score??50, tech.verdict??"HOLD", fund.score, fund.hasData, goal.score, pos)

      results[pos.key] = {
        ...out,
        scores:       { technical: tech.score??50, fundamental: fund.score, goalAlign: goal.score },
        signals:      { technical: tech.signals||[], fundamental: fund.signals, goalAlign: goal.signals },
        fundamentals: fund.display || { pe:"N/A", pb:"N/A", roe:"N/A", de:"N/A", revGrow:"N/A", margins:"N/A", sector:"N/A", grade:"UNKNOWN" }
      }
    }))
    if (i + BATCH < positions.length) await new Promise(r => setTimeout(r, 150))
  }

  return res.status(200).json({ results, computedAt: new Date().toISOString() })
}

function toYahooTicker(pos) {
  const t = (pos.key || "").replace(/\.(NS|BO)$/, "")
  if (!t) return null
  if (pos.currency === "INR") return `${t}.NS`
  const map = { SEMI:"CHIP.PA", EWG2:"EWG2.SG", DFNS:"DFNS.L", IWDA:"IWDA.L", EIMI:"EIMI.L", SSLV:"SSLV.L" }
  return map[t] || t
}

async function fetchFundamentals(quoteSummary, ticker) {
  try {
    const data = await quoteSummary(ticker, {
      modules: ["financialData", "defaultKeyStatistics", "summaryDetail", "assetProfile"]
    })
    if (!data) return null
    const fd = data.financialData        || {}
    const ks = data.defaultKeyStatistics || {}
    const sd = data.summaryDetail        || {}
    const ap = data.assetProfile         || {}
    const n  = v => (typeof v === "number" && isFinite(v)) ? v : null
    return {
      trailingPE:       n(sd.trailingPE)       ?? n(ks.forwardPE),
      priceToBook:      n(ks.priceToBook),
      roe:              n(fd.returnOnEquity),
      profitMargins:    n(fd.profitMargins),
      operatingMargins: n(fd.operatingMargins),
      debtToEquity:     n(fd.debtToEquity),
      revenueGrowth:    n(fd.revenueGrowth),
      earningsGrowth:   n(fd.earningsGrowth),
      currentRatio:     n(fd.currentRatio),
      sector:           ap.sector   || null,
      industry:         ap.industry || null,
      recommendationKey:         fd.recommendationKey || null,
      numberOfAnalystOpinions:   n(fd.numberOfAnalystOpinions),
      targetMeanPrice:           n(fd.targetMeanPrice),
    }
  } catch(e) {
    console.error(`[fundamentals] ${ticker}:`, e.message)
    return null
  }
}

function scoreFundamentals(f) {
  if (!f) return { score:50, signals:[], grade:"UNKNOWN", hasData:false, display:null }
  const sigs = []; let score = 50, fields = 0

  if (f.trailingPE != null) { fields++
    if      (f.trailingPE <= 0)  { score-=15; sigs.push("Negative P/E") }
    else if (f.trailingPE < 12)  { score+=12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE < 20)  { score+=8;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — fair`) }
    else if (f.trailingPE < 35)  { score+=2 }
    else if (f.trailingPE < 60)  { score-=5;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — elevated`) }
    else                         { score-=12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — very high`) }
  }
  if (f.priceToBook != null) { fields++
    if      (f.priceToBook < 0)   { score-=10 }
    else if (f.priceToBook < 1.5) { score+=8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x`) }
    else if (f.priceToBook < 3)   { score+=4 }
    else if (f.priceToBook > 6)   { score-=8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }
  if (f.roe != null) { fields++
    const r = f.roe * 100
    if      (r > 25) { score+=15; sigs.push(`ROE ${r.toFixed(0)}% — excellent`) }
    else if (r > 15) { score+=10; sigs.push(`ROE ${r.toFixed(0)}% — good`) }
    else if (r > 8)  { score+=4 }
    else if (r > 0)  { score-=5;  sigs.push(`ROE ${r.toFixed(0)}% — weak`) }
    else             { score-=15; sigs.push("Negative ROE") }
  }
  if (f.debtToEquity != null) { fields++
    const de = f.debtToEquity > 10 ? f.debtToEquity/100 : f.debtToEquity
    if      (de < 0.2) { score+=10; sigs.push(`Low debt D/E ${de.toFixed(2)}`) }
    else if (de < 0.5) { score+=6 }
    else if (de < 1.0) { score+=0 }
    else if (de < 2.0) { score-=8;  sigs.push(`High debt D/E ${de.toFixed(1)}`) }
    else               { score-=15; sigs.push(`Excessive debt D/E ${de.toFixed(1)}`) }
  }
  if (f.revenueGrowth != null) { fields++
    const g = f.revenueGrowth * 100
    if      (g > 20) { score+=12; sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score+=7;  sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g > 0)  { score+=2 }
    else             { score-=10; sigs.push(`Revenue declining ${g.toFixed(0)}%`) }
  }
  if (f.earningsGrowth != null) { fields++
    const g = f.earningsGrowth * 100
    if      (g > 25) { score+=12; sigs.push(`Earnings +${g.toFixed(0)}% YoY`) }
    else if (g > 10) { score+=6 }
    else if (g > 0)  { score+=2 }
    else             { score-=10; sigs.push("Earnings declining") }
  }
  if (f.profitMargins != null) { fields++
    const m = f.profitMargins * 100
    if      (m > 25) { score+=10; sigs.push(`Margins ${m.toFixed(0)}% — excellent`) }
    else if (m > 15) { score+=6;  sigs.push(`Margins ${m.toFixed(0)}% — good`) }
    else if (m > 8)  { score+=2 }
    else if (m > 0)  { score-=3 }
    else             { score-=12; sigs.push("Negative margins") }
  }
  if (fields === 0) return { score:50, signals:[], grade:"UNKNOWN", hasData:false, display:null }

  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score>=70?"STRONG":score>=50?"FAIR":score>=30?"WEAK":"POOR"
  const fmt   = (v,m=1,d=1,s="") => v!=null?(v*m).toFixed(d)+s:"N/A"
  const fmtDE = v => { if(v==null)return"N/A"; return (v>10?v/100:v).toFixed(2) }
  return {
    score, grade, signals: sigs.slice(0,4), hasData: true,
    display: {
      pe:      fmt(f.trailingPE,  1,  1,"x"),
      pb:      fmt(f.priceToBook, 1,  1,"x"),
      roe:     fmt(f.roe,       100,  1,"%"),
      de:      fmtDE(f.debtToEquity),
      revGrow: fmt(f.revenueGrowth, 100,1,"%"),
      margins: fmt(f.profitMargins, 100,1,"%"),
      sector:  f.sector || "N/A",
      grade,
      targetPrice:    f.targetMeanPrice ? `₹${f.targetMeanPrice.toFixed(0)}` : null,
      analysts:       f.numberOfAnalystOpinions || null,
      recommendation: f.recommendationKey || null
    }
  }
}

function scoreGoalAlignment(pos, sector, goals) {
  let score = 50; const sigs = []
  if (pos.currency === "INR") {
    score += 10; sigs.push("India — home fund")
    const good = ["bank","financial","nbfc","software","it","technology","pharma","healthcare","consumer","fmcg","capital goods","industrial","machinery","chemicals","ratings","food"]
    const bad  = ["utilities","power","oil","gas","metals","mining","telecom","cement"]
    const s = (sector||"").toLowerCase()
    if (good.some(g=>s.includes(g))) { score+=12; sigs.push(`Quality sector: ${sector}`) }
    if (bad.some(b=> s.includes(b))) { score-=8;  sigs.push(`Cyclical sector`) }
  } else { score+=10; sigs.push("EUR/USD — retirement corpus") }
  const eur = pos.totalCurrentEUR||0
  if      (eur<30)  { score-=20; sigs.push("Under €30 — negligible") }
  else if (eur<100) { score-=8;  sigs.push("Under €100 — underfunded") }
  if ((goals.retireAge||50)-36 >= 10) score+=6
  return { score:Math.max(0,Math.min(100,Math.round(score))), signals:sigs }
}

function getVerdict(techScore, techVerdict, fundScore, fundHasData, goalScore, pos) {
  const composite = fundHasData
    ? Math.round(techScore*0.40 + fundScore*0.35 + goalScore*0.25)
    : Math.round(techScore*0.65 + goalScore*0.35)
  const isBuy  = techVerdict==="BUY"||techVerdict==="STRONG BUY"
  const isSell = techVerdict==="SELL"||techVerdict==="TRIM"
  const cur    = pos.currentPrice||0
  let verdict, action, priority, reasoning

  if (fundHasData) {
    if (fundScore<30)                 { verdict="EXIT";   priority="HIGH";   reasoning="Poor fundamentals confirm exit"; action=`Sell all ${pos.qty||""} shares — business quality insufficient.` }
    else if (isBuy && fundScore>=55)  { verdict="ADD";    priority=composite>=72?"HIGH":"MEDIUM"; reasoning="Strong technicals + solid fundamentals"; const q=Math.max(1,Math.round(5000/(cur||1))); action=pos.currency==="INR"?`Add ${q} shares at ₹${cur.toFixed(0)} (≈₹${(q*cur).toFixed(0)})`:`Add €200–300` }
    else if (isSell && fundScore>=60) { verdict="HOLD";   priority="MEDIUM"; reasoning="Weak technicals but strong fundamentals — temporary dip"; action=`Hold. Fundamentals contradict sell signal. Add if RSI drops below 35.` }
    else if (isSell && fundScore>=40) { verdict="REVIEW"; priority="LOW";    reasoning="Bearish technicals + average fundamentals"; action=`Hold. Exit if price breaks 52-week low or next earnings disappoint.` }
    else if (isSell)                  { verdict="EXIT";   priority="HIGH";   reasoning="Bearish technicals + weak fundamentals confirmed"; action=`Sell all ${pos.qty||""} shares. Both signals confirm exit.` }
    else if (isBuy)                   { verdict="ADD";    priority="MEDIUM"; reasoning="Technical BUY with fair fundamentals"; const q=Math.max(1,Math.round(5000/(cur||1))); action=pos.currency==="INR"?`Add ${q} shares at ₹${cur.toFixed(0)}`:`Add €150–200` }
    else                              { verdict="HOLD";   priority="LOW";    reasoning="Consolidating with solid fundamentals"; action=`Hold. Add if RSI drops below 42.` }
  } else {
    if (isBuy)        { verdict="ADD";    priority="MEDIUM"; reasoning="Technical BUY — no fundamental data"; const q=Math.max(1,Math.round(5000/(cur||1))); action=pos.currency==="INR"?`Add ${q} shares at ₹${cur.toFixed(0)} — verify on Screener.in first`:`Add €150` }
    else if (isSell)  { verdict="REVIEW"; priority="MEDIUM"; reasoning="Technical SELL — verify on Screener.in before exiting"; action=`Check Screener.in for ${pos.key} before exiting.` }
    else              { verdict="HOLD";   priority="LOW";    reasoning="Neutral — no fundamental data"; action=`Hold. Verify on Screener.in.` }
  }
  return { verdict, action, priority, composite, reasoning }
}
