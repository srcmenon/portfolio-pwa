/* ============================================================
   CapIntel — api/technicals.js   FREE — no Claude, no credits

   Computes comprehensive technical analysis for all portfolio
   positions using Yahoo Finance OHLCV data only.

   COMPOSITE SCORE (0-100):
     Trend     35% — SMA alignment, Golden/Death Cross, EMA
     Momentum  30% — RSI-14, MACD(12,26,9)
     Volume    20% — price-volume confirmation
     Structure 15% — 52wk position, BB, Support/Resistance

   VERDICT THRESHOLDS:
     80-100  → STRONG BUY
     65-79   → BUY
     45-64   → HOLD
     25-44   → TRIM
     0-24    → SELL

   PORTFOLIO OVERRIDES (applied after scoring):
     EUR value < €100 AND not MF → SELL (noise)
     Weight > 6% AND not ETF    → TRIM (concentration)
   ============================================================ */

/* ── MATH HELPERS ── */
function sma(arr, p) {
  if (arr.length < p) return null
  return arr.slice(-p).reduce((s,v)=>s+v,0)/p
}

function emaArray(arr, p) {
  const k = 2/(p+1), out = [arr[0]]
  for (let i=1; i<arr.length; i++) out.push(arr[i]*k + out[i-1]*(1-k))
  return out
}

function rsi14(closes) {
  if (closes.length < 15) return null
  let gains=0, losses=0
  for (let i=1; i<=14; i++) {
    const d = closes[i]-closes[i-1]
    d>0 ? gains+=d : losses-=d
  }
  let ag=gains/14, al=losses/14
  for (let i=15; i<closes.length; i++) {
    const d = closes[i]-closes[i-1]
    ag = (ag*13 + Math.max(d,0))/14
    al = (al*13 + Math.max(-d,0))/14
  }
  return al===0 ? 100 : Math.round(100 - 100/(1+ag/al))
}

function macd(closes) {
  if (closes.length < 35) return null
  const e12 = emaArray(closes,12)
  const e26 = emaArray(closes,26)
  const line = e12.map((v,i)=>v-e26[i])
  const sig  = emaArray(line.slice(-20),9)
  const l=line[line.length-1], s=sig[sig.length-1]
  const prev = line[line.length-2]
  const prevSig = emaArray(line.slice(-21,-1),9)
  return {
    macd: l, signal: s, histogram: l-s,
    bullish: l>s,
    justCrossedBullish: l>s && prev < (prevSig[prevSig.length-1]||s),
    justCrossedBearish: l<s && prev > (prevSig[prevSig.length-1]||s)
  }
}

function bollingerBands(closes, p=20, mult=2) {
  if (closes.length < p) return null
  const slice = closes.slice(-p)
  const mean  = slice.reduce((s,v)=>s+v,0)/p
  const std   = Math.sqrt(slice.reduce((s,v)=>s+Math.pow(v-mean,2),0)/p)
  const cur   = closes[closes.length-1]
  const upper = mean+mult*std, lower=mean-mult*std
  return {
    upper, middle:mean, lower,
    pct: std>0 ? (cur-lower)/(upper-lower)*100 : 50,  /* 0=at lower, 100=at upper */
    width: mean>0 ? (upper-lower)/mean*100 : 0         /* bandwidth % */
  }
}

function adx14(highs, lows, closes) {
  const n = Math.min(highs.length,lows.length,closes.length)
  if (n < 20) return null
  const tr=[],pdm=[],mdm=[]
  for (let i=1;i<n;i++){
    tr.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])))
    const up=highs[i]-highs[i-1], dn=lows[i-1]-lows[i]
    pdm.push(up>dn&&up>0?up:0)
    mdm.push(dn>up&&dn>0?dn:0)
  }
  let atr=tr.slice(0,14).reduce((s,v)=>s+v,0)
  let p=pdm.slice(0,14).reduce((s,v)=>s+v,0)
  let m=mdm.slice(0,14).reduce((s,v)=>s+v,0)
  const dxArr=[]
  const dx=(p,m,a)=>{const pi=p/a*100,mi=m/a*100;return {pi,mi,dx:Math.abs(pi-mi)/(pi+mi+0.001)*100}}
  let last=dx(p,m,atr); dxArr.push(last.dx)
  for (let i=14;i<tr.length;i++){
    atr=atr-atr/14+tr[i]; p=p-p/14+pdm[i]; m=m-m/14+mdm[i]
    last=dx(p,m,atr); dxArr.push(last.dx)
  }
  const adxVal=dxArr.slice(-14).reduce((s,v)=>s+v,0)/Math.min(14,dxArr.length)
  return {adx:Math.round(adxVal), pdi:last.pi, mdi:last.mi, trending:adxVal>25, strong:adxVal>40}
}

