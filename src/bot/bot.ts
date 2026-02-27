/**
 * Bot class - manages a single bot's lifecycle and routine execution.
 *
 * State machine: IDLE → LOGGING_IN → READY → RUNNING → STOPPING → IDLE/READY
 *                                      ↑                    │
 *                                      └────────────────────┘ (reassignment)
 */

import type { ApiClient } from "../core/api-client";
import type { Galaxy } from "../core/galaxy";
import type { Navigation } from "../core/navigation";
import type { Market } from "../core/market";
import type { Cargo } from "../core/cargo";
import type { Fuel } from "../core/fuel";
import type { Combat } from "../core/combat";
import type { Crafting } from "../core/crafting";
import type { Station } from "../core/station";
import type { GameCache } from "../data/game-cache";
import type { TrainingLogger } from "../data/training-logger";
import type { PlayerState, ShipState, SessionInfo } from "../types/game";
import type { BotStatus, RoutineName, BotSummary } from "../types/protocol";
import type { BotContext, Routine, RoutineParams, FleetStatus, BotSettings, FleetConfig } from "./types";

export interface BotDeps {
  api: ApiClient;
  nav: Navigation;
  market: Market;
  cargo: Cargo;
  fuel: Fuel;
  combat: Combat;
  crafting: Crafting;
  station: Station;
  galaxy: Galaxy;
  cache: GameCache;
  logger: TrainingLogger;
  getFleetStatus: () => FleetStatus;
}

export class Bot {
  readonly id: string;
  readonly username: string;

  private _status: BotStatus = "idle";
  private _routine: RoutineName | null = null;
  private _routineState = "";
  private _params: RoutineParams = {};
  private _error: string | null = null;
  private _shouldStop = false;
  private _loginTime: number | null = null;
  private _generator: AsyncGenerator<string, void, void> | null = null;

  private _player: PlayerState | null = null;
  private _ship: ShipState | null = null;
  private _session: SessionInfo | null = null;
  private _routineStartedAt: number = 0;
  private _rapidRoutines: Map<RoutineName, number> = new Map();

  /** Credits withdrawn from faction treasury (not real revenue). Drained by broadcast loop. */
  private _factionWithdrawals = 0;

  /** Full skill data (fetched via getSkills after login) */
  private _skills: Record<string, { level: number; xp: number; xpNext: number }> = {};

  private deps: BotDeps | null = null;

  /** Configurable bot settings (updated via dashboard) */
  settings: BotSettings = {
    fuelEmergencyThreshold: 20,
    autoRepair: true,
    maxCargoFillPct: 90,
    storageMode: "sell",
    factionStorage: false,
  };

  /** Fleet-wide config (set by BotManager from app config) */
  fleetConfig: FleetConfig = {
    homeSystem: "",
    homeBase: "",
    defaultStorageMode: "sell",
    factionStorageStation: "",
    factionTaxPercent: 0,
    minBotCredits: 0,
  };

  /** Optional callback invoked on each routine state yield (for broadcasting to dashboard) */
  onStateChange: ((botId: string, routine: string, state: string) => void) | null = null;

  constructor(id: string, username: string) {
    this.id = id;
    this.username = username;
  }

  // ── Getters ──

  /** Expose the bot's authenticated API client (for galaxy loading, etc.) */
  get api(): ApiClient | null {
    return this.deps?.api ?? null;
  }

  get status(): BotStatus {
    return this._status;
  }
  get routine(): RoutineName | null {
    return this._routine;
  }
  get routineState(): string {
    return this._routineState;
  }
  get error(): string | null {
    return this._error;
  }
  get player(): PlayerState | null {
    return this._player;
  }
  get ship(): ShipState | null {
    return this._ship;
  }
  get uptime(): number {
    return this._loginTime ? Date.now() - this._loginTime : 0;
  }
  get rapidRoutines(): Map<RoutineName, number> {
    return this._rapidRoutines;
  }
  /** Record a faction treasury withdrawal (not real revenue) */
  recordFactionWithdrawal(amount: number): void {
    this._factionWithdrawals += amount;
  }
  /** Drain accumulated faction withdrawals (returns and resets to 0) */
  drainFactionWithdrawals(): number {
    const amount = this._factionWithdrawals;
    this._factionWithdrawals = 0;
    return amount;
  }
  /** Skill levels as flat record (e.g. { mining: 3, trading: 1 }) */
  get skillLevels(): Record<string, number> {
    const levels: Record<string, number> = {};
    for (const [id, data] of Object.entries(this._skills)) {
      levels[id] = data.level;
    }
    // Fallback to PlayerState skills
    if (Object.keys(levels).length === 0 && this._player?.skills) {
      return { ...this._player.skills };
    }
    return levels;
  }

