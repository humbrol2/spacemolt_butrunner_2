/**
 * Commander types - interfaces for the scoring brain, economy engine,
 * fleet evaluation, and assignment decisions.
 */

import type { Goal, GoalType, StockTarget } from "../types/config";
import type { RoutineName } from "../types/protocol";
import type { FleetStatus, FleetBotInfo } from "../bot/types";
import type { TradeRoute } from "../core/market";

// ── Commander Brain Interface ──

/**
 * Drop-in brain interface. v2.0 = ScoringBrain, v3.0+ = LLM/trained model.
 */
export interface CommanderBrain {
  evaluate(input: EvaluationInput): EvaluationOutput;
  clearCooldown(botId: string): void;
}

/** Real-world data context assembled by Commander from Galaxy/Cache/Market */
export interface WorldContext {
  /** Per-system POI availability (keyed by systemId) */
  systemPois: Map<string, {
    hasBelts: boolean;
    hasIceFields: boolean;
    hasGasClouds: boolean;
    hasStation: boolean;
    stationIds: string[];
    poiTypes: string[];
  }>;
  /** Station IDs with fresh (non-expired) market data */
  freshStationIds: string[];
  /** Station IDs near bots that need market data refresh */
  staleStationIds: string[];
  /** Whether any market data has ever been collected */
  hasAnyMarketData: boolean;
  /** Number of profitable trade routes found in fresh data */
  tradeRouteCount: number;
  /** Best trade route profitPerTick (0 if none) */
  bestTradeProfit: number;
  /** Whether galaxy topology is loaded */
  galaxyLoaded: boolean;
  /** Ranked trade routes from fresh market data (for trader assignment deconfliction) */
  tradeRoutes: TradeRoute[];
  /** Ratio of fresh vs total known stations (0-1). Lower = more stale data. */
  dataFreshnessRatio: number;
}

export interface EvaluationInput {
  fleet: FleetStatus;
  goals: Goal[];
  economy: EconomySnapshot;
  world: WorldContext;
  tick: number;
}

export interface EvaluationOutput {
  assignments: Assignment[];
  reasoning: string;
}

// ── Assignments ──

export interface Assignment {
  botId: string;
  routine: RoutineName;
  params: Record<string, unknown>;
  score: number;
  reasoning: string;
  previousRoutine: RoutineName | null;
}

// ── Economy ──

export interface MaterialDemand {
  itemId: string;
  quantityPerHour: number;
  source: string;
  priority: "critical" | "normal" | "low";
}

export interface MaterialSupply {
  itemId: string;
  quantityPerHour: number;
  source: string;
}

export interface SupplyDeficit {
  itemId: string;
  demandPerHour: number;
  supplyPerHour: number;
  shortfall: number;
  priority: "critical" | "normal" | "low";
}

export interface SupplySurplus {
  itemId: string;
  excessPerHour: number;
  stationId: string;
  currentStock: number;
}

export interface InventoryAlert {
  stationId: string;
  itemId: string;
  current: number;
  target: StockTarget;
  type: "below_min" | "above_max";
}

export interface EconomySnapshot {
  deficits: SupplyDeficit[];
  surpluses: SupplySurplus[];
  inventoryAlerts: InventoryAlert[];
  totalRevenue: number;
  totalCosts: number;
  netProfit: number;
  /** Faction storage inventory (itemId → quantity) */
  factionStorage: Map<string, number>;
}

// ── Scoring ──

export interface BotScore {
  botId: string;
  routine: RoutineName;
  baseScore: number;
  supplyBonus: number;
  skillBonus: number;
  infoBonus: number;
  factionBonus: number;
  riskPenalty: number;
  switchCost: number;
  diversityPenalty: number;
  rapidPenalty: number;
  equipmentPenalty: number;
  worldPenalty: number;
  idlePenalty: number;
  stalenessPenalty: number;
  finalScore: number;
  reasoning: string;
}

/** Goal-type weight profiles for routine scoring */
export interface StrategyWeights {
  miner: number;
  harvester: number;
  trader: number;
  explorer: number;
  crafter: number;
  hunter: number;
  salvager: number;
  mission_runner: number;
  return_home: number;
  scout: number;
}

// ── Reassignment Tracking ──

export interface ReassignmentState {
  lastAssignment: number;   // timestamp ms
  lastRoutine: RoutineName | null;
  cooldownUntil: number;    // timestamp ms
}
