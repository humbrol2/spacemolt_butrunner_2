/**
 * Bot engine types - BotContext, Routine, RoutineParams, FleetStatus.
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
import type { BotStatus, RoutineName } from "../types/protocol";

// ── Fleet-wide Config ──

export interface FleetConfig {
  /** Fleet home system ID (shared hub) */
  homeSystem: string;
  /** Fleet home base/station ID (shared storage) */
  homeBase: string;
  /** Default cargo disposal mode */
  defaultStorageMode: "sell" | "deposit" | "faction_deposit";
  /** Specific station for faction storage deposits (if different from homeBase) */
  factionStorageStation: string;
  /** Percent of profit to deposit into faction treasury (0-100) */
  factionTaxPercent: number;
  /** Minimum credits a bot should maintain — withdraws from faction if below (0 = disabled) */
  minBotCredits: number;
}

// ── Bot Settings ──

export interface BotSettings {
  /** Fuel level (%) below which bot returns to station */
  fuelEmergencyThreshold: number;
  /** Auto-repair when docked */
  autoRepair: boolean;
  /** Max cargo fill percentage before returning */
  maxCargoFillPct: number;
  /** What to do with gathered resources: "sell" | "deposit" | "faction_deposit" */
  storageMode: "sell" | "deposit" | "faction_deposit";
  /** Use faction storage instead of personal when depositing */
  factionStorage: boolean;
}

// ── Routine Types ──

/** Routine params set by Commander to guide routine behavior */
export type RoutineParams = Record<string, unknown>;

/** A routine is an async generator that yields state labels for the dashboard */
export type Routine = (ctx: BotContext) => AsyncGenerator<string, void, void>;

/** Registry of named routines */
export type RoutineRegistry = Partial<Record<RoutineName, Routine>>;

// ── Fleet Awareness ──

export interface FleetBotInfo {
  botId: string;
  username: string;
  status: BotStatus;
  routine: RoutineName | null;
  routineState: string;
  systemId: string | null;
  poiId: string | null;
  docked: boolean;
  credits: number;
  fuelPct: number;
  cargoPct: number;
  hullPct: number;
  /** Installed module IDs (e.g. ["ice_harvester", "weapon_laser_1"]) */
  moduleIds: string[];
  /** Ship class ID (e.g. "shuttle", "hauler") */
  shipClass: string | null;
  /** Ship cargo capacity in weight units */
  cargoCapacity: number;
  /** All ships this bot owns: [{id, classId}] — populated after login */
  ownedShips: Array<{ id: string; classId: string }>;
  /** Bot skill levels (e.g. { mining: 3, trading: 1 }) */
  skills: Record<string, number>;
  /** Routines that completed too quickly (< 60s), mapped to timestamp of failure */
  rapidRoutines: Map<RoutineName, number>;
}

export interface FleetStatus {
  bots: FleetBotInfo[];
  totalCredits: number;
  activeBots: number;
}

// ── BotContext ──

export interface BotContext {
  // Identity
  botId: string;
  username: string;
  session: SessionInfo;

  // Core services
  api: ApiClient;
  nav: Navigation;
  market: Market;
  cargo: Cargo;
  fuel: Fuel;
  combat: Combat;
  crafting: Crafting;
  station: Station;
  galaxy: Galaxy;

  // Data
  cache: GameCache;
  logger: TrainingLogger;

  // Fleet awareness (read-only view of other bots)
  getFleetStatus: () => FleetStatus;

  // Routine params (set by Commander)
  params: RoutineParams;

  // Bot settings (configured via dashboard)
  settings: BotSettings;

  // Fleet-wide config (shared across all bots)
  fleetConfig: FleetConfig;

  // State (updated after each API call)
  player: PlayerState;
  ship: ShipState;

  // Signal: set to true when bot should stop gracefully
  shouldStop: boolean;

  /** Update player/ship state from a fresh getStatus() call */
  refreshState: () => Promise<void>;

  /** Record a faction treasury withdrawal (excluded from revenue tracking) */
  recordFactionWithdrawal: (amount: number) => void;
}
