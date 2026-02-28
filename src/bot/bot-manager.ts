/**
 * BotManager - manages a fleet of Bot instances.
 * Handles login staggering, lifecycle management, snapshots, and fleet status.
 */

import { Bot, type BotDeps } from "./bot";
import type { RoutineRegistry, FleetStatus, FleetBotInfo } from "./types";
import type { ApiClient, ApiClientOptions } from "../core/api-client";
import type { Galaxy } from "../core/galaxy";
import type { Navigation } from "../core/navigation";
import type { Market } from "../core/market";
import type { Cargo } from "../core/cargo";
import type { Fuel } from "../core/fuel";
import type { Combat } from "../core/combat";
import type { Crafting } from "../core/crafting";
import type { Station } from "../core/station";
import type { GameCache } from "../data/game-cache";
import type { SessionStore } from "../data/session-store";
import type { TrainingLogger } from "../data/training-logger";
import type { BotSummary, RoutineName } from "../types/protocol";
import type { FleetConfig } from "./types";

export interface SharedServices {
  galaxy: Galaxy;
  nav: Navigation;
  market: Market;
  cargo: Cargo;
  fuel: Fuel;
  combat: Combat;
  crafting: Crafting;
  station: Station;
  cache: GameCache;
  logger: TrainingLogger;
  sessionStore: SessionStore;
}

export interface BotManagerConfig {
  maxBots: number;
  loginStaggerMs: number;
  snapshotIntervalSec: number;
}

export type ApiClientFactory = (username: string) => ApiClient;

export class BotManager {
  private bots = new Map<string, Bot>();
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private routines: RoutineRegistry = {};

  /** Fleet-wide config applied to all bots */
  fleetConfig: FleetConfig = { homeSystem: "", homeBase: "", defaultStorageMode: "sell", factionStorageStation: "", factionTaxPercent: 0, minBotCredits: 0 };

  /** Optional callback for broadcasting bot state changes to the dashboard */
  onBotStateChange: ((botId: string, routine: string, state: string) => void) | null = null;

  constructor(
    private config: BotManagerConfig,
    private services: SharedServices,
    private apiFactory: ApiClientFactory
  ) {}

  /** Register available routines */
  registerRoutines(routines: RoutineRegistry): void {
    this.routines = { ...this.routines, ...routines };
  }

  /** Get all bots */
  getAllBots(): Bot[] {
    return Array.from(this.bots.values());
  }

  /** Get a specific bot */
  getBot(botId: string): Bot | null {
    return this.bots.get(botId) ?? null;
  }

  /** Get bot count */
  get botCount(): number {
    return this.bots.size;
  }

  /** Get fleet status (for BotContext.getFleetStatus) */
  getFleetStatus(): FleetStatus {
    const bots: FleetBotInfo[] = [];
    let totalCredits = 0;
    let activeBots = 0;

    for (const bot of this.bots.values()) {
      const player = bot.player;
      const ship = bot.ship;

      bots.push({
        botId: bot.id,
        username: bot.username,
        status: bot.status,
        routine: bot.routine,
        routineState: bot.routineState,
        systemId: player?.currentSystem ?? null,
        poiId: player?.currentPoi ?? null,
        docked: player?.dockedAtBase !== null && player?.dockedAtBase !== undefined,
        credits: player?.credits ?? 0,
        fuelPct: ship ? (ship.maxFuel > 0 ? (ship.fuel / ship.maxFuel) * 100 : 0) : 0,
        cargoPct: ship ? (ship.cargoCapacity > 0 ? (ship.cargoUsed / ship.cargoCapacity) * 100 : 0) : 0,
        hullPct: ship ? (ship.maxHull > 0 ? (ship.hull / ship.maxHull) * 100 : 0) : 0,
        moduleIds: ship?.modules.map((m) => m.moduleId) ?? [],
        shipClass: ship?.classId ?? null,
        ownedShips: bot.ownedShips,
        skills: bot.skillLevels,
        rapidRoutines: bot.rapidRoutines,
      });

      totalCredits += player?.credits ?? 0;
      if (bot.status === "running") activeBots++;
    }

    return { bots, totalCredits, activeBots };
  }

