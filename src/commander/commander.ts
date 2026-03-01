/**
 * Commander - the fleet brain orchestrator.
 * Periodically evaluates the fleet and issues assignments via BotManager.
 * Bridges the CommanderBrain, EconomyEngine, and BotManager.
 */

import type { Goal, StockTarget } from "../types/config";
import type { CommanderDecision, FleetAssignment } from "../types/protocol";
import type { TrainingLogger } from "../data/training-logger";
import type { Galaxy } from "../core/galaxy";
import type { Market } from "../core/market";
import type { Crafting } from "../core/crafting";
import type { ApiClient } from "../core/api-client";
import type { GameCache } from "../data/game-cache";
import type { FleetStatus } from "../bot/types";
import type { ShipClass } from "../types/game";
import type { CommanderBrain, EvaluationOutput, Assignment, WorldContext, PendingUpgrade } from "./types";
import { EconomyEngine } from "./economy-engine";
import { ScoringBrain, type ScoringConfig } from "./scoring-brain";
import { findBestUpgrade, calculateROI, scoreShipForRole, LEGACY_SHIPS } from "../core/ship-fitness";

export interface CommanderConfig {
  /** Evaluation interval in seconds */
  evaluationIntervalSec: number;
  /** Whether urgency overrides can bypass cooldowns */
  urgencyOverride: boolean;
}

export interface CommanderDeps {
  /** Function to get current fleet status */
  getFleetStatus: () => FleetStatus;
  /** Function to assign a routine to a bot */
  assignRoutine: (botId: string, routine: string, params: Record<string, unknown>) => Promise<void>;
  /** Training logger for recording decisions */
  logger: TrainingLogger;
  /** World data services for informed decision-making */
  galaxy: Galaxy;
  market: Market;
  cache: GameCache;
  crafting: Crafting;
  /** Function to get an authenticated API client (for faction storage polling) */
  getApi?: () => ApiClient | null;
  /** Fleet home base ID */
  homeBase?: string;
  /** Fleet home system ID */
  homeSystem?: string;
  /** Default storage mode */
  defaultStorageMode?: "sell" | "deposit" | "faction_deposit";
  /** Minimum credits per bot — bots below this should return home to withdraw */
  minBotCredits?: number;
}

export class Commander {
  private brain: CommanderBrain;
  private economy: EconomyEngine;
  private goals: Goal[] = [];
  private evaluationTimer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private decisionHistory: CommanderDecision[] = [];
  private maxHistorySize = 100;
  private lastShipCheck = 0;
  private lastFactionPoll = 0;
  private cachedTradeRoutes: { routes: import("../core/market").TradeRoute[]; at: number } | null = null;
  /** Ship classes that failed to be found at any shipyard — blacklisted with cooldown */
  private shipBlacklist = new Map<string, number>(); // classId → blacklisted until timestamp
  /** Bots that recently failed a ship upgrade — cooldown before re-queueing any upgrade */
  private botUpgradeCooldown = new Map<string, number>(); // botId → cooldown until timestamp

  constructor(
    private config: CommanderConfig,
    private deps: CommanderDeps,
    brain?: CommanderBrain,
    scoringConfig?: Partial<ScoringConfig>
  ) {
    const scoringBrain = new ScoringBrain(scoringConfig);
    scoringBrain.homeBase = deps.homeBase ?? "";
    scoringBrain.homeSystem = deps.homeSystem ?? "";
    scoringBrain.defaultStorageMode = deps.defaultStorageMode ?? "sell";
    scoringBrain.crafting = deps.crafting;
    scoringBrain.galaxy = deps.galaxy;
    scoringBrain.market = deps.market;
    scoringBrain.minBotCredits = deps.minBotCredits ?? 0;
    this.brain = brain ?? scoringBrain;
    this.economy = new EconomyEngine();
  }

  // ── Goal Management ──

  /** Set active goals (replaces all) */
  setGoals(goals: Goal[]): void {
    this.goals = [...goals].sort((a, b) => b.priority - a.priority);
  }

  /** Add a single goal */
  addGoal(goal: Goal): void {
    this.goals.push(goal);
    this.goals.sort((a, b) => b.priority - a.priority);
  }

  /** Update goal at index */
  updateGoal(index: number, goal: Goal): void {
    if (index >= 0 && index < this.goals.length) {
      this.goals[index] = goal;
      this.goals.sort((a, b) => b.priority - a.priority);
    }
  }