  /** Build a BotSummary for the dashboard */
  toSummary(): BotSummary {
    const systemId = this._player?.currentSystem ?? null;
    const poiId = this._player?.currentPoi ?? null;

    // Resolve names via Galaxy if deps are available
    let systemName = systemId;
    let poiName: string | null = null;
    if (this.deps?.galaxy && systemId) {
      const sys = this.deps.galaxy.getSystem(systemId);
      if (sys) {
        systemName = sys.name;
        if (poiId) {
          const poi = sys.pois.find((p) => p.id === poiId);
          if (poi) poiName = poi.name;
        }
      }
    }

    return {
      id: this.id,
      username: this.username,
      empire: this._player?.empire ?? "",
      status: this._status,
      routine: this._routine,
      routineState: this._routineState,
      systemId,
      systemName,
      poiId,
      poiName,
      credits: this._player?.credits ?? 0,
      creditsPerHour: 0,
      fuelPct: this._ship ? (this._ship.maxFuel > 0 ? (this._ship.fuel / this._ship.maxFuel) * 100 : 0) : 0,
      cargoPct: this._ship ? (this._ship.cargoCapacity > 0 ? (this._ship.cargoUsed / this._ship.cargoCapacity) * 100 : 0) : 0,
      hullPct: this._ship ? (this._ship.maxHull > 0 ? (this._ship.hull / this._ship.maxHull) * 100 : 0) : 0,
      shieldPct: this._ship ? (this._ship.maxShield > 0 ? (this._ship.shield / this._ship.maxShield) * 100 : 0) : 0,
      shipClass: this._ship?.classId ?? null,
      shipName: this._ship?.name ?? null,
      docked: this._player?.dockedAtBase !== null && this._player?.dockedAtBase !== undefined,
      error: this._error,
      uptime: this.uptime,
      cargo: this._ship?.cargo.map((c) => ({ itemId: c.itemId, quantity: c.quantity })) ?? [],
      modules: this._ship?.modules.map((m) => ({ id: m.id, moduleId: m.moduleId, name: m.name })) ?? [],
      skills: this.buildSkillsSummary(),
      settings: {
        fuelEmergencyThreshold: this.settings.fuelEmergencyThreshold,
        autoRepair: this.settings.autoRepair,
        maxCargoFillPct: this.settings.maxCargoFillPct,
        storageMode: this.settings.storageMode,
        factionStorage: this.settings.factionStorage,
      },
    };
  }

  /** Build skills summary from stored data */
  private buildSkillsSummary(): Record<string, { level: number; xp: number; xpNext: number }> {
    // Prefer full skill data if available
    if (Object.keys(this._skills).length > 0) return this._skills;
    // Fallback: build from PlayerState flat data
    if (!this._player?.skills) return {};
    const result: Record<string, { level: number; xp: number; xpNext: number }> = {};
    for (const [skillId, level] of Object.entries(this._player.skills)) {
      result[skillId] = { level, xp: this._player.skillXp?.[skillId] ?? 0, xpNext: 0 };
    }
    return result;
  }

  // ── Lifecycle ──

  /** Inject dependencies. Call before login. */
  setDeps(deps: BotDeps): void {
    this.deps = deps;
  }