function atr14(highs, lows, closes) {
  const n=Math.min(highs.length,lows.length,closes.length)
  if (n<15) return null
  let a=0
  for (let i=1;i<=14;i++) a+=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]))
  a/=14
  for (let i=15;i<n;i++) a=(a*13+Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])))/14
  return {atr:a, atrPct: closes[n-1]>0?a/closes[n-1]*100:0}
}

function supportResistance(highs, lows, closes) {
  const n=Math.min(20,highs.length,lows.length)
  const cur=closes[closes.length-1]
  const res=Math.max(...highs.slice(-n)), sup=Math.min(...lows.slice(-n))
  return {
    support:sup, resistance:res,
    nearSupport:  (cur-sup)/cur < 0.03,
    nearResistance:(res-cur)/cur < 0.03,
    pctToResistance: (res-cur)/cur*100,
    pctToSupport:    (cur-sup)/cur*100
  }
}

function volumeAnalysis(volumes, closes) {
  if (volumes.length < 21) return null
  const cur   = volumes[volumes.length-1]
  const avg20 = volumes.slice(-21,-1).filter(v=>v>0).reduce((s,v)=>s+v,0)/20
  const priceChg = closes.length>5 ? closes[closes.length-1]-closes[closes.length-6] : 0
  return {
    ratio:     avg20>0 ? cur/avg20 : 1,
    aboveAvg:  cur > avg20,
    confirms:  (priceChg>0 && cur>avg20) || (priceChg<0 && cur>avg20*1.2)
  }
}

