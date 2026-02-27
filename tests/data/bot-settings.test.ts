import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

/** Mimics the bot_settings table from migrateV4 */
function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE bot_settings (
      username TEXT PRIMARY KEY,
      fuel_emergency_threshold REAL NOT NULL DEFAULT 20,
      auto_repair INTEGER NOT NULL DEFAULT 1,
      max_cargo_fill_pct REAL NOT NULL DEFAULT 90,
      storage_mode TEXT NOT NULL DEFAULT 'sell',
      faction_storage INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  return db;
}

/** Save function matching the one in index.ts */
function saveBotSettings(db: Database, username: string, settings: {
  fuelEmergencyThreshold: number;
  autoRepair: boolean;
  maxCargoFillPct: number;
  storageMode: string;
  factionStorage: boolean;
}): void {
  db.run(
    `INSERT OR REPLACE INTO bot_settings (username, fuel_emergency_threshold, auto_repair, max_cargo_fill_pct, storage_mode, faction_storage, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [username, settings.fuelEmergencyThreshold, settings.autoRepair ? 1 : 0, settings.maxCargoFillPct, settings.storageMode, settings.factionStorage ? 1 : 0]
  );
}

/** Load function matching the one in index.ts */
function loadBotSettings(db: Database, username: string): {
  fuelEmergencyThreshold: number;
  autoRepair: boolean;
  maxCargoFillPct: number;
  storageMode: "sell" | "deposit" | "faction_deposit";
  factionStorage: boolean;
} | null {
  const row = db.query(
    "SELECT fuel_emergency_threshold, auto_repair, max_cargo_fill_pct, storage_mode, faction_storage FROM bot_settings WHERE username = ?"
  ).get(username) as {
    fuel_emergency_threshold: number;
    auto_repair: number;
    max_cargo_fill_pct: number;
    storage_mode: string;
    faction_storage: number;
  } | null;
  if (!row) return null;
  return {
    fuelEmergencyThreshold: row.fuel_emergency_threshold,
    autoRepair: row.auto_repair === 1,
    maxCargoFillPct: row.max_cargo_fill_pct,
    storageMode: row.storage_mode as "sell" | "deposit" | "faction_deposit",
    factionStorage: row.faction_storage === 1,
  };
}

describe("Bot Settings Persistence", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  test("returns null for unknown bot", () => {
    expect(loadBotSettings(db, "unknown")).toBeNull();
  });

  test("saves and loads default settings", () => {
    saveBotSettings(db, "TestBot", {
      fuelEmergencyThreshold: 20,
      autoRepair: true,
      maxCargoFillPct: 90,
      storageMode: "sell",
      factionStorage: false,
    });

    const loaded = loadBotSettings(db, "TestBot");
    expect(loaded).not.toBeNull();
    expect(loaded!.fuelEmergencyThreshold).toBe(20);
    expect(loaded!.autoRepair).toBe(true);
    expect(loaded!.maxCargoFillPct).toBe(90);
    expect(loaded!.storageMode).toBe("sell");
    expect(loaded!.factionStorage).toBe(false);
  });

  test("saves custom settings", () => {
    saveBotSettings(db, "MinerBot", {
      fuelEmergencyThreshold: 15,
      autoRepair: false,
      maxCargoFillPct: 95,
      storageMode: "faction_deposit",
      factionStorage: true,
    });

    const loaded = loadBotSettings(db, "MinerBot");
    expect(loaded!.fuelEmergencyThreshold).toBe(15);
    expect(loaded!.autoRepair).toBe(false);
    expect(loaded!.maxCargoFillPct).toBe(95);
    expect(loaded!.storageMode).toBe("faction_deposit");
    expect(loaded!.factionStorage).toBe(true);
  });

  test("updates existing settings (upsert)", () => {
    saveBotSettings(db, "TestBot", {
      fuelEmergencyThreshold: 20,
      autoRepair: true,
      maxCargoFillPct: 90,
      storageMode: "sell",
      factionStorage: false,
    });

    // Update
    saveBotSettings(db, "TestBot", {
      fuelEmergencyThreshold: 10,
      autoRepair: false,
      maxCargoFillPct: 80,
      storageMode: "deposit",
      factionStorage: true,
    });

    const loaded = loadBotSettings(db, "TestBot");
    expect(loaded!.fuelEmergencyThreshold).toBe(10);
    expect(loaded!.autoRepair).toBe(false);
    expect(loaded!.maxCargoFillPct).toBe(80);
    expect(loaded!.storageMode).toBe("deposit");
    expect(loaded!.factionStorage).toBe(true);
  });

  test("stores settings per-bot independently", () => {
    saveBotSettings(db, "Bot1", {
      fuelEmergencyThreshold: 10,
      autoRepair: true,
      maxCargoFillPct: 85,
      storageMode: "sell",
      factionStorage: false,
    });

    saveBotSettings(db, "Bot2", {
      fuelEmergencyThreshold: 30,
      autoRepair: false,
      maxCargoFillPct: 70,
      storageMode: "faction_deposit",
      factionStorage: true,
    });

    const s1 = loadBotSettings(db, "Bot1")!;
    const s2 = loadBotSettings(db, "Bot2")!;

    expect(s1.fuelEmergencyThreshold).toBe(10);
    expect(s2.fuelEmergencyThreshold).toBe(30);
    expect(s1.storageMode).toBe("sell");
    expect(s2.storageMode).toBe("faction_deposit");
  });
});
