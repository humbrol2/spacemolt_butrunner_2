/**
 * Typed WebSocket protocol between dashboard and backend server.
 */

import type { Goal, StockTarget } from "./config";

// ── Routine Types ──

export type RoutineName =
  | "miner"
  | "harvester"
  | "trader"
  | "explorer"
  | "crafter"
  | "hunter"
  | "salvager"
  | "mission_runner"
  | "return_home"
  | "scout"
  | "quartermaster"
  | "scavenger"
  | "ship_upgrade";

export const ROUTINE_COLORS: Record<RoutineName, string> = {
  miner: "#ff6b35",
  harvester: "#ff6b35",
  trader: "#2dd4bf",
  explorer: "#00d4ff",
  crafter: "#9b59b6",
  hunter: "#e63946",
  salvager: "#ffd93d",
  mission_runner: "#ffd700",
  return_home: "#8899aa",
  scout: "#66ccff",
  quartermaster: "#c9a84c",
  scavenger: "#c0a060",
  ship_upgrade: "#4ecdc4",
};

export type BotStatus = "idle" | "logging_in" | "ready" | "running" | "stopping" | "error";

// ── Bot Summary (sent to dashboard) ──

export interface BotSummary {
  id: string;
  username: string;
  empire: string;
  status: BotStatus;
  routine: RoutineName | null;
  routineState: string; // yielded state label
  systemId: string | null;
  systemName: string | null;
  poiId: string | null;
  poiName: string | null;
  credits: number;
  creditsPerHour: number;
  fuel: number;
  maxFuel: number;
  fuelPct: number;
  cargoUsed: number;
  cargoCapacity: number;
  cargoPct: number;
  hullPct: number;
  shieldPct: number;
  shipClass: string | null;
  shipName: string | null;
  shipStats: {
    hull: number; maxHull: number;
    shield: number; maxShield: number;
    armor: number; speed: number;
    cpuUsed: number; cpuCapacity: number;
    powerUsed: number; powerCapacity: number;
  } | null;
  docked: boolean;
  destination: string | null; // Human-readable destination from routine params
  jumpsRemaining: number | null; // Jumps to reach destination system
  error: string | null;
  uptime: number; // ms since login
  cargo: Array<{ itemId: string; quantity: number }>;
  modules: Array<{ id: string; moduleId: string; name: string }>;
  ownedShips: Array<{ id: string; classId: string; name: string | null }>;
  skills: Record<string, { level: number; xp: number; xpNext: number }>;
  settings: {
    fuelEmergencyThreshold: number;
    autoRepair: boolean;
    maxCargoFillPct: number;
    storageMode: "sell" | "deposit" | "faction_deposit";
    factionStorage: boolean;
  };
}

// ── Fleet Stats ──

export interface FleetStats {
  totalCredits: number;
  creditsPerHour: number;
  activeBots: number;
  totalBots: number;
  uptime: number;
  apiCallsToday: { mutations: number; queries: number };
}

// ── Economy State ──

export interface MaterialDeficit {
  itemId: string;
  itemName: string;
  demandPerHour: number;
  supplyPerHour: number;
  shortfall: number;
  priority: "critical" | "normal" | "low";
}

export interface MaterialSurplus {
  itemId: string;
  itemName: string;
  excessPerHour: number;
  stationId: string;
  stationName: string;
  currentStock: number;
}

export interface OpenOrder {
  id: string;
  type: "buy" | "sell";
  itemId: string;
  itemName: string;
  quantity: number;
  filled: number;
  priceEach: number;
  stationId: string;
  stationName: string;
  createdAt: string;
  botId: string;
}

export interface EconomyState {
  deficits: MaterialDeficit[];
  surpluses: MaterialSurplus[];
  openOrders: OpenOrder[];
  totalRevenue24h: number;
  totalCosts24h: number;
  netProfit24h: number;
}

// ── Market Data (for Market page) ──

export interface MarketStationData {
  stationId: string;
  stationName: string;
  prices: Array<{
    itemId: string;
    itemName: string;
    buyPrice: number;
    sellPrice: number;
    buyVolume: number;
    sellVolume: number;
  }>;
  fetchedAt: number;
}

// ── Commander Decisions ──

export interface FleetAssignment {
  botId: string;
  routine: RoutineName;
  params: Record<string, unknown>;
  reasoning: string;
  score: number;
  previousRoutine: RoutineName | null;
}

export interface CommanderDecision {
  tick: number;
  goal: string;
  assignments: FleetAssignment[];
  reasoning: string;
  thoughts: string[];
  timestamp: string;
}

// ── Log Entry ──

export type LogLevel = "info" | "warn" | "error" | "cmd";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  botId: string | null;
  message: string;
  details?: Record<string, unknown>;
}