/* ── COMPOSITE SCORER ── */
function compositeScore(tech, pos, totalEUR) {
  const cur   = tech.currentPrice
  const sigs  = []  /* {label, weight} */

  /* ── TREND (35pts) ── */
  let trend = 0
  if (tech.sma200 !== null) {
    if (cur > tech.sma200) { trend+=14; sigs.push({l:`Above 200DMA`,w:2}) }
    else                   { trend-=14; sigs.push({l:`Below 200DMA`,w:-2}) }
  }
  if (tech.sma50 !== null) {
    if (cur > tech.sma50)  { trend+=9;  sigs.push({l:`Above 50DMA`,w:1}) }
    else                   { trend-=9;  sigs.push({l:`Below 50DMA`,w:-1}) }
  }
  if (tech.sma50 && tech.sma200) {
    if (tech.sma50 > tech.sma200) { trend+=12; sigs.push({l:`Golden Cross`,w:3}) }
    else                          { trend-=12; sigs.push({l:`Death Cross`,w:-3}) }
  }

  /* ── MOMENTUM (30pts) ── */
  let mom = 0
  if (tech.rsi !== null) {
    if      (tech.rsi < 25)  { mom+=22; sigs.push({l:`RSI ${tech.rsi} — oversold`,w:3}) }
    else if (tech.rsi < 35)  { mom+=16; sigs.push({l:`RSI ${tech.rsi} — low, buy zone`,w:2}) }
    else if (tech.rsi < 50)  { mom+=8  }
    else if (tech.rsi < 60)  { mom+=3  }
    else if (tech.rsi < 70)  { mom-=5  }
    else if (tech.rsi < 80)  { mom-=15; sigs.push({l:`RSI ${tech.rsi} — overbought`,w:-2}) }
    else                     { mom-=22; sigs.push({l:`RSI ${tech.rsi} — extreme overbought`,w:-3}) }
  }
  if (tech.macd) {
    if (tech.macd.justCrossedBullish) { mom+=8;  sigs.push({l:`MACD bullish crossover`,w:2}) }
    else if (tech.macd.justCrossedBearish){ mom-=8; sigs.push({l:`MACD bearish crossover`,w:-2}) }
    else if (tech.macd.bullish)       { mom+=4;  sigs.push({l:`MACD bullish`,w:1}) }
    else                              { mom-=4;  sigs.push({l:`MACD bearish`,w:-1}) }
  }

  /* ── VOLUME (20pts) ── */
  let vol = 0
  if (tech.volume) {
    if (tech.volume.confirms) {
      const priceDir = (tech.mom1m||0) > 0
      if (priceDir)  { vol+=18; sigs.push({l:`Volume confirms uptrend`,w:2}) }
      else           { vol-=15; sigs.push({l:`Volume confirms downtrend`,w:-2}) }
    } else if (tech.volume.aboveAvg) { vol+=8 }
    else { vol+=3 } /* low volume = weak conviction */
  }

  /* ── STRUCTURE (15pts) ── */
  let str = 0
  if (tech.bb) {
    const pct = tech.bb.pct
    if      (pct < 10)  { str+=10; sigs.push({l:`Near BB lower band`,w:2}) }
    else if (pct < 30)  { str+=6  }
    else if (pct < 70)  { str+=2  }
    else if (pct < 90)  { str-=4  }
    else                { str-=8;  sigs.push({l:`Near BB upper band`,w:-1}) }
  }
  if (tech.pctFrom52High !== null) {
    const p = tech.pctFrom52High
    if      (p > -8)   { str-=5 }   /* near peak */
    else if (p > -20)  { str+=2 }
    else if (p > -35)  { str+=6 }
    else               { str+=8;  sigs.push({l:`${Math.abs(p).toFixed(0)}% below 52wk high`,w:1}) }
  }
  if (tech.sr?.nearSupport)    { str+=5; sigs.push({l:`Near support level`,w:1}) }
  if (tech.sr?.nearResistance) { str-=3; sigs.push({l:`Near resistance`,w:-1}) }

  /* ── ADX multiplier ── */
  let mult = 1
  if (tech.adx) {
    if (tech.adx.strong)    mult = 1.25  /* strong trend = amplify signal */
    else if (!tech.adx.trending) mult = 0.8  /* sideways = reduce conviction */
  }

  /* ── RAW SCORE ── */
  const raw = 50 + (trend*0.35 + mom*0.30 + vol*0.20 + str*0.15) * mult
  const score = Math.max(0, Math.min(100, Math.round(raw)))

  /* ── VERDICT ── */
  let verdict = score >= 80 ? "STRONG BUY"
              : score >= 65 ? "BUY"
              : score >= 45 ? "HOLD"
              : score >= 25 ? "TRIM"
              : "SELL"

  /* ── PORTFOLIO OVERRIDES ── */
  const val = pos.totalCurrentEUR || 0
  const wt  = totalEUR > 0 ? val/totalEUR*100 : 0
  const isETF = (pos.type||"") === "ETF"

  if (val < 100 && pos.type !== "MutualFund") {
    verdict = "SELL"
    sigs.unshift({l:`Noise: <€100`,w:-3})
  } else if (wt > 6 && !isETF && verdict !== "SELL") {
    verdict = verdict === "STRONG BUY" || verdict === "BUY" ? "HOLD" : "TRIM"
    sigs.unshift({l:`Overweight ${wt.toFixed(1)}%`,w:-2})
  }

  /* Top 3 signals by absolute weight */
  const top3 = sigs.sort((a,b)=>Math.abs(b.w)-Math.abs(a.w)).slice(0,3).map(s=>s.l)

  return { score, verdict, signals: top3, weight: wt }
}

/* ── TICKER RESOLVER (mirrors app.js logic) ── */
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
  return t+".NS"
}

