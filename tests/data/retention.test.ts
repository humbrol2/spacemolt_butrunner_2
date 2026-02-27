import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { RetentionManager } from "../../src/data/retention";

function createTestDb(): Database {
  const db = new Database(":memory:");

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

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function insertRows(db: Database, table: string, count: number, createdAt: string): void {
  let stmt;
  if (table === "market_history") {
    stmt = db.prepare(`INSERT INTO ${table} (tick, station_id, item_id, buy_price, sell_price, buy_volume, sell_volume, created_at) VALUES (?, 'st1', 'ore', 10, 8, 100, 50, ?)`);
  } else if (table === "commander_log") {
    stmt = db.prepare(`INSERT INTO ${table} (tick, goal, fleet_state, assignments, reasoning, created_at) VALUES (?, 'maximize_income', '{}', '[]', 'test', ?)`);
  } else if (table === "state_snapshots") {
    stmt = db.prepare(`INSERT INTO ${table} (tick, bot_id, player_state, ship_state, location, created_at) VALUES (?, 'bot1', '{}', '{}', '{}', ?)`);
  } else {
    stmt = db.prepare(`INSERT INTO ${table} (tick, bot_id, action, context, created_at) VALUES (?, 'bot1', 'mine', '{}', ?)`);
  }

  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      stmt.run(i, createdAt);
    }
  });
  tx();
}

function getCount(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count;
}

describe("RetentionManager", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test("does nothing with no data", () => {
    const rm = new RetentionManager(db);
    const result = rm.run();
    expect(result.decisionLogDeleted).toBe(0);
    expect(result.snapshotsDeleted).toBe(0);
    expect(result.marketHistoryDeleted).toBe(0);
    expect(result.commanderLogDeleted).toBe(0);
  });

  test("does not delete recent data (< 7 days)", () => {
    insertRows(db, "decision_log", 30, daysAgo(3));
    insertRows(db, "state_snapshots", 30, daysAgo(3));
    insertRows(db, "market_history", 30, daysAgo(3));

    const rm = new RetentionManager(db);
    const result = rm.run();

    expect(result.decisionLogDeleted).toBe(0);
    expect(result.snapshotsDeleted).toBe(0);
    expect(result.marketHistoryDeleted).toBe(0);
    expect(getCount(db, "decision_log")).toBe(30);
  });

  test("downsamples 33% zone (7-30 days old)", () => {
    // Insert 30 rows 15 days ago (in the 33% zone)
    insertRows(db, "decision_log", 30, daysAgo(15));

    const before = getCount(db, "decision_log");
    expect(before).toBe(30);

    const rm = new RetentionManager(db);
    rm.run();

    const after = getCount(db, "decision_log");
    // Should keep every 3rd record (id % 3 == 0), so ~10 kept, ~20 deleted
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(0);
  });

  test("downsamples 10% zone (30-90 days old)", () => {
    // Insert 100 rows 60 days ago (in the 10% zone)
    insertRows(db, "decision_log", 100, daysAgo(60));

    const rm = new RetentionManager(db);
    rm.run();

    const after = getCount(db, "decision_log");
    // Should keep every 10th record (id % 10 == 0), so ~10 kept, ~90 deleted
    expect(after).toBeLessThanOrEqual(11); // could be 10 or 11 depending on starting id
    expect(after).toBeGreaterThan(0);
  });

  test("deletes all data older than 90 days from high-volume tables", () => {
    insertRows(db, "decision_log", 50, daysAgo(100));
    insertRows(db, "state_snapshots", 50, daysAgo(100));
    insertRows(db, "market_history", 50, daysAgo(100));

    const rm = new RetentionManager(db);
    const result = rm.run();

    expect(getCount(db, "decision_log")).toBe(0);
    expect(getCount(db, "state_snapshots")).toBe(0);
    expect(getCount(db, "market_history")).toBe(0);
    expect(result.decisionLogDeleted).toBe(50);
    expect(result.snapshotsDeleted).toBe(50);
    expect(result.marketHistoryDeleted).toBe(50);
  });

  test("commander_log older than 90 days is downsampled, not deleted", () => {
    insertRows(db, "commander_log", 360, daysAgo(100));

    const rm = new RetentionManager(db);
    rm.run();

    const after = getCount(db, "commander_log");
    // Should keep every 360th record - at least 1 record should remain
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(360);
  });

  test("works with custom config", () => {
    insertRows(db, "decision_log", 50, daysAgo(5));

    // Custom config: full resolution only 3 days
    const rm = new RetentionManager(db, { fullResolutionDays: 3 });
    rm.run();

    // 5-day-old data falls in 33% zone with 3-day full resolution
    const after = getCount(db, "decision_log");
    expect(after).toBeLessThan(50);
  });

  test("getDataRange returns correct stats", () => {
    insertRows(db, "decision_log", 10, daysAgo(5));

    const rm = new RetentionManager(db);
    const range = rm.getDataRange("decision_log");

    expect(range.count).toBe(10);
    expect(range.oldest).not.toBeNull();
    expect(range.newest).not.toBeNull();
  });

  test("getDataRange returns nulls for empty table", () => {
    const rm = new RetentionManager(db);
    const range = rm.getDataRange("decision_log");

    expect(range.count).toBe(0);
    expect(range.oldest).toBeNull();
    expect(range.newest).toBeNull();
  });

  test("preserves recent data while cleaning old data", () => {
    // Mix of recent and old data
    insertRows(db, "decision_log", 20, daysAgo(2));   // recent - keep all
    insertRows(db, "decision_log", 20, daysAgo(100));  // old - delete all

    const rm = new RetentionManager(db);
    rm.run();

    const after = getCount(db, "decision_log");
    expect(after).toBe(20); // only recent data remains
  });
});
