import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TrainingLogger } from "../../src/data/training-logger";
import { handleTrainingRoute } from "../../src/server/training-api";

function createTestDb(): Database {
  const db = new Database(":memory:");

  // Create all tables needed
  db.run(`CREATE TABLE decision_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tick INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    action TEXT NOT NULL,
    params TEXT,
    context TEXT NOT NULL DEFAULT '{}',
    result TEXT,
    commander_goal TEXT,
    game_version TEXT NOT NULL DEFAULT 'test',
    commander_version TEXT NOT NULL DEFAULT 'test',
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE state_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tick INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    player_state TEXT NOT NULL DEFAULT '{}',
    ship_state TEXT NOT NULL DEFAULT '{}',
    location TEXT NOT NULL DEFAULT '{}',
    game_version TEXT NOT NULL DEFAULT 'test',
    commander_version TEXT NOT NULL DEFAULT 'test',
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE market_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tick INTEGER NOT NULL,
    station_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    buy_price REAL,
    sell_price REAL,
    buy_volume INTEGER,
    sell_volume INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE commander_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tick INTEGER NOT NULL,
    goal TEXT NOT NULL,
    fleet_state TEXT NOT NULL DEFAULT '{}',
    assignments TEXT NOT NULL DEFAULT '[]',
    reasoning TEXT NOT NULL DEFAULT '',
    economy_state TEXT,
    game_version TEXT NOT NULL DEFAULT 'test',
    commander_version TEXT NOT NULL DEFAULT 'test',
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id TEXT NOT NULL,
    episode_type TEXT NOT NULL,
    start_tick INTEGER NOT NULL,
    end_tick INTEGER NOT NULL,
    duration_ticks INTEGER NOT NULL,
    start_credits INTEGER,
    end_credits INTEGER,
    profit INTEGER,
    route TEXT,
    items_involved TEXT,
    fuel_consumed INTEGER,
    risks TEXT,
    commander_goal TEXT,
    success INTEGER NOT NULL DEFAULT 1,
    game_version TEXT NOT NULL DEFAULT 'test',
    commander_version TEXT NOT NULL DEFAULT 'test',
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  return db;
}

// Helper to create a mock TrainingLogger that uses our test db
function createMockLogger(db: Database): TrainingLogger {
  // TrainingLogger constructor takes a Database directly
  const logger = new TrainingLogger(db);
  logger.setGameVersion("test");
  return logger;
}

async function callRoute(path: string, db: Database, logger: TrainingLogger, method = "GET", body?: unknown): Promise<Response> {
  const url = new URL(`http://localhost/api/training/${path}`);
  const req = body
    ? new Request(url.toString(), {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    : new Request(url.toString(), { method });
  return handleTrainingRoute(url, req, { db, logger });
}

describe("Training API", () => {
  let db: Database;
  let logger: TrainingLogger;

  beforeEach(() => {
    db = createTestDb();
    logger = createMockLogger(db);
  });

  // ── Stats ──

  describe("GET /stats", () => {
    test("returns empty stats for fresh database", async () => {
      const res = await callRoute("stats", db, logger);
      const data = await res.json();
      expect(data.decisions.count).toBe(0);
      expect(data.snapshots.count).toBe(0);
      expect(data.episodes.count).toBe(0);
      expect(data.marketHistory.count).toBe(0);
      expect(data.commanderLog.count).toBe(0);
    });

    test("returns counts after inserting data", async () => {
      logger.logDecision({
        tick: 1,
        botId: "bot1",
        action: "mine",
        context: { system: "sol" },
      });
      logger.logDecision({
        tick: 2,
        botId: "bot1",
        action: "sell",
        context: { system: "sol" },
      });

      const res = await callRoute("stats", db, logger);
      const data = await res.json();
      expect(data.decisions.count).toBe(2);
      expect(data.decisions.byAction.mine).toBe(1);
      expect(data.decisions.byAction.sell).toBe(1);
      expect(data.decisions.byBot.bot1).toBe(2);
    });

    test("returns episode stats with success rate", async () => {
      logger.logEpisode({
        botId: "bot1",
        episodeType: "mining_run",
        startTick: 1,
        endTick: 10,
        startCredits: 1000,
        endCredits: 1500,
        route: ["sol"],
        itemsInvolved: { ore_iron: 50 },
        fuelConsumed: 5,
        risks: [],
        success: true,
      });
      logger.logEpisode({
        botId: "bot1",
        episodeType: "mining_run",
        startTick: 11,
        endTick: 20,
        startCredits: 1500,
        endCredits: 1400,
        route: ["sol"],
        itemsInvolved: {},
        fuelConsumed: 5,
        risks: ["pirate"],
        success: false,
      });

      const res = await callRoute("stats", db, logger);
      const data = await res.json();
      expect(data.episodes.count).toBe(2);
      expect(data.episodes.successRate).toBe(0.5);
      expect(data.episodes.byType.mining_run).toBe(2);
      expect(data.episodes.totalProfit).toBe(400); // (500 + -100)
    });
  });

  // ── Export: Decisions ──

  describe("GET /export/decisions", () => {
    test("returns empty records for fresh db", async () => {
      const res = await callRoute("export/decisions", db, logger);
      const data = await res.json();
      expect(data.table).toBe("decision_log");
      expect(data.recordCount).toBe(0);
      expect(data.records).toEqual([]);
    });

    test("returns decisions with parsed JSON fields", async () => {
      logger.logDecision({
        tick: 5,
        botId: "bot1",
        action: "mine",
        actionParams: { target: "sol_belt" },
        context: { fuel: 80 },
        result: { ore: 10 },
      });

      const res = await callRoute("export/decisions", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].action).toBe("mine");
      expect(data.records[0].params).toEqual({ target: "sol_belt" });
      expect(data.records[0].context).toEqual({ fuel: 80 });
      expect(data.records[0].result).toEqual({ ore: 10 });
    });

    test("filters by botId", async () => {
      logger.logDecision({ tick: 1, botId: "bot1", action: "mine", context: {} });
      logger.logDecision({ tick: 2, botId: "bot2", action: "sell", context: {} });

      const res = await callRoute("export/decisions?botId=bot1", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].bot_id).toBe("bot1");
    });

    test("filters by action", async () => {
      logger.logDecision({ tick: 1, botId: "bot1", action: "mine", context: {} });
      logger.logDecision({ tick: 2, botId: "bot1", action: "sell", context: {} });

      const res = await callRoute("export/decisions?action=sell", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].action).toBe("sell");
    });

    test("filters by tick range", async () => {
      logger.logDecision({ tick: 5, botId: "bot1", action: "mine", context: {} });
      logger.logDecision({ tick: 15, botId: "bot1", action: "sell", context: {} });
      logger.logDecision({ tick: 25, botId: "bot1", action: "travel", context: {} });

      const res = await callRoute("export/decisions?startTick=10&endTick=20", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].tick).toBe(15);
    });

    test("respects limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        logger.logDecision({ tick: i, botId: "bot1", action: "mine", context: {} });
      }

      const res = await callRoute("export/decisions?limit=3", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(3);
    });

    test("returns CSV when format=csv", async () => {
      logger.logDecision({ tick: 1, botId: "bot1", action: "mine", context: {} });

      const res = await callRoute("export/decisions?format=csv", db, logger);
      expect(res.headers.get("Content-Type")).toBe("text/csv");
      const text = await res.text();
      expect(text).toContain("id,tick,bot_id,action");
      expect(text).toContain("mine");
    });
  });

  // ── Export: Snapshots ──

  describe("GET /export/snapshots", () => {
    test("returns snapshots with parsed JSON", async () => {
      logger.logSnapshot({
        tick: 1,
        botId: "bot1",
        playerState: { credits: 5000 },
        shipState: { fuel: 80 },
        location: { system: "sol" },
      });
      logger.flushSnapshots();

      const res = await callRoute("export/snapshots", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].player_state).toEqual({ credits: 5000 });
      expect(data.records[0].ship_state).toEqual({ fuel: 80 });
      expect(data.records[0].location).toEqual({ system: "sol" });
    });
  });

  // ── Export: Episodes ──

  describe("GET /export/episodes", () => {
    test("returns episodes with parsed JSON arrays", async () => {
      logger.logEpisode({
        botId: "bot1",
        episodeType: "trade_run",
        startTick: 1,
        endTick: 50,
        startCredits: 1000,
        endCredits: 2000,
        route: ["sol", "alpha"],
        itemsInvolved: { ore_iron: 100 },
        fuelConsumed: 10,
        risks: ["pirate"],
        success: true,
      });

      const res = await callRoute("export/episodes", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].route).toEqual(["sol", "alpha"]);
      expect(data.records[0].items_involved).toEqual({ ore_iron: 100 });
      expect(data.records[0].risks).toEqual(["pirate"]);
    });

    test("filters by episodeType", async () => {
      logger.logEpisode({
        botId: "bot1", episodeType: "mining_run", startTick: 1, endTick: 10,
        startCredits: 100, endCredits: 200, route: [], itemsInvolved: {},
        fuelConsumed: 1, risks: [], success: true,
      });
      logger.logEpisode({
        botId: "bot1", episodeType: "trade_run", startTick: 11, endTick: 20,
        startCredits: 200, endCredits: 400, route: [], itemsInvolved: {},
        fuelConsumed: 2, risks: [], success: true,
      });

      const res = await callRoute("export/episodes?episodeType=trade_run", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].episode_type).toBe("trade_run");
    });

    test("filters by successOnly", async () => {
      logger.logEpisode({
        botId: "bot1", episodeType: "mining_run", startTick: 1, endTick: 10,
        startCredits: 100, endCredits: 200, route: [], itemsInvolved: {},
        fuelConsumed: 1, risks: [], success: true,
      });
      logger.logEpisode({
        botId: "bot1", episodeType: "mining_run", startTick: 11, endTick: 20,
        startCredits: 200, endCredits: 150, route: [], itemsInvolved: {},
        fuelConsumed: 1, risks: [], success: false,
      });

      const res = await callRoute("export/episodes?successOnly=true", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].success).toBe(1);
    });
  });

  // ── Export: Market History ──

  describe("GET /export/market-history", () => {
    test("returns CSV format", async () => {
      logger.logMarketPrices(1, "station1", [
        { itemId: "ore_iron", buyPrice: 10, sellPrice: 8, buyVolume: 100, sellVolume: 50 },
      ]);

      const res = await callRoute("export/market-history", db, logger);
      expect(res.headers.get("Content-Type")).toBe("text/csv");
      const text = await res.text();
      expect(text).toContain("tick,station_id,item_id");
      expect(text).toContain("ore_iron");
    });

    test("filters by stationId", async () => {
      logger.logMarketPrices(1, "station1", [
        { itemId: "ore_iron", buyPrice: 10, sellPrice: 8, buyVolume: 100, sellVolume: 50 },
      ]);
      logger.logMarketPrices(1, "station2", [
        { itemId: "ore_copper", buyPrice: 15, sellPrice: 12, buyVolume: 80, sellVolume: 40 },
      ]);

      const res = await callRoute("export/market-history?stationId=station1", db, logger);
      const text = await res.text();
      expect(text).toContain("station1");
      expect(text).not.toContain("station2");
    });
  });

  // ── Export: Commander Log ──

  describe("GET /export/commander-log", () => {
    test("returns commander decisions with parsed JSON", async () => {
      logger.logCommanderDecision({
        tick: 1,
        goal: "maximize_income",
        fleetState: { activeBots: 3 },
        assignments: [{ botId: "bot1", routine: "miner" }],
        reasoning: "Mining is profitable",
      });

      const res = await callRoute("export/commander-log", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].fleet_state).toEqual({ activeBots: 3 });
      expect(data.records[0].assignments).toEqual([{ botId: "bot1", routine: "miner" }]);
    });

    test("filters by goal", async () => {
      logger.logCommanderDecision({
        tick: 1, goal: "maximize_income", fleetState: {}, assignments: [], reasoning: "a",
      });
      logger.logCommanderDecision({
        tick: 2, goal: "explore_region", fleetState: {}, assignments: [], reasoning: "b",
      });

      const res = await callRoute("export/commander-log?goal=explore_region", db, logger);
      const data = await res.json();
      expect(data.recordCount).toBe(1);
      expect(data.records[0].goal).toBe("explore_region");
    });
  });

  // ── Clear ──

  describe("POST /clear", () => {
    test("rejects without confirm flag", async () => {
      const res = await callRoute("clear", db, logger, "POST", {});
      expect(res.status).toBe(400);
    });

    test("clears all tables with confirm", async () => {
      logger.logDecision({ tick: 1, botId: "bot1", action: "mine", context: {} });
      logger.logSnapshot({ tick: 1, botId: "bot1", playerState: {}, shipState: {}, location: {} });
      logger.flushSnapshots();

      const res = await callRoute("clear", db, logger, "POST", { confirm: true });
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.recordsDeleted.decision_log).toBe(1);
      expect(data.recordsDeleted.state_snapshots).toBe(1);
    });

    test("clears specific tables", async () => {
      logger.logDecision({ tick: 1, botId: "bot1", action: "mine", context: {} });
      logger.logSnapshot({ tick: 1, botId: "bot1", playerState: {}, shipState: {}, location: {} });
      logger.flushSnapshots();

      const res = await callRoute("clear", db, logger, "POST", {
        confirm: true,
        tables: ["decision_log"],
      });
      const data = await res.json();
      expect(data.recordsDeleted.decision_log).toBe(1);
      expect(data.recordsDeleted.state_snapshots).toBeUndefined();

      // Snapshots should still exist
      const count = (db.query("SELECT COUNT(*) as c FROM state_snapshots").get() as { c: number }).c;
      expect(count).toBe(1);
    });

    test("clears by olderThanTick", async () => {
      logger.logDecision({ tick: 5, botId: "bot1", action: "mine", context: {} });
      logger.logDecision({ tick: 15, botId: "bot1", action: "sell", context: {} });

      const res = await callRoute("clear", db, logger, "POST", {
        confirm: true,
        olderThanTick: 10,
        tables: ["decision_log"],
      });
      const data = await res.json();
      expect(data.recordsDeleted.decision_log).toBe(1);

      // Tick 15 should remain
      const count = (db.query("SELECT COUNT(*) as c FROM decision_log").get() as { c: number }).c;
      expect(count).toBe(1);
    });

    test("rejects invalid JSON body", async () => {
      const url = new URL("http://localhost/api/training/clear");
      const req = new Request(url.toString(), {
        method: "POST",
        body: "not json",
      });
      const res = await handleTrainingRoute(url, req, { db, logger });
      expect(res.status).toBe(400);
    });

    test("ignores invalid table names", async () => {
      const res = await callRoute("clear", db, logger, "POST", {
        confirm: true,
        tables: ["decision_log", "not_a_real_table"],
      });
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.recordsDeleted.not_a_real_table).toBeUndefined();
    });
  });

  // ── 404 ──

  describe("unknown routes", () => {
    test("returns 404 for unknown path", async () => {
      const res = await callRoute("nonexistent", db, logger);
      expect(res.status).toBe(404);
    });
  });
});
