/**
 * SQLite database setup with schema and migrations.
 * Single file database for cache, training data, and market history.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";

const DB_PATH = "data/commander.db";
const CURRENT_SCHEMA_VERSION = 6;

export function createDatabase(): Database {
  mkdirSync("data", { recursive: true });

  const db = new Database(DB_PATH, { create: true });

  // Performance pragmas
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA cache_size = -64000"); // 64MB cache
  db.run("PRAGMA busy_timeout = 5000");

  // Schema versioning
  db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | null;
  const currentVersion = row?.version ?? 0;

  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    applyMigrations(db, currentVersion);
  }

  return db;
}

function applyMigrations(db: Database, fromVersion: number): void {
  const tx = db.transaction(() => {
    if (fromVersion < 1) migrateV1(db);
    if (fromVersion < 2) migrateV2(db);
    if (fromVersion < 3) migrateV3(db);
    if (fromVersion < 4) migrateV4(db);
    if (fromVersion < 5) migrateV5(db);
    if (fromVersion < 6) migrateV6(db);

    // Update schema version
    db.run("DELETE FROM schema_version");
    db.run("INSERT INTO schema_version (version) VALUES (?)", [CURRENT_SCHEMA_VERSION]);
  });

  tx();
  console.log(`[DB] Migrated from v${fromVersion} → v${CURRENT_SCHEMA_VERSION}`);
}

function migrateV1(db: Database): void {
  // ── Static data cache (version-gated) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      game_version TEXT,
      fetched_at INTEGER NOT NULL
    )
  `);

  // ── Timed cache (market, system, poi) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS timed_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL
    )
  `);

  // ── Decision log (training data - every bot action) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      action TEXT NOT NULL,
      params TEXT,
      context TEXT NOT NULL,
      result TEXT,
      commander_goal TEXT,
      game_version TEXT NOT NULL,
      commander_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_decision_log_bot ON decision_log(bot_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_decision_log_tick ON decision_log(tick)");
  db.run("CREATE INDEX IF NOT EXISTS idx_decision_log_action ON decision_log(action)");

  // ── State snapshots (full bot state every ~30s) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS state_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      player_state TEXT NOT NULL,
      ship_state TEXT NOT NULL,
      location TEXT NOT NULL,
      game_version TEXT NOT NULL,
      commander_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_snapshots_bot ON state_snapshots(bot_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_snapshots_tick ON state_snapshots(tick)");

  // ── Episode summaries (completed task cycles) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS episodes (
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
      game_version TEXT NOT NULL,
      commander_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_episodes_bot ON episodes(bot_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(episode_type)");

  // ── Market price history (time-series) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS market_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      station_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      buy_price REAL,
      sell_price REAL,
      buy_volume INTEGER,
      sell_volume INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_market_station_item ON market_history(station_id, item_id)"
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_market_tick ON market_history(tick)");

  // ── Commander decisions log ──
  db.run(`
    CREATE TABLE IF NOT EXISTS commander_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      goal TEXT NOT NULL,
      fleet_state TEXT NOT NULL,
      assignments TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      economy_state TEXT,
      game_version TEXT NOT NULL,
      commander_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_commander_tick ON commander_log(tick)");

  // ── Bot credentials and sessions ──
  db.run(`
    CREATE TABLE IF NOT EXISTS bot_sessions (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      empire TEXT,
      player_id TEXT,
      session_id TEXT,
      session_expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function migrateV2(db: Database): void {
  // ── Credit history (fleet total credits over time) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS credit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      total_credits INTEGER NOT NULL,
      active_bots INTEGER NOT NULL
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_credit_ts ON credit_history(timestamp)");
}

function migrateV3(db: Database): void {
  // ── Fleet goals (persisted across restarts) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      constraints TEXT
    )
  `);
}

function migrateV4(db: Database): void {
  // ── Bot settings (persisted across restarts) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS bot_settings (
      username TEXT PRIMARY KEY,
      fuel_emergency_threshold REAL NOT NULL DEFAULT 20,
      auto_repair INTEGER NOT NULL DEFAULT 1,
      max_cargo_fill_pct REAL NOT NULL DEFAULT 90,
      storage_mode TEXT NOT NULL DEFAULT 'sell',
      faction_storage INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function migrateV5(db: Database): void {
  // ── Financial events (revenue/cost time-series for profit chart) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS financial_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      amount REAL NOT NULL,
      bot_id TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_financial_ts ON financial_events(timestamp)");
  db.run("CREATE INDEX IF NOT EXISTS idx_financial_type ON financial_events(event_type)");

  // ── Trade log (individual buy/sell transactions) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS trade_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      action TEXT NOT NULL,
      item_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price_each REAL NOT NULL,
      total REAL NOT NULL,
      station_id TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_trade_ts ON trade_log(timestamp)");
  db.run("CREATE INDEX IF NOT EXISTS idx_trade_bot ON trade_log(bot_id)");
}

function migrateV6(db: Database): void {
  // ── Fleet settings (persisted across restarts) ──
  db.run(`
    CREATE TABLE IF NOT EXISTS fleet_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// ── Helper for the cache ──

export class CacheHelper {
  constructor(private db: Database) {}

  getStatic(key: string, gameVersion?: string): string | null {
    const query = gameVersion
      ? "SELECT data FROM cache WHERE key = ? AND game_version = ?"
      : "SELECT data FROM cache WHERE key = ?";
    const params = gameVersion ? [key, gameVersion] : [key];
    const row = this.db.query(query).get(...params) as { data: string } | null;
    return row?.data ?? null;
  }

  setStatic(key: string, data: string, gameVersion: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO cache (key, data, game_version, fetched_at) VALUES (?, ?, ?, ?)",
      [key, data, gameVersion, Date.now()]
    );
  }

  deleteStatic(key: string): void {
    this.db.run("DELETE FROM cache WHERE key = ?", [key]);
  }

  getTimed(key: string): string | null {
    const row = this.db
      .query("SELECT data, fetched_at, ttl_ms FROM timed_cache WHERE key = ?")
      .get(key) as { data: string; fetched_at: number; ttl_ms: number } | null;

    if (!row) return null;
    if (Date.now() - row.fetched_at > row.ttl_ms) return null; // expired
    return row.data;
  }

  setTimed(key: string, data: string, ttlMs: number): void {
    this.db.run(
      "INSERT OR REPLACE INTO timed_cache (key, data, fetched_at, ttl_ms) VALUES (?, ?, ?, ?)",
      [key, data, Date.now(), ttlMs]
    );
  }

  clearTimed(keyPattern?: string): void {
    if (keyPattern) {
      this.db.run("DELETE FROM timed_cache WHERE key LIKE ?", [keyPattern]);
    } else {
      this.db.run("DELETE FROM timed_cache");
    }
  }

  /** Get all static cache entries matching a key prefix */
  getAllByPrefix(prefix: string): Array<{ key: string; data: string }> {
    return this.db.query("SELECT key, data FROM cache WHERE key LIKE ?").all(`${prefix}%`) as Array<{ key: string; data: string }>;
  }

  clearAll(): void {
    this.db.run("DELETE FROM cache");
    this.db.run("DELETE FROM timed_cache");
  }
}
