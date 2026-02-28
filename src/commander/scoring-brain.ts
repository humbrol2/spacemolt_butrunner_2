/**
 * Scoring brain - deterministic Commander implementation.
 * Scores every bot × routine combination and assigns the best fits.
 */

import type { Goal } from "../types/config";
import type { RoutineName } from "../types/protocol";
import type { FleetBotInfo, FleetStatus } from "../bot/types";
import type {
  CommanderBrain,
  EvaluationInput,
  EvaluationOutput,
  Assignment,
  BotScore,
  StrategyWeights,
  EconomySnapshot,
  WorldContext,
  SupplyDeficit,
  ReassignmentState,
} from "./types";
import type { TradeRoute } from "../core/market";
import type { PendingUpgrade } from "./types";
import type { ShipClass } from "../types/game";
import { scoreShipForRole } from "../core/ship-fitness";
import { getStrategyWeights } from "./strategies";

const ALL_ROUTINES: RoutineName[] = [
  "miner", "harvester", "trader", "explorer", "crafter",
  "hunter", "salvager", "return_home", "scout", "quartermaster",
  "ship_upgrade",
  // "mission_runner", // Disabled until mission system is tested
];

/** Routines that operate in the field and should not be interrupted for return_home */
const FIELD_ROUTINES: Set<RoutineName> = new Set(["trader", "hunter", "explorer"]);

/** Maximum concurrent bots per routine (enforced in greedy assignment loop) */
/** Note: explorer scales with fleet size — see getMaxCount() */
const ROUTINE_MAX_COUNT: Partial<Record<RoutineName, number>> = {
  scout: 1,
  explorer: 1, // Default; overridden by getMaxCount() for larger fleets
  quartermaster: 1, // Only one faction home manager
  ship_upgrade: 1, // One upgrade at a time fleet-wide
};

/** Dynamic max count: scales explorer cap with fleet size */
function getMaxCount(routine: RoutineName, fleetSize: number): number | undefined {
  if (routine === "explorer") {
    // 1 explorer for 1-5 bots, 2 for 6+ bots
    return fleetSize >= 6 ? 2 : 1;
  }
  return ROUTINE_MAX_COUNT[routine];
}

/** Scoring configuration */
export interface ScoringConfig {
  /** Base score per routine (tunable defaults) */
  baseScores: Record<RoutineName, number>;
  /** Supply deficit multiplier */
  supplyMultiplier: number;
  /** Skill match bonus */
  skillBonus: number;
  /** Switch cost per estimated tick */
  switchCostPerTick: number;
  /** Diversity penalty when > N bots on same routine */
  diversityThreshold: number;
  /** Diversity penalty amount per extra bot */
  diversityPenaltyPerBot: number;
  /** Min score improvement to trigger reassignment (0-1) */
  reassignmentThreshold: number;
  /** Cooldown in ms before a bot can be reassigned */
  reassignmentCooldownMs: number;
}

const DEFAULT_CONFIG: ScoringConfig = {
  baseScores: {
    miner: 55,        // Supply chain: feeds faction storage with ore
    harvester: 50,    // Multi-target extraction, good discovery
    trader: 40,       // Needs specific market data to be effective
    explorer: 25,     // Charts systems, intel submission (low priority vs revenue)
    crafter: 55,      // Supply chain: converts ore to goods (same priority as miner)
    hunter: 30,       // Risky, needs combat readiness
    salvager: 25,
    mission_runner: 45, // Good auto-discovery, reliable income
    return_home: 5,     // Utility routine — only for idle bots away from home
    scout: 10,          // One-shot data gathering — scored high only when data is needed
    quartermaster: 35,  // Faction home manager — sells goods, buys modules
    ship_upgrade: 0,    // Only scores > 0 when Commander queues an upgrade
  },
  supplyMultiplier: 15,
  skillBonus: 10,
  switchCostPerTick: 3,
  diversityThreshold: 2,
  diversityPenaltyPerBot: 25,
  reassignmentThreshold: 0.3,
  reassignmentCooldownMs: 300_000, // 5 minutes
};

export class ScoringBrain implements CommanderBrain {
  private config: ScoringConfig;
  private reassignmentState = new Map<string, ReassignmentState>();

