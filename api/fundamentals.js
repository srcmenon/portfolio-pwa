/* CapIntel fundamentals.js — CommonJS */
const yf = require("yahoo-finance2")
/* Log the shape so we can see exactly what's exported */
console.log("[yf2 shape]", typeof yf, typeof yf.default, typeof yf.quoteSummary, Object.keys(yf).slice(0,10))
const yahooFinance = yf.quoteSummary ? yf : (yf.default?.quoteSummary ? yf.default : yf)

function toYahooTicker(pos) {
  const t = (pos.key || "").replace(/\.(NS|BO)$/, "")
  if (!t || pos.type === "MutualFund" || t.includes("-USD")) return null
  if (pos.currency === "INR") return t + ".NS"
  const m = { "SEMI":"CHIP.PA","EWG2":"EWG2.SG","DFNS":"DFNS.L","IWDA":"IWDA.L","EIMI":"EIMI.L","SSLV":"SSLV.L","SGLN":"SGLN.L" }
  return m[t] || t
}

async function fetchFundamentals(ticker) {
  try {
    const q = await yahooFinance.quoteSummary(ticker, {
      modules: ["financialData","defaultKeyStatistics","summaryDetail","assetProfile"]
    })
    if (!q) return null
    const fd=q.financialData||{}, ks=q.defaultKeyStatistics||{}, sd=q.summaryDetail||{}, ap=q.assetProfile||{}
    const n = v => (typeof v==="number" && isFinite(v)) ? v : null
    return {
      trailingPE:      n(sd.trailingPE)       ?? n(ks.forwardPE),
      priceToBook:     n(ks.priceToBook),
      roe:             n(fd.returnOnEquity),
      profitMargins:   n(fd.profitMargins),
      operatingMargins:n(fd.operatingMargins),
      debtToEquity:    n(fd.debtToEquity),
      currentRatio:    n(fd.currentRatio),
      revenueGrowth:   n(fd.revenueGrowth),
      earningsGrowth:  n(fd.earningsGrowth),
      sector:          ap.sector   || null,
      industry:        ap.industry || null,
      recommendationKey: fd.recommendationKey || null,
      numberOfAnalysts:  n(fd.numberOfAnalystOpinions),
      targetMeanPrice:   n(fd.targetMeanPrice),
    }
  } catch(e) {
    console.error("[yahoo-finance2]", ticker+":", e.message)
    return null
  }
}

