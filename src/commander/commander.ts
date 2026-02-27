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
import type { CommanderBrain, EvaluationOutput, Assignment, WorldContext } from "./types";
import { EconomyEngine } from "./economy-engine";
import { ScoringBrain, type ScoringConfig } from "./scoring-brain";

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

    // Step 5: Execute assignments
    const executedAssignments: FleetAssignment[] = [];

    for (const assignment of output.assignments) {
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

  /** Poll faction storage inventory (best-effort, non-blocking) */
  private async pollFactionStorage(): Promise<void> {
    const api = this.deps.getApi?.();
    if (!api) return;

    // Only poll if using faction storage
    const mode = this.deps.defaultStorageMode;
    if (mode !== "faction_deposit") return;

    try {
      const items = await api.viewFactionStorage();
      const inventory = new Map<string, number>();
      for (const item of items) {
        if (item.quantity > 0) {
          inventory.set(item.itemId, (inventory.get(item.itemId) ?? 0) + item.quantity);
        }
      }
      this.economy.updateFactionInventory(inventory);
    } catch {
      // Non-critical - faction storage may not be accessible
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

      const hasBelts = system.pois.some((p) =>
        p.type === "asteroid_belt" || p.type === "asteroid"
      );
      const hasIceFields = system.pois.some((p) => p.type === "ice_field");
      const hasGasClouds = system.pois.some((p) =>
        p.type === "gas_cloud" || p.type === "nebula"
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

    // Trade routes from ALL cached market data (not just fresh — stale data is still useful for routing)
    const allCachedStationIds = cache.getAllMarketFreshness().map((f) => f.stationId);
    const tradeRoutes = allCachedStationIds.length >= 2
      ? market.findArbitrage(allCachedStationIds, fleet.bots[0]?.systemId ?? "").slice(0, 10)
      : [];

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