  constructor(config?: Partial<ScoringConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Update config dynamically (e.g., from dashboard settings) */
  updateConfig(partial: Partial<ScoringConfig>): void {
    Object.assign(this.config, partial);
  }

  /**
   * Evaluate the fleet and produce assignments.
   * Core algorithm:
   * 1. Get strategy weights from active goals
   * 2. Score every bot × routine combination
   * 3. Greedy assignment (highest score first)
   * 4. Respect cooldowns and thresholds
   */
  evaluate(input: EvaluationInput): EvaluationOutput {
    const { fleet, goals, economy, world, tick } = input;
    const now = Date.now();

    // Only evaluate ready/running bots
    const candidates = fleet.bots.filter(
      (b) => b.status === "ready" || b.status === "running"
    );

    if (candidates.length === 0) {
      return { assignments: [], reasoning: "No bots available for assignment." };
    }

    // Clear cooldowns for bots stuck on over-cap routines
    // (e.g., 4 bots on scout when max is 1 — 3 need to be freed immediately)
    const fleetSize = candidates.length;
    for (const routine of Object.keys(ROUTINE_MAX_COUNT) as RoutineName[]) {
      const maxCount = getMaxCount(routine, fleetSize)!;
      const botsOnRoutine = candidates.filter((b) => b.routine === routine);
      if (botsOnRoutine.length > maxCount) {
        // Keep the first N, clear cooldowns on the rest so they can be reassigned
        for (let i = maxCount; i < botsOnRoutine.length; i++) {
          this.clearCooldown(botsOnRoutine[i].botId);
        }
      }
    }

    // Get strategy weights from goals
    const weights = getStrategyWeights(goals);

    // Score all bot × routine combinations
    const allScores: BotScore[] = [];
    for (const bot of candidates) {
      for (const routine of ALL_ROUTINES) {
        const score = this.scoreAssignment(bot, routine, weights, economy, fleet, world);
        allScores.push(score);
      }
    }

    // Greedy assignment: pick best score for each bot
    const assignments: Assignment[] = [];
    const assignedBots = new Set<string>();
    const routineCounts = new Map<RoutineName, number>();

    // Count current routine distribution (from previous cycle)
    for (const bot of fleet.bots) {
      if (bot.routine) {
        routineCounts.set(bot.routine, (routineCounts.get(bot.routine) ?? 0) + 1);
      }
    }

    // Track routines assigned THIS cycle for dynamic diversity
    const cycleRoutineCounts = new Map<RoutineName, number>();

    // Sort scores descending
    allScores.sort((a, b) => b.finalScore - a.finalScore);

    // Assign each bot to its best routine, respecting diversity.
    // Two-pass: first let bots keep current routines within diversity threshold,
    // then assign remaining bots using per-bot best-adjusted-score.

    // Pass 1: Auto-continue bots already on a routine within diversity threshold.
    // When more bots want the same routine than the threshold allows, keep the
    // NEWEST assignments (they just switched) and rotate OUT the longest-running
    // ones. This ensures all bots eventually get different experiences.
    const routineGroups = new Map<RoutineName, FleetBotInfo[]>();
    for (const bot of candidates) {
      if (!bot.routine) continue;
      const routine = bot.routine as RoutineName;
      const group = routineGroups.get(routine) ?? [];
      group.push(bot);
      routineGroups.set(routine, group);
    }

    for (const [routine, bots] of routineGroups) {
      const maxCount = getMaxCount(routine, fleetSize);
      const threshold = maxCount !== undefined ? Math.min(maxCount, this.config.diversityThreshold) : this.config.diversityThreshold;

      if (bots.length <= threshold) {
        // All fit within threshold — keep them all
        for (const bot of bots) {
          assignedBots.add(bot.botId);
          cycleRoutineCounts.set(routine, (cycleRoutineCounts.get(routine) ?? 0) + 1);
        }
      } else {
        // More bots than threshold — keep newest, rotate out longest-running
        // Sort by assignment time ascending (oldest first = rotate out first)
        bots.sort((a, b) => {
          const aTime = this.reassignmentState.get(a.botId)?.lastAssignment ?? 0;
          const bTime = this.reassignmentState.get(b.botId)?.lastAssignment ?? 0;
          return aTime - bTime; // oldest first
        });
        // Keep only the last N (newest assignments)
        const keepers = bots.slice(bots.length - threshold);
        const rotatedOut = bots.slice(0, bots.length - threshold);
        for (const bot of keepers) {
          assignedBots.add(bot.botId);
          cycleRoutineCounts.set(routine, (cycleRoutineCounts.get(routine) ?? 0) + 1);
        }
        if (rotatedOut.length > 0) {
          console.log(`[Commander] Diversity: ${routine} has ${bots.length}/${threshold} — keeping [${keepers.map(b => b.botId).join(",")}], rotating out [${rotatedOut.map(b => b.botId).join(",")}]`);
        }
      }
    }

    // Pass 2: Assign remaining bots to best available routine (diversity-adjusted).
    // These bots were excluded from Pass 1 because their routine is over-represented.
    // They MUST switch — skip their current routine entirely.
    // KEY: Evaluate ALL valid routines and pick the highest ADJUSTED score,
    // not the first positive one (which would ignore diversity penalties).
    for (const bot of candidates) {
      if (assignedBots.has(bot.botId)) continue;

      // This bot's current routine is over the diversity threshold — must switch
      const mustSwitch = bot.routine && (cycleRoutineCounts.get(bot.routine as RoutineName) ?? 0) >= this.config.diversityThreshold;

      // Get this bot's scores
      const botScores = allScores.filter((s) => s.botId === bot.botId);

      // Find the best ADJUSTED score across all valid routines
      let bestScore: BotScore | null = null;
      let bestAdjusted = 0;

      for (const score of botScores) {
        // Skip current routine if bot must switch for diversity
        if (mustSwitch && score.routine === bot.routine) continue;

        // Hard cap: skip if this routine has reached its max count this cycle
        const maxCount = getMaxCount(score.routine, fleetSize);
        if (maxCount !== undefined) {
          const alreadyAssigned = cycleRoutineCounts.get(score.routine) ?? 0;
          if (alreadyAssigned >= maxCount) continue;
        }

        // Dynamic diversity: penalize routines already assigned this cycle
        const cycleCount = cycleRoutineCounts.get(score.routine) ?? 0;
        const adjustedScore = score.finalScore - (cycleCount * this.config.diversityPenaltyPerBot);

        // Skip if adjusted score is non-positive
        if (adjustedScore <= 0) continue;

        // Track the best adjusted score (not just the first valid one)
        if (adjustedScore > bestAdjusted) {
          bestScore = score;
          bestAdjusted = adjustedScore;
        }
      }

      if (bestScore) {
        const cycleCount = cycleRoutineCounts.get(bestScore.routine) ?? 0;
        console.log(`[Commander] Pass2: ${bestScore.botId} ${bot.routine ?? "idle"} → ${bestScore.routine} (adjusted=${bestAdjusted.toFixed(0)}, mustSwitch=${mustSwitch})`);
        assignments.push({
          botId: bestScore.botId,
          routine: bestScore.routine,
          params: this.buildParams(bestScore.routine, bot, economy, goals, assignments, world),
          score: bestAdjusted,
          reasoning: bestScore.reasoning,
          previousRoutine: bot.routine,
        });

        assignedBots.add(bestScore.botId);
        cycleRoutineCounts.set(bestScore.routine, cycleCount + 1);

        // Track reassignment
        if (bot.routine && bot.routine !== bestScore.routine) {
          this.reassignmentState.set(bestScore.botId, {
            lastAssignment: now,
            lastRoutine: bestScore.routine,
            cooldownUntil: now + this.config.reassignmentCooldownMs,
          });
        }
      }
    }

    // Log top scores per bot for diagnostics
    for (const bot of candidates) {
      const botScores = allScores
        .filter((s) => s.botId === bot.botId)
        .sort((a, b) => b.finalScore - a.finalScore)
        .slice(0, 3);
      const scoreStr = botScores.map((s) => `${s.routine}=${s.finalScore.toFixed(0)}`).join(", ");
      console.log(`[Commander] ${bot.botId} (fuel=${bot.fuelPct.toFixed(0)}% mods=[${bot.moduleIds.join(",")}]): ${scoreStr}`);
    }

    // Fallback: if any idle bot (no routine) wasn't assigned, force-assign the best available routine
    for (const bot of candidates) {
      if (assignedBots.has(bot.botId)) continue;
      if (bot.routine) continue; // Already running something

      // Find the best routine for this bot regardless of score
      const botScores = allScores
        .filter((s) => s.botId === bot.botId)
        .sort((a, b) => b.finalScore - a.finalScore);

      if (botScores.length > 0) {
        const best = botScores[0];
        console.log(`[Commander] Fallback: forcing ${bot.botId} → ${best.routine} (score ${best.finalScore.toFixed(0)})`);
        assignments.push({
          botId: bot.botId,
          routine: best.routine,
          params: this.buildParams(best.routine, bot, economy, goals, assignments, world),
          score: best.finalScore,
          reasoning: `fallback: ${best.reasoning}`,
          previousRoutine: null,
        });
        assignedBots.add(bot.botId);
      }
    }

    // Build reasoning summary
    const reasoning = this.buildReasoning(assignments, candidates, economy, goals);

    return { assignments, reasoning };
  }

  /** Score a single bot × routine combination */
  scoreAssignment(
    bot: FleetBotInfo,
    routine: RoutineName,
    weights: StrategyWeights,
    economy: EconomySnapshot,
    fleet: FleetStatus,
    world?: WorldContext
  ): BotScore {
    // 1. Base score × strategy weight
    const baseScore = this.config.baseScores[routine] * weights[routine];

    // 2. Supply chain bonus: deficit detection boosts relevance
    const supplyBonus = this.calcSupplyBonus(routine, economy);

    // 3. Skill bonus: reward bots suited to the role
    const skillBonus = this.calcSkillBonus(bot, routine);

    // 4. Risk penalty based on bot's current location safety
    const riskPenalty = this.calcRiskPenalty(bot, routine);

    // 5. Switch cost: penalize if bot needs to change roles (0 for idle bots)
    const switchCost = !bot.routine ? 0 :
      bot.routine === routine ? 0 :
      (bot.docked ? 2 : 6) * this.config.switchCostPerTick;

    // 6. Diversity penalty: too many bots on same routine (capped to never exceed base score)
    const currentCount = fleet.bots.filter((b) => b.routine === routine && b.botId !== bot.botId).length;
    const rawDiversityPenalty = currentCount >= this.config.diversityThreshold
      ? (currentCount - this.config.diversityThreshold + 1) * this.config.diversityPenaltyPerBot
      : 0;
    const diversityPenalty = Math.min(rawDiversityPenalty, baseScore * 0.8); // Never exceed 80% of base

    // 7. Rapid completion penalty: routine recently failed to find work (completed in < 60s)
    //    Tracks ALL recently-failed routines (not just the last one) to prevent alternating failures
    const RAPID_EXPIRY_MS = 300_000; // 5 minutes
    const rapidAt = bot.rapidRoutines.get(routine);
    const rapidPenalty = (rapidAt && (Date.now() - rapidAt) < RAPID_EXPIRY_MS)
      ? 200 // Strong penalty — this routine definitively can't work right now
      : 0;

    // 8. Information scarcity bonus: uses world context for data-aware scoring
    //    Scaled by strategy weight so income goals suppress exploration bonuses
    const rawInfoBonus = this.calcInfoScarcityBonus(routine, economy, world);
    const infoBonus = rawInfoBonus * weights[routine];

    // 9. Equipment penalty: bot lacks required modules for the routine
    const equipmentPenalty = this.calcEquipmentPenalty(bot, routine);

    // 10. World penalty: system lacks POIs needed for the routine
    const worldPenalty = this.calcWorldPenalty(bot, routine, world);

    // 11. Faction storage bonus: supply chain awareness
    const factionBonus = this.calcFactionStorageBonus(routine, economy);

    // 12. Idle routine penalty: routines that need external inputs but have none configured
    const idlePenalty = this.calcIdleRoutinePenalty(routine, economy, fleet, bot);

    // 13. Data staleness penalty: penalize data-dependent routines when market data is old
    const stalenessPenalty = this.calcStalenessPenalty(routine, world);

    const finalScore = baseScore + supplyBonus + skillBonus + infoBonus + factionBonus - riskPenalty - switchCost - diversityPenalty - rapidPenalty - equipmentPenalty - worldPenalty - idlePenalty - stalenessPenalty;

    const parts = [`${routine}: base=${baseScore.toFixed(0)}`];
    if (supplyBonus > 0) parts.push(`supply=+${supplyBonus.toFixed(0)}`);
    if (skillBonus > 0) parts.push(`skill=+${skillBonus.toFixed(0)}`);
    if (infoBonus !== 0) parts.push(`info=${infoBonus > 0 ? "+" : ""}${infoBonus.toFixed(0)}`);
    if (factionBonus !== 0) parts.push(`faction=${factionBonus > 0 ? "+" : ""}${factionBonus.toFixed(0)}`);
    if (riskPenalty > 0) parts.push(`risk=-${riskPenalty.toFixed(0)}`);
    if (switchCost > 0) parts.push(`switch=-${switchCost.toFixed(0)}`);
    if (diversityPenalty > 0) parts.push(`diversity=-${diversityPenalty.toFixed(0)}`);
    if (rapidPenalty > 0) parts.push(`rapid=-${rapidPenalty}`);
    if (equipmentPenalty > 0) parts.push(`equip=-${equipmentPenalty}`);
    if (worldPenalty > 0) parts.push(`world=-${worldPenalty}`);
    if (idlePenalty > 0) parts.push(`idle=-${idlePenalty}`);
    if (stalenessPenalty > 0) parts.push(`stale=-${stalenessPenalty.toFixed(0)}`);
    parts.push(`→ ${finalScore.toFixed(0)}`);
    const reasoning = parts.join(" ");

    return {
      botId: bot.botId,
      routine,
      baseScore,
      supplyBonus,
      skillBonus,
      infoBonus,
      factionBonus,
      riskPenalty,
      switchCost,
      diversityPenalty,
      rapidPenalty,
      equipmentPenalty,
      worldPenalty,
      idlePenalty,
      stalenessPenalty,
      finalScore,
      reasoning,
    };
  }

  /** Check if a bot can be reassigned (cooldown expired) */
  canReassign(botId: string, now: number): boolean {
    const state = this.reassignmentState.get(botId);
    if (!state) return true;
    return now >= state.cooldownUntil;
  }

  /** Force-clear cooldown for a bot (urgency override) */
  clearCooldown(botId: string): void {
    this.reassignmentState.delete(botId);
  }

  /** Clear all cooldowns */
  clearAllCooldowns(): void {
    this.reassignmentState.clear();
  }

  // ── Private Scoring Components ──

  private calcSupplyBonus(routine: RoutineName, economy: EconomySnapshot): number {
    let bonus = 0;

    for (const deficit of economy.deficits) {
      const priorityMult = deficit.priority === "critical" ? 3 : deficit.priority === "normal" ? 1.5 : 1;
      const relevance = this.routineRelevanceToDeficit(routine, deficit);
      bonus += deficit.shortfall * relevance * priorityMult * (this.config.supplyMultiplier / 10);
    }

    return bonus;
  }

  private routineRelevanceToDeficit(routine: RoutineName, deficit: SupplyDeficit): number {
    // How relevant is this routine to addressing the deficit?
    const id = deficit.itemId;
    // Ores (mined from belts)
    if (id.startsWith("ore_") && !id.includes("ice")) {
      if (routine === "miner") return 1.0;
      if (routine === "harvester") return 0.5;
    }
    // Ice ores (harvested from ice fields)
    if (id.includes("ice") || id.includes("crystal")) {
      if (routine === "harvester") return 1.0;
      if (routine === "miner") return 0.3;
    }
    // Refined/crafted materials
    if (id.startsWith("refined_") || id.startsWith("component_")) {
      if (routine === "crafter") return 1.0;
    }
    return 0;
  }

  /**
   * Supply chain bonus: boost crafter when faction storage has raw materials,
   * boost miner when faction storage is low on ore.
   */
  private calcFactionStorageBonus(routine: RoutineName, economy: EconomySnapshot): number {
    if (economy.factionStorage.size === 0) return 0;

    const oreInStorage = [...economy.factionStorage.entries()]
      .filter(([id]) => id.includes("ore"))
      .reduce((sum, [, qty]) => sum + qty, 0);

    switch (routine) {
      case "crafter":
        // Crafter should be strongly preferred when ANY ore is available to process
        if (oreInStorage >= 50) return 50;  // Lots of ore — definitely need crafters
        if (oreInStorage >= 20) return 40;  // Good supply
        if (oreInStorage >= 10) return 30;  // Decent supply — crafter should be active
        if (oreInStorage >= 3) return 20;   // Minimum viable batch — start crafting
        return 0;
      case "miner":
        // Miner gets bonus when storage is empty, penalty when ore is piling up
        if (oreInStorage < 3) return 25;    // Storage empty — need to mine
        if (oreInStorage < 10) return 10;   // Low ore — keep mining
        if (oreInStorage < 30) return 0;    // Neutral — enough ore for now
        return -20; // Ore piling up — crafter should take priority, not more mining
      case "trader":
        // Trader gets bonus when crafted goods are in storage (ready to sell)
        {
          const goodsInStorage = [...economy.factionStorage.entries()]
            .filter(([id]) => id.startsWith("refined_") || id.startsWith("component_"))
            .reduce((sum, [, qty]) => sum + qty, 0);
          if (goodsInStorage >= 20) return 25;
          if (goodsInStorage >= 5) return 10;
        }
        return 0;
      default:
        return 0;
    }
  }

  private calcSkillBonus(bot: FleetBotInfo, routine: RoutineName): number {
    // Ship fitness bonus: bots in better ships for a role get priority
    if (bot.shipClass && this.shipCatalog.length > 0) {
      const shipClass = this.shipCatalog.find((s) => s.id === bot.shipClass);
      if (shipClass) {
        const fitness = scoreShipForRole(shipClass, routine);
        // +0 to +25 bonus based on ship fitness (normalized 0-100 → 0-25)
        return Math.round(fitness * 0.25);
      }
    }
    return 0;
  }

  /**
   * Information-aware scoring. Uses WorldContext when available for precise data-driven bonuses.
   * Revenue-generating routines (miner, trader, mission_runner) are preferred over pure intel.
   * Explorer only gets boosted when data is specifically needed for profitable activities.
   */
  private calcInfoScarcityBonus(routine: RoutineName, economy: EconomySnapshot, world?: WorldContext): number {
    // If no world context, fall back to economy-only check
    if (!world) {
      const hasData = economy.deficits.length > 0 || economy.surpluses.length > 0
        || economy.inventoryAlerts.length > 0 || economy.totalRevenue > 0;
      if (hasData) return 0;
      // Prioritize revenue-generating routines that work blind
      switch (routine) {
        case "miner": return 15;           // Works great blind, generates credits
        case "crafter": return 10;          // Works from faction storage — doesn't need market data
        case "mission_runner": return 15;   // Reliable income
        case "explorer": return 5;          // Intel is nice but doesn't earn
        case "trader": return -20;          // Useless without price data
        default: return 0;
      }
    }

    let bonus = 0;

    // Galaxy not loaded → boost routines that still work + mild explorer boost
    if (!world.galaxyLoaded) {
      if (routine === "miner") return 15;           // Auto-discovers belts, earns credits
      if (routine === "crafter") return 5;            // Uses faction storage, not market
      if (routine === "mission_runner") return 15;   // Docks, takes missions, earns
      if (routine === "explorer") return 10;         // Gathers map data (needed eventually)
      if (routine === "trader") return -30;          // Needs prices
      return -5;
    }

    // No market data at all → revenue routines first, explorer second
    if (!world.hasAnyMarketData) {
      switch (routine) {
        case "miner": bonus += 15; break;           // Mine and sell, always works
        case "crafter": bonus += 5; break;           // Uses faction storage, not market
        case "mission_runner": bonus += 15; break;   // Docks at stations (triggers market scan)
        case "explorer": bonus += 10; break;         // Visits systems, triggers scans on dock
        case "trader": bonus -= 30; break;           // Useless without price data
      }
      return bonus;
    }

    // Have some market data but stale stations nearby → boost routines that refresh data
    if (world.staleStationIds.length > 0) {
      if (routine === "mission_runner") bonus += 10;
      if (routine === "trader") bonus += 5;
      if (routine === "explorer") bonus += 5;
    }

    // Have fresh trade routes → boost trader
    if (world.tradeRouteCount > 0 && routine === "trader") {
      bonus += Math.min(world.bestTradeProfit * 5, 25);
    }

    // No trade routes found even with data → penalize trader
    if (world.hasAnyMarketData && world.tradeRouteCount === 0 && routine === "trader") {
      bonus -= 15;
    }

    return bonus;
  }

  /**
   * World penalty: check if the bot's current system has POIs the bot can actually use.
   * Cross-references bot modules with system POI types:
   * - mining_laser/drill → asteroid_belt, asteroid
   * - ice_harvester → ice_field
   * - gas_harvester → gas_cloud, nebula
   */
  private calcWorldPenalty(bot: FleetBotInfo, routine: RoutineName, world?: WorldContext): number {
    if (!world || !bot.systemId) return 0;

    const system = world.systemPois.get(bot.systemId);
    if (!system) return 0; // No data for this system, don't penalize (routine will auto-discover)

    switch (routine) {
      case "miner":
      case "harvester": {
        // Check if system has any extractable resource POIs
        const hasResources = system.hasBelts || system.hasIceFields || system.hasGasClouds;
        if (!hasResources) return 50; // No resource POIs in system
        if (!system.hasStation) return 30; // Can extract but nowhere to sell/deposit
        return 0;
      }
      case "trader": {
        if (!system.hasStation) return 100;
        const hasLocalMarketData = system.stationIds.some((sid) =>
          world.freshStationIds.includes(sid)
        );
        if (!hasLocalMarketData) return 40; // No price data — trader would be guessing
        return 0;
      }
      case "crafter": {
        if (!system.hasStation) return 80;
        return 0;
      }
      case "mission_runner": {
        if (!system.hasStation) return 60;
        return 0;
      }
      case "salvager":
        return 0; // Wrecks appear anywhere
      default:
        return 0;
    }
  }

  private calcRiskPenalty(bot: FleetBotInfo, routine: RoutineName): number {
    // Critical fuel (<15%): all routines penalized heavily (bot needs emergency refuel)
    if (bot.fuelPct < 15) {
      if (routine === "miner") return 50; // Miner will auto-dock but still penalize at critical
      return 150; // Hard block — bot needs to refuel, not work
    }
    // Low fuel (15-30%): penalize routines that travel a lot, miner is safest (auto-docks)
    if (bot.fuelPct < 30) {
      if (routine === "miner") return 0;
      if (routine === "mission_runner") return 20; // Can dock and refuel during missions
      return 80; // Most routines need fuel to function
    }
    // Below comfortable (30-50%): mild penalty for non-docking routines
    if (bot.fuelPct < 50 && routine !== "miner" && routine !== "mission_runner") {
      return 15;
    }
    // Risk for combat routines on low-hull bots
    if (routine === "hunter" && bot.cargoPct > 80) {
      return 10; // Don't send full cargo bots into combat
    }
    if (routine === "hunter" && bot.hullPct < 50) {
      return 20; // Don't send damaged bots into combat
    }
    return 0;
  }

  /**
   * Equipment penalty: check if the bot has the modules needed for a routine.
   * Returns a heavy penalty (effectively blocks assignment) if critical modules are missing.
   *
   * Extraction module requirements:
   * - Ore (asteroid_belt/asteroid): mining_laser or drill
   * - Ice (ice_field): ice_harvester
   * - Gas (gas_cloud/nebula): gas_harvester
   * - At least ONE matching extraction module required for miner/harvester
   */
  private calcEquipmentPenalty(bot: FleetBotInfo, routine: RoutineName): number {
    const mods = bot.moduleIds;
    const hasModule = (pattern: string) => mods.some((id) => id.includes(pattern));

    switch (routine) {
      case "miner":
        // No penalty — mining works with starter ships
        return 0;
      case "harvester": {
        // Harvester is only valuable with specialized modules (ice/gas harvesters)
        // Without them, it does the same thing as miner but with worse params
        const hasSpecialized = hasModule("ice_harvester") || hasModule("gas_harvester");
        return hasSpecialized ? 0 : 80; // Heavy penalty if no specialized gear
      }
      case "hunter": {
        const hasWeapon = hasModule("weapon") || hasModule("laser") || hasModule("cannon")
          || hasModule("missile") || hasModule("turret") || hasModule("gun");
        return hasWeapon ? 0 : 200;
      }
      case "salvager": {
        const hasSalvage = hasModule("tow") || hasModule("salvage");
        return hasSalvage ? 0 : 200;
      }
      case "crafter": {
        // Check if bot has any crafting-related skills
        const hasCraftingSkill = Object.entries(bot.skills).some(
          ([id, level]) => (id.includes("craft") || id.includes("refin") || id.includes("manufactur")) && level > 0
        );
        // Mild penalty if no crafting skills — bot can still attempt easy recipes to level up
        return hasCraftingSkill ? 0 : 20;
      }
      default:
        return 0;
    }
  }

  /**
   * Penalize routines that need external inputs but have none configured.
   * Also enforces hard caps: max 1 explorer in the fleet.
   * Handles return_home scoring: big bonus for idle bots away from home,
   * blocked for bots already home or recently on field routines.
   */
  private calcIdleRoutinePenalty(routine: RoutineName, economy: EconomySnapshot, fleet?: FleetStatus, bot?: FleetBotInfo): number {
    switch (routine) {
      case "explorer": {
        // Dynamic cap: 1 explorer for small fleets, 2 for 6+ bots
        const explorerMax = fleet ? getMaxCount("explorer", fleet.bots.length) ?? 1 : 1;
        const explorerCount = fleet?.bots.filter((b) => b.routine === "explorer").length ?? 0;
        if (explorerCount >= explorerMax) return 200; // Block additional explorers
        // Guaranteed slot: no explorer assigned in 2+ bot fleet → strong bonus
        // Score = 25 base + 55 bonus = 80, beats diversity-penalized duplicate miners
        return (fleet && fleet.bots.length >= 2) ? -55 : 0;
      }
      case "salvager":
        // Salvager is speculative (wrecks are random) — mild idle penalty
        return 10;
      case "return_home": {
        if (!bot) return 200;
        // No home configured → block entirely
        if (!this.homeBase && !this.homeSystem) return 200;

        // CREDIT EMERGENCY: bot is critically low on credits and needs to return
        // to faction base to withdraw from treasury. Override all other checks.
        if (this.minBotCredits > 0 && bot.credits < this.minBotCredits * 0.5) {
          // Already at home (docked) → handle at dock, don't force return
          if (this.homeBase && bot.docked && bot.systemId === this.homeSystem) return 200;
          // Away from home with critically low credits → MUST return
          return -150; // Very strong bonus — override nearly everything
        }

        // Already at home base (docked) → block
        if (this.homeBase && bot.docked && bot.systemId === this.homeSystem) return 200;
        // Already in home system → mild penalty (might still need to dock)
        if (this.homeSystem && bot.systemId === this.homeSystem) return 60;
        // Bot is idle (no routine) and away from home → big BONUS (negative penalty)
        if (!bot.routine) return -80;
        // Bot is on a field routine → block (let them stay in the field)
        if (FIELD_ROUTINES.has(bot.routine)) return 200;
        // Bot on a home-based routine → small bonus if away from home
        return -20;
      }
      case "scout": {
        if (!bot) return 200;
        // Scout is one-shot data gathering. Score high when we need data, block otherwise.
        // Hard cap: only 1 scout at a time
        const scoutCount = fleet?.bots.filter((b) => b.routine === "scout").length ?? 0;
        if (scoutCount >= 1) return 200;
        // If faction storage is already known, no need to scout
        if (this.homeBase && this.homeSystem) {
          // Check if home system has station data (i.e., we've visited it)
          // If homeBase is set, discovery already happened
          return 200;
        }
        // homeSystem set but no homeBase — we need station data!
        if (this.homeSystem && !this.homeBase) return -200; // Massive bonus → highest priority
        // No home configured at all — block
        return 200;
      }
      case "quartermaster": {
        if (!bot) return 200;
        // Only assign when faction home is configured
        if (!this.homeBase) return 200;
        // Hard cap: only 1 quartermaster
        const qmCount = fleet?.bots.filter((b) => b.routine === "quartermaster").length ?? 0;
        if (qmCount >= 1 && bot.routine !== "quartermaster") return 200;
        // Need at least 3 bots to justify a dedicated quartermaster
        if (fleet && fleet.bots.length < 3) return 200;
        // Bonus when faction storage has sellable goods
        const hasSellableGoods = [...economy.factionStorage.entries()]
          .some(([id, qty]) => qty > 0 && !id.startsWith("ore_"));
        // Bonus: +30 if there are goods to sell, +10 base for fleet management
        return hasSellableGoods ? -30 : -10;
      }
      case "ship_upgrade": {
        if (!bot) return 200;
        const pending = this.pendingUpgrades.get(bot.botId);
        if (!pending) return 200; // No upgrade queued → block entirely
        // Hard cap: only 1 ship_upgrade at a time
        const upgradeCount = fleet?.bots.filter((b) => b.routine === "ship_upgrade").length ?? 0;
        if (upgradeCount >= 1 && bot.routine !== "ship_upgrade") return 200;
        // Base 70 when upgrade is queued — high enough to interrupt most activities
        let bonus = -70;
        // ROI bonus: better deals score higher (cap -20)
        bonus -= Math.min(20, pending.roi * 10);
        return bonus;
      }
      default:
        return 0;
    }
  }

  /**
   * Data staleness penalty: penalize routines that depend on fresh market data
   * when a high proportion of stations have stale/expired data.
   * Boosts routines that refresh data (docking triggers auto-scan).
   */
  private calcStalenessPenalty(routine: RoutineName, world?: WorldContext): number {
    if (!world || !world.hasAnyMarketData) return 0;

    // dataFreshnessRatio: 1.0 = all fresh, 0.0 = all stale
    const staleness = 1 - world.dataFreshnessRatio;
    if (staleness < 0.3) return 0; // Mostly fresh, no penalty

    switch (routine) {
      case "trader":
        // Traders depend heavily on accurate prices — stale data = bad trades
        return Math.round(staleness * 40);
      case "crafter":
        // Crafters need material price info for profitability
        return Math.round(staleness * 15);
      case "mission_runner":
        // Bonus: mission runners dock frequently, refreshing data
        return -Math.round(staleness * 10);
      case "explorer":
        // Bonus: explorers visit new systems and dock, refreshing data
        return -Math.round(staleness * 8);
      default:
        return 0;
    }
  }

  /** Build routine params based on fleet state and economy */
  private buildParams(
    routine: RoutineName,
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    goals: Goal[],
    existingAssignments: Assignment[],
    world?: WorldContext,
  ): Record<string, unknown> {
    const homeBase = this.homeBase;
    const isFactionMode = this.defaultStorageMode === "faction_deposit";
    const hasFactionMaterials = economy.factionStorage.size > 0;

    // Base params - routines use these to guide behavior
    switch (routine) {
      case "miner":
        return this.buildMinerParams(bot, economy, existingAssignments, world);
      case "harvester":
        return this.buildHarvesterParams(bot, economy, existingAssignments, world);
      case "trader":
        return this.buildTraderParams(bot, economy, existingAssignments, world);
      case "explorer":
        return this.buildExplorerParams(bot, economy, existingAssignments);
      case "crafter":
        return this.buildCrafterParams(bot, economy, existingAssignments);
      case "hunter":
        return { huntZone: "", fleeThreshold: 25, engagementRules: "npcs_only" };
      case "salvager":
        return { salvageYard: homeBase || "", scrapMethod: "scrap" };
      case "mission_runner":
        return { autoAccept: true, missionTypes: [], minReward: 100 };
      case "return_home":
        return { homeBase: this.homeBase, homeSystem: this.homeSystem };
      case "scout":
        return { targetSystem: this.homeSystem, scanMarket: true, checkFaction: true };
      case "quartermaster":
        return { homeBase: this.homeBase };
      case "ship_upgrade":
        return this.buildShipUpgradeParams(bot);
      default:
        return {};
    }
  }

  /** Build ship_upgrade params from the pending upgrades queue */
  private buildShipUpgradeParams(bot: FleetBotInfo): Record<string, unknown> {
    const pending = this.pendingUpgrades.get(bot.botId);
    if (!pending) return { targetShipClass: "", maxSpend: 0, sellOldShip: true };
    const reserve = Math.max(5000, this.minBotCredits);
    return {
      targetShipClass: pending.targetShipClass,
      maxSpend: Math.max(0, bot.credits - reserve),
      sellOldShip: true,
    };
  }

  /**
   * Build trader params with order deconfliction.
   * Assigns each trader a different trade route so they don't compete for the same orders.
   */
  private buildTraderParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
    world?: WorldContext,
  ): Record<string, unknown> {
    // Check if faction storage has crafted goods to sell
    // (Supply chain: miners deposit ore → crafters make goods → traders sell goods)
    const hasFactionSeller = existingAssignments.some(
      (a) => a.routine === "trader" && a.params.sellFromFaction,
    );
    if (!hasFactionSeller && economy.factionStorage.size > 0) {
      // Check for non-ore items in faction storage
      const sellableItems = [...economy.factionStorage.entries()]
        .filter(([itemId, qty]) => !itemId.startsWith("ore_") && qty > 0);
      if (sellableItems.length > 0) {
        return { sellFromFaction: true };
      }
    }

    // Standard arbitrage trading
    if (!world || world.tradeRoutes.length === 0) {
      return { buyStation: "", sellStation: "", item: "", useOrders: false };
    }

    // Collect items+routes already assigned to other traders this cycle
    const claimedRoutes = new Set<string>();
    const claimedItems = new Set<string>();
    for (const a of existingAssignments) {
      if (a.routine === "trader" && a.params.item) {
        claimedRoutes.add(`${a.params.item}|${a.params.buyStation}|${a.params.sellStation}`);
        claimedItems.add(String(a.params.item));
      }
    }

    // Find the best unclaimed trade route (skip ores — miners handle those)
    for (const route of world.tradeRoutes) {
      if (route.itemId.startsWith("ore_")) continue;
      const routeKey = `${route.itemId}|${route.buyStationId}|${route.sellStationId}`;
      if (claimedRoutes.has(routeKey)) continue;
      if (claimedItems.has(route.itemId)) continue;

      return {
        buyStation: route.buyStationId,
        sellStation: route.sellStationId,
        item: route.itemId,
        useOrders: false,
      };
    }

    // All routes claimed — fall back to empty params (trader will auto-discover)
    return { buyStation: "", sellStation: "", item: "", useOrders: false };
  }

