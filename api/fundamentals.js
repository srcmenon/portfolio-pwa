/* ============================================================
   CapIntel — api/fundamentals.js (Vercel)

   Proxies to the Render microservice which runs yahoo-finance2
   on non-blocked IPs. Render's IP ranges are not flagged by
   Yahoo Finance unlike Vercel/AWS.

   Set FUNDAMENTALS_URL env var in Vercel to your Render URL:
   e.g. https://capintel-fundamentals.onrender.com
   ============================================================ */

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" })

  const { positions, techMap, goals } = req.body || {}
  if (!positions?.length) return res.status(400).json({ error: "positions required" })

  const serviceUrl = process.env.FUNDAMENTALS_URL
  if (!serviceUrl) return res.status(500).json({ error: "FUNDAMENTALS_URL not set in Vercel env vars" })

  try {
    const r = await fetch(`${serviceUrl}/fundamentals`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ positions, techMap, goals })
    })

    if (!r.ok) {
      const err = await r.text()
      console.error("[fundamentals proxy] Render error:", r.status, err)
      return res.status(502).json({ error: `Render service error: ${r.status}` })
    }

    const data = await r.json()
    return res.status(200).json(data)

  } catch(e) {
    console.error("[fundamentals proxy] fetch failed:", e.message)
    return res.status(502).json({ error: "Fundamentals service unreachable" })
  }
}
