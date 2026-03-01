import { Database } from "bun:sqlite";

const db = new Database("data/commander.db", { readonly: true });
const hour = Date.now() - 3600000;

// Revenue vs cost summary in last hour
const rev = db.query('SELECT SUM(amount) as total, COUNT(*) as cnt FROM financial_events WHERE event_type="revenue" AND timestamp > ?').get(hour) as any;
const cost = db.query('SELECT SUM(amount) as total, COUNT(*) as cnt FROM financial_events WHERE event_type="cost" AND timestamp > ?').get(hour) as any;
console.log("=== Last Hour ===");
console.log("Revenue:", rev.total, "cr (" + rev.cnt + " events)");
console.log("Cost:", cost.total, "cr (" + cost.cnt + " events)");
console.log("Net:", (rev.total || 0) - (cost.total || 0), "cr");

// Per-bot revenue/cost
const perBot = db.query('SELECT bot_id, event_type, SUM(amount) as total, COUNT(*) as cnt FROM financial_events WHERE timestamp > ? GROUP BY bot_id, event_type ORDER BY bot_id').all(hour) as any[];
console.log("\n=== Per Bot (Last Hour) ===");
for (const r of perBot) {
  console.log("  " + r.bot_id.padEnd(20) + r.event_type.padEnd(10) + String(r.total).padStart(8) + "cr  (" + r.cnt + ")");
}

// Trade profit analysis
const trades = db.query('SELECT bot_id, item_id, action, quantity, price_each, total FROM trade_log WHERE timestamp > ? ORDER BY timestamp DESC').all(hour) as any[];
console.log("\n=== Trades (Last Hour) ===");
for (const t of trades) {
  console.log("  " + t.bot_id.padEnd(18) + t.action.padEnd(6) + String(t.quantity).padStart(4) + "x " + t.item_id.padEnd(30) + "@ " + String(t.price_each).padStart(6) + "cr = " + String(t.total).padStart(8) + "cr");
}

// Credit trend (last 30min)
const halfHour = Date.now() - 1800000;
const credits = db.query('SELECT total_credits, timestamp FROM credit_history WHERE timestamp > ? ORDER BY timestamp ASC').all(halfHour) as any[];
if (credits.length >= 2) {
  const first = credits[0];
  const last = credits[credits.length - 1];
  const delta = last.total_credits - first.total_credits;
  const mins = (last.timestamp - first.timestamp) / 60000;
  console.log("\n=== Credit Trend (Last " + Math.round(mins) + " min) ===");
  console.log("Start:", first.total_credits, "cr");
  console.log("Now:  ", last.total_credits, "cr");
  console.log("Delta:", delta, "cr (" + Math.round(delta / mins) + " cr/min)");
}

db.close();
