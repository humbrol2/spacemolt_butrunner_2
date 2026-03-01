import { Database } from "bun:sqlite";

const db = new Database("data/commander.db", { readonly: true });
const hour = Date.now() - 3600000;

// Commander assignments from most recent log entry
console.log("=== Current Bot Assignments ===");
const latest = db.query(`
  SELECT assignments, fleet_state, goal, created_at FROM commander_log
  ORDER BY id DESC LIMIT 1
`).get() as any;

if (latest) {
  console.log("Goal:", latest.goal, "| Time:", latest.created_at);
  const assigns = JSON.parse(latest.assignments);
  const fleet = JSON.parse(latest.fleet_state);
  const bots = Array.isArray(fleet) ? fleet : (fleet.bots || Object.values(fleet));
  for (const a of assigns) {
    const bot = bots.find((b: any) => b.botId === a.botId || b.name === a.botId);
    const sys = bot?.currentSystem || "?";
    const credits = bot?.credits || 0;
    const params = a.params ? JSON.stringify(a.params).substring(0, 70) : "";
    console.log("  " + (a.botId || "?").padEnd(20) + (a.routine || "?").padEnd(16) + sys.padEnd(15) + String(credits).padStart(8) + "cr  " + params);
  }
}

// Cost breakdown analysis: separate trade buys from operational costs
console.log("\n=== Cost Breakdown (Last Hour) ===");
const allCosts = db.query(`
  SELECT bot_id, amount, timestamp FROM financial_events
  WHERE event_type = 'cost' AND timestamp > ?
  ORDER BY amount DESC
`).all(hour) as any[];

const tradeBuys = db.query(`
  SELECT bot_id, total FROM trade_log
  WHERE action = 'buy' AND timestamp > ?
`).all(hour) as any[];

const tradeBuyTotals = new Map<string, number>();
for (const t of tradeBuys) {
  tradeBuyTotals.set(t.bot_id, (tradeBuyTotals.get(t.bot_id) || 0) + t.total);
}

const botCosts = new Map<string, number>();
for (const c of allCosts) {
  botCosts.set(c.bot_id, (botCosts.get(c.bot_id) || 0) + c.amount);
}

console.log("Bot".padEnd(22) + "Total Cost".padStart(10) + "  Trade Buys".padStart(12) + "  Operational".padStart(12));
for (const [bot, total] of [...botCosts.entries()].sort((a, b) => b[1] - a[1])) {
  const tradeBuy = tradeBuyTotals.get(bot) || 0;
  const operational = total - tradeBuy;
  console.log("  " + bot.padEnd(20) + String(total).padStart(10) + "cr" + String(tradeBuy).padStart(10) + "cr" + String(operational).padStart(10) + "cr");
}

// Biggest individual costs (non-trade)
console.log("\n=== Biggest Individual Costs ===");
const bigCosts = db.query(`
  SELECT bot_id, amount, timestamp FROM financial_events
  WHERE event_type = 'cost' AND timestamp > ? AND amount > 100
  ORDER BY amount DESC LIMIT 20
`).all(hour) as any[];

for (const c of bigCosts) {
  const ts = new Date(c.timestamp).toISOString().substring(11, 19);
  console.log("  " + ts + " " + c.bot_id.padEnd(20) + String(c.amount).padStart(8) + "cr");
}

// Trade round-trip profitability
console.log("\n=== Trade Round-Trip Analysis ===");
const allTrades = db.query(`
  SELECT bot_id, item_id, action, quantity, price_each, total, timestamp
  FROM trade_log WHERE timestamp > ? ORDER BY bot_id, item_id, timestamp
`).all(hour) as any[];

// Group by bot+item
const tradeGroups = new Map<string, any[]>();
for (const t of allTrades) {
  const key = t.bot_id + ":" + t.item_id;
  if (!tradeGroups.has(key)) tradeGroups.set(key, []);
  tradeGroups.get(key)!.push(t);
}

for (const [key, trades] of tradeGroups) {
  const buys = trades.filter((t: any) => t.action === "buy");
  const sells = trades.filter((t: any) => t.action === "sell");
  const buyTotal = buys.reduce((s: number, t: any) => s + t.total, 0);
  const sellTotal = sells.reduce((s: number, t: any) => s + t.total, 0);
  const buyQty = buys.reduce((s: number, t: any) => s + t.quantity, 0);
  const sellQty = sells.reduce((s: number, t: any) => s + t.quantity, 0);
  const profit = sellTotal - buyTotal;
  const avgBuy = buyQty > 0 ? Math.round(buyTotal / buyQty) : 0;
  const avgSell = sellQty > 0 ? Math.round(sellTotal / sellQty) : 0;
  const margin = avgBuy > 0 ? Math.round((avgSell - avgBuy) / avgBuy * 100) : 0;
  console.log("  " + key.padEnd(45) + "buy:" + String(buyQty).padStart(3) + "@" + String(avgBuy).padStart(5) + " sell:" + String(sellQty).padStart(3) + "@" + String(avgSell).padStart(5) + " profit:" + String(profit).padStart(8) + "cr margin:" + String(margin).padStart(4) + "%");
}

db.close();