  /** Login to the game. Transitions: IDLE → LOGGING_IN → READY */
  async login(password?: string): Promise<void> {
    if (!this.deps) throw new Error("Bot deps not set - call setDeps() first");

    // If stopping, wait for it to finish first
    if (this._status === "stopping") {
      await this.stopRoutine();
    }

    if (this._status !== "idle" && this._status !== "error" && this._status !== "ready") {
      throw new Error(`Cannot login from state: ${this._status}`);
    }

    // Already logged in
    if (this._status === "ready") return;

    this._status = "logging_in";
    this._error = null;

    try {
      const result = await this.deps.api.login(password);
      this._session = { id: result.sessionId, playerId: result.player.id, createdAt: new Date().toISOString(), expiresAt: "" };
      this._player = result.player;
      this._ship = result.ship;
      this._loginTime = Date.now();
      this._status = "ready";

      // Update galaxy with login system data (helps fill in missing systems like Sol)
      // Only update if the login data has POIs (don't overwrite detailed data with empty data)
      if (result.system?.id && result.system.pois.length > 0) {
        const existing = this.deps.galaxy.getSystem(result.system.id);
        if (!existing || result.system.pois.length >= existing.pois.length) {
          this.deps.galaxy.updateSystem(result.system);
          this.deps.cache.setSystemDetail(result.system.id, result.system);
        }
      }

      // Fetch full skill data (non-blocking, best-effort)
      try {
        this._skills = await this.deps.api.getSkills();
      } catch {
        // Skills from login PlayerState will be used as fallback
      }

      console.log(`[Bot:${this.username}] Logged in at ${result.player.currentSystem}`);
    } catch (err) {
      this._status = "error";
      this._error = err instanceof Error ? err.message : String(err);
      console.error(`[Bot:${this.username}] Login failed: ${this._error}`);
      throw err;
    }
  }

  /**
   * Assign and start a routine. Transitions: READY → RUNNING
   * If already running, stops current routine first (RUNNING → STOPPING → RUNNING).
   */
  async assignRoutine(
    routineName: RoutineName,
    routineFn: Routine,
    params: RoutineParams = {}
  ): Promise<void> {
    if (!this.deps) throw new Error("Bot deps not set");

    // If already running, stop first
    if (this._status === "running") {
      await this.stopRoutine();
    }

    if (this._status !== "ready") {
      throw new Error(`Cannot assign routine from state: ${this._status}`);
    }

    this._routine = routineName;
    this._params = params;
    this._routineState = "starting";
    this._shouldStop = false;
    this._status = "running";
    this._routineStartedAt = Date.now();

    // Build context
    const ctx = this.buildContext();

    // Dispose leftover cargo before starting new routine (sell → faction deposit → skip)
    // Prevents miners leaving ore in cargo when switching to trader, etc.
    await this.disposeLeftoverCargo(ctx);

    // Start the async generator
    this._generator = routineFn(ctx);

    // Run the routine loop (non-blocking)
    this.runRoutineLoop();
  }

  /** Request graceful stop. The routine will finish at next yield. */
  requestStop(): void {
    if (this._status !== "running") return;
    this._shouldStop = true;
    this._status = "stopping";
  }

  /** Stop routine and wait for it to finish */
  async stopRoutine(): Promise<void> {
    if (this._status !== "running" && this._status !== "stopping") return;

    this._shouldStop = true;
    this._status = "stopping";

    // Give the generator a chance to finish
    if (this._generator) {
      try {
        await this._generator.return(undefined);
      } catch {
        // Ignore errors during cleanup
      }
      this._generator = null;
    }

    this._routine = null;
    this._routineState = "";
    this._params = {};
    this._status = "ready";
  }

  /** Full shutdown - stop routine and logout */
  async shutdown(): Promise<void> {
    await this.stopRoutine();

    if (this.deps && (this._status === "ready" || this._status === "logging_in")) {
      try {
        await this.deps.api.logout();
      } catch {
        // Ignore logout errors
      }
    }

    this._status = "idle";
    this._session = null;
    this._player = null;
    this._ship = null;
    this._loginTime = null;
    this._error = null;
  }

  // ── Internal ──

  private buildContext(): BotContext {
    const deps = this.deps!;
    const bot = this;

    return {
      botId: this.id,
      username: this.username,
      session: this._session!,
      api: deps.api,
      nav: deps.nav,
      market: deps.market,
      cargo: deps.cargo,
      fuel: deps.fuel,
      combat: deps.combat,
      crafting: deps.crafting,
      station: deps.station,
      galaxy: deps.galaxy,
      cache: deps.cache,
      logger: deps.logger,
      getFleetStatus: deps.getFleetStatus,
      params: this._params,
      settings: this.settings,
      fleetConfig: this.fleetConfig,
      get player() {
        return bot._player!;
      },
      get ship() {
        return bot._ship!;
      },
      get shouldStop() {
        return bot._shouldStop;
      },
      refreshState: async () => {
        const status = await deps.api.getStatus();
        bot._player = status.player;
        bot._ship = status.ship;
      },
      recordFactionWithdrawal: (amount: number) => {
        bot.recordFactionWithdrawal(amount);
      },
    };
  }

