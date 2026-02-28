/**
 * SpaceMolt Commander v2 - Entry Point
 * Wires together all components and starts the system.
 */

import { readFileSync, existsSync, mkdirSync, createWriteStream } from "fs";
import TOML from "toml";
import { createDatabase, CacheHelper } from "./data/database";
import { SessionStore } from "./data/session-store";
import { TrainingLogger } from "./data/training-logger";
import { GameCache } from "./data/game-cache";
import { RetentionManager } from "./data/retention";
import { Galaxy, Navigation, Market, Cargo, Fuel, Combat, Crafting, Station, ApiClient } from "./core";
import { BotManager, type SharedServices } from "./bot/bot-manager";
import { Commander, type CommanderDeps } from "./commander/commander";
import { ScoringBrain } from "./commander/scoring-brain";
import { buildRoutineRegistry } from "./routines";
import { createServer, broadcast, sendTo, getClientCount } from "./server/server";
import { AppConfigSchema, type AppConfig, type Goal, type StockTarget } from "./types/config";
import type { ClientMessage, RoutineName, FleetStats, ServerMessage, EconomyState, MarketStationData, FactionState } from "./types/protocol";
import type { Database } from "bun:sqlite";

const VERSION = "2.0.0";
const BUILD = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHmmss

// ── File Logging ──
// Tee all console output to logs/commander.log (timestamped, rotates daily)
{
  mkdirSync("logs", { recursive: true });
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logStream = createWriteStream(`logs/commander-${date}.log`, { flags: "a" });

  function timestamp(): string {
    return new Date().toISOString();
  }

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    const line = `[${timestamp()}] ${args.map(String).join(" ")}`;
    logStream.write(line + "\n");
    origLog.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    const line = `[${timestamp()}] WARN ${args.map(String).join(" ")}`;
    logStream.write(line + "\n");
    origWarn.apply(console, args);
  };
  console.error = (...args: unknown[]) => {
    const line = `[${timestamp()}] ERROR ${args.map(String).join(" ")}`;
    logStream.write(line + "\n");
    origError.apply(console, args);
  };

  // Startup banner — easy to spot in logs when reviewing
  const banner = [
    "",
    "════════════════════════════════════════════════════════════════",
    `  SPACEMOLT COMMANDER v${VERSION} (build ${BUILD})`,
    `  Started: ${new Date().toISOString()}`,
    `  Platform: ${process.platform} | Runtime: Bun ${typeof Bun !== "undefined" ? Bun.version : "?"}`,
    "════════════════════════════════════════════════════════════════",
    "",
  ].join("\n");
  logStream.write(banner + "\n");
  origLog(banner);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Load Configuration ──

function loadConfig(): AppConfig {
  const configPath = "config.toml";
  if (!existsSync(configPath)) {
    console.log("[Config] No config.toml found, using defaults");
    return AppConfigSchema.parse({});
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = TOML.parse(raw);
    return AppConfigSchema.parse(parsed);
  } catch (err) {
    console.error("[Config] Failed to parse config.toml:", err);
    console.log("[Config] Using defaults");
    return AppConfigSchema.parse({});
  }
}

// ── Bot Settings Persistence ──

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

// ── Fleet Settings Persistence ──

function saveFleetSettings(db: Database, settings: { factionTaxPercent: number; minBotCredits: number }): void {
  const stmt = db.prepare("INSERT OR REPLACE INTO fleet_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
  stmt.run("factionTaxPercent", String(settings.factionTaxPercent));
  stmt.run("minBotCredits", String(settings.minBotCredits));
}

function loadFleetSettings(db: Database): { factionTaxPercent: number; minBotCredits: number } | null {
  const rows = db.query("SELECT key, value FROM fleet_settings").all() as Array<{ key: string; value: string }>;
  if (rows.length === 0) return null;
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    factionTaxPercent: Number(map.get("factionTaxPercent") ?? 0),
    minBotCredits: Number(map.get("minBotCredits") ?? 0),
  };
}

// ── Goal Persistence ──

function saveGoals(db: Database, goals: Goal[]): void {
  const tx = db.transaction(() => {
    db.run("DELETE FROM goals");
    const insert = db.prepare(
      "INSERT INTO goals (type, priority, params, constraints) VALUES (?, ?, ?, ?)"
    );
    for (const g of goals) {
      insert.run(g.type, g.priority, JSON.stringify(g.params ?? {}), JSON.stringify(g.constraints ?? null));
    }
  });
  tx();
}

function loadGoals(db: Database): Goal[] {
  const rows = db.query("SELECT type, priority, params, constraints FROM goals ORDER BY priority DESC").all() as Array<{
    type: string;
    priority: number;
    params: string;
    constraints: string | null;
  }>;
  return rows.map((r) => ({
    type: r.type as Goal["type"],
    priority: r.priority,
    params: JSON.parse(r.params),
    constraints: r.constraints ? JSON.parse(r.constraints) : undefined,
  }));
}

// ── Main ──