  /** Fleet home base ID (set by Commander) */
  homeBase = "";
  /** Fleet home system ID (set by Commander) */
  homeSystem = "";
  /** Default storage mode (set by Commander) */
  defaultStorageMode: "sell" | "deposit" | "faction_deposit" = "sell";
  /** Minimum credits a bot should maintain (set by Commander from FleetConfig) */
  minBotCredits = 0;
  /** Crafting service (set by Commander for recipe-aware crafter params) */
  crafting: import("../core/crafting").Crafting | null = null;
  /** Galaxy service (set by Commander for belt-aware miner params) */
  galaxy: import("../core/galaxy").Galaxy | null = null;
  /** Pending ship upgrades queued by Commander (botId → upgrade info) */
  pendingUpgrades = new Map<string, PendingUpgrade>();
  /** Ship catalog (set by Commander for ship fitness scoring) */
  shipCatalog: ShipClass[] = [];

  /**
   * Build crafter params with intelligent recipe selection:
   * 1. Items with market demand (high sell price / confirmed demand)
   * 2. Items that use available faction storage materials
   * 3. Items that give XP for skill progression
   * Deconflicts: multiple crafters pick different recipes
   */
  private buildCrafterParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
  ): Record<string, unknown> {
    const homeBase = this.homeBase;
    const crafting = this.crafting;

    // Base params — crafter sources from faction storage, deposits output back to faction
    // Traders handle selling from faction storage (supply chain separation)
    const baseParams = {
      recipeId: "",
      count: 1,
      materialSource: "storage",  // Pull from faction storage
      sellOutput: false,          // Deposit to faction — traders sell
      craftStation: homeBase,
    };

    if (!crafting || crafting.recipeCount === 0) return baseParams;

    // Collect recipes already assigned to other crafters this cycle
    const claimedRecipes = new Set<string>();
    const claimedOutputs = new Set<string>();
    for (const a of existingAssignments) {
      if (a.routine === "crafter" && a.params.recipeId) {
        claimedRecipes.add(String(a.params.recipeId));
        const recipe = crafting.getRecipe(String(a.params.recipeId));
        if (recipe) claimedOutputs.add(recipe.outputItem);
      }
    }

    // Get available recipes for this bot's skills
    const available = crafting.getAvailableRecipes(bot.skills ?? {});
    if (available.length === 0) return baseParams;

    // Score each recipe
    const scored: Array<{ recipe: typeof available[0]; score: number; reason: string }> = [];
    for (const recipe of available) {
      if (claimedRecipes.has(recipe.id)) continue;
      if (claimedOutputs.has(recipe.outputItem)) continue; // Don't flood same item

      let score = 0;
      let reason = "";

      // Factor 1: Estimated profit (base catalog prices)
      const profit = crafting.estimateProfit(recipe.id);
      if (profit > 0) {
        score += Math.min(profit / 10, 50); // Cap at 50 points
        reason = `profit:${profit}cr`;
      }

      // Factor 2: Can we actually craft this with faction storage materials?
      const rawMaterials = crafting.getRawMaterials(recipe.id, 1);
      let hasMaterials = true;
      let materialScore = 0;
      for (const [itemId, needed] of rawMaterials) {
        const inStorage = economy.factionStorage.get(itemId) ?? 0;
        if (inStorage >= needed) {
          materialScore += 10; // Bonus per ingredient available
        } else {
          hasMaterials = false;
        }
      }
      if (hasMaterials && rawMaterials.size > 0) {
        score += 30; // Big bonus if we can craft right now
        reason += " +materials_ready";
      } else if (rawMaterials.size > 0) {
        score -= 100; // Heavy penalty — this recipe will fail immediately
        reason += " -no_materials";
      }
      score += materialScore;

      // Factor 3: Output is an ingredient for ANY recipes (fleet-wide supply chain value)
      // Check ALL recipes, not just this bot's available ones
      const allRecipes = crafting.getAllRecipes();
      const recipesUsingOutput = allRecipes.filter((r) =>
        r.ingredients.some((i) => i.itemId === recipe.outputItem)
      );
      if (recipesUsingOutput.length > 0) {
        score += 15; // Intermediate product that feeds the chain
        reason += " +chain_value";
        // Extra bonus if the output is actually MISSING from faction storage
        // (demand-pull: someone needs this but we have none)
        const outputStock = economy.factionStorage.get(recipe.outputItem) ?? 0;
        if (outputStock === 0) {
          score += 40; // Strong bonus — this intermediate is blocking other crafters
          reason += " +demand_deficit";
        } else if (outputStock < 10) {
          score += 20; // Moderate bonus — low stock of needed intermediate
          reason += " +demand_low";
        }
      }

      // Factor 4: XP rewards for skill progression
      const xpEntries = Object.entries(recipe.xpRewards);
      if (xpEntries.length > 0) {
        // Bonus for skills that are low (more room to grow)
        for (const [skillId, xp] of xpEntries) {
          const currentLevel = bot.skills?.[skillId] ?? 0;
          if (currentLevel < 5) {
            score += xp * (5 - currentLevel); // More bonus for lower skills
            reason += ` +xp:${skillId}`;
          }
        }
      }

      // Factor 5: Market demand signal — items with confirmed sell prices
      // Higher base price = likely more valuable crafted goods
      const outputPrice = crafting.getItemBasePrice(recipe.outputItem);
      if (outputPrice > 0) {
        score += Math.min(outputPrice / 20, 30); // Higher value items score better
      }

      // Factor 6: Inventory saturation penalty — deprioritize items we already have lots of
      // Prevents spamming 10k of a single item, encourages diversity
      const outputInStorage = economy.factionStorage.get(recipe.outputItem) ?? 0;
      if (outputInStorage > 0) {
        // Logarithmic penalty: 5 items = -8, 20 items = -15, 100 items = -23, 500 items = -31
        const saturationPenalty = Math.round(Math.log2(outputInStorage + 1) * 5);
        score -= saturationPenalty;
        reason += ` -inventory:${outputInStorage}`;
      }

      scored.push({ recipe, score, reason });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      return {
        ...baseParams,
        recipeId: best.recipe.id,
      };
    }

    return baseParams;
  }

  /**
   * Build explorer params — equip survey scanner if available in faction storage.
   */
  private buildExplorerParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
  ): Record<string, unknown> {
    const explorerIndex = existingAssignments.filter(a => a.routine === "explorer").length;
    const equipModules: string[] = [];

    // Equip survey scanner if bot doesn't have one and faction storage has one
    const hasSurvey = bot.moduleIds.some((id) => id.includes("survey"));
    if (!hasSurvey) {
      // Check faction storage for a survey scanner
      const surveyInStorage = [...economy.factionStorage.entries()]
        .some(([itemId, qty]) => itemId.includes("survey") && qty > 0);
      if (surveyInStorage) {
        equipModules.push("survey");
      }
    }

    return { targetSystems: [], submitIntel: true, explorerIndex, equipModules };
  }

  /**
   * Build miner params with intelligent belt selection:
   * 1. Check what ores are most needed (faction storage deficits)
   * 2. Find belts with those resources (non-depleted)
   * 3. Pick closest non-claimed belt for this miner
   * 4. Specify equipment modules to install if available in faction storage
   */
  private buildMinerParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
    world?: WorldContext,
  ): Record<string, unknown> {
    const homeBase = this.homeBase;
    const baseParams = {
      targetBelt: "",
      sellStation: homeBase,
      depositToStorage: true,
      equipModules: [] as string[],
      unequipModules: [] as string[],
    };

    if (!this.galaxy) return baseParams;

    // Determine what resource type is most needed
    // Map: POI type → ore prefixes found there
    const POI_ORE_MAP: Record<string, string[]> = {
      asteroid_belt: ["ore_iron", "ore_copper", "ore_titanium", "ore_gold", "ore_nickel", "ore_sol"],
      asteroid: ["ore_iron", "ore_copper", "ore_titanium", "ore_gold", "ore_nickel", "ore_sol"],
      ice_field: ["ore_ice"],
      gas_cloud: ["ore_crystal", "ore_gas"],
      nebula: ["ore_crystal", "ore_gas"],
    };

    // Equipment needed per POI type
    const POI_EQUIP: Record<string, string> = {
      ice_field: "ice_harvester",
      gas_cloud: "gas_harvester",
      nebula: "gas_harvester",
    };

    // Rank resource types by need (lowest faction storage = most needed)
    const oreStock: Array<{ poiType: string; stock: number }> = [];
    for (const [poiType, orePatterns] of Object.entries(POI_ORE_MAP)) {
      const stock = orePatterns.reduce((sum, prefix) => {
        let total = 0;
        for (const [itemId, qty] of economy.factionStorage) {
          if (itemId.startsWith(prefix)) total += qty;
        }
        return sum + total;
      }, 0);
      oreStock.push({ poiType, stock });
    }
    // Deduplicate asteroid/asteroid_belt (same thing)
    const uniqueStock = oreStock.filter((o, i, arr) =>
      i === arr.findIndex((x) => {
        const norm = (t: string) => t === "asteroid" ? "asteroid_belt" : t === "nebula" ? "gas_cloud" : t;
        return norm(x.poiType) === norm(o.poiType);
      })
    );
    uniqueStock.sort((a, b) => a.stock - b.stock); // Lowest stock first

    // Collect belts already claimed by other miners this eval
    const claimedBelts = new Set<string>();
    for (const a of existingAssignments) {
      if (a.routine === "miner" && a.params.targetBelt) {
        claimedBelts.add(String(a.params.targetBelt));
      }
    }

    // Find best belt: iterate through needed resource types, find unclaimed non-depleted POIs
    const botSystem = bot.systemId ?? this.homeSystem;
    const hasResourcesLeft = (poi: { resources: Array<{ remaining: number }> }) =>
      poi.resources.length === 0 || poi.resources.some((r) => r.remaining > 0);

    for (const { poiType } of uniqueStock) {
      // Find all POIs of this type
      const normalizedTypes = poiType === "asteroid_belt"
        ? ["asteroid_belt", "asteroid"] : poiType === "gas_cloud"
        ? ["gas_cloud", "nebula"] : [poiType];

      const candidates: Array<{ systemId: string; poiId: string; distance: number }> = [];
      for (const type of normalizedTypes) {
        const pois = this.galaxy.findPoisByType(type as import("../types/game").PoiType);
        for (const { systemId, poi } of pois) {
          if (claimedBelts.has(poi.id)) continue;
          if (!hasResourcesLeft(poi)) continue;
          // Calculate distance from bot's current system
          const distance = botSystem ? (systemId === botSystem ? 0 : 1) : 99;
          candidates.push({ systemId, poiId: poi.id, distance });
        }
      }

      if (candidates.length === 0) continue;

      // Pick closest
      candidates.sort((a, b) => a.distance - b.distance);
      const best = candidates[0];

      // Check if bot needs special equipment for this POI type
      const neededModule = POI_EQUIP[poiType];
      const hasModule = neededModule
        ? bot.moduleIds.some((id) => id.includes(neededModule))
        : true;
      const moduleInStorage = neededModule
        ? (economy.factionStorage.get(neededModule) ?? 0) > 0
        : false;

      // Skip ice/gas if bot lacks module AND none in faction storage
      if (neededModule && !hasModule && !moduleInStorage) continue;

      // Build equip/unequip lists
      const equipModules: string[] = [];
      const unequipModules: string[] = [];
      if (neededModule && !hasModule && moduleInStorage) {
        equipModules.push(neededModule);
      }
      // If going to asteroid belt but has ice/gas harvester, suggest unequip to free slot
      if (!neededModule) {
        for (const modId of bot.moduleIds) {
          if (modId.includes("ice_harvester") || modId.includes("gas_harvester")) {
            unequipModules.push(modId);
          }
        }
      }

      return {
        ...baseParams,
        targetBelt: best.poiId,
        equipModules,
        unequipModules,
      };
    }

    return baseParams;
  }

  /**
   * Build harvester params — focuses on ice/gas POIs (specialized extraction).
   * Harvester adds value over miner by targeting ice_field and gas_cloud with
   * specialized modules. Falls back to asteroid belts if no ice/gas available.
   */
  private buildHarvesterParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
    world?: WorldContext,
  ): Record<string, unknown> {
    const homeBase = this.homeBase;
    const baseParams = {
      targets: [] as Array<{ poiId: string; priority: number }>,
      depositStation: homeBase,
      resourceType: "ore",
      depositToStorage: true,
      equipModules: [] as string[],
      unequipModules: [] as string[],
    };

    if (!this.galaxy) return baseParams;

    const POI_ORE_MAP: Record<string, string[]> = {
      ice_field: ["ore_ice"],
      gas_cloud: ["ore_crystal", "ore_gas"],
      nebula: ["ore_crystal", "ore_gas"],
      asteroid_belt: ["ore_iron", "ore_copper", "ore_titanium", "ore_gold", "ore_nickel", "ore_sol"],
      asteroid: ["ore_iron", "ore_copper", "ore_titanium", "ore_gold", "ore_nickel", "ore_sol"],
    };

    const POI_EQUIP: Record<string, string> = {
      ice_field: "ice_harvester",
      gas_cloud: "gas_harvester",
      nebula: "gas_harvester",
    };

    const RESOURCE_TYPE_MAP: Record<string, string> = {
      ice_field: "ice",
      gas_cloud: "gas",
      nebula: "gas",
      asteroid_belt: "ore",
      asteroid: "ore",
    };

    // Rank by lowest faction stock — but prioritize ice/gas over asteroid belts
    // (harvesters add unique value for specialized extraction)
    const oreStock: Array<{ poiType: string; stock: number; specialized: boolean }> = [];
    for (const [poiType, orePatterns] of Object.entries(POI_ORE_MAP)) {
      const stock = orePatterns.reduce((sum, prefix) => {
        let total = 0;
        for (const [itemId, qty] of economy.factionStorage) {
          if (itemId.startsWith(prefix)) total += qty;
        }
        return sum + total;
      }, 0);
      oreStock.push({ poiType, stock, specialized: poiType in POI_EQUIP });
    }
    // Deduplicate asteroid/asteroid_belt and gas_cloud/nebula
    const uniqueStock = oreStock.filter((o, i, arr) =>
      i === arr.findIndex((x) => {
        const norm = (t: string) => t === "asteroid" ? "asteroid_belt" : t === "nebula" ? "gas_cloud" : t;
        return norm(x.poiType) === norm(o.poiType);
      })
    );
    // Sort: specialized (ice/gas) first by stock, then asteroid belts by stock
    uniqueStock.sort((a, b) => {
      if (a.specialized !== b.specialized) return a.specialized ? -1 : 1;
      return a.stock - b.stock;
    });

    // Collect POIs already claimed by miners or harvesters
    const claimedPois = new Set<string>();
    for (const a of existingAssignments) {
      if (a.routine === "miner" && a.params.targetBelt) {
        claimedPois.add(String(a.params.targetBelt));
      }
      if (a.routine === "harvester" && Array.isArray(a.params.targets)) {
        for (const t of a.params.targets as Array<{ poiId: string }>) {
          claimedPois.add(t.poiId);
        }
      }
    }

    const botSystem = bot.systemId ?? this.homeSystem;
    const hasResourcesLeft = (poi: { resources: Array<{ remaining: number }> }) =>
      poi.resources.length === 0 || poi.resources.some((r) => r.remaining > 0);

    // Find the best POI type to harvest
    for (const { poiType } of uniqueStock) {
      const normalizedTypes = poiType === "asteroid_belt"
        ? ["asteroid_belt", "asteroid"] : poiType === "gas_cloud"
        ? ["gas_cloud", "nebula"] : [poiType];

      const candidates: Array<{ systemId: string; poiId: string; distance: number }> = [];
      for (const type of normalizedTypes) {
        const pois = this.galaxy.findPoisByType(type as import("../types/game").PoiType);
        for (const { systemId, poi } of pois) {
          if (claimedPois.has(poi.id)) continue;
          if (!hasResourcesLeft(poi)) continue;
          const distance = botSystem ? (systemId === botSystem ? 0 : 1) : 99;
          candidates.push({ systemId, poiId: poi.id, distance });
        }
      }

      if (candidates.length === 0) continue;

      // Check equipment availability
      const neededModule = POI_EQUIP[poiType];
      const hasModule = neededModule
        ? bot.moduleIds.some((id) => id.includes(neededModule))
        : true;
      const moduleInStorage = neededModule
        ? (economy.factionStorage.get(neededModule) ?? 0) > 0
        : false;

      if (neededModule && !hasModule && !moduleInStorage) continue;

      // Build equip/unequip lists
      const equipModules: string[] = [];
      const unequipModules: string[] = [];
      if (neededModule && !hasModule && moduleInStorage) {
        equipModules.push(neededModule);
      }
      // Unequip wrong harvester type if switching (e.g. ice→gas or gas→asteroid)
      if (!neededModule) {
        for (const modId of bot.moduleIds) {
          if (modId.includes("ice_harvester") || modId.includes("gas_harvester")) {
            unequipModules.push(modId);
          }
        }
      } else {
        // Unequip the OTHER harvester type if present
        const otherHarvester = neededModule === "ice_harvester" ? "gas_harvester" : "ice_harvester";
        for (const modId of bot.moduleIds) {
          if (modId.includes(otherHarvester)) {
            unequipModules.push(modId);
          }
        }
      }

      // Sort by distance, build targets array (harvester can visit multiple POIs)
      candidates.sort((a, b) => a.distance - b.distance);
      const targets = candidates.slice(0, 3).map((c, i) => ({
        poiId: c.poiId,
        priority: 3 - i,
      }));

      return {
        ...baseParams,
        targets,
        resourceType: RESOURCE_TYPE_MAP[poiType] ?? "ore",
        equipModules,
        unequipModules,
      };
    }

    return baseParams;
  }

  private buildReasoning(
    assignments: Assignment[],
    candidates: FleetBotInfo[],
    economy: EconomySnapshot,
    goals: Goal[]
  ): string {
    const parts: string[] = [];

    // Goals summary
    if (goals.length > 0) {
      parts.push(`Goals: ${goals.map((g) => `${g.type}(p${g.priority})`).join(", ")}`);
    } else {
      parts.push("No active goals, using balanced strategy.");
    }

    // Economy summary
    if (economy.deficits.length > 0) {
      const criticalCount = economy.deficits.filter((d) => d.priority === "critical").length;
      parts.push(`Deficits: ${economy.deficits.length} (${criticalCount} critical)`);
    }
    if (economy.inventoryAlerts.length > 0) {
      parts.push(`Inventory alerts: ${economy.inventoryAlerts.length}`);
    }

    // Assignment summary
    if (assignments.length > 0) {
      parts.push(`Reassigning ${assignments.length} bot(s):`);
      for (const a of assignments) {
        const prev = a.previousRoutine ? ` (was: ${a.previousRoutine})` : "";
        parts.push(`  ${a.botId} → ${a.routine} (score: ${a.score.toFixed(0)})${prev}`);
      }
    } else {
      parts.push("No reassignments needed.");
    }

    return parts.join(" | ");
  }
}
