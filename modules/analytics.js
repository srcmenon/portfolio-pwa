function calculatePortfolioValue(assets){

let total = 0;

assets.forEach(a=>{
total += a.currentPrice * a.quantity;
});

return total;

}