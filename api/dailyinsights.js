/* CapIntel — Daily Insights via Google News RSS
   100% free: no API key, no AI calls, no charges.
   Vercel function acts as CORS proxy for Google News RSS. */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({ error: "POST only" })

  let body = {}
  try { body = req.body || {} } catch(e) {}

  const { holdings } = body
  if(!holdings || !holdings.length) return res.status(400).json({ error: "holdings required" })

  /* Top 8 holdings by EUR value */
  const top = [...holdings]
    .sort((a, b) => (b.totalCurrentEUR || 0) - (a.totalCurrentEUR || 0))
    .slice(0, 8)

  const queries = top.map(h => {
    /* Strip exchange suffixes for cleaner queries */
    const clean = (h.ticker || "").replace(/\^|\.NS|\.BO|-USD|-EUR|-INR/g, "").trim()
    return { name: h.name, ticker: h.ticker || "", query: clean || h.name.split(" ")[0] }
  })

  /* Manual 5s timeout — AbortSignal.timeout not reliable on all Vercel runtimes */
  function fetchWithTimeout(url, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms)
      fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CapIntel/1.0)" } })
        .then(r => { clearTimeout(timer); resolve(r) })
        .catch(e => { clearTimeout(timer); reject(e) })
    })
  }

  const fetches = queries.map(async q => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q.query + " stock finance")}&hl=en-US&gl=US&ceid=US:en`
    try {
      const r = await fetchWithTimeout(url, 5000)
      if(!r.ok) return []
      const xml = await r.text()
      /* Sanity check — must be XML */
      if(!xml.trim().startsWith("<")) return []
      return parseRSS(xml, q.name, q.ticker).slice(0, 2)
    } catch(e) {
      return []
    }
  })

  let results = []
  try { results = await Promise.all(fetches) } catch(e) {}

  const allArticles = results.flat()

  /* Deduplicate by title prefix */
  const seen = new Set()
  const deduped = allArticles.filter(a => {
    const key = a.title.toLowerCase().slice(0, 45)
    if(seen.has(key)) return false
    seen.add(key)
    return true
  })

  deduped.sort((a, b) => b.pubMs - a.pubMs)
  const articles = deduped.slice(0, 10)

  return res.status(200).json({ articles, date: new Date().toISOString().slice(0, 10) })
}

function parseRSS(xml, holdingName, ticker) {
  const items = []
  const itemRx = /<item>([\s\S]*?)<\/item>/g
  let m
  while((m = itemRx.exec(xml)) !== null) {
    const block   = m[1]
    const title   = stripTags(extract(block, "title"))
    const link    = extract(block, "link") || extract(block, "guid")
    const pubDate = extract(block, "pubDate")
    const source  = extract(block, "source") || "News"
    const desc    = stripTags(extract(block, "description")).slice(0, 200)
    if(!title || title.length < 5) continue
    const pubMs = pubDate ? new Date(pubDate).getTime() : Date.now()
    /* Skip articles older than 48 hours */
    if(Date.now() - pubMs > 172800000) continue
    items.push({ title, link: cleanLink(link), source, desc, pubMs, holding: holdingName, ticker })
  }
  return items
}

function extract(str, tag) {
  const cdata = str.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i"))
  if(cdata) return cdata[1].trim()
  const plain = str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"))
  return plain ? plain[1].trim() : ""
}

function stripTags(str) {
  return str
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .trim()
}

function cleanLink(url) {
  try {
    const decoded = decodeURIComponent(url)
    const m = decoded.match(/url=([^&]+)/)
    return m ? m[1] : url
  } catch(e) { return url }
}
