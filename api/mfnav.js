export default async function handler(req, res) {

try {

const response = await fetch("https://www.amfiindia.com/spages/NAVAll.txt")

const text = await response.text()

res.setHeader("Access-Control-Allow-Origin", "*")
res.status(200).send(text)

} catch (err) {

res.status(500).json({error:"NAV fetch failed"})

}

}
