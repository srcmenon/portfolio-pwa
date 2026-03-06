export default async function handler(req, res) {

const { ticker } = req.query;

if(!ticker){
return res.status(400).json({error:"Ticker required"});
}

try{

const r = await fetch(
`https://query2.finance.yahoo.com/v8/finance/chart/${ticker}`
);

const data = await r.json();

const result = data.chart?.result;

if(!result){
return res.status(404).json({error:"Price not found"});
}

const price = result[0]?.meta?.regularMarketPrice;

res.status(200).json({price});

}catch(e){

res.status(500).json({error:"Price fetch failed"});

}

}