  /** Get all bot summaries for dashboard */
  getSummaries(): BotSummary[] {
    return Array.from(this.bots.values()).map((b) => b.toSummary());
  }

  // ── Bot Lifecycle ──

  /**
   * Add a bot to the fleet. Does not login automatically.
   */
  addBot(username: string): Bot {
    if (this.bots.size >= this.config.maxBots) {
      throw new Error(`Fleet at max capacity (${this.config.maxBots})`);
    }

    const botId = username; // Use username as ID for simplicity
    if (this.bots.has(botId)) {
      throw new Error(`Bot already exists: ${username}`);
    }

    const bot = new Bot(botId, username);
    const api = this.apiFactory(username);

    const deps: BotDeps = {
      api,
      nav: this.services.nav,
      market: this.services.market,
      cargo: this.services.cargo,
      fuel: this.services.fuel,
      combat: this.services.combat,
      crafting: this.services.crafting,
      station: this.services.station,
      galaxy: this.services.galaxy,
      cache: this.services.cache,
      logger: this.services.logger,
      getFleetStatus: () => this.getFleetStatus(),
    };

    bot.setDeps(deps);
    bot.fleetConfig = this.fleetConfig;
    // Sync per-bot settings from fleet config defaults
    // (individual bot settings from DB will overwrite these later if they exist)
    if (this.fleetConfig.defaultStorageMode !== "sell") {
      bot.settings.storageMode = this.fleetConfig.defaultStorageMode;
      bot.settings.factionStorage = this.fleetConfig.defaultStorageMode === "faction_deposit";
    }
    bot.onStateChange = this.onBotStateChange;
    this.bots.set(botId, bot);
    console.log(`[Fleet] Added bot: ${username} (${this.bots.size}/${this.config.maxBots})`);
    return bot;
  }

  /** Remove a bot from the fleet (shuts down first) */
  async removeBot(botId: string): Promise<boolean> {
    const bot = this.bots.get(botId);
    if (!bot) return false;

    await bot.shutdown();
    this.bots.delete(botId);
    console.log(`[Fleet] Removed bot: ${bot.username} (${this.bots.size}/${this.config.maxBots})`);
    return true;
  }

  /**
   * Login all idle bots with staggered timing.
   * Returns array of bots that failed to login.
   */
  async loginAll(): Promise<{ success: string[]; failed: Array<{ username: string; error: string }> }> {
    const idleBots = Array.from(this.bots.values()).filter(
      (b) => b.status === "idle" || b.status === "error"
    );

    const success: string[] = [];
    const failed: Array<{ username: string; error: string }> = [];

    for (let i = 0; i < idleBots.length; i++) {
      const bot = idleBots[i];

      // Stagger logins
      if (i > 0) {
        await sleep(this.config.loginStaggerMs);
      }

      try {
        await bot.login();
        success.push(bot.username);
      } catch (err) {
        failed.push({
          username: bot.username,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { success, failed };
  }

  /** Login a single bot */
  async loginBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    await bot.login();
  }

  /** Assign a routine to a bot */
  async assignRoutine(botId: string, routineName: RoutineName, params: Record<string, unknown> = {}): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);

    const routineFn = this.routines[routineName];
    if (!routineFn) throw new Error(`Unknown routine: ${routineName}`);

    await bot.assignRoutine(routineName, routineFn, params);
    console.log(`[Fleet] Assigned ${routineName} to ${bot.username}`);
  }

  /** Stop a bot's current routine */
  async stopBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    await bot.stopRoutine();
  }

