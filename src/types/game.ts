/**
 * Domain types for SpaceMolt game entities.
 * Hand-written for clean DX, mapped from API responses in ApiClient.
 */

// ── Empires ──

export type Empire = "solarian" | "voidborn" | "crimson" | "nebula" | "outerrim";

export const EMPIRE_COLORS: Record<Empire | "neutral", string> = {
  solarian: "#ffd700",
  voidborn: "#9b59b6",
  crimson: "#e63946",
  nebula: "#00d4ff",
  outerrim: "#2dd4bf",
  neutral: "#5a6a7a",
};

// ── Galaxy ──

export interface StarSystem {
  id: string;
  name: string;
  x: number;
  y: number;
  empire: Empire | null;
  policeLevel: number;
  connections: string[]; // connected system IDs
  pois: PoiSummary[];
  /** Number of POIs in this system (from get_map, even without full POI data) */
  poiCount: number;
  /** Whether any bot has visited this system */
  visited: boolean;
}

export interface PoiSummary {
  id: string;
  name: string;
  type: PoiType;
  hasBase: boolean;
  baseId: string | null;
  baseName: string | null;
  /** Resource deposits at this POI (populated from get_system detail) */
  resources: ResourceDeposit[];
}

export type PoiType =
  | "planet"
  | "moon"
  | "sun"
  | "asteroid_belt"
  | "asteroid"
  | "nebula"
  | "gas_cloud"
  | "ice_field"
  | "relic"
  | "station";

export interface PoiDetail {
  id: string;
  systemId: string;
  type: PoiType;
  name: string;
  description: string;
  position: { x: number; y: number };
  resources: ResourceDeposit[];
  baseId: string | null;
}

export interface ResourceDeposit {
  resourceId: string;
  richness: number;
  remaining: number;
}

// ── Player ──

export interface PlayerState {
  id: string;
  username: string;
  empire: Empire;
  credits: number;
  currentSystem: string;
  currentPoi: string;
  currentShipId: string;
  homeBase: string | null;
  dockedAtBase: string | null;
  factionId: string | null;
  factionRank: string | null;
  statusMessage: string | null;
  clanTag: string | null;
  anonymous: boolean;
  isCloaked: boolean;
  skills: Record<string, number>;
  skillXp: Record<string, number>;
  stats: PlayerStats;
}

export interface PlayerStats {
  shipsDestroyed: number;
  timesDestroyed: number;
  oreMined: number;
  creditsEarned: number;
  creditsSpent: number;
  tradesCompleted: number;
  systemsVisited: number;
  itemsCrafted: number;
  missionsCompleted: number;
}

// ── Ship ──

export interface ShipState {
  id: string;
  ownerId: string;
  classId: string;
  name: string | null;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  shieldRecharge: number;
  armor: number;
  speed: number;
  fuel: number;
  maxFuel: number;
  cargoUsed: number;
  cargoCapacity: number;
  cpuUsed: number;
  cpuCapacity: number;
  powerUsed: number;
  powerCapacity: number;
  modules: ShipModule[];
  cargo: CargoItem[];
}

export interface ShipModule {
  id: string;
  moduleId: string;
  name: string;
}

export interface CargoItem {
  itemId: string;
  quantity: number;
  /** Weight per unit (from API). Defaults to 1 if not provided. */
  size?: number;
}

// ── Market ──

export interface MarketOrder {
  id: string;
  type: "buy" | "sell";
  itemId: string;
  itemName: string;
  quantity: number;
  priceEach: number;
  playerId: string;
  playerName: string;
  stationId: string;
}

export interface MarketPrice {
  itemId: string;
  itemName: string;
  buyPrice: number | null;  // best ask (cheapest sell order)
  sellPrice: number | null; // best bid (highest buy order)
  buyVolume: number;
  sellVolume: number;
}

// ── Purchase Estimate ──

export interface EstimatePurchaseResult {
  item: string;
  available: number;
  quantityRequested: number;
  totalCost: number;
  unfilled: number;
  fills: Array<{
    priceEach: number;
    quantity: number;
    subtotal: number;
  }>;
}

// ── Catalog ──

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  description: string;
  basePrice: number;
  stackSize: number;
}

export interface ShipClass {
  id: string;
  name: string;
  category: string;
  description: string;
  basePrice: number;
  hull: number;
  shield: number;
  armor: number;
  speed: number;
  fuel: number;
  cargoCapacity: number;
  cpuCapacity: number;
  powerCapacity: number;
}

export interface Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  maxLevel: number;
  prerequisites: Record<string, number>; // skill_id → required level
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  outputItem: string;
  outputQuantity: number;
  ingredients: RecipeIngredient[];
  requiredSkills: Record<string, number>;
  xpRewards: Record<string, number>;
}

export interface RecipeIngredient {
  itemId: string;
  quantity: number;
}

// ── Combat ──

export type BattleZone = "outer" | "mid" | "inner" | "engaged";
export type BattleStance = "fire" | "evade" | "brace" | "flee";
export type DamageType = "kinetic" | "energy" | "explosive" | "thermal" | "em" | "void";

export interface BattleStatus {
  id: string;
  tick: number;
  zone: BattleZone;
  stance: BattleStance;
  sides: BattleSide[];
}

export interface BattleSide {
  id: string;
  participants: BattleParticipant[];
}

export interface BattleParticipant {
  playerId: string;
  username: string;
  shipClass: string;
  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;
  zone: BattleZone;
  stance: BattleStance;
}

// ── Missions ──

export interface Mission {
  id: string;
  title: string;
  description: string;
  type: string;
  objectives: MissionObjective[];
  rewards: MissionReward[];
}

export interface MissionObjective {
  description: string;
  progress: number;
  target: number;
  complete: boolean;
}

export interface MissionReward {
  type: "credits" | "item" | "xp";
  amount: number;
  itemId?: string;
}

// ── Nearby ──

export interface NearbyPlayer {
  playerId: string;
  username: string;
  shipClass: string;
  factionId: string | null;
  factionTag: string | null;
  anonymous: boolean;
  inCombat: boolean;
}

// ── Notifications ──

export type NotificationType = "chat" | "combat" | "trade" | "faction" | "friend" | "system";

export interface GameNotification {
  type: NotificationType;
  data: Record<string, unknown>;
  timestamp: string;
}

// ── API Responses ──

export interface MiningYield {
  resourceId: string;
  quantity: number;
  remaining: number;
  xpGained: Record<string, number>;
}

export interface TravelResult {
  destination: string;
  arrivalTick: number;
  fuelConsumed: number;
}

export interface TradeResult {
  itemId: string;
  quantity: number;
  priceEach: number;
  total: number;
}

export interface CraftResult {
  recipeId: string;
  outputItem: string;
  outputQuantity: number;
  xpGained: Record<string, number>;
}

// ── Session ──

export interface SessionInfo {
  id: string;
  playerId: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface LoginResult {
  sessionId: string;
  player: PlayerState;
  ship: ShipState;
  system: StarSystem;
  poi: PoiDetail;
}

export interface RegisterResult {
  password: string;
  playerId: string;
}