function scoreFundamentals(f) {
  if (!f) return { score:50, signals:[], grade:"UNKNOWN", hasData:false, display:null }
  const sigs=[]; let score=50, fields=0

  if (f.trailingPE != null) {
    fields++
    if      (f.trailingPE<=0)  { score-=15; sigs.push("Negative P/E — loss-making") }
    else if (f.trailingPE<12)  { score+=12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — undervalued`) }
    else if (f.trailingPE<20)  { score+=8;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — fair`) }
    else if (f.trailingPE<35)  { score+=2 }
    else if (f.trailingPE<60)  { score-=5;  sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — elevated`) }
    else                       { score-=12; sigs.push(`P/E ${f.trailingPE.toFixed(1)}x — very high`) }
  }
  if (f.priceToBook != null) {
    fields++
    if      (f.priceToBook<0)   { score-=10 }
    else if (f.priceToBook<1.5) { score+=8;  sigs.push(`P/B ${f.priceToBook.toFixed(1)}x — near book`) }
    else if (f.priceToBook<3)   { score+=4 }
    else if (f.priceToBook>6)   { score-=8;  sigs.push(`High P/B ${f.priceToBook.toFixed(1)}x`) }
  }
  if (f.roe != null) {
    fields++
    const r=f.roe*100
    if      (r>25) { score+=15; sigs.push(`ROE ${r.toFixed(0)}% — excellent`) }
    else if (r>15) { score+=10; sigs.push(`ROE ${r.toFixed(0)}% — good`) }
    else if (r>8)  { score+=4 }
    else if (r>0)  { score-=5;  sigs.push(`ROE ${r.toFixed(0)}% — weak`) }
    else           { score-=15; sigs.push("Negative ROE") }
  }
  if (f.debtToEquity != null) {
    fields++
    const de = f.debtToEquity > 10 ? f.debtToEquity/100 : f.debtToEquity
    if      (de<0.2) { score+=10; sigs.push(`Low debt D/E ${de.toFixed(2)}`) }
    else if (de<0.5) { score+=6 }
    else if (de<1.0) { score+=0 }
    else if (de<2.0) { score-=8;  sigs.push(`High debt D/E ${de.toFixed(1)}`) }
    else             { score-=15; sigs.push(`Excessive debt D/E ${de.toFixed(1)}`) }
  }
  if (f.revenueGrowth != null) {
    fields++
    const g=f.revenueGrowth*100
    if      (g>20)  { score+=12; sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g>10)  { score+=7;  sigs.push(`Revenue +${g.toFixed(0)}% YoY`) }
    else if (g>0)   { score+=2 }
    else if (g>-5)  { score-=5 }
    else            { score-=12; sigs.push(`Revenue declining ${g.toFixed(0)}%`) }
  }
  if (f.earningsGrowth != null) {
    fields++
    const g=f.earningsGrowth*100
    if      (g>25)  { score+=12; sigs.push(`Earnings +${g.toFixed(0)}% YoY`) }
    else if (g>10)  { score+=6 }
    else if (g>0)   { score+=2 }
    else if (g>-15) { score-=8;  sigs.push(`Earnings declining`) }
    else            { score-=15; sigs.push(`Earnings declining sharply`) }
  }
  if (f.profitMargins != null) {
    fields++
    const m=f.profitMargins*100
    if      (m>25) { score+=10; sigs.push(`Margins ${m.toFixed(0)}% — excellent`) }
    else if (m>15) { score+=6;  sigs.push(`Margins ${m.toFixed(0)}% — good`) }
    else if (m>8)  { score+=2 }
    else if (m>0)  { score-=3 }
    else           { score-=12; sigs.push("Negative margins") }
  }
  if (f.recommendationKey && f.numberOfAnalysts>=3) {
    const rec=(f.recommendationKey||"").toLowerCase()
    if (rec==="strong_buy"||rec==="buy")   { score+=5; sigs.push(`${f.numberOfAnalysts} analysts: BUY`) }
    if (rec==="strong_sell"||rec==="sell") { score-=5; sigs.push(`${f.numberOfAnalysts} analysts: SELL`) }
  }

  if (fields===0) return { score:50, signals:[], grade:"UNKNOWN", hasData:false, display:null }
  score = Math.max(0, Math.min(100, Math.round(score)))
  const grade = score>=70?"STRONG":score>=50?"FAIR":score>=30?"WEAK":"POOR"
  const fmt=(v,mult=1,dec=1,suf="")=> v!=null?(v*mult).toFixed(dec)+suf:"N/A"
  const fmtDE=v=>{ if(v==null)return"N/A"; const d=v>10?v/100:v; return d.toFixed(2) }
  return {
    score, grade, signals:sigs.slice(0,4), hasData:true,
    display:{
      pe:      fmt(f.trailingPE,   1,  1,"x"),
      pb:      fmt(f.priceToBook,  1,  1,"x"),
      roe:     fmt(f.roe,          100,1,"%"),
      de:      fmtDE(f.debtToEquity),
      revGrow: fmt(f.revenueGrowth,100,1,"%"),
      margins: fmt(f.profitMargins,100,1,"%"),
      sector:  f.sector||"N/A",
      grade,
      targetPrice: f.targetMeanPrice?`₹${f.targetMeanPrice.toFixed(0)}`:null,
      analysts:    f.numberOfAnalysts||null,
      recommendation: f.recommendationKey||null
    }
  }
}

function scoreGoalAlignment(pos, sector, goals) {
  let score=50; const sigs=[]
  if (pos.currency==="INR") {
    score+=10; sigs.push("India — home purchase fund")
    const good=["bank","financial","nbfc","insurance","software","it","technology","pharma",
                "healthcare","consumer","fmcg","capital goods","industrial","machinery",
                "engineering","chemicals","ratings","analytics","food","beverage"]
    const bad =["utilities","power","oil","gas","metals","mining","telecom","cement","coal"]
    const s=(sector||"").toLowerCase()
    if (good.some(g=>s.includes(g))) { score+=12; sigs.push(`Quality sector: ${sector}`) }
    if (bad.some(b=>s.includes(b)))  { score-=8;  sigs.push(`Cyclical sector`) }
  } else {
    score+=10; sigs.push("EUR/USD — retirement corpus")
  }
  const eur=pos.totalCurrentEUR||0
  if      (eur<30)  { score-=20; sigs.push("Under €30 — negligible") }
  else if (eur<100) { score-=8;  sigs.push("Under €100 — underfunded") }
  if ((goals.retireAge||50)-36>=10) score+=6
  return { score:Math.max(0,Math.min(100,Math.round(score))), signals:sigs }
}

function getVerdict(techScore, techVerdict, fundScore, fundHasData, goalScore, pos) {
  const composite = fundHasData
    ? Math.round(techScore*0.40+fundScore*0.35+goalScore*0.25)
    : Math.round(techScore*0.65+goalScore*0.35)
  const isBuy  = techVerdict==="BUY"||techVerdict==="STRONG BUY"
  const isSell = techVerdict==="SELL"||techVerdict==="TRIM"
  const cur    = pos.currentPrice||0
  let verdict,action,priority,reasoning

  if (fundHasData) {
    if (fundScore<30) {
      verdict="EXIT"; priority="HIGH"
      reasoning="Poor fundamentals confirm exit — weak business metrics"
      action=`Sell all ${pos.qty||""} shares. Fundamentals confirm business quality insufficient.`
    } else if (isBuy&&fundScore>=55) {
      verdict="ADD"; priority=composite>=72?"HIGH":"MEDIUM"
      reasoning="Strong technicals + solid fundamentals — quality entry"
      const qty=Math.max(1,Math.round(5000/(cur||1)))
      action=pos.currency==="INR"
        ?`Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)}) — builds to meaningful size`
        :`Add €200–300 — underfunded quality position`
    } else if (isSell&&fundScore>=60) {
      verdict="HOLD"; priority="MEDIUM"
      reasoning="Weak technicals but strong fundamentals — temporary dip in quality business"
      action=`Hold. Strong fundamentals contradict sell signal. Add if RSI drops below 35.`
    } else if (isSell&&fundScore>=40) {
      verdict="REVIEW"; priority="LOW"
      reasoning="Bearish technicals + average fundamentals — monitor closely"
      action=`Hold but watch. Exit if price breaks 52-week low or next earnings disappoint.`
    } else if (isSell) {
      verdict="EXIT"; priority="HIGH"
      reasoning="Bearish technicals + weak fundamentals — confirmed exit"
      action=`Sell all ${pos.qty||""} shares. Both signals confirm exit.`
    } else if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning="Technical BUY with fair fundamentals"
      const qty=Math.max(1,Math.round(5000/(cur||1)))
      action=pos.currency==="INR"
        ?`Add ${qty} shares at ₹${cur.toFixed(0)} (≈₹${(qty*cur).toFixed(0)})`
        :`Add €150–200`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning="Consolidating with solid fundamentals — wait for better entry"
      action=`Hold. Quality business in consolidation. Add if RSI drops below 42.`
    }
  } else {
    if (isBuy) {
      verdict="ADD"; priority="MEDIUM"
      reasoning="Technical BUY — verify fundamentals on Screener.in"
      const qty=Math.max(1,Math.round(5000/(cur||1)))
      action=pos.currency==="INR"
        ?`Add ${qty} shares at ₹${cur.toFixed(0)} — verify on Screener.in before large commitment`
        :`Add €150 — verify fundamentals first`
    } else if (isSell) {
      verdict="REVIEW"; priority="MEDIUM"
      reasoning="Technical SELL — no fundamental data. Check Screener.in before exiting."
      action=`Verify fundamentals on Screener.in for ${pos.key} before exiting.`
    } else {
      verdict="HOLD"; priority="LOW"
      reasoning="Neutral technicals — fundamental data unavailable"
      action=`Hold. Check Screener.in before adding or exiting.`
    }
  }
  return { verdict,action,priority,composite,reasoning }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*")
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers","Content-Type")
  if (req.method==="OPTIONS") return res.status(200).end()
  if (req.method!=="POST")   return res.status(405).json({error:"POST only"})

  const { positions, techMap, goals } = req.body||{}
  if (!positions?.length) return res.status(400).json({error:"positions required"})

  const results={}
  const BATCH=3

  for (let i=0; i<positions.length; i+=BATCH) {
    const batch=positions.slice(i,i+BATCH)
    await Promise.all(batch.map(async pos => {
      const ticker=toYahooTicker(pos)
      if (!ticker) return
      const f=await fetchFundamentals(ticker)
      const {score:fundScore,signals:fundSigs,grade,hasData,display}=scoreFundamentals(f)
      const tech=techMap?.[pos.key]||{}
      const techScore=tech.score??50, techVerdict=tech.verdict??"HOLD"
      const {score:goalScore,signals:goalSigs}=scoreGoalAlignment(pos,f?.sector,goals||{})
      const {verdict,action,priority,composite,reasoning}=
        getVerdict(techScore,techVerdict,fundScore,hasData,goalScore,pos)
      results[pos.key]={
        verdict,action,priority,composite,reasoning,
        scores:{technical:techScore,fundamental:fundScore,goalAlign:goalScore},
        signals:{technical:tech.signals||[],fundamental:fundSigs,goalAlign:goalSigs},
        fundamentals:display||{pe:"N/A",pb:"N/A",roe:"N/A",de:"N/A",revGrow:"N/A",margins:"N/A",sector:"N/A",grade:"UNKNOWN"}
      }
    }))
    if (i+BATCH<positions.length) await new Promise(r=>setTimeout(r,150))
  }

  return res.status(200).json({results,computedAt:new Date().toISOString()})
}