async function main() {
  console.log(`\n⚡ SpaceMolt Commander v${VERSION}\n`);

  // 1. Load config
  const config = loadConfig();
  console.log(`[Config] Brain: ${config.commander.brain}`);
  console.log(`[Config] Max bots: ${config.fleet.max_bots}`);
  console.log(`[Config] Goals: ${config.goals.length > 0 ? config.goals.map((g) => g.type).join(", ") : "none set"}`);

  // 2. Initialize database
  const db = createDatabase();
  const cacheHelper = new CacheHelper(db);
  const sessionStore = new SessionStore(db);
  const trainingLogger = new TrainingLogger(db);
  console.log("[DB] Database initialized");

  // Configure training logger
  trainingLogger.configure({
    decisions: config.training.log_decisions,
    snapshots: config.training.log_snapshots,
    episodes: config.training.log_episodes,
    marketHistory: config.training.log_market_history,
  });

  // 3. Initialize core services
  const galaxy = new Galaxy();
  const nav = new Navigation(galaxy);
  const gameCache = new GameCache(cacheHelper, trainingLogger);
  const market = new Market(gameCache, galaxy);
  const cargo = new Cargo();
  const fuel = new Fuel(nav);
  const combat = new Combat(galaxy);
  const crafting = new Crafting(cargo);
  const station = new Station(galaxy);

  // 3.5. Fleet config
  const fleetHomeBase = config.fleet.home_base;
  const fleetHomeSystem = config.fleet.home_system;
  const fleetStorageMode = config.fleet.default_storage_mode;
  const fleetFactionStation = config.fleet.faction_storage_station;
  if (fleetHomeBase) {
    console.log(`[Config] Fleet home base: ${fleetHomeBase}`);
    console.log(`[Config] Storage mode: ${fleetStorageMode}`);
    if (fleetFactionStation) {
      console.log(`[Config] Faction storage station: ${fleetFactionStation}`);
    }
  }

  // 4. Initialize bot manager
  const sharedServices: SharedServices = {
    galaxy,
    nav,
    market,
    cargo,
    fuel,
    combat,
    crafting,
    station,
    cache: gameCache,
    logger: trainingLogger,
    sessionStore,
  };

  const botManager = new BotManager(
    {
      maxBots: config.fleet.max_bots,
      loginStaggerMs: config.fleet.login_stagger_ms,
      snapshotIntervalSec: config.fleet.snapshot_interval,
    },
    sharedServices,
    (username: string) =>
      new ApiClient({
        username,
        sessionStore,
        cache: cacheHelper,
        logger: trainingLogger,
      })
  );

  // Apply fleet config to bot manager
  botManager.fleetConfig = {
    homeSystem: fleetHomeSystem,
    homeBase: fleetHomeBase,
    defaultStorageMode: fleetStorageMode,
    factionStorageStation: fleetFactionStation,
    factionTaxPercent: config.fleet.faction_tax_percent,
    minBotCredits: config.fleet.min_bot_credits,
  };

  // Override with persisted fleet settings (if any)
  const savedFleetSettings = loadFleetSettings(db);
  if (savedFleetSettings) {
    botManager.fleetConfig.factionTaxPercent = savedFleetSettings.factionTaxPercent;
    botManager.fleetConfig.minBotCredits = savedFleetSettings.minBotCredits;
    console.log(`[Config] Loaded saved fleet settings: tax=${savedFleetSettings.factionTaxPercent}%, minCredits=${savedFleetSettings.minBotCredits}`);
  }

  // Register all routines
  botManager.registerRoutines(buildRoutineRegistry());
  console.log("[Fleet] Routines registered: 10");

  // Wire bot state changes to dashboard log_entry broadcasts
  botManager.onBotStateChange = (botId, routine, state) => {
    if (getClientCount() > 0) {
      broadcast({
        type: "log_entry",
        entry: {
          timestamp: new Date().toISOString(),
          level: state.startsWith("error") || state.startsWith("emergency") ? "warn" : "info",
          botId,
          message: `[${routine}] ${state}`,
        },
      });
    }

    // Track trade events (buy/sell) from routine state yields
    parseAndLogTrade(trainingLogger, botId, state);

    // Scout completed: propagate discovered faction storage to entire fleet
    if (routine === "scout" && state.startsWith("faction storage confirmed")) {
      const bot = botManager.getAllBots().find((b) => b.id === botId);
      if (bot?.fleetConfig.factionStorageStation) {
        const stationId = bot.fleetConfig.factionStorageStation;
        const systemId = bot.fleetConfig.homeSystem;
        console.log(`[Scout] Propagating discovered faction storage: ${stationId} (system: ${systemId})`);
        propagateFleetHome(botManager, stationId, systemId);
        cacheHelper.setStatic(FACTION_STORAGE_KEY, stationId, "fleet");
        if (systemId) cacheHelper.setStatic(HOME_SYSTEM_KEY, systemId, "fleet");
        cacheHelper.setStatic(HOME_BASE_KEY, stationId, "fleet");

        // Update Commander brain
        const brain = commander.getBrain() as ScoringBrain;
        brain.homeBase = stationId;
        if (systemId) brain.homeSystem = systemId;

        // Force re-evaluation so bots get reassigned from scout
        commander.forceEvaluation();
      }
    }
  };

  // 5. Initialize commander
  const commanderDeps: CommanderDeps = {
    getFleetStatus: () => botManager.getFleetStatus(),
    assignRoutine: (botId, routine, params) =>
      botManager.assignRoutine(botId, routine as RoutineName, params),
    logger: trainingLogger,
    galaxy,
    market,
    cache: gameCache,
    crafting,
    getApi: () => {
      // Return first available authenticated API client for faction storage polling
      for (const bot of botManager.getAllBots()) {
        if (bot.api && (bot.status === "ready" || bot.status === "running")) return bot.api;
      }
      return null;
    },
    homeBase: fleetHomeBase,
    homeSystem: fleetHomeSystem,
    defaultStorageMode: fleetStorageMode,
    minBotCredits: config.fleet.min_bot_credits,
  };

  const commander = new Commander(
    {
      evaluationIntervalSec: config.commander.evaluation_interval,
      urgencyOverride: config.commander.urgency_override,
    },
    commanderDeps
  );

  // Load goals: DB first (persisted), fallback to config.toml
  const dbGoals = loadGoals(db);
  if (dbGoals.length > 0) {
    commander.setGoals(dbGoals);
    console.log(`[Commander] Goals loaded from DB: ${dbGoals.map((g) => g.type).join(", ")}`);
  } else if (config.goals.length > 0) {
    commander.setGoals(config.goals);
    saveGoals(db, config.goals);
    console.log(`[Commander] Goals loaded from config: ${config.goals.map((g) => g.type).join(", ")}`);
  }

  // Set inventory targets
  if (config.inventory_targets.length > 0) {
    commander.setStockTargets(config.inventory_targets);
    console.log(`[Commander] Stock targets: ${config.inventory_targets.length}`);
  }

  // 6. Data retention manager
  const retention = new RetentionManager(db);

  // Run retention on startup
  const retResult = retention.run();
  const totalCleaned =
    retResult.decisionLogDeleted +
    retResult.snapshotsDeleted +
    retResult.marketHistoryDeleted +
    retResult.commanderLogDeleted;
  if (totalCleaned > 0) {
    console.log(`[Retention] Cleaned ${totalCleaned} old records`);
  }

  // Schedule daily retention + economy reset
  setInterval(() => {
    const r = retention.run();
    const total = r.decisionLogDeleted + r.snapshotsDeleted + r.marketHistoryDeleted + r.commanderLogDeleted;
    if (total > 0) {
      console.log(`[Retention] Cleaned ${total} old records`);
    }
    commander.getEconomy().resetProfitTracking();
    console.log("[Economy] 24h profit tracking reset");
  }, 86_400_000); // 24 hours

  // 6b. Load recent market data from DB into cache (so market page has data on startup)
  gameCache.loadRecentMarketData(db);

  // 7. Start web server with message routing
  const server = createServer({
    port: config.server.port,
    host: config.server.host,
    staticDir: "web/build",
    db,
    trainingLogger,
    onClientMessage(ws, msg) {
      handleClientMessage(ws, msg, botManager, commander, sessionStore, ensureGalaxyLoaded, galaxy, gameCache, db);
    },
    onClientConnect(ws) {
      // Send initial state so dashboard populates immediately
      const summaries = botManager.getSummaries();
      sendTo(ws, { type: "fleet_update", bots: summaries });

      const fleet = botManager.getFleetStatus();
      const fleetStats: FleetStats = {
        totalCredits: fleet.totalCredits,
        creditsPerHour: 0,
        activeBots: fleet.activeBots,
        totalBots: fleet.bots.length,
        uptime: 0,
        apiCallsToday: { mutations: 0, queries: 0 },
      };
      sendTo(ws, { type: "stats_update", stats: fleetStats });

      const lastDecision = commander.getLastDecision();
      if (lastDecision) {
        sendTo(ws, { type: "commander_decision", decision: lastDecision });
      }

      // Send economy state
      const ecoSnap = commander.getEconomy().analyze(fleet);
      sendTo(ws, {
        type: "economy_update",
        economy: {
          deficits: ecoSnap.deficits.map(d => ({
            itemId: d.itemId,
            itemName: formatItemName(d.itemId),
            demandPerHour: d.demandPerHour,
            supplyPerHour: d.supplyPerHour,
            shortfall: d.shortfall,
            priority: d.priority,
          })),
          surpluses: ecoSnap.surpluses.map(s => ({
            itemId: s.itemId,
            itemName: formatItemName(s.itemId),
            excessPerHour: s.excessPerHour,
            stationId: s.stationId,
            stationName: s.stationId || "Fleet",
            currentStock: s.currentStock,
          })),
          openOrders: [],
          totalRevenue24h: ecoSnap.totalRevenue,
          totalCosts24h: ecoSnap.totalCosts,
          netProfit24h: ecoSnap.netProfit,
        },
      });

      // Send galaxy data if loaded
      if (galaxy.systemCount > 0) {
        const galSummaries = galaxy.toSummaries();
        console.log(`[WS] Sending galaxy to new client: ${galSummaries.length} systems`);
        sendTo(ws, { type: "galaxy_update", systems: galSummaries });
      } else {
        console.log(`[WS] No galaxy data to send (systemCount=0)`);
      }

      // Send market data if available
      const marketData = buildMarketData(gameCache, galaxy);
      if (marketData.length > 0) {
        sendTo(ws, { type: "market_update", stations: marketData });
      }

      // Send current goals
      const currentGoals = commander.getGoals();
      sendTo(ws, { type: "goals_update", goals: currentGoals });

      // Send current fleet settings
      sendTo(ws, { type: "fleet_settings_update", settings: { factionTaxPercent: botManager.fleetConfig.factionTaxPercent, minBotCredits: botManager.fleetConfig.minBotCredits } });

      // Send faction data (async, non-blocking)
      buildFactionState(botManager, commander, { defaultStorageMode: config.fleet.default_storage_mode }).then((faction) => {
        if (faction) sendTo(ws, { type: "faction_update", faction });
      }).catch((err) => {
        console.warn("[Faction] Initial faction data failed:", err instanceof Error ? err.message : err);
      });
    },
  });

  // 8. Start broadcast loop (push state to dashboard every 3s)
  startBroadcastLoop(botManager, commander, galaxy, db, gameCache, trainingLogger, config.fleet.default_storage_mode);

  // 9. Load registered bots from DB (with persisted settings)
  const bots = sessionStore.listBots();
  for (const bot of bots) {
    try {
      const added = botManager.addBot(bot.username);
      // Restore persisted settings
      const savedSettings = loadBotSettings(db, bot.username);
      if (savedSettings) {
        added.settings = savedSettings;
        console.log(`[Settings] Restored settings for ${bot.username}`);
      }
    } catch (err) {
      console.warn(`[Fleet] Failed to add bot ${bot.username}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[Fleet] ${botManager.botCount} bot(s) registered`);

  // 10. Galaxy loading helper (uses bot's authenticated API)
  let galaxyLoaded = false;
  async function ensureGalaxyLoaded(): Promise<void> {
    if (galaxyLoaded) return;
    const ok = await botManager.loadGalaxy();
    if (ok) {
      galaxyLoaded = true;
      // Broadcast galaxy data to all connected dashboards
      const summaries = galaxy.toSummaries();
      console.log(`[Galaxy] Broadcasting ${summaries.length} systems to dashboard`);
      broadcast({ type: "galaxy_update", systems: summaries });
    }
  }

  // 11. Auto-login all bots on startup and load galaxy
  if (botManager.botCount > 0) {
    console.log("[Fleet] Auto-logging in bots...");
    const result = await botManager.loginAll();
    if (result.success.length > 0) {
      console.log(`[Fleet] Logged in: ${result.success.join(", ")}`);
      await ensureGalaxyLoaded();

      // Overlay persisted system details (cached from previous bot visits)
      const persistedSystems = gameCache.loadPersistedSystemDetails();
      if (persistedSystems.length > 0) {
        let overlaid = 0;
        for (const sys of persistedSystems) {
          if (sys.id && sys.pois.length > 0) {
            galaxy.updateSystem(sys);
            overlaid++;
          }
        }
        console.log(`[Galaxy] Loaded ${overlaid} persisted system details (POI data from previous visits)`);
      }

      // Dump galaxy systems for diagnostics
      if (galaxy.systemCount > 0) {
        const systems = galaxy.getAllSystems();
        const withStations = systems.filter((s) => s.pois.some((p) => p.hasBase));
        console.log(`[Galaxy] ${systems.length} systems loaded, ${withStations.length} with stations:`);
        for (const sys of withStations) {
          const stations = sys.pois.filter((p) => p.hasBase);
          console.log(`  ${sys.id} "${sys.name}": ${stations.map((s) => `${s.baseId ?? "?"} (${s.baseName ?? s.name})`).join(", ")}`);
        }
      }

      // Ensure all bots are in the same faction and promoted to officer
      await ensureFactionMembership(botManager);

      // Auto-discover faction storage station if any bot uses faction_deposit mode
      const anyFactionMode = fleetStorageMode === "faction_deposit"
        || botManager.getAllBots().some((b) => b.settings.storageMode === "faction_deposit" || b.settings.factionStorage);
      if (anyFactionMode && !botManager.fleetConfig.factionStorageStation) {
        await discoverFactionStorage(botManager, cacheHelper, galaxy);
      }

      // Propagate discovered home to Commander's scoring brain
      const brain = commander.getBrain() as ScoringBrain;
      if (botManager.fleetConfig.homeBase && !brain.homeBase) {
        brain.homeBase = botManager.fleetConfig.homeBase;
      }
      if (botManager.fleetConfig.homeSystem && !brain.homeSystem) {
        brain.homeSystem = botManager.fleetConfig.homeSystem;
      }

      // Load ship catalog for upgrade evaluation
      try {
        const anyBot = botManager.getAllBots().find((b) => b.api && (b.status === "ready" || b.status === "running"));
        if (anyBot?.api) {
          const shipCatalog = await gameCache.getShipCatalog(anyBot.api);
          if (shipCatalog.length > 0) {
            commander.setShipCatalog(shipCatalog);
          }
        }
      } catch (err) {
        console.warn("[Fleet] Failed to load ship catalog:", err instanceof Error ? err.message : err);
      }
    }
    for (const fail of result.failed) {
      console.warn(`[Fleet] Login failed for ${fail.username}: ${fail.error}`);
    }
  }

  // 12. Log fleet home configuration for diagnostics
  {
    const fc = botManager.fleetConfig;
    if (fc.homeSystem || fc.homeBase || fc.factionStorageStation) {
      console.log(`[Fleet] Home: system=${fc.homeSystem || "(none)"}, base=${fc.homeBase || "(none)"}, factionStorage=${fc.factionStorageStation || "(none)"}`);
    } else {
      console.warn("[Fleet] WARNING: No home system configured! Bots won't return home when idle.");
      console.warn("[Fleet] Set home_system and home_base in config.toml, or ensure faction_info returns facilities.");
      // Help the user find IDs by listing known systems with stations
      if (galaxy.systemCount > 0) {
        const solSystem = galaxy.getSystem("sol");
        if (solSystem) {
          const stations = solSystem.pois.filter((p) => p.hasBase && p.baseId);
          if (stations.length > 0) {
            console.log(`[Fleet] Sol system stations: ${stations.map((s) => `${s.baseId} (${s.baseName ?? s.name})`).join(", ")}`);
            console.log(`[Fleet] Add to config.toml: home_system = "sol" and home_base = "${stations[0].baseId}"`);
          }
        }
      }
    }
  }

  // 13. Start periodic systems
  botManager.startSnapshots();
  commander.start();

  // Force an immediate evaluation so bots get assigned right away (don't wait 60s for the first interval tick)
  if (botManager.botCount > 0) {
    console.log("[Commander] Running initial evaluation...");
    commander.forceEvaluation().catch((err) => {
      console.error("[Commander] Initial evaluation failed:", err instanceof Error ? err.message : err);
    });
  }

  // Print startup summary
  const stats = trainingLogger.getStats();
  console.log(`[Training] ${stats.decisions} decisions, ${stats.episodes} episodes, ${stats.marketRecords} market records`);
  console.log(`[Training] DB size: ${(stats.dbSizeBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`\n✓ Commander v${VERSION} (build ${BUILD}) ready at http://${config.server.host}:${config.server.port}\n`);
}

// ── Client Message Handler ──

function handleClientMessage(
  ws: Parameters<NonNullable<Parameters<typeof createServer>[0]["onClientMessage"]>>[0],
  msg: ClientMessage,
  botManager: BotManager,
  commander: Commander,
  sessionStore: SessionStore,
  ensureGalaxyLoaded: () => Promise<void>,
  galaxy: Galaxy,
  gameCache: GameCache,
  db: Database,
): void {
  try {
    switch (msg.type) {
      case "set_goal":
        commander.addGoal(msg.goal);
        saveGoals(db, commander.getGoals());
        broadcast({ type: "goals_update", goals: commander.getGoals() });
        broadcast({ type: "notification", level: "info", title: "Goal Added", message: `New goal: ${msg.goal.type}` });
        break;

      case "update_goal":
        commander.updateGoal(msg.index, msg.goal);
        saveGoals(db, commander.getGoals());
        broadcast({ type: "goals_update", goals: commander.getGoals() });
        broadcast({ type: "notification", level: "info", title: "Goal Updated", message: `Updated goal: ${msg.goal.type}` });
        break;

      case "remove_goal":
        commander.removeGoal(msg.index);
        saveGoals(db, commander.getGoals());
        broadcast({ type: "goals_update", goals: commander.getGoals() });
        broadcast({ type: "notification", level: "info", title: "Goal Removed", message: "Goal removed from queue" });
        break;

      case "override_assignment":
        botManager.assignRoutine(msg.botId, msg.routine, msg.params ?? {}).catch((err) => {
          broadcast({ type: "notification", level: "warning", title: "Assignment Failed", message: err.message });
        });
        break;

      case "release_override":
        // Stop current routine so commander can reassign next cycle
        botManager.stopBot(msg.botId).catch(() => {});
        break;

      case "set_inventory_target":
        commander.getEconomy().addStockTarget(msg.target);
        break;

      case "remove_inventory_target":
        commander.getEconomy().removeStockTarget(msg.stationId, msg.itemId);
        break;

      case "start_bot": {
        const bot = botManager.getBot(msg.botId);
        if (!bot) {
          broadcast({ type: "notification", level: "warning", title: "Bot Not Found", message: msg.botId });
        } else if (bot.status === "running") {
          broadcast({ type: "notification", level: "info", title: "Bot Active", message: `${msg.botId} is already running` });
        } else if (bot.status === "logging_in") {
          broadcast({ type: "notification", level: "info", title: "Bot Active", message: `${msg.botId} is logging in...` });
        } else {
          // Handles: idle, error, ready, stopping (login() waits for stopping to finish)
          (async () => {
            if (bot.status !== "ready") {
              await botManager.loginBot(msg.botId);
            }
            await ensureGalaxyLoaded();
            broadcast({ type: "notification", level: "info", title: "Bot Started", message: `${msg.botId} ready` });
            const decision = await commander.forceEvaluation();
            broadcast({ type: "commander_decision", decision });
          })().catch((err) => {
            broadcast({ type: "notification", level: "warning", title: "Start Failed", message: `${msg.botId}: ${err instanceof Error ? err.message : String(err)}` });
          });
        }
        break;
      }

      case "stop_bot":
        botManager.stopBot(msg.botId).catch(() => {});
        break;

      case "add_bot": {
        try {
          // Store credentials first so the bot can log in later
          sessionStore.upsertBot({ username: msg.username, password: msg.password, empire: null, playerId: null });
          botManager.addBot(msg.username);
          broadcast({ type: "notification", level: "info", title: "Bot Added", message: `${msg.username} added to fleet` });
        } catch (err) {
          broadcast({ type: "notification", level: "warning", title: "Add Failed", message: err instanceof Error ? err.message : "Unknown error" });
        }
        break;
      }

      case "remove_bot":
        botManager.removeBot(msg.botId).then((removed) => {
          if (removed) {
            sessionStore.removeBot(msg.botId);
            broadcast({ type: "notification", level: "info", title: "Bot Removed", message: `${msg.botId} removed from fleet` });
          }
        });
        break;

      case "update_settings": {
        const s = msg.settings;
        // Apply fleet settings (live, no restart needed)
        if (s.factionTaxPercent !== undefined) {
          botManager.fleetConfig.factionTaxPercent = Math.max(0, Math.min(100, Number(s.factionTaxPercent)));
        }
        if (s.minBotCredits !== undefined) {
          botManager.fleetConfig.minBotCredits = Math.max(0, Number(s.minBotCredits));
        }
        // Persist to database
        saveFleetSettings(db, {
          factionTaxPercent: botManager.fleetConfig.factionTaxPercent,
          minBotCredits: botManager.fleetConfig.minBotCredits,
        });
        console.log("[Settings] Updated & persisted:", Object.keys(msg.settings).join(", "));
        // Broadcast current settings to all clients
        broadcast({ type: "fleet_settings_update", settings: { factionTaxPercent: botManager.fleetConfig.factionTaxPercent, minBotCredits: botManager.fleetConfig.minBotCredits } });
        broadcast({ type: "notification", level: "info", title: "Settings Saved", message: "Fleet settings updated" });
        break;
      }

      case "update_bot_settings": {
        const settingsBot = botManager.getBot(msg.botId);
        if (settingsBot) {
          const s = msg.settings;
          if (s.maxFuelThreshold !== undefined) settingsBot.settings.fuelEmergencyThreshold = Number(s.maxFuelThreshold);
          if (s.autoRepair !== undefined) settingsBot.settings.autoRepair = Boolean(s.autoRepair);
          if (s.maxCargo !== undefined) settingsBot.settings.maxCargoFillPct = Number(s.maxCargo);
          if (s.storageMode !== undefined) settingsBot.settings.storageMode = String(s.storageMode) as "sell" | "deposit" | "faction_deposit";
          if (s.factionStorage !== undefined) settingsBot.settings.factionStorage = Boolean(s.factionStorage);

          // Persist to database
          saveBotSettings(db, msg.botId, settingsBot.settings);

          console.log(`[Settings] Bot ${msg.botId} saved:`, Object.keys(msg.settings).join(", "));
          broadcast({ type: "notification", level: "info", title: "Settings Saved", message: `${msg.botId} settings updated` });
        } else {
          broadcast({ type: "notification", level: "warning", title: "Bot Not Found", message: msg.botId });
        }
        break;
      }

      case "cancel_order":
        console.log(`[Economy] Cancel order: ${msg.orderId}`);
        break;

      case "force_reassign":
        botManager.assignRoutine(msg.botId, msg.routine, {}).catch((err) => {
          broadcast({ type: "notification", level: "warning", title: "Reassign Failed", message: err.message });
        });
        break;

      case "force_evaluation":
        commander.forceEvaluation().then((decision) => {
          broadcast({ type: "commander_decision", decision });
          broadcast({ type: "notification", level: "info", title: "Evaluation Complete", message: decision.reasoning.slice(0, 100) });
        }).catch((err) => {
          broadcast({ type: "notification", level: "warning", title: "Evaluation Failed", message: err.message });
        });
        break;

      case "request_bot_storage":
        (async () => {
          try {
            const bot = botManager.getAllBots().find((b) => b.id === msg.botId);
            if (!bot?.api || (bot.status !== "ready" && bot.status !== "running")) {
              sendTo(ws, { type: "bot_storage", botId: msg.botId, storage: { stations: [], totalItems: 0, totalCredits: 0 } });
              return;
            }
            // view_storage works with station_id param even when undocked.
            // First try without station_id (works if docked), otherwise parse error hint for station IDs.
            let stationIds: string[] = [];
            let firstStation: { baseId: string; credits: number; hint: string; items: Array<{ itemId: string; itemName: string; quantity: number }> } | null = null;
            try {
              firstStation = await bot.api.viewStorageTyped();
              stationIds = bot.api.parseStorageHint(firstStation.hint);
            } catch (err) {
              // Bot not docked — parse station IDs from the error message hint
              const errMsg = err instanceof Error ? err.message : String(err);
              // Error format: "...\n\n200 credits and 13,122 items in storage at alpha_base, sol_base, ..."
              const match = errMsg.match(/in storage at ([a-z0-9_,\s]+)/i);
              if (match) {
                stationIds = match[1].split(",").map((s: string) => s.trim()).filter((s: string) => s.length > 0);
                console.log(`[Storage] Bot not docked, parsed ${stationIds.length} station IDs from error hint`);
              }
            }
            // Fetch all stations by ID (queries are free/instant, works when undocked)
            const stationResults: import("./types/protocol").BotStorageStation[] = [];
            // Add first station result if we got one
            if (firstStation && (firstStation.items.length > 0 || firstStation.credits > 0)) {
              stationResults.push({
                stationId: firstStation.baseId,
                stationName: resolveStationName(galaxy, firstStation.baseId),
                credits: firstStation.credits,
                items: firstStation.items,
              });
            }
            // Fetch remaining stations by ID
            for (const sid of stationIds) {
              if (firstStation && sid === firstStation.baseId) continue;
              try {
                const stData = await bot.api.viewStorageTyped(sid);
                if (stData.items.length > 0 || stData.credits > 0) {
                  stationResults.push({
                    stationId: sid,
                    stationName: resolveStationName(galaxy, sid),
                    credits: stData.credits,
                    items: stData.items,
                  });
                }
              } catch {
                // Skip stations we can't query
              }
            }
            const totalItems = stationResults.reduce((sum, s) => sum + s.items.reduce((iSum, i) => iSum + i.quantity, 0), 0);
            const totalCredits = stationResults.reduce((sum, s) => sum + s.credits, 0);
            sendTo(ws, { type: "bot_storage", botId: msg.botId, storage: { stations: stationResults, totalItems, totalCredits } });
          } catch (err) {
            console.warn("[Storage] Failed to fetch bot storage:", err instanceof Error ? err.message : err);
            sendTo(ws, { type: "bot_storage", botId: msg.botId, storage: { stations: [], totalItems: 0, totalCredits: 0 } });
          }
        })();
        break;

      case "refresh_cache":
        console.log(`[Cache] Refresh requested: ${msg.cacheKey ?? "all"}`);
        (async () => {
          try {
            if (!msg.cacheKey || msg.cacheKey === "galaxy" || msg.cacheKey === "all") {
              gameCache.clearGalaxyCache();
              // Reset galaxy and reload from API
              galaxy.load([]);
              const ok = await botManager.loadGalaxy();
              if (ok) {
                broadcast({ type: "galaxy_update", systems: galaxy.toSummaries() });
                broadcast({ type: "notification", level: "info", title: "Cache Refreshed", message: `Galaxy reloaded: ${galaxy.systemCount} systems` });
              }
            }
            if (!msg.cacheKey || msg.cacheKey === "market" || msg.cacheKey === "all") {
              gameCache.clearMarketCache();
              broadcast({ type: "notification", level: "info", title: "Cache Refreshed", message: "Market data cleared" });
            }
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Refresh Failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
    }
  } catch (err) {
    console.error("[WS Handler] Error:", err);
    broadcast({ type: "notification", level: "warning", title: "Error", message: err instanceof Error ? err.message : "Unknown error" });
  }
}

// ── Helpers ──

/** Parse trade events from routine state yields and log to DB */
function parseAndLogTrade(logger: TrainingLogger, botId: string, state: string): void {
  // Patterns from routines:
  //   "bought 10 ore_iron @ 55cr each (550cr)"
  //   "sold 10 ore_iron @ 10cr = 100cr"
  //   "sold 10 ore_iron @ 10cr (total: 100cr)"
  //   "sold cargo for 500 credits"
  //   "sold for 100cr" (crafter output)

  // Match "bought QTY ITEM @ PRICEcr" — item can be multi-word (e.g. "Refined Steel")
  const buyMatch = state.match(/bought (\d+)\s+(.+?)\s+@\s*(\d+)cr/i);
  if (buyMatch) {
    const qty = parseInt(buyMatch[1]);
    const itemId = buyMatch[2];
    const price = parseInt(buyMatch[3]);
    if (qty > 0 && price > 0) {
      logger.logTrade({ botId, action: "buy", itemId, quantity: qty, priceEach: price, total: qty * price });
    }
    return;
  }

  // Match "sold QTY ITEM @ PRICEcr" — item can be multi-word
  const sellMatch = state.match(/sold (\d+)\s+(.+?)\s+@\s*(\d+)cr/i);
  if (sellMatch) {
    const qty = parseInt(sellMatch[1]);
    const itemId = sellMatch[2];
    const price = parseInt(sellMatch[3]);
    if (qty > 0 && price > 0) {
      logger.logTrade({ botId, action: "sell", itemId, quantity: qty, priceEach: price, total: qty * price });
    }
    return;
  }

  // Match "sold cargo for TOTAL credits" (miner/general cargo dump)
  const cargoMatch = state.match(/sold cargo for (\d+) credits/i);
  if (cargoMatch) {
    const total = parseInt(cargoMatch[1]);
    if (total > 0) {
      logger.logTrade({ botId, action: "sell", itemId: "cargo_batch", quantity: 1, priceEach: total, total });
    }
    return;
  }

  // Match "sold for TOTALcr" (crafter output)
  const soldForMatch = state.match(/sold for (\d+)cr/i);
  if (soldForMatch) {
    const total = parseInt(soldForMatch[1]);
    if (total > 0) {
      logger.logTrade({ botId, action: "sell", itemId: "crafted_output", quantity: 1, priceEach: total, total });
    }
  }
}

function formatItemName(itemId: string): string {
  return itemId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function resolveStationName(galaxy: Galaxy, stationId: string): string {
  const systemId = galaxy.getSystemForBase(stationId);
  if (systemId) {
    const sys = galaxy.getSystem(systemId);
    if (sys) {
      const poi = sys.pois.find((p) => p.baseId === stationId);
      if (poi?.baseName) return poi.baseName;
      if (poi?.name) return poi.name;
    }
  }
  return formatItemName(stationId);
}

/** Build faction state for dashboard broadcast */
async function buildFactionState(
  botManager: BotManager,
  commander: Commander,
  fleetConfig: { defaultStorageMode: string },
): Promise<FactionState | null> {
  // Find a logged-in bot to query faction data — prefer a DOCKED bot
  // (view_faction_storage requires docking, faction_info does not)
  let api: ApiClient | null = null;
  let factionId: string | null = null;
  let dockedApi: ApiClient | null = null;
  for (const bot of botManager.getAllBots()) {
    if ((bot.status === "ready" || bot.status === "running") && bot.api && bot.player?.factionId) {
      if (!api) {
        api = bot.api;
        factionId = bot.player.factionId;
      }
      if (bot.player.dockedAtBase) {
        dockedApi = bot.api;
        factionId = bot.player.factionId;
      }
    }
  }
  // Use docked bot for storage calls if available
  const storageApi = dockedApi ?? api;

  if (!api || !factionId) {
    return {
      id: null,
      name: null,
      tag: null,
      credits: 0,
      memberCount: 0,
      members: [],
      storage: [],
      facilities: [],
      allies: [],
      enemies: [],
      commanderAware: fleetConfig.defaultStorageMode === "faction_deposit",
      storageMode: fleetConfig.defaultStorageMode,
    };
  }

  try {
    const [info, storageFull, rawFacilities] = await Promise.all([
      api.factionInfo().catch((err) => {
        console.warn("[Faction] factionInfo() failed:", err instanceof Error ? err.message : err);
        return {} as Record<string, unknown>;
      }),
      // view_faction_storage requires docking — use docked bot if available
      (storageApi ?? api).viewFactionStorageFull().catch((err) => {
        console.warn("[Faction] viewFactionStorageFull() failed (bot may not be docked):", err instanceof Error ? err.message : err);
        return { credits: 0, items: [], itemNames: new Map<string, string>() };
      }),
      // Faction facilities requires docking — use docked bot if available
      (storageApi ?? api).factionListFacilities().catch((err) => {
        console.warn("[Faction] factionListFacilities() failed:", err instanceof Error ? err.message : err);
        return [] as Array<Record<string, unknown>>;
      }),
    ]);

    console.log(`[Faction] factionInfo keys: ${Object.keys(info).join(", ")}, members: ${(info.members as unknown[])?.length ?? 0}`);
    console.log(`[Faction] storage: ${storageFull.items.length} items, ${storageFull.credits} credits`);
    console.log(`[Faction] facilities: ${rawFacilities.length} found`);
    if (rawFacilities.length > 0) {
      console.log(`[Faction] facility sample: ${JSON.stringify(rawFacilities[0])}`);
    }

    // Parse members from faction_info (real API: is_online, player_id, role)
    const members = ((info.members ?? []) as Array<Record<string, unknown>>).map((m) => ({
      playerId: String(m.player_id ?? ""),
      username: String(m.username ?? ""),
      role: String(m.role ?? "member"),
      online: Boolean(m.is_online ?? m.online),
      lastSeen: (m.last_seen ?? null) as string | null,
    }));

    // Storage items with real names from API
    const storage = storageFull.items
      .filter((i) => i.quantity > 0)
      .map((i) => ({
        itemId: i.itemId,
        itemName: storageFull.itemNames.get(i.itemId) || formatItemName(i.itemId),
        quantity: i.quantity,
      }));

    return {
      id: factionId,
      name: String(info.name ?? "Unknown"),
      tag: String(info.tag ?? ""),
      credits: storageFull.credits,
      memberCount: members.length || Number(info.member_count ?? 0),
      members,
      storage,
      facilities: rawFacilities.map((f) => ({
        id: String(f.id ?? f.facility_id ?? ""),
        name: String(f.name ?? f.facility_name ?? ""),
        type: String(f.type ?? f.facility_type ?? ""),
        systemId: String(f.system_id ?? f.systemId ?? ""),
        systemName: String(f.system_name ?? f.systemName ?? ""),
        status: String(f.status ?? f.active !== undefined ? (f.active ? "active" : "inactive") : "active"),
      })),
      allies: ((info.allies ?? []) as Array<Record<string, unknown>>).map((a) => ({
        factionId: String(a.faction_id ?? a.factionId ?? ""),
        name: String(a.name ?? ""),
      })),
      enemies: ((info.enemies ?? info.wars ?? []) as Array<Record<string, unknown>>).map((e) => ({
        factionId: String(e.faction_id ?? e.factionId ?? ""),
        name: String(e.name ?? ""),
      })),
      commanderAware: fleetConfig.defaultStorageMode === "faction_deposit",
      storageMode: fleetConfig.defaultStorageMode,
    };
  } catch (err) {
    console.warn("[Faction] Failed to build faction state:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Ensure all bots in the fleet are in the same faction and promoted to officer.
 * Flow:
 *   1. Find the "officer" bot — first bot that is already in a faction
 *   2. Officer invites all bots that are NOT in the faction
 *   3. Each invited bot checks for pending invites and accepts
 *   4. Officer promotes all non-officer bots to officer rank
 *
 * Note: faction commands may require being docked. After login, bots are
 * usually docked at their last position. If not, commands will fail gracefully.
 * Mutations are rate-limited (1 per 10s per bot), so we add delays.
 */
/** Tracks bots we've already attempted to promote (shared between startup + periodic) */
const _promotedBots = new Set<string>();

async function ensureFactionMembership(botManager: BotManager): Promise<void> {
  const allBots = botManager.getAllBots().filter(
    (b) => b.player && b.api && (b.status === "ready" || b.status === "running")
  );

  if (allBots.length < 2) return; // Need at least 2 bots

  // Find the officer: first bot already in a faction
  const officer = allBots.find((b) => b.player!.factionId);
  if (!officer) {
    console.log("[Faction] No bot is in a faction — cannot auto-invite. Join a faction manually with at least one bot.");
    return;
  }

  const factionId = officer.player!.factionId!;
  const officerRank = officer.player!.factionRank ?? "member";
  console.log(`[Faction] Officer: ${officer.username} (rank: ${officerRank}, faction: ${factionId})`);

  // Only target bots with NO faction — don't touch bots already in our or another faction
  const needInvite = allBots.filter((b) => !b.player!.factionId);

  // Bots in a different faction — warn but don't touch
  const wrongFaction = allBots.filter(
    (b) => b.player!.factionId && b.player!.factionId !== factionId
  );
  if (wrongFaction.length > 0) {
    console.warn(`[Faction] ${wrongFaction.length} bot(s) in a different faction: ${wrongFaction.map((b) => b.username).join(", ")} — leave their faction manually first`);
  }

  // Check which bots need promotion (already in OUR faction but not officer/leader)
  const needPromotion = allBots.filter(
    (b) => b.player!.factionId === factionId
      && b.player!.factionRank !== "officer"
      && b.player!.factionRank !== "leader"
      && b !== officer
  );

  if (needInvite.length === 0 && needPromotion.length === 0) {
    console.log("[Faction] All bots are in faction and have proper rank");
    return;
  }

  // Determine faction home station for docking
  const factionHome = botManager.fleetConfig.factionStorageStation
    || botManager.fleetConfig.homeBase
    || "";

  // Step 1: Navigate non-faction bots to faction home and dock
  if (needInvite.length > 0 && factionHome) {
    console.log(`[Faction] Navigating ${needInvite.length} bot(s) to faction home: ${factionHome}`);
    for (const bot of needInvite) {
      try {
        await navigateBotToBase(bot, factionHome);
      } catch (err) {
        console.warn(`[Faction] ${bot.username} failed to reach faction home: ${err instanceof Error ? err.message : err}`);
      }
    }
    // Also ensure officer is docked at faction home
    try {
      await navigateBotToBase(officer, factionHome);
    } catch (err) {
      console.warn(`[Faction] Officer ${officer.username} failed to reach faction home: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Step 2: Officer invites non-faction bots
  if (needInvite.length > 0) {
    console.log(`[Faction] Inviting ${needInvite.length} bot(s): ${needInvite.map((b) => b.username).join(", ")}`);

    for (const bot of needInvite) {
      try {
        await officer.api!.factionInvite(bot.username);
        console.log(`[Faction] Invited ${bot.username}`);
        await sleep(11_000); // Wait for next tick (rate limit)
      } catch (err) {
        console.warn(`[Faction] Failed to invite ${bot.username}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Step 3: Each invited bot checks invites and accepts
    for (const bot of needInvite) {
      try {
        const invites = await bot.api!.factionGetInvites();
        const match = invites.find((inv) => inv.factionId === factionId);
        if (match) {
          await bot.api!.joinFaction(factionId);
          console.log(`[Faction] ${bot.username} joined faction`);
          await sleep(11_000); // Rate limit
        } else {
          console.warn(`[Faction] ${bot.username} has no invite from faction ${factionId} (${invites.length} pending)`);
        }
      } catch (err) {
        console.warn(`[Faction] ${bot.username} failed to join: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Step 4: Promote all non-officer bots (only leader can promote)
  if (needPromotion.length > 0) {
    if (officerRank !== "leader") {
      console.log(`[Faction] Officer ${officer.username} is ${officerRank}, not leader — cannot promote bots. Promote them manually.`);
    } else {
      console.log(`[Faction] Promoting ${needPromotion.length} bot(s) to officer`);
      for (const bot of needPromotion) {
        try {
          await officer.api!.factionPromote(bot.username, "officer");
          _promotedBots.add(bot.id);
          console.log(`[Faction] Promoted ${bot.username} to officer`);
          await sleep(11_000); // Rate limit
        } catch (err) {
          _promotedBots.add(bot.id); // Don't retry on failure either
          console.warn(`[Faction] Failed to promote ${bot.username}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  console.log("[Faction] Membership check complete");
}

/**
 * Periodic check: if a leader bot is docked at the faction home station,
 * promote any faction members that aren't yet officers.
 * Tracks already-promoted bots to avoid re-attempting every cycle.
 */
async function promoteFactionMembers(botManager: BotManager): Promise<void> {
  const factionHome = botManager.fleetConfig.factionStorageStation || botManager.fleetConfig.homeBase;
  if (!factionHome) return;

  const allBots = botManager.getAllBots().filter(
    (b) => b.player && b.api && (b.status === "ready" || b.status === "running")
  );
  if (allBots.length < 2) return;

  // Find a leader bot docked at faction home
  const leader = allBots.find(
    (b) => b.player!.factionId
      && b.player!.factionRank === "leader"
      && b.player!.dockedAtBase === factionHome
  );
  if (!leader) return;

  const factionId = leader.player!.factionId!;

  // Find faction members that need promotion (skip already-promoted)
  const needPromotion = allBots.filter(
    (b) => b.player!.factionId === factionId
      && b.player!.factionRank !== "officer"
      && b.player!.factionRank !== "leader"
      && b !== leader
      && !_promotedBots.has(b.id)
  );
  if (needPromotion.length === 0) return;

  console.log(`[Faction] Promoting ${needPromotion.length} member(s) to officer (leader docked at home)`);
  for (const bot of needPromotion) {
    try {
      await leader.api!.factionPromote(bot.username, "officer");
      _promotedBots.add(bot.id);
      console.log(`[Faction] Promoted ${bot.username} to officer`);
      await sleep(11_000);
    } catch (err) {
      // Mark as promoted anyway to avoid spamming failed attempts
      _promotedBots.add(bot.id);
      console.warn(`[Faction] Failed to promote ${bot.username}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** Navigate a bot to a target base — undock if needed, travel, dock. Used for faction enrollment. */
async function navigateBotToBase(bot: import("./bot/bot").Bot, baseId: string): Promise<void> {
  const api = bot.api!;
  const player = bot.player!;

  // Already docked at the target
  if (player.dockedAtBase === baseId) return;

  // Undock if docked elsewhere
  if (player.dockedAtBase) {
    await api.undock();
    await sleep(11_000);
  }

  // Try to travel to the base POI (base ID often matches or is derived from POI)
  // Use find_route to get there if in a different system
  try {
    await api.travel(baseId);
    await sleep(11_000);
  } catch {
    // travel() might fail if baseId is not a POI — try dock directly
  }

  // Dock
  try {
    await api.dock();
    await sleep(11_000);
    console.log(`[Faction] ${bot.username} docked at ${baseId}`);
  } catch (err) {
    console.warn(`[Faction] ${bot.username} dock failed: ${err instanceof Error ? err.message : err}`);
  }
}

// v2: invalidates old cached values from broken discovery that tagged the wrong station
const FACTION_STORAGE_KEY = "faction_storage_station_v2";
const HOME_SYSTEM_KEY = "home_system_v2";
const HOME_BASE_KEY = "home_base_v2";

/**
 * Auto-discover faction storage station at startup.
 * 1. Check persistent cache (previously discovered)
 * 2. Parse faction_info facilities to find lockbox/storage facility and its system
 * 3. Resolve the station in that system via galaxy data
 * 4. Fall back to homeBase config
 *
 * Also sets homeSystem and homeBase if not already configured.
 * Persists everything to SQLite so it survives restarts.
 */
async function discoverFactionStorage(
  botManager: BotManager,
  cache: CacheHelper,
  galaxy: Galaxy,
): Promise<void> {
  console.log("[Faction] Auto-discovering faction storage station...");

  // 1. Check persistent cache from previous run
  const cachedStation = cache.getStatic(FACTION_STORAGE_KEY);
  const cachedSystem = cache.getStatic(HOME_SYSTEM_KEY);
  if (cachedStation) {
    console.log(`[Faction] Using persisted station: ${cachedStation} (system: ${cachedSystem ?? "unknown"})`);
    propagateFleetHome(botManager, cachedStation, cachedSystem ?? "");
    return;
  }

  // 2. Parse faction_info to find lockbox facility and its system
  let api: ApiClient | null = null;
  for (const bot of botManager.getAllBots()) {
    if (bot.api && bot.player?.factionId && (bot.status === "ready" || bot.status === "running")) {
      api = bot.api;
      break;
    }
  }

  if (api) {
    try {
      const info = await api.factionInfo();
      console.log(`[Faction] faction_info keys: ${Object.keys(info).join(", ")}`);

      // Parse owned_bases (the real API field, not "facilities")
      // owned_bases can be a number (count) or an array — must check
      const rawBases = info.owned_bases ?? info.facilities;
      const ownedBases = Array.isArray(rawBases) ? rawBases as Array<Record<string, unknown>> : [];
      console.log(`[Faction] owned_bases: ${Array.isArray(rawBases) ? ownedBases.length : `(number: ${rawBases})`}`);
      for (const base of ownedBases) {
        console.log(`[Faction]   base: ${JSON.stringify(base)}`);
      }

      // Look for a lockbox base in owned_bases
      if (ownedBases.length > 0) {
        // Find a base that looks like a lockbox/storage
        const lockboxBase = ownedBases.find((b) => {
          const type = String(b.type ?? b.facility_type ?? "").toLowerCase();
          const name = String(b.name ?? "").toLowerCase();
          return type.includes("lockbox") || type.includes("storage")
            || name.includes("lockbox") || name.includes("storage");
        });
        // If no lockbox found specifically, use the first owned base as likely faction HQ
        const targetBase = lockboxBase ?? ownedBases[0];
        if (targetBase) {
          const baseId = String(targetBase.base_id ?? targetBase.id ?? "");
          const systemId = String(targetBase.system_id ?? targetBase.systemId ?? "");
          const systemName = String(targetBase.system_name ?? targetBase.systemName ?? "");
          const baseName = String(targetBase.name ?? targetBase.base_name ?? "");
          console.log(`[Faction] Owned base: ${baseName} (${baseId}) in ${systemName} (${systemId})`);

          if (baseId) {
            propagateFleetHome(botManager, baseId, systemId);
            cache.setStatic(FACTION_STORAGE_KEY, baseId, "fleet");
            if (systemId) cache.setStatic(HOME_SYSTEM_KEY, systemId, "fleet");
            cache.setStatic(HOME_BASE_KEY, baseId, "fleet");
            return;
          }
        }
      }
    } catch (err) {
      console.warn(`[Faction] faction_info failed: ${err instanceof Error ? err.message : err}`);
    }

    // 2b. Query faction facilities API (requires docking — find a docked bot)
    const dockedBot = botManager.getAllBots().find(
      (b) => b.api && b.player?.dockedAtBase && b.player?.factionId && (b.status === "ready" || b.status === "running")
    );
    const facilitiesApi = dockedBot?.api ?? api;
    try {
      const facilities = await facilitiesApi.factionListFacilities();
      console.log(`[Faction] factionListFacilities: ${facilities.length} facilities`);
      for (const f of facilities.slice(0, 5)) {
        console.log(`[Faction]   facility: ${JSON.stringify(f)}`);
      }

      // Find a lockbox/storage facility
      const lockbox = facilities.find((f) => {
        const type = String(f.type ?? f.facility_type ?? "").toLowerCase();
        const name = String(f.name ?? "").toLowerCase();
        return type.includes("lockbox") || type.includes("storage")
          || name.includes("lockbox") || name.includes("storage");
      });

      if (lockbox) {
        const baseId = String(lockbox.base_id ?? lockbox.baseId ?? lockbox.station_id ?? "");
        const systemId = String(lockbox.system_id ?? lockbox.systemId ?? "");
        const facilityName = String(lockbox.name ?? lockbox.facility_name ?? "");
        console.log(`[Faction] Lockbox facility found: ${facilityName} at base ${baseId} (system: ${systemId})`);

        if (baseId) {
          propagateFleetHome(botManager, baseId, systemId);
          cache.setStatic(FACTION_STORAGE_KEY, baseId, "fleet");
          if (systemId) cache.setStatic(HOME_SYSTEM_KEY, systemId, "fleet");
          cache.setStatic(HOME_BASE_KEY, baseId, "fleet");
          return;
        }
      }
    } catch (err) {
      console.warn(`[Faction] factionListFacilities failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 3. Check persisted system details (cached when bots visited Sol previously)
  const cachedSol = galaxy.getSystem("sol") ?? galaxy.getSystemByName("Sol");
  if (cachedSol && cachedSol.pois.length > 0) {
    const solStation = cachedSol.pois.find((p) => p.hasBase && p.baseId);
    if (solStation?.baseId) {
      console.log(`[Faction] Sol station from cached system data: ${solStation.baseId} (${solStation.baseName ?? solStation.name})`);
      propagateFleetHome(botManager, solStation.baseId, cachedSol.id);
      cache.setStatic(FACTION_STORAGE_KEY, solStation.baseId, "fleet");
      cache.setStatic(HOME_SYSTEM_KEY, cachedSol.id, "fleet");
      cache.setStatic(HOME_BASE_KEY, solStation.baseId, "fleet");
      return;
    }
  }

  // 4. Search for Sol via API (bots may not have visited it, so galaxy data is incomplete)
  if (api) {
    console.log("[Faction] Searching for Sol system via API...");
    try {
      const searchResults = await api.searchSystems("sol");
      console.log(`[Faction] searchSystems("sol"): ${searchResults.length} results`);

      // Find Sol in results
      const solResult = searchResults.find((s) => {
        const name = String(s.name ?? "").toLowerCase();
        return name === "sol";
      });

      if (solResult) {
        const solId = String(solResult.id ?? solResult.system_id ?? "");
        console.log(`[Faction] Found Sol system ID: ${solId}`);

        // Look for a station/base in Sol's POIs (search may not include these)
        const pois = (solResult.pois ?? solResult.points_of_interest ?? []) as Array<Record<string, unknown>>;
        const stationPoi = pois.find((p) => Boolean(p.has_base ?? p.hasBase));

        if (stationPoi) {
          const baseId = String(stationPoi.base_id ?? stationPoi.baseId ?? "");
          if (baseId) {
            const baseName = String(stationPoi.base_name ?? stationPoi.baseName ?? stationPoi.name ?? "");
            console.log(`[Faction] Sol station found: ${baseId} (${baseName})`);
            propagateFleetHome(botManager, baseId, solId);
            cache.setStatic(FACTION_STORAGE_KEY, baseId, "fleet");
            cache.setStatic(HOME_SYSTEM_KEY, solId, "fleet");
            cache.setStatic(HOME_BASE_KEY, baseId, "fleet");
            return;
          }
        }

        // Set Sol as home system — station data will be discovered by scout routine
        if (solId) {
          console.log(`[Faction] Sol found but no station data — scout routine will discover it`);
          botManager.fleetConfig.homeSystem = solId;
          for (const b of botManager.getAllBots()) {
            b.fleetConfig.homeSystem = solId;
          }
          cache.setStatic(HOME_SYSTEM_KEY, solId, "fleet");
        }
      }
    } catch (err) {
      console.warn(`[Faction] searchSystems failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 5. Fallback: use homeBase from config
  if (botManager.fleetConfig.homeBase) {
    console.log(`[Faction] No confirmed lockbox — using homeBase ${botManager.fleetConfig.homeBase} as fallback`);
    propagateFleetHome(botManager, botManager.fleetConfig.homeBase, botManager.fleetConfig.homeSystem);
    cache.setStatic(FACTION_STORAGE_KEY, botManager.fleetConfig.homeBase, "fleet");
    return;
  }

  // 6. Last resort: dump known systems so user can configure manually
  if (galaxy.systemCount > 0) {
    const systems = galaxy.getAllSystems().filter((s) => s.pois.some((p) => p.hasBase));
    console.warn(`[Faction] Could not auto-discover. Known systems with stations:`);
    for (const sys of systems.slice(0, 10)) {
      const stations = sys.pois.filter((p) => p.hasBase && p.baseId);
      console.warn(`  ${sys.id} (${sys.name}): ${stations.map((s) => s.baseId).join(", ")}`);
    }
    console.warn(`[Faction] Set home_system and home_base in config.toml with one of the above`);
  } else {
    console.warn("[Faction] Could not discover faction storage — galaxy not loaded. Set faction_storage_station in config.toml");
  }
}

/** Propagate factionStorageStation + homeBase + homeSystem to all bots */
function propagateFleetHome(botManager: BotManager, stationId: string, systemId: string): void {
  botManager.fleetConfig.factionStorageStation = stationId;
  if (!botManager.fleetConfig.homeBase) botManager.fleetConfig.homeBase = stationId;
  if (systemId && !botManager.fleetConfig.homeSystem) botManager.fleetConfig.homeSystem = systemId;
  for (const b of botManager.getAllBots()) {
    b.fleetConfig.factionStorageStation = stationId;
    if (!b.fleetConfig.homeBase) b.fleetConfig.homeBase = stationId;
    if (systemId && !b.fleetConfig.homeSystem) b.fleetConfig.homeSystem = systemId;
  }
  console.log(`[Faction] Fleet home: system=${botManager.fleetConfig.homeSystem}, base=${botManager.fleetConfig.homeBase}, factionStorage=${stationId}`);
}

/** Build market station data from cache for dashboard broadcast */
function buildMarketData(gameCache: GameCache, galaxy: Galaxy): MarketStationData[] {
  const cached = gameCache.getAllCachedMarketPrices();
  return cached.map((entry) => {
    // Try to resolve station name from galaxy
    const system = galaxy.getSystemForBase(entry.stationId);
    const poi = system ? galaxy.getSystem(system)?.pois.find(p => p.baseId === entry.stationId) : null;
    const stationName = poi?.baseName ?? poi?.name ?? entry.stationId;

    return {
      stationId: entry.stationId,
      stationName,
      prices: entry.prices.map(p => ({
        itemId: p.itemId,
        itemName: formatItemName(p.itemId),
        buyPrice: p.buyPrice ?? 0,
        sellPrice: p.sellPrice ?? 0,
        buyVolume: p.buyVolume ?? 0,
        sellVolume: p.sellVolume ?? 0,
      })),
      fetchedAt: entry.fetchedAt,
    };
  });
}

// ── Broadcast Loop ──

function startBroadcastLoop(
  botManager: BotManager,
  commander: Commander,
  galaxy: Galaxy,
  db: import("bun:sqlite").Database,
  gameCache: GameCache,
  trainingLogger: TrainingLogger,
  defaultStorageMode = "sell",
): void {
  let tick = 0;
  const creditInsert = db.prepare(
    "INSERT INTO credit_history (timestamp, total_credits, active_bots) VALUES (?, ?, ?)"
  );

  // Track per-bot credits to detect revenue/cost changes
  const lastCredits = new Map<string, number>();

  // Track per-bot credit snapshots for creditsPerHour (cumulative last hour)
  // Snapshot approach: sum actual net credit change over the last 60 minutes
  // No extrapolation — shows real earned credits, not projected rates
  const botCreditSnapshots = new Map<string, Array<{ timestamp: number; credits: number }>>();
  const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour — cumulative, not extrapolated
  const SNAPSHOT_INTERVAL_MS = 30_000; // Record snapshot every 30s
  let lastSnapshotTime = 0;

  setInterval(() => {
    try {
      tick++;
      const fleet = botManager.getFleetStatus();

      // Track credit changes per bot → feed to economy engine + persist
      const now = Date.now();
      const economy = commander.getEconomy();
      for (const bot of fleet.bots) {
        if (bot.status !== "running") continue;
        const prev = lastCredits.get(bot.botId);
        if (prev !== undefined) {
          let delta = bot.credits - prev;
          // Subtract faction treasury withdrawals — those aren't real revenue
          const botObj = botManager.getBot(bot.botId);
          const factionWithdrawal = botObj?.drainFactionWithdrawals() ?? 0;
          if (factionWithdrawal > 0 && delta > 0) {
            delta = Math.max(0, delta - factionWithdrawal);
          }
          if (delta > 0) {
            economy.recordRevenue(delta);
            trainingLogger.logFinancialEvent("revenue", delta, bot.botId);
          } else if (delta < 0) {
            economy.recordCost(-delta);
            trainingLogger.logFinancialEvent("cost", -delta, bot.botId);
          }
        }
        lastCredits.set(bot.botId, bot.credits);
      }

      // Record credit snapshots every 30s for rate calculation
      if (now - lastSnapshotTime >= SNAPSHOT_INTERVAL_MS) {
        lastSnapshotTime = now;
        const cutoff = now - RATE_WINDOW_MS;
        for (const bot of fleet.bots) {
          if (bot.status !== "running") continue;
          const snaps = botCreditSnapshots.get(bot.botId) ?? [];
          snaps.push({ timestamp: now, credits: bot.credits });
          // Prune old snapshots outside window
          const pruned = snaps.filter((s) => s.timestamp >= cutoff);
          botCreditSnapshots.set(bot.botId, pruned);
        }
      }

      // Record credit history every 30s (tick 10, 20, 30...) regardless of clients
      if (tick % 10 === 0 && fleet.activeBots > 0) {
        creditInsert.run(Date.now(), fleet.totalCredits, fleet.activeBots);
      }

      // Skip dashboard broadcasts if no clients connected
      if (getClientCount() === 0) return;

      // Fleet update every 3s - inject per-bot creditsPerHour from snapshots
      // Cumulative: actual net credit change over the last hour (no extrapolation)
      const MIN_SNAPSHOTS = 4; // Need at least ~2 min of data
      const summaries = botManager.getSummaries().map((s) => {
        const snaps = botCreditSnapshots.get(s.id);
        if (snaps && snaps.length >= MIN_SNAPSHOTS) {
          const oldest = snaps[0];
          const netChange = s.credits - oldest.credits;
          s.creditsPerHour = Math.round(netChange);
        }
        return s;
      });
      broadcast({ type: "fleet_update", bots: summaries });

      // Fleet stats every 6s (tick 2, 4, 6...)
      if (tick % 2 === 0) {
        // Aggregate fleet-wide credits per hour from snapshot windows
        // Cumulative: actual net change over last hour, no extrapolation
        let fleetCph = 0;
        for (const [botId, snaps] of botCreditSnapshots) {
          if (snaps.length >= MIN_SNAPSHOTS) {
            const oldest = snaps[0];
            const currentCredits = lastCredits.get(botId) ?? snaps[snaps.length - 1].credits;
            const netChange = currentCredits - oldest.credits;
            fleetCph += Math.round(netChange);
          }
        }

        const fleetStats: FleetStats = {
          totalCredits: fleet.totalCredits,
          creditsPerHour: fleetCph,
          activeBots: fleet.activeBots,
          totalBots: fleet.bots.length,
          uptime: 0,
          apiCallsToday: { mutations: 0, queries: 0 },
        };
        broadcast({ type: "stats_update", stats: fleetStats });
      }

      // Commander decision + economy broadcast every 15s (tick 5, 10, 15...)
      if (tick % 5 === 0) {
        const lastDecision = commander.getLastDecision();
        if (lastDecision) {
          broadcast({ type: "commander_decision", decision: lastDecision });
        }

        if (galaxy.systemCount > 0) {
          // Safety net: if all systems still at (0,0), regenerate layout now
          if (galaxy.allCoordsZero) {
            console.warn("[Broadcast] Galaxy coords still (0,0) — regenerating layout");
            galaxy.generateLayout();
            // Persist the generated layout so it survives restarts
            gameCache.setMapCache(galaxy.getAllSystems());
          }
          broadcast({ type: "galaxy_update", systems: galaxy.toSummaries() });
        }

        // Economy state
        const ecoSnap = commander.getEconomy().analyze(fleet);
        const economyState: EconomyState = {
          deficits: ecoSnap.deficits.map(d => ({
            itemId: d.itemId,
            itemName: formatItemName(d.itemId),
            demandPerHour: d.demandPerHour,
            supplyPerHour: d.supplyPerHour,
            shortfall: d.shortfall,
            priority: d.priority,
          })),
          surpluses: ecoSnap.surpluses.map(s => ({
            itemId: s.itemId,
            itemName: formatItemName(s.itemId),
            excessPerHour: s.excessPerHour,
            stationId: s.stationId,
            stationName: s.stationId || "Fleet",
            currentStock: s.currentStock,
          })),
          openOrders: [],
          totalRevenue24h: ecoSnap.totalRevenue,
          totalCosts24h: ecoSnap.totalCosts,
          netProfit24h: ecoSnap.netProfit,
        };
        broadcast({ type: "economy_update", economy: economyState });

        // Market data broadcast
        const marketData = buildMarketData(gameCache, galaxy);
        if (marketData.length > 0) {
          broadcast({ type: "market_update", stations: marketData });
        }

        // Faction data broadcast (every 30s = tick 10, 20, 30...)
        if (tick % 10 === 0) {
          buildFactionState(botManager, commander, { defaultStorageMode }).then((faction) => {
            if (faction) broadcast({ type: "faction_update", faction });
          }).catch(() => {});
        }

        // Faction promotion check (every 60s = tick 20)
        // If an officer/leader is docked at faction home, promote non-officer members
        if (tick % 20 === 0) {
          promoteFactionMembers(botManager).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[Broadcast] Error:", err);
    }
  }, 3000);
}

// ── Graceful shutdown logging ──
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n════ SHUTDOWN (${signal}) v${VERSION} build ${BUILD} at ${new Date().toISOString()} ════\n`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  console.log(`\n════ CRASH v${VERSION} build ${BUILD} at ${new Date().toISOString()} ════\n`);
  process.exit(1);
});
