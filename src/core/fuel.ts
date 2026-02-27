/**
 * Fuel service - monitoring, pre-checks, emergency detection.
 */

import type { ShipState } from "../types/game";
import type { Navigation } from "./navigation";

/** Fuel thresholds as percentage of max */
export const FUEL_THRESHOLDS = {
  critical: 15,  // Need emergency refuel
  low: 30,       // Should refuel soon
  comfortable: 60, // Enough for moderate trips
} as const;

export type FuelLevel = "critical" | "low" | "comfortable" | "full";

export class Fuel {
  constructor(private nav: Navigation) {}

  /** Get current fuel as percentage */
  getPercentage(ship: ShipState): number {
    return ship.maxFuel > 0 ? (ship.fuel / ship.maxFuel) * 100 : 0;
  }

  /** Get fuel level category */
  getLevel(ship: ShipState): FuelLevel {
    const pct = this.getPercentage(ship);
    if (pct <= FUEL_THRESHOLDS.critical) return "critical";
    if (pct <= FUEL_THRESHOLDS.low) return "low";
    if (pct <= FUEL_THRESHOLDS.comfortable) return "comfortable";
    return "full";
  }

  /** Check if we have enough fuel to make a trip */
  canReach(fromSystemId: string, toSystemId: string, ship: ShipState): boolean {
    return this.nav.canMakeTrip(fromSystemId, toSystemId, ship);
  }

  /** Check if fuel is below a threshold percentage */
  needsRefuel(ship: ShipState, thresholdPct = FUEL_THRESHOLDS.low): boolean {
    return this.getPercentage(ship) <= thresholdPct;
  }

  /** Estimate how many jumps we can make with current fuel */
  estimateRange(ship: ShipState): number {
    const fuelPerJump = this.nav.estimateJumpFuel(ship);
    return fuelPerJump > 0 ? Math.floor(ship.fuel / fuelPerJump) : 0;
  }

  /** Check if we're stranded (can't reach any station) */
  isStranded(currentSystemId: string, ship: ShipState): boolean {
    const nearest = this.nav.findNearestRefuel(currentSystemId);
    if (!nearest) return true; // No stations in galaxy
    return !this.nav.canMakeTrip(currentSystemId, nearest.systemId, ship);
  }

  /** Calculate fuel needed for a round trip */
  roundTripFuel(fromSystemId: string, toSystemId: string, ship: ShipState): number {
    const there = this.nav.planRoute(fromSystemId, toSystemId, ship);
    const back = this.nav.planRoute(toSystemId, fromSystemId, ship);
    return there.totalFuelCost + back.totalFuelCost;
  }

  /** Check if we can make a round trip */
  canRoundTrip(fromSystemId: string, toSystemId: string, ship: ShipState): boolean {
    return ship.fuel >= this.roundTripFuel(fromSystemId, toSystemId, ship);
  }
}