// ── Skill Milestone ──

export interface SkillMilestone {
  botId: string;
  skill: string;
  level: number;
  unlocks: string[];
}

// ── Training Stats ──

export interface TrainingStats {
  decisions: {
    count: number;
    byAction: Record<string, number>;
    byBot: Record<string, number>;
  };
  snapshots: { count: number };
  episodes: {
    count: number;
    byType: Record<string, number>;
    successRate: number;
    avgDurationTicks: number;
    totalProfit: number;
  };
  marketHistory: {
    count: number;
    stationsTracked: number;
    itemsTracked: number;
  };
  commanderLog: {
    count: number;
    goalDistribution: Record<string, number>;
  };
  database: {
    sizeBytes: number;
    sizeMB: number;
  };
}

// ── Faction State (sent to dashboard) ──

export interface FactionMember {
  playerId: string;
  username: string;
  role: string;
  online: boolean;
  lastSeen: string | null;
}

export interface FactionFacility {
  id: string;
  name: string;
  type: string;
  systemId: string;
  systemName: string;
  status: string;
}

export interface FactionState {
  id: string | null;
  name: string | null;
  tag: string | null;
  credits: number;
  memberCount: number;
  members: FactionMember[];
  storage: Array<{ itemId: string; itemName: string; quantity: number }>;
  facilities: FactionFacility[];
  allies: Array<{ factionId: string; name: string }>;
  enemies: Array<{ factionId: string; name: string }>;
  /** Whether commander factors faction storage into scoring */
  commanderAware: boolean;
  /** Current fleet storage mode */
  storageMode: string;
}

// ── Bot Storage Data (fetched on demand) ──

export interface BotStorageStation {
  stationId: string;
  stationName: string;
  credits: number;
  items: Array<{ itemId: string; itemName: string; quantity: number }>;
}

export interface BotStorageData {
  stations: BotStorageStation[];
  totalItems: number;
  totalCredits: number;
}

// ── Server → Dashboard Messages ──

// ── Galaxy Data (sent to dashboard) ──

export interface GalaxySystemSummary {
  id: string;
  name: string;
  x: number;
  y: number;
  empire: string;
  policeLevel: number;
  connections: string[];
  poiCount: number;
  visited: boolean;
  pois: Array<{
    id: string;
    name: string;
    type: string;
    hasBase: boolean;
    baseName: string | null;
    resources: Array<{ resourceId: string; richness: number; remaining: number }>;
  }>;
}

export type ServerMessage =
  | { type: "fleet_update"; bots: BotSummary[] }
  | { type: "bot_update"; botId: string; data: Partial<BotSummary> }
  | { type: "commander_decision"; decision: CommanderDecision }
  | { type: "economy_update"; economy: EconomyState }
  | { type: "supply_chain_update"; deficits: MaterialDeficit[]; surpluses: MaterialSurplus[] }
  | { type: "order_update"; orders: OpenOrder[] }
  | { type: "market_update"; stations: MarketStationData[] }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "stats_update"; stats: FleetStats }
  | { type: "training_stats_update"; stats: TrainingStats }
  | { type: "skill_milestone"; milestone: SkillMilestone }
  | { type: "notification"; level: "critical" | "warning" | "info"; title: string; message: string }
  | { type: "galaxy_update"; systems: GalaxySystemSummary[] }
  | { type: "goals_update"; goals: Goal[] }
  | { type: "faction_update"; faction: FactionState }
  | { type: "connected"; version: string }
  | { type: "fleet_settings_update"; settings: { factionTaxPercent: number; minBotCredits: number } }
  | { type: "bot_storage"; botId: string; storage: BotStorageData };

// ── Dashboard → Server Messages ──

export type ClientMessage =
  | { type: "set_goal"; goal: Goal }
  | { type: "update_goal"; index: number; goal: Goal }
  | { type: "remove_goal"; index: number }
  | { type: "override_assignment"; botId: string; routine: RoutineName; params?: Record<string, unknown> }
  | { type: "release_override"; botId: string }
  | { type: "set_inventory_target"; target: StockTarget }
  | { type: "remove_inventory_target"; stationId: string; itemId: string }
  | { type: "start_bot"; botId: string }
  | { type: "stop_bot"; botId: string }
  | { type: "add_bot"; username: string; password: string }
  | { type: "remove_bot"; botId: string }
  | { type: "update_settings"; settings: Record<string, unknown> }
  | { type: "update_bot_settings"; botId: string; settings: Record<string, unknown> }
  | { type: "cancel_order"; orderId: string }
  | { type: "force_reassign"; botId: string; routine: RoutineName }
  | { type: "force_evaluation" }
  | { type: "refresh_cache"; cacheKey?: string }
  | { type: "request_bot_storage"; botId: string };
