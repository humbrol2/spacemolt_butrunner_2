/**
 * Cargo service - space calculations, sell ordering, material checks.
 *
 * Weight-aware: items can have size > 1 per unit. The API provides
 * cargoUsed/cargoCapacity in weight units, and CargoItem.size gives
 * the per-unit weight. All buy calculations account for item weight.
 */

import type { ShipState, CargoItem, CatalogItem } from "../types/game";

export interface CargoSummary {
  used: number;
  capacity: number;
  free: number;
  pctFull: number;
  items: CargoItem[];
}

export interface SellPlan {
  itemId: string;
  quantity: number;
  estimatedValue: number;
}

export class Cargo {
  /** Get cargo summary from ship state */
  getSummary(ship: ShipState): CargoSummary {
    return {
      used: ship.cargoUsed,
      capacity: ship.cargoCapacity,
      free: ship.cargoCapacity - ship.cargoUsed,
      pctFull: ship.cargoCapacity > 0 ? (ship.cargoUsed / ship.cargoCapacity) * 100 : 0,
      items: ship.cargo,
    };
  }

  /** Check if cargo has weight-space for N units of a given item size */
  hasSpace(ship: ShipState, units: number, itemSize: number = 1): boolean {
    return ship.cargoCapacity - ship.cargoUsed >= units * itemSize;
  }

  /** Get available cargo weight capacity */
  freeSpace(ship: ShipState): number {
    return ship.cargoCapacity - ship.cargoUsed;
  }

  /** Get quantity of a specific item in cargo */
  getItemQuantity(ship: ShipState, itemId: string): number {
    return ship.cargo.find((c) => c.itemId === itemId)?.quantity ?? 0;
  }

  /** Get the per-unit size of an item from cargo (returns 1 if not in cargo) */
  getItemSize(ship: ShipState, itemId: string): number {
    return ship.cargo.find((c) => c.itemId === itemId)?.size ?? 1;
  }

  /** Check if cargo contains all required items (e.g., for crafting) */
  hasItems(ship: ShipState, requirements: Array<{ itemId: string; quantity: number }>): boolean {
    for (const req of requirements) {
      if (this.getItemQuantity(ship, req.itemId) < req.quantity) return false;
    }
    return true;
  }

  /** Get missing items (what we need but don't have enough of) */
  getMissing(ship: ShipState, requirements: Array<{ itemId: string; quantity: number }>): Array<{ itemId: string; needed: number }> {
    const missing: Array<{ itemId: string; needed: number }> = [];
    for (const req of requirements) {
      const have = this.getItemQuantity(ship, req.itemId);
      if (have < req.quantity) {
        missing.push({ itemId: req.itemId, needed: req.quantity - have });
      }
    }
    return missing;
  }

  /**
   * Plan which items to sell first for maximum value.
   * Sorts by estimated price (descending) so most valuable items sell first.
   */
  planSellOrder(
    ship: ShipState,
    prices: Map<string, number> // itemId → price per unit
  ): SellPlan[] {
    const plans: SellPlan[] = [];

    for (const item of ship.cargo) {
      const price = prices.get(item.itemId) ?? 0;
      plans.push({
        itemId: item.itemId,
        quantity: item.quantity,
        estimatedValue: price * item.quantity,
      });
    }

    // Sort by value descending (sell most valuable first)
    plans.sort((a, b) => b.estimatedValue - a.estimatedValue);
    return plans;
  }

  /** Estimate total cargo value at current market prices */
  estimateCargoValue(ship: ShipState, prices: Map<string, number>): number {
    return ship.cargo.reduce((total, item) => {
      return total + (prices.get(item.itemId) ?? 0) * item.quantity;
    }, 0);
  }

  /**
   * Calculate how many units of an item we can buy given credits, cargo weight,
   * and per-unit item size (weight). Accounts for heavy items (size > 1).
   */
  maxBuyQuantity(ship: ShipState, priceEach: number, credits: number, itemSize: number = 1): number {
    const freeWeight = this.freeSpace(ship);
    const safeSize = Math.max(1, itemSize);
    const bySpace = Math.floor(freeWeight / safeSize);
    const byCredits = priceEach > 0 ? Math.floor(credits / priceEach) : 0;
    return Math.min(bySpace, byCredits);
  }
}
