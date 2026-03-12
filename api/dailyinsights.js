/* CapIntel — Daily Insights via Google News RSS
   100% free: no API key, no AI calls, no charges.
   Acts as a CORS proxy: fetches Google News RSS for each holding and returns parsed articles. */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if(req.method === "OPTIONS") return res.status(200).end()
  if(req.method !== "POST") return res.status(405).json({ error: "POST only" })

  const { holdings } = req.body || {}
  if(!holdings || !holdings.length) return res.status(400).json({ error: "holdings required" })

  /* Top 8 holdings by EUR value */
  const top = [...holdings]
    .sort((a, b) => (b.totalCurrentEUR || 0) - (a.totalCurrentEUR || 0))
    .slice(0, 8)

  /* Build search queries: prefer ticker, fall back to first word of name */
  const queries = top.map(h => ({
    name: h.name,
    ticker: h.ticker || "",
    query: h.ticker ? h.ticker.replace(/[\^]|-USD|-EUR|-INR/g, "") : h.name.split(" ")[0]
  }))

  /* Fetch RSS for each holding in parallel */
  const fetches = queries.map(async q => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q.query + " stock")}&hl=en-US&gl=US&ceid=US:en`
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(5000)
      })
      if(!r.ok) return []
      const xml = await r.text()
      return parseRSS(xml, q.name, q.ticker).slice(0, 2)
    } catch(e) {
      return []
    }
  })

  const results = await Promise.all(fetches)
  const allArticles = results.flat()

  /* Deduplicate by title prefix */
  const seen = new Set()
  const deduped = allArticles.filter(a => {
    const key = a.title.toLowerCase().slice(0, 40)
    if(seen.has(key)) return false
    seen.add(key)
    return true
  })

  /* Sort newest first, return top 10 */
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
    const source  = extract(block, "source") || extract(block, "dc:creator") || "News"
    const desc    = stripTags(extract(block, "description")).slice(0, 220)
    if(!title || !link) continue
    const pubMs = pubDate ? new Date(pubDate).getTime() : 0
    if(pubMs && Date.now() - pubMs > 172800000) continue  /* skip > 48h old */
    items.push({ title, link: cleanLink(link), source, desc, pubMs, pubDate, holding: holdingName, ticker })
  }
  return items
}

function extract(str, tag) {
  const m = str.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/${tag}>`, "i"))
            || str.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"))
  return m ? m[1].trim() : ""
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').trim()
}

function cleanLink(url) {
  try {
    const decoded = decodeURIComponent(url)
    const m = decoded.match(/url=([^&]+)/)
    return m ? m[1] : url
  } catch(e) { return url }
}
