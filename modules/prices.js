async function fetchPrice(ticker){

let url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols="+ticker;

let r = await fetch(url);
let data = await r.json();

return data.quoteResponse.result[0].regularMarketPrice;

}