  /**
   * Dispose leftover cargo before starting a new routine.
   * Sells non-protected items first (earns credits), then tries faction deposit
   * for anything that couldn't be sold. Only runs if bot is docked and has cargo.
   */
  private async disposeLeftoverCargo(ctx: BotContext): Promise<void> {
    if (!ctx.ship || !ctx.player) return;

    // Only dispose if docked (can't sell/deposit in space)
    if (!ctx.player.dockedAtBase) return;

    // Filter to disposable items (not fuel cells)
    const disposable = ctx.ship.cargo.filter((c) => c.itemId !== "fuel_cell");
    if (disposable.length === 0) return;

    console.log(`[${this.id}] disposing ${disposable.length} leftover cargo item(s) before new routine`);
    this.onStateChange?.(this.id, this._routine ?? "bot", "disposing leftover cargo");

    const useFactionDeposit = this.fleetConfig.defaultStorageMode === "faction_deposit"
      || this.settings.storageMode === "faction_deposit";

    for (const item of disposable) {
      // Try sell first (earns credits)
      try {
        const result = await ctx.api.sell(item.itemId, item.quantity);
        if (result.total > 0) {
          console.log(`[${this.id}] sold ${result.quantity} ${item.itemId} @ ${result.priceEach}cr`);
          await ctx.refreshState();
          continue;
        }
      } catch { /* sell failed, try deposit */ }

      // Sell didn't work (no demand) — try faction deposit if configured
      if (useFactionDeposit) {
        try {
          await ctx.api.factionDepositItems(item.itemId, item.quantity);
          console.log(`[${this.id}] deposited ${item.quantity} ${item.itemId} to faction storage`);
          await ctx.refreshState();
          continue;
        } catch { /* faction deposit failed too */ }
      }

      // Last resort: deposit to station storage (never jettison)
      try {
        await ctx.api.depositItems(item.itemId, item.quantity);
        console.log(`[${this.id}] stashed ${item.quantity} ${item.itemId} in station storage`);
        await ctx.refreshState();
      } catch {
        // Item stays in cargo — nothing we can do without leaving station
      }
    }
  }

  private async runRoutineLoop(): Promise<void> {
    if (!this._generator) return;

    // Capture identity of THIS loop invocation — if stopRoutine() resets
    // and a new assignRoutine() fires, the old loop must not clobber new state
    const myStartedAt = this._routineStartedAt;
    const myRoutine = this._routine;

    try {
      while (!this._shouldStop && this._generator) {
        const result = await this._generator.next();

        if (result.done) {
          // Routine completed naturally
          this._routineState = "completed";
          break;
        }

        // Update state label from yielded string
        this._routineState = result.value;
        console.log(`[Bot:${this.username}] ${myRoutine}: ${result.value}`);
        this.onStateChange?.(this.id, myRoutine ?? "", result.value);
      }
    } catch (err) {
      // Only set error state if we're still the active routine (not superseded)
      if (this._routineStartedAt === myStartedAt) {
        this._error = err instanceof Error ? err.message : String(err);
        this._status = "error";
        console.error(`[Bot:${this.username}] Routine error: ${this._error}`);
      }
      return;
    }

    // Only run cleanup if we're still the active routine (not superseded by a new assignment)
    if (this._routineStartedAt !== myStartedAt) return;

    // Clean exit - track rapid completions (< 60s = routine couldn't find work)
    const routineDuration = Date.now() - myStartedAt;
    if (routineDuration < 60_000 && myRoutine && !this._shouldStop) {
      this._rapidRoutines.set(myRoutine, Date.now());
      console.log(`[Bot:${this.username}] ${myRoutine} completed rapidly (${(routineDuration / 1000).toFixed(0)}s) - will avoid re-assignment (${this._rapidRoutines.size} blocked)`);
    }

    this._generator = null;
    if (this._status === "running" || this._status === "stopping") {
      this._routine = null;
      this._routineState = "";
      this._status = "ready";
    }
  }
}