  /** Seed faction inventory into economy engine (for startup) */
  seedFactionInventory(items: Map<string, number>): void {
    this.economy.updateFactionInventory(items);
  }

  /** Remove goal by index */
  removeGoal(index: number): void {
    this.goals.splice(index, 1);
  }

  /** Get current goals */
  getGoals(): Goal[] {
    return [...this.goals];
  }

  // ── Inventory Targets ──

  /** Set stock targets for economy engine */
  setStockTargets(targets: StockTarget[]): void {
    this.economy.setStockTargets(targets);
  }

  // ── Economy ──

  /** Get the economy engine for direct manipulation */
  getEconomy(): EconomyEngine {
    return this.economy;
  }

  // ── Evaluation Loop ──

  /** Start periodic evaluation */
  start(): void {
    if (this.evaluationTimer) return;

    this.evaluationTimer = setInterval(() => {
      this.evaluateAndAssign().catch((err) => {
        console.error("[Commander] Evaluation error:", err);
      });
    }, this.config.evaluationIntervalSec * 1000);

    console.log(`[Commander] Started (eval every ${this.config.evaluationIntervalSec}s)`);
  }

  /** Stop periodic evaluation */
  stop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    console.log("[Commander] Stopped");
  }

  /** Force a single evaluation (can be triggered from dashboard) */
  async forceEvaluation(): Promise<CommanderDecision> {
    return this.evaluateAndAssign();
  }

  /** Get the brain for direct config updates */
  getBrain(): CommanderBrain {
    return this.brain;
  }

  /** Replace the brain (e.g., switching from scoring to LLM) */
  setBrain(brain: CommanderBrain): void {
    this.brain = brain;
  }

  /** Set ship catalog for upgrade evaluation (call after loading from cache/API) */
  setShipCatalog(catalog: ShipClass[]): void {
    const brain = this.brain as ScoringBrain;
    if (brain.shipCatalog !== undefined) {
      brain.shipCatalog = catalog;
      console.log(`[Commander] Ship catalog loaded: ${catalog.length} ship classes`);
    }
  }

  /** Get recent decision history */
  getDecisionHistory(): CommanderDecision[] {
    return [...this.decisionHistory];
  }

  /** Get the latest decision */
  getLastDecision(): CommanderDecision | null {
    return this.decisionHistory.length > 0
      ? this.decisionHistory[this.decisionHistory.length - 1]
      : null;
  }

  // ── Core Evaluation ──

  private async evaluateAndAssign(): Promise<CommanderDecision> {
    this.tick = Math.floor(Date.now() / 1000);

    // Step 1: Get fleet state
    const fleet = this.deps.getFleetStatus();

    // Step 1.5: Poll faction storage (non-blocking, best-effort)
    await this.pollFactionStorage();

    // Step 1.6: Check for ship upgrades (every 5 minutes)
    await this.checkShipUpgrades(fleet);

    // Step 2: Analyze economy
    const economySnapshot = this.economy.analyze(fleet);

    // Step 3: Build world context from real data
    const world = this.buildWorldContext(fleet);

    // Step 3.5: Pre-evaluation emergency overrides — clear cooldowns BEFORE brain runs
    this.applyEmergencyOverrides(fleet);

    // Step 4: Run brain evaluation
    const output = this.brain.evaluate({
      fleet,
      goals: this.goals,
      economy: economySnapshot,
      world,
      tick: this.tick,
    });

    // Step 5: Build conversational thoughts
    const thoughts = this.buildThoughts(fleet, world, output);

    // Step 5: Execute assignments — skip bots already running the same routine
    const executedAssignments: FleetAssignment[] = [];
    const botStatusMap = new Map(fleet.bots.map((b) => [b.botId, b]));

    for (const assignment of output.assignments) {
      // Skip re-assigning a bot that's already running this exact routine
      const botInfo = botStatusMap.get(assignment.botId);
      if (botInfo && botInfo.routine === assignment.routine && botInfo.status === "running") {
        continue; // Already doing this — don't interrupt
      }

      try {
        await this.deps.assignRoutine(
          assignment.botId,
          assignment.routine,
          assignment.params
        );

        executedAssignments.push({
          botId: assignment.botId,
          routine: assignment.routine,
          params: assignment.params,
          reasoning: assignment.reasoning,
          score: assignment.score,
          previousRoutine: assignment.previousRoutine,
        });
      } catch (err) {
        console.warn(
          `[Commander] Failed to assign ${assignment.routine} to ${assignment.botId}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Step 6: Build decision record
    const decision: CommanderDecision = {
      tick: this.tick,
      goal: this.goals.length > 0 ? this.goals[0].type : "none",
      assignments: executedAssignments,
      reasoning: output.reasoning,
      thoughts,
      timestamp: new Date().toISOString(),
    };

    // Step 7: Log and record
    this.recordDecision(decision, fleet, economySnapshot);

    return decision;
  }

  /** Poll faction storage inventory (best-effort, non-blocking, max every 3 minutes) */
  private async pollFactionStorage(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFactionPoll < 180_000) return; // Only poll every 3 minutes

    const api = this.deps.getApi?.();
    if (!api) return;

    // Only poll if using faction storage
    const mode = this.deps.defaultStorageMode;
    if (mode !== "faction_deposit") return;

    this.lastFactionPoll = now;
    try {
      const items = await api.viewFactionStorage();
      const inventory = new Map<string, number>();
      for (const item of items) {
        if (item.quantity > 0) {
          inventory.set(item.itemId, (inventory.get(item.itemId) ?? 0) + item.quantity);
        }
      }
      this.economy.updateFactionInventory(inventory);
      const oreCount = [...inventory.entries()].filter(([id]) => id.includes("ore")).reduce((s, [, q]) => s + q, 0);
      console.log(`[Commander] Faction storage polled: ${inventory.size} item types, ${oreCount} ore units`);
    } catch (err) {
      console.log(`[Commander] Faction storage poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Periodically evaluate fleet for ship upgrades (every 5 minutes) */
  private async checkShipUpgrades(fleet: FleetStatus): Promise<void> {
    const now = Date.now();
    if (now - this.lastShipCheck < 300_000) return; // Only check every 5 minutes
    this.lastShipCheck = now;

    // Only works with ScoringBrain (has pendingUpgrades + shipCatalog)
    const brain = this.brain as ScoringBrain;
    if (!brain.shipCatalog || brain.shipCatalog.length === 0) return;

    const catalog = brain.shipCatalog;
    const minReserve = Math.max(5000, this.deps.minBotCredits ?? 0);

    // Expire old blacklist entries (30 minute cooldown)
    for (const [classId, until] of this.shipBlacklist) {
      if (now > until) this.shipBlacklist.delete(classId);
    }
    // Expire old per-bot upgrade cooldowns
    for (const [botId, until] of this.botUpgradeCooldown) {
      if (now > until) this.botUpgradeCooldown.delete(botId);
    }

    // Clear stale pending upgrades for bots that already completed or failed upgrading
    for (const [botId, pending] of brain.pendingUpgrades) {
      const bot = fleet.bots.find((b) => b.botId === botId);
      if (!bot) {
        brain.pendingUpgrades.delete(botId);
        continue;
      }
      // If bot already has the target ship, remove the pending upgrade
      if (bot.shipClass === pending.targetShipClass) {
        brain.pendingUpgrades.delete(botId);
        continue;
      }
      // If bot rapid-completed ship_upgrade, the target wasn't available — blacklist it + cooldown the bot
      if (bot.routine !== "ship_upgrade" && bot.rapidRoutines.has("ship_upgrade") && !pending.alreadyOwned) {
        const rapidTime = bot.rapidRoutines.get("ship_upgrade")!;
        if (now - rapidTime < 300_000) { // Rapid failure within 5 minutes
          if (!this.shipBlacklist.has(pending.targetShipClass)) {
            this.shipBlacklist.set(pending.targetShipClass, now + 1_800_000); // Blacklist ship for 30 min
            console.log(`[Commander] Blacklisted ${pending.targetShipClass} — not available at any visited shipyard (30min cooldown)`);
          }
          // Per-bot cooldown: don't try ANY upgrade for this bot for 30 min
          this.botUpgradeCooldown.set(botId, now + 1_800_000);
          brain.pendingUpgrades.delete(botId);
        }
      }
    }

    for (const bot of fleet.bots) {
      if (bot.status !== "ready" && bot.status !== "running") continue;
      if (bot.routine === "ship_upgrade") continue; // Already upgrading
      if (brain.pendingUpgrades.has(bot.botId)) continue; // Already queued
      if (this.botUpgradeCooldown.has(bot.botId)) continue; // Recently failed — on cooldown

      const role = bot.routine ?? "default";
      const currentClass = catalog.find((s) => s.id === bot.shipClass)
        ?? LEGACY_SHIPS.find((s) => s.id === bot.shipClass);
      if (!currentClass) continue;

      // Priority 1: Check if bot already owns a better ship (free switch, no purchase)
      if (bot.ownedShips.length > 1) {
        let bestOwnedScore = scoreShipForRole(currentClass, role);
        let bestOwned: { id: string; classId: string } | null = null;
        let bestOwnedClass: typeof currentClass | null = null;

        for (const owned of bot.ownedShips) {
          if (owned.classId === bot.shipClass) continue; // Skip current ship
          const ownedShipClass = catalog.find((s) => s.id === owned.classId)
            ?? LEGACY_SHIPS.find((s) => s.id === owned.classId);
          if (!ownedShipClass) continue;
          const score = scoreShipForRole(ownedShipClass, role);
          if (score > bestOwnedScore + 3) { // Must be noticeably better
            bestOwnedScore = score;
            bestOwned = owned;
            bestOwnedClass = ownedShipClass;
          }
        }

        if (bestOwned && bestOwnedClass) {
          const roi = calculateROI(currentClass, bestOwnedClass, role);
          brain.pendingUpgrades.set(bot.botId, {
            targetShipClass: bestOwned.classId,
            targetPrice: 0,
            role,
            roi: roi + 100, // High priority — it's free
            alreadyOwned: true,
            ownedShipId: bestOwned.id,
          });
          console.log(`[Commander] Ship switch queued (already owned): ${bot.botId} ${bot.shipClass} → ${bestOwned.classId} (role=${role}, FREE)`);
          continue;
        }
      }

      // Priority 2: Find an upgrade to buy from shipyard (skip blacklisted classes)
      const budget = bot.credits - minReserve;
      if (budget <= 0) continue;

      const availableCatalog = catalog.filter((s) => !this.shipBlacklist.has(s.id));
      const upgrade = findBestUpgrade(currentClass.id, role, availableCatalog, budget);
      if (!upgrade) continue;

      const roi = calculateROI(currentClass, upgrade, role);
      brain.pendingUpgrades.set(bot.botId, {
        targetShipClass: upgrade.id,
        targetPrice: upgrade.basePrice,
        role,
        roi,
      });

      console.log(`[Commander] Ship upgrade queued: ${bot.botId} ${currentClass.id} → ${upgrade.id} (role=${role}, price=${upgrade.basePrice}cr, ROI=${roi.toFixed(2)})`);
    }
  }

  /** Clear cooldowns for bots in emergency states (low fuel, low hull) so brain can reassign them */
  private applyEmergencyOverrides(fleet: FleetStatus): void {
    const lowFuel = fleet.bots.filter((b) => b.fuelPct < 25 && (b.status === "running" || b.status === "ready"));
    for (const b of lowFuel) {
      this.brain.clearCooldown(b.botId);
    }
    const lowHull = fleet.bots.filter((b) => b.hullPct < 30 && (b.status === "running" || b.status === "ready"));
    for (const b of lowHull) {
      this.brain.clearCooldown(b.botId);
    }
  }

  /** Build world context from galaxy/cache/market for brain evaluation */
  private buildWorldContext(fleet: FleetStatus): WorldContext {
    const { galaxy, cache, market } = this.deps;

    // Per-system POI data for each bot's location
    const systemPois = new Map<string, WorldContext["systemPois"] extends Map<string, infer V> ? V : never>();
    const seenSystems = new Set<string>();

    for (const bot of fleet.bots) {
      if (!bot.systemId || seenSystems.has(bot.systemId)) continue;
      seenSystems.add(bot.systemId);

      const system = galaxy.getSystem(bot.systemId);
      if (!system) continue;

      // Check for resource POIs with remaining resources
      // A POI with no resources array means we haven't scanned it yet (optimistic: assume available)
      // A POI with resources all at remaining=0 means it's depleted
      const hasResourcesLeft = (p: { resources: Array<{ remaining: number }> }) =>
        p.resources.length === 0 || p.resources.some((r) => r.remaining > 0);

      const hasBelts = system.pois.some((p) =>
        (p.type === "asteroid_belt" || p.type === "asteroid") && hasResourcesLeft(p)
      );
      const hasIceFields = system.pois.some((p) =>
        p.type === "ice_field" && hasResourcesLeft(p)
      );
      const hasGasClouds = system.pois.some((p) =>
        (p.type === "gas_cloud" || p.type === "nebula") && hasResourcesLeft(p)
      );
      const stations = system.pois.filter((p) => p.hasBase && p.baseId);
      const hasStation = stations.length > 0;
      const stationIds = stations.map((p) => p.baseId!);

      systemPois.set(bot.systemId, {
        hasBelts,
        hasIceFields,
        hasGasClouds,
        hasStation,
        stationIds,
        poiTypes: system.pois.map((p) => p.type),
      });
    }

    // Market freshness
    const freshStationIds = cache.getFreshStationIds();
    const hasAnyMarketData = cache.hasAnyMarketData();

    // Stale stations: stations bots are near that have old/no market data
    const staleStationIds: string[] = [];
    for (const [, info] of systemPois) {
      for (const sid of info.stationIds) {
        const freshness = cache.getMarketFreshness(sid);
        if (!freshness.fresh) staleStationIds.push(sid);
      }
    }

    // Trade routes from ALL cached market data (cached 3 min, invalidated by market changes)
    const allCachedStationIds = cache.getAllMarketFreshness().map((f) => f.stationId);
    const now = Date.now();
    if (!this.cachedTradeRoutes || now - this.cachedTradeRoutes.at > 180_000 || cache.marketDirty) {
      // Use median fleet cargo capacity for route ranking
      const capacities = fleet.bots.map((b) => b.cargoCapacity).filter((c) => c > 0).sort((a, b) => a - b);
      const medianCargo = capacities.length > 0 ? capacities[Math.floor(capacities.length / 2)] : 100;
      const routes = allCachedStationIds.length >= 2
        ? market.findArbitrage(allCachedStationIds, fleet.bots[0]?.systemId ?? "", medianCargo).slice(0, 10)
        : [];
      this.cachedTradeRoutes = { routes, at: now };
    }
    const tradeRoutes = this.cachedTradeRoutes.routes;

    // Data freshness ratio: what fraction of known stations have fresh data
    const allKnownStationIds = new Set<string>();
    for (const [, info] of systemPois) {
      for (const sid of info.stationIds) allKnownStationIds.add(sid);
    }
    const totalKnown = allKnownStationIds.size;
    const dataFreshnessRatio = totalKnown > 0 ? freshStationIds.length / totalKnown : 0;

    return {
      systemPois,
      freshStationIds,
      staleStationIds,
      hasAnyMarketData,
      tradeRouteCount: tradeRoutes.length,
      bestTradeProfit: tradeRoutes.length > 0 ? tradeRoutes[0].tripProfitPerTick : 0,
      galaxyLoaded: galaxy.systemCount > 0,
      tradeRoutes,
      cachedStationIds: allCachedStationIds,
      dataFreshnessRatio,
    };
  }

  /** Generate conversational thoughts narrating the commander's reasoning */
  private buildThoughts(
    fleet: FleetStatus,
    world: WorldContext,
    output: EvaluationOutput
  ): string[] {
    const thoughts: string[] = [];

    // Fleet observation
    const readyCount = fleet.bots.filter((b) => b.status === "ready" || b.status === "running").length;
    const idleCount = fleet.bots.filter((b) => b.status === "ready" && !b.routine).length;
    if (readyCount === 0) {
      thoughts.push("No bots online. Waiting for fleet to come online.");
      return thoughts;
    }
    thoughts.push(`Fleet check: ${readyCount} bot(s) operational, ${fleet.totalCredits.toLocaleString()} credits in treasury.`);

    // Goals
    if (this.goals.length > 0) {
      const primary = this.goals[0];
      const label = primary.type.replace(/_/g, " ");
      thoughts.push(`Current objective: ${label} (priority ${primary.priority}).`);
    } else {
      thoughts.push("No objectives set — running balanced fleet strategy.");
    }

    // World awareness
    if (!world.galaxyLoaded) {
      thoughts.push("Galaxy map not yet loaded — exploration should be prioritized.");
    } else if (!world.hasAnyMarketData) {
      thoughts.push("No market intelligence gathered yet. Bots that dock at stations will scan prices automatically.");
    } else if (world.staleStationIds.length > 0) {
      thoughts.push(`${world.staleStationIds.length} station(s) have stale market data — could use a refresh.`);
    }

    if (world.tradeRouteCount > 0) {
      thoughts.push(`Found ${world.tradeRouteCount} profitable trade route(s). Best yields ${world.bestTradeProfit.toFixed(1)} cr/tick.`);
    }

    // Data freshness awareness
    if (world.hasAnyMarketData && world.dataFreshnessRatio < 0.5) {
      const pct = Math.round(world.dataFreshnessRatio * 100);
      thoughts.push(`Market data quality: ${pct}% fresh. Stale data reduces trader effectiveness — prioritizing bots that dock and refresh prices.`);
    }

    // Faction storage awareness
    const factionInv = this.economy.getFactionInventory();
    if (factionInv.size > 0) {
      const totalItems = [...factionInv.values()].reduce((s, q) => s + q, 0);
      const oreCount = [...factionInv.entries()]
        .filter(([id]) => id.includes("ore"))
        .reduce((s, [, q]) => s + q, 0);
      if (oreCount > 0) {
        thoughts.push(`Faction storage: ${totalItems} items (${oreCount} ore units available for crafting).`);
      } else {
        thoughts.push(`Faction storage: ${totalItems} items.`);
      }
    } else if (this.deps.defaultStorageMode === "faction_deposit") {
      thoughts.push("Faction storage empty — miners should deposit raw materials for crafters.");
    }

    // Bot health concerns (cooldowns already cleared in applyEmergencyOverrides before eval)
    const lowFuel = fleet.bots.filter((b) => b.fuelPct < 25 && (b.status === "running" || b.status === "ready"));
    if (lowFuel.length > 0) {
      thoughts.push(`${lowFuel.length} bot(s) running low on fuel — emergency overrides applied.`);
    }
    const lowHull = fleet.bots.filter((b) => b.hullPct < 30 && (b.status === "running" || b.status === "ready"));
    if (lowHull.length > 0) {
      thoughts.push(`${lowHull.length} bot(s) with damaged hull — emergency overrides applied.`);
    }

    // Assignment decisions
    if (output.assignments.length > 0) {
      for (const a of output.assignments) {
        if (a.previousRoutine) {
          thoughts.push(`Reassigning ${a.botId}: ${a.previousRoutine} -> ${a.routine} (score ${a.score.toFixed(0)}). ${a.reasoning}`);
        } else {
          thoughts.push(`Assigning ${a.botId} to ${a.routine} (score ${a.score.toFixed(0)}).`);
        }
      }
    } else if (idleCount > 0) {
      thoughts.push(`${idleCount} bot(s) idle but no suitable assignments found yet.`);
    } else {
      thoughts.push("All bots performing well in current roles. No changes needed.");
    }

    // Routine distribution
    const routineCounts = new Map<string, number>();
    for (const bot of fleet.bots) {
      if (bot.routine) routineCounts.set(bot.routine, (routineCounts.get(bot.routine) ?? 0) + 1);
    }
    if (routineCounts.size > 0) {
      const dist = [...routineCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, c]) => `${c} ${r}${c > 1 ? "s" : ""}`)
        .join(", ");
      thoughts.push(`Fleet composition: ${dist}.`);
    }

    return thoughts;
  }

  private recordDecision(
    decision: CommanderDecision,
    fleet: FleetStatus,
    economy: { deficits: unknown[]; surpluses: unknown[]; netProfit: number }
  ): void {
    // Add to history
    this.decisionHistory.push(decision);
    if (this.decisionHistory.length > this.maxHistorySize) {
      this.decisionHistory.shift();
    }

    // Log to training data
    try {
      this.deps.logger.logCommanderDecision({
        tick: decision.tick,
        goal: decision.goal,
        fleetState: {
          totalBots: fleet.bots.length,
          activeBots: fleet.activeBots,
          totalCredits: fleet.totalCredits,
          botSummaries: fleet.bots.map((b) => ({
            id: b.botId,
            status: b.status,
            routine: b.routine,
            system: b.systemId,
            fuelPct: b.fuelPct,
            cargoPct: b.cargoPct,
          })),
        },
        assignments: decision.assignments.map((a) => ({
          botId: a.botId,
          routine: a.routine,
          score: a.score,
          previous: a.previousRoutine,
          reasoning: a.reasoning,
        })),
        reasoning: decision.reasoning,
        economyState: {
          deficits: economy.deficits.length,
          surpluses: economy.surpluses.length,
          netProfit: economy.netProfit,
        },
      });
    } catch {
      // Training logger failure shouldn't break the Commander
    }
  }
}