/* ── MAIN HANDLER ── */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({error:"POST only"})

  const { portfolio } = req.body || {}
  if (!portfolio?.length) return res.status(400).json({error:"portfolio required"})

  const totalEUR = portfolio.reduce((s,p)=>s+(p.totalCurrentEUR||0),0)

  /* Fetch OHLCV — top 50 by value, in batches of 10 to avoid rate limits */
  const targets = portfolio
    .filter(p => resolveYahoo(p))
    .sort((a,b)=>(b.totalCurrentEUR||0)-(a.totalCurrentEUR||0))
    .slice(0,50)

  const BATCH = 10
  const results = {}

  for (let i=0; i<targets.length; i+=BATCH) {
    const batch = targets.slice(i, i+BATCH)
    await Promise.all(batch.map(async pos => {
      const sym = resolveYahoo(pos)
      try {
        const r = await fetch(
          `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?range=1y&interval=1d`,
          {headers:{"User-Agent":"Mozilla/5.0"}}
        )
        const d = await r.json()
        const result = d.chart?.result?.[0]
        if (!result) return

        const ts  = result.timestamp || []
        const q   = result.indicators?.quote?.[0] || {}
        const raw = ts.map((_,i) => ({
          open:   q.open?.[i],
          high:   q.high?.[i],
          low:    q.low?.[i],
          close:  q.close?.[i],
          volume: q.volume?.[i]
        })).filter(p=>p.close!=null&&p.high!=null&&p.low!=null)

        if (raw.length < 20) return

        const closes  = raw.map(p=>p.close)
        const highs   = raw.map(p=>p.high)
        const lows    = raw.map(p=>p.low)
        const volumes = raw.map(p=>p.volume||0)
        const cur     = closes[closes.length-1]
        const high52  = Math.max(...closes)
        const low52   = Math.min(...closes)

        /* MF momentum only — no price technicals */
        if (pos.type === "MutualFund") {
          const mom6m = closes.length>126 ? (cur-closes[closes.length-127])/closes[closes.length-127]*100 : null
          results[pos.key] = {isMF:true, mom6m, currentPrice:cur}
          return
        }

        const s50  = sma(closes,50)
        const s200 = sma(closes,200)
        const e20  = emaArray(closes,20).slice(-1)[0]

        /* Momentum */
        const mom1m  = closes.length>22  ? (cur-closes[closes.length-23])/closes[closes.length-23]*100 : null
        const mom3m  = closes.length>66  ? (cur-closes[closes.length-67])/closes[closes.length-67]*100 : null
        const mom6m  = closes.length>126 ? (cur-closes[closes.length-127])/closes[closes.length-127]*100 : null
        const mom1y  = closes.length>2   ? (cur-closes[0])/closes[0]*100 : null

        const tech = {
          currentPrice:   cur,
          sma50:          s50,
          sma200:         s200,
          ema20:          e20,
          rsi:            rsi14(closes),
          macd:           macd(closes),
          bb:             bollingerBands(closes),
          adx:            adx14(highs,lows,closes),
          atr:            atr14(highs,lows,closes),
          volume:         volumeAnalysis(volumes,closes),
          sr:             supportResistance(highs,lows,closes),
          pctFrom52High:  ((cur-high52)/high52*100),
          pctFrom52Low:   ((cur-low52)/low52*100),
          high52, low52,
          mom1m, mom3m, mom6m, mom1y
        }

        const {score, verdict, signals, weight} = compositeScore(tech, pos, totalEUR)
        results[pos.key] = {...tech, score, verdict, signals, weight}

      } catch(e) { /* silent fail per position */ }
    }))
  }

  /* For MFs and unresolved positions, assign score based on growth only */
  portfolio.forEach(pos => {
    if (results[pos.key]) return
    const g = pos.growth || 0
    const score = Math.max(0, Math.min(100, Math.round(50 + g*0.3)))
    const verdict = score>=65?"BUY":score>=45?"HOLD":score>=25?"TRIM":"SELL"
    results[pos.key] = {isMF:true, score, verdict, signals:[`Based on ${g.toFixed(1)}% growth`]}
  })

  return res.status(200).json({technicals: results, totalEUR, computedAt: new Date().toISOString()})
}
