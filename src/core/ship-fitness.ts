/**
 * Ship fitness scoring - pure functions for evaluating ship suitability per role.
 * No API calls, no state. Takes ship stats + role -> returns scores.
 */

import type { ShipClass } from "../types/game";

/**
 * Legacy/pre-catalog ships that can't be bought from shipyards but may be owned.
 * Real stats obtained from in-game get_status after switching to each ship (2026-02-28).
 */
export const LEGACY_SHIPS: ShipClass[] = [
  {
    id: "mining_barge", name: "Excavator", category: "Industrial", description: "Legacy mining barge",
    basePrice: 0, hull: 180, shield: 60, armor: 12, speed: 2, fuel: 150,
    cargoCapacity: 150, cpuCapacity: 20, powerCapacity: 40,
  },
  {
    id: "freighter_medium", name: "Merchantman", category: "Industrial", description: "Legacy medium freighter",
    basePrice: 0, hull: 250, shield: 80, armor: 22, speed: 2, fuel: 300,
    cargoCapacity: 450, cpuCapacity: 18, powerCapacity: 35,
  },
  {
    id: "fighter_scout", name: "Sparrow", category: "Combat", description: "Legacy scout fighter",
    basePrice: 0, hull: 70, shield: 45, armor: 6, speed: 4, fuel: 90,
    cargoCapacity: 15, cpuCapacity: 12, powerCapacity: 24,
  },
  {
    id: "fighter_light", name: "Viper", category: "Combat", description: "Legacy light fighter",
    basePrice: 0, hull: 80, shield: 60, armor: 13, speed: 5, fuel: 80,
    cargoCapacity: 15, cpuCapacity: 15, powerCapacity: 30,
  },
  {
    id: "starter_mining", name: "Prospector", category: "Industrial", description: "Legacy starter mining vessel",
    basePrice: 0, hull: 100, shield: 50, armor: 5, speed: 2, fuel: 100,
    cargoCapacity: 50, cpuCapacity: 12, powerCapacity: 25,
  },
];

/** Stat weight profile for a role */
interface RoleProfile {
  cargo: number;
  fuel: number;
  hull: number;
  speed: number;
  cpu: number;
  shield?: number;
}

/** Role-specific stat weightings (must sum to ~1.0) */
const ROLE_PROFILES: Record<string, RoleProfile> = {
  miner:         { cargo: 0.4, fuel: 0.2, hull: 0.2, speed: 0.1, cpu: 0.1 },
  harvester:     { cargo: 0.4, fuel: 0.2, hull: 0.2, speed: 0.1, cpu: 0.1 },
  trader:        { cargo: 0.5, fuel: 0.2, speed: 0.2, hull: 0.05, cpu: 0.05 },
  explorer:      { fuel: 0.4, speed: 0.3, cpu: 0.15, hull: 0.1, cargo: 0.05 },
  crafter:       { cargo: 0.3, cpu: 0.3, hull: 0.2, fuel: 0.1, speed: 0.1 },
  hunter:        { hull: 0.3, speed: 0.25, cpu: 0.2, shield: 0.15, cargo: 0.1, fuel: 0.0 },
  salvager:      { cargo: 0.35, hull: 0.25, fuel: 0.2, speed: 0.15, cpu: 0.05 },
  scavenger:     { cargo: 0.3, fuel: 0.3, speed: 0.25, hull: 0.1, cpu: 0.05 },
  quartermaster: { cargo: 0.3, cpu: 0.2, hull: 0.2, fuel: 0.15, speed: 0.15 },
  default:       { cargo: 0.25, fuel: 0.25, hull: 0.2, speed: 0.15, cpu: 0.15 },
};

/** Normalization ranges for ship stats (approximate game maximums) */
const STAT_MAX: Record<string, number> = {
  cargo: 500,
  fuel: 200,
  hull: 500,
  speed: 20,
  cpu: 100,
  shield: 300,
};

/** Extract a normalized stat (0-1) from a ShipClass */
function getNormalizedStat(ship: ShipClass, stat: string): number {
  const max = STAT_MAX[stat] ?? 100;
  switch (stat) {
    case "cargo": return Math.min(ship.cargoCapacity / max, 1);
    case "fuel": return Math.min(ship.fuel / max, 1);
    case "hull": return Math.min(ship.hull / max, 1);
    case "speed": return Math.min(ship.speed / max, 1);
    case "cpu": return Math.min(ship.cpuCapacity / max, 1);
    case "shield": return Math.min(ship.shield / max, 1);
    default: return 0;
  }
}

/**
 * Score a ship class for a given role (0-100).
 * Higher = better fit for the role.
 */
export function scoreShipForRole(ship: ShipClass, role: string): number {
  const profile = ROLE_PROFILES[role] ?? ROLE_PROFILES.default;
  let score = 0;
  for (const [stat, weight] of Object.entries(profile)) {
    score += getNormalizedStat(ship, stat) * weight * 100;
  }
  return Math.round(score);
}

/**
 * Check if an upgrade is strictly better: at least 2 stats improve,
 * no stat decreases by more than 20%.
 */
export function isStrictUpgrade(current: ShipClass, upgrade: ShipClass): boolean {
  const stats = [
    { cur: current.cargoCapacity, upg: upgrade.cargoCapacity },
    { cur: current.fuel, upg: upgrade.fuel },
    { cur: current.hull, upg: upgrade.hull },
    { cur: current.speed, upg: upgrade.speed },
    { cur: current.cpuCapacity, upg: upgrade.cpuCapacity },
    { cur: current.shield, upg: upgrade.shield },
  ];

  let improvements = 0;
  for (const { cur, upg } of stats) {
    if (upg > cur) improvements++;
    // Check for significant decrease (>20%)
    if (cur > 0 && upg < cur * 0.8) return false;
  }
  return improvements >= 2;
}

/**
 * Calculate ROI: fitness gain per 1000 credits spent.
 * Higher = better deal. Used to prioritize which bot upgrades first.
 */
export function calculateROI(current: ShipClass, upgrade: ShipClass, role: string): number {
  const currentScore = scoreShipForRole(current, role);
  const upgradeScore = scoreShipForRole(upgrade, role);
  const gain = upgradeScore - currentScore;
  if (gain <= 0 || upgrade.basePrice <= 0) return 0;
  return (gain / upgrade.basePrice) * 1000;
}

/**
 * Find the best affordable upgrade for a bot's role.
 * Returns null if no upgrade is worth buying.
 */
export function findBestUpgrade(
  currentClassId: string,
  role: string,
  catalog: ShipClass[],
  maxPrice: number,
): ShipClass | null {
  const current = catalog.find((s) => s.id === currentClassId);
  if (!current) return null;

  const currentScore = scoreShipForRole(current, role);

  let bestCandidate: ShipClass | null = null;
  let bestROI = 0;

  for (const ship of catalog) {
    if (ship.id === currentClassId) continue;
    if (ship.basePrice <= 0 || ship.basePrice > maxPrice) continue;

    const score = scoreShipForRole(ship, role);
    // Must be at least 5 points better for the role
    if (score <= currentScore + 5) continue;

    // Must be a strict upgrade (no severe stat regressions)
    if (!isStrictUpgrade(current, ship)) continue;

    const roi = calculateROI(current, ship, role);
    if (roi > bestROI) {
      bestROI = roi;
      bestCandidate = ship;
    }
  }

  return bestCandidate;
}
