import { Database } from "bun:sqlite";

const db = new Database("data/commander.db", { readonly: true });

const r = db.query("SELECT fleet_state, assignments, goal, created_at FROM commander_log ORDER BY id DESC LIMIT 1").get() as any;
if (r) {
  console.log("=== Fleet State (", r.created_at, ") goal:", r.goal, "===\n");
  const fleet = JSON.parse(r.fleet_state);
  const bots = fleet.botSummaries || [];

  console.log("Bot".padEnd(22) + "Routine".padEnd(16) + "System".padEnd(18) + "Fuel%".padStart(6) + "  Cargo%".padStart(8));
  for (const b of bots) {
    console.log(
      "  " + (b.id || "?").padEnd(20) +
      (b.routine || "idle").padEnd(16) +
      (b.system || "?").padEnd(18) +
      String(Math.round(b.fuelPct || 0)).padStart(5) + "%" +
      String(Math.round(b.cargoPct || 0)).padStart(7) + "%"
    );
  }

  // Count routines
  const routineCounts = new Map<string, number>();
  for (const b of bots) {
    const r = b.routine || "idle";
    routineCounts.set(r, (routineCounts.get(r) || 0) + 1);
  }
  console.log("\n=== Routine Distribution ===");
  for (const [routine, count] of [...routineCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("  " + routine.padEnd(20) + count);
  }

  console.log("\nTotal credits:", fleet.totalCredits, "| Active:", fleet.activeBots + "/" + fleet.totalBots);
}

db.close();