  /** Shutdown a bot completely */
  async shutdownBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`Bot not found: ${botId}`);
    await bot.shutdown();
  }

  /** Shutdown all bots */
  async shutdownAll(): Promise<void> {
    this.stopSnapshots();
    const promises = Array.from(this.bots.values()).map((bot) => bot.shutdown());
    await Promise.allSettled(promises);
    console.log("[Fleet] All bots shut down");
  }

  // ── Galaxy Loading ──

  /** Load galaxy data using logged-in bots' API clients. Must call after at least one bot is logged in. */
  async loadGalaxy(): Promise<boolean> {
    let loaded = false;

    for (const bot of this.bots.values()) {
      if ((bot.status === "ready" || bot.status === "running") && bot.api) {
        try {
          // 1. Initialize cache (fetches game version for version-gated caching)
          if (this.services.cache.version === "unknown") {
            await this.services.cache.initialize(bot.api);
          }

          // 2. Load basic system list via cache (version-gated, stored in SQLite)
          // Note: systemCount may be > 0 from bot logins adding their current systems (e.g., 2-4).
          // We still need to load the full 500+ system map, so check for < 50 not === 0.
          if (this.services.galaxy.systemCount < 50) {
            const systems = await this.services.cache.getMap(bot.api);
            const valid = systems.filter((s) => s.id && s.id !== "undefined" && s.id !== "null");
            if (valid.length < systems.length) {
              console.warn(`[Galaxy] Warning: ${systems.length - valid.length}/${systems.length} systems have empty/invalid IDs`);
            }

            this.services.galaxy.load(valid);
            console.log(`[Galaxy] Map loaded: ${this.services.galaxy.systemCount} systems`);

            // If API doesn't provide coordinates, generate a force-directed layout
            if (this.services.galaxy.allCoordsZero) {
              console.warn(`[Galaxy] All systems at (0,0) — generating force-directed layout`);
              this.services.galaxy.generateLayout();
              // Save layout-generated coords to cache so they persist across restarts
              const layoutSystems = this.services.galaxy.getAllSystems();
              this.services.cache.setMapCache(layoutSystems);
              console.log(`[Galaxy] Layout coordinates cached for ${layoutSystems.length} systems`);
            }
          }

          // 3. Load catalog data (recipes + items) - version-gated, only fetches once
          if (this.services.crafting.recipeCount === 0) {
            try {
              const [recipes, items] = await Promise.all([
                this.services.cache.getRecipes(bot.api),
                this.services.cache.getItemCatalog(bot.api),
              ]);
              this.services.crafting.load(recipes);
              this.services.crafting.loadItems(items);
              console.log(`[Catalog] ${recipes.length} recipes, ${items.length} items`);
            } catch (err) {
              console.warn("[Catalog] Failed to load:", err instanceof Error ? err.message : err);
            }
          }

          // 4. Get current system with full detail for EVERY logged-in bot
          //    This ensures all systems bots are in (Sol, Alpha Centauri, etc.) get full POI data
          const currentSystem = await bot.api.getSystem();
          if (currentSystem?.id) {
            this.services.galaxy.updateSystem(currentSystem);
            this.services.cache.setSystemDetail(currentSystem.id, currentSystem);
            console.log(`[Galaxy] Updated ${currentSystem.name}: ${currentSystem.pois.length} POIs, ${currentSystem.connections.length} connections`);
          }

          loaded = true;
        } catch (err) {
          console.warn(`[Galaxy] Failed to load via ${bot.username}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    if (!loaded) {
      console.warn("[Galaxy] No bot available to load galaxy data");
    }
    return loaded;
  }

  // ── Snapshots ──

  /** Start periodic state snapshots for training data */
  startSnapshots(): void {
    if (this.snapshotTimer) return;

    this.snapshotTimer = setInterval(() => {
      this.takeSnapshots();
    }, this.config.snapshotIntervalSec * 1000);

    console.log(`[Fleet] Snapshots every ${this.config.snapshotIntervalSec}s`);
  }

  /** Stop periodic snapshots */
  stopSnapshots(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /** Take a snapshot of all running bots */
  private takeSnapshots(): void {
    const tick = Math.floor(Date.now() / 1000);

    for (const bot of this.bots.values()) {
      if (bot.status !== "running" || !bot.player || !bot.ship) continue;

      this.services.logger.logSnapshot({
        tick,
        botId: bot.id,
        playerState: bot.player as unknown as Record<string, unknown>,
        shipState: bot.ship as unknown as Record<string, unknown>,
        location: {
          system: bot.player.currentSystem,
          poi: bot.player.currentPoi,
          docked: bot.player.dockedAtBase,
        },
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
