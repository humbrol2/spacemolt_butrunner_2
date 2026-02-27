/**
 * Economy engine - tracks supply/demand, inventory alerts, and profit.
 * Provides the EconomySnapshot consumed by the Commander brain.
 */

import type { StockTarget } from "../types/config";
import type { FleetStatus, FleetBotInfo } from "../bot/types";
import type {
  MaterialDemand,
  MaterialSupply,
  SupplyDeficit,
  SupplySurplus,
  InventoryAlert,
  EconomySnapshot,
} from "./types";

/** Production rates per routine per hour (rough estimates, tunable) */
const ROUTINE_PRODUCTION: Record<string, { itemId: string; qtyPerHour: number }[]> = {
  miner: [
    { itemId: "ore_iron", qtyPerHour: 30 },
    { itemId: "ore_copper", qtyPerHour: 15 },
    { itemId: "ore_titanium", qtyPerHour: 10 },
    { itemId: "ore_gold", qtyPerHour: 5 },
  ],
  harvester: [
    { itemId: "ore_ice_nitrogen", qtyPerHour: 25 },
    { itemId: "ore_ice_hydrogen", qtyPerHour: 20 },
    { itemId: "ore_crystal", qtyPerHour: 5 },
  ],
  crafter: [
    { itemId: "refined_steel", qtyPerHour: 10 },
    { itemId: "component_electronics", qtyPerHour: 5 },
  ],
};

/** Consumption rates per routine per hour (rough estimates) */
const ROUTINE_CONSUMPTION: Record<string, { itemId: string; qtyPerHour: number }[]> = {
  crafter: [
    { itemId: "ore_iron", qtyPerHour: 20 },
    { itemId: "ore_copper", qtyPerHour: 10 },
  ],
};

export class EconomyEngine {
  private demands: MaterialDemand[] = [];
  private supplies: MaterialSupply[] = [];
  private stockTargets: StockTarget[] = [];
  private stationInventory = new Map<string, Map<string, number>>(); // station → item → qty
  private factionInventory = new Map<string, number>(); // item → qty (shared faction storage)

  // Profit tracking
  private revenueHistory: number[] = [];
  private costHistory: number[] = [];

  /** Set inventory targets from config */
  setStockTargets(targets: StockTarget[]): void {
    this.stockTargets = targets;
  }

  /** Add a single stock target */
  addStockTarget(target: StockTarget): void {
    // Replace existing target for same station/item, or add new
    const idx = this.stockTargets.findIndex(
      (t) => t.station_id === target.station_id && t.item_id === target.item_id
    );
    if (idx >= 0) {
      this.stockTargets[idx] = target;
    } else {
      this.stockTargets.push(target);
    }
  }

  /** Remove a stock target by station and item */
  removeStockTarget(stationId: string, itemId: string): void {
    this.stockTargets = this.stockTargets.filter(
      (t) => !(t.station_id === stationId && t.item_id === itemId)
    );
  }

  /** Update station inventory from storage queries */
  updateStationInventory(stationId: string, items: Map<string, number>): void {
    this.stationInventory.set(stationId, items);
  }

  /** Update faction storage inventory (shared across all bots) */
  updateFactionInventory(items: Map<string, number>): void {
    this.factionInventory = items;
  }

  /** Get quantity of an item in faction storage */
  getFactionStock(itemId: string): number {
    return this.factionInventory.get(itemId) ?? 0;
  }

  /** Get the full faction inventory snapshot */
  getFactionInventory(): Map<string, number> {
    return new Map(this.factionInventory);
  }

  /** Check if faction has any items matching a pattern */
  hasFactionMaterials(itemPatterns: string[]): boolean {
    for (const pattern of itemPatterns) {
      for (const [itemId] of this.factionInventory) {
        if (itemId.includes(pattern)) return true;
      }
    }
    return false;
  }

  /** Record revenue (credits earned from selling) */
  recordRevenue(amount: number): void {
    this.revenueHistory.push(amount);
  }

  /** Record cost (credits spent on buying/refueling/repair) */
  recordCost(amount: number): void {
    this.costHistory.push(amount);
  }

  /**
   * Analyze fleet state and produce an economy snapshot.
   * This is the primary output consumed by the Commander brain.
   */
  analyze(fleet: FleetStatus): EconomySnapshot {
    this.calculateDemandSupply(fleet);

    const deficits = this.computeDeficits();
    const surpluses = this.computeSurpluses();
    const inventoryAlerts = this.checkInventoryTargets();

    // Calculate profit from recent history
    const totalRevenue = this.revenueHistory.reduce((s, r) => s + r, 0);
    const totalCosts = this.costHistory.reduce((s, c) => s + c, 0);
    const netProfit = totalRevenue - totalCosts;

    return {
      deficits,
      surpluses,
      inventoryAlerts,
      totalRevenue,
      totalCosts,
      netProfit,
      factionStorage: new Map(this.factionInventory),
    };
  }

  /** Reset profit tracking (call at beginning of each evaluation period) */
  resetProfitTracking(): void {
    this.revenueHistory = [];
    this.costHistory = [];
  }

  // ── Internal ──

  private calculateDemandSupply(fleet: FleetStatus): void {
    this.demands = [];
    this.supplies = [];

    for (const bot of fleet.bots) {
      if (bot.status !== "running" || !bot.routine) continue;

      // Production
      const production = ROUTINE_PRODUCTION[bot.routine];
      if (production) {
        for (const p of production) {
          this.supplies.push({
            itemId: p.itemId,
            quantityPerHour: p.qtyPerHour,
            source: bot.botId,
          });
        }
      }

      // Consumption
      const consumption = ROUTINE_CONSUMPTION[bot.routine];
      if (consumption) {
        for (const c of consumption) {
          this.demands.push({
            itemId: c.itemId,
            quantityPerHour: c.qtyPerHour,
            source: bot.botId,
            priority: "normal",
          });
        }
      }

      // Fuel demand for all active bots
      this.demands.push({
        itemId: "fuel",
        quantityPerHour: 10, // Approximate fuel consumption
        source: bot.botId,
        priority: bot.fuelPct < 30 ? "critical" : "normal",
      });
    }
  }

  private computeDeficits(): SupplyDeficit[] {
    // Aggregate demand and supply per item
    const demandMap = new Map<string, { total: number; priority: "critical" | "normal" | "low" }>();
    const supplyMap = new Map<string, number>();

    for (const d of this.demands) {
      const existing = demandMap.get(d.itemId) ?? { total: 0, priority: "low" as const };
      existing.total += d.quantityPerHour;
      // Escalate priority
      if (d.priority === "critical" || existing.priority === "critical") {
        existing.priority = "critical";
      } else if (d.priority === "normal" || existing.priority === "normal") {
        existing.priority = "normal";
      }
      demandMap.set(d.itemId, existing);
    }

    for (const s of this.supplies) {
      supplyMap.set(s.itemId, (supplyMap.get(s.itemId) ?? 0) + s.quantityPerHour);
    }

    const deficits: SupplyDeficit[] = [];
    for (const [itemId, demand] of demandMap) {
      const supply = supplyMap.get(itemId) ?? 0;
      if (demand.total > supply) {
        deficits.push({
          itemId,
          demandPerHour: demand.total,
          supplyPerHour: supply,
          shortfall: demand.total - supply,
          priority: demand.priority,
        });
      }
    }

    // Sort by priority then shortfall
    deficits.sort((a, b) => {
      const prio = priorityValue(b.priority) - priorityValue(a.priority);
      if (prio !== 0) return prio;
      return b.shortfall - a.shortfall;
    });

    return deficits;
  }

  private computeSurpluses(): SupplySurplus[] {
    const demandMap = new Map<string, number>();
    const supplyMap = new Map<string, number>();

    for (const d of this.demands) {
      demandMap.set(d.itemId, (demandMap.get(d.itemId) ?? 0) + d.quantityPerHour);
    }
    for (const s of this.supplies) {
      supplyMap.set(s.itemId, (supplyMap.get(s.itemId) ?? 0) + s.quantityPerHour);
    }

    const surpluses: SupplySurplus[] = [];
    for (const [itemId, supply] of supplyMap) {
      const demand = demandMap.get(itemId) ?? 0;
      if (supply > demand) {
        surpluses.push({
          itemId,
          excessPerHour: supply - demand,
          stationId: "", // Would need station-level tracking
          currentStock: 0,
        });
      }
    }

    return surpluses;
  }

  private checkInventoryTargets(): InventoryAlert[] {
    const alerts: InventoryAlert[] = [];

    for (const target of this.stockTargets) {
      const stationItems = this.stationInventory.get(target.station_id);
      const current = stationItems?.get(target.item_id) ?? 0;

      if (current < target.min_stock) {
        alerts.push({
          stationId: target.station_id,
          itemId: target.item_id,
          current,
          target,
          type: "below_min",
        });
      } else if (current > target.max_stock) {
        alerts.push({
          stationId: target.station_id,
          itemId: target.item_id,
          current,
          target,
          type: "above_max",
        });
      }
    }

    return alerts;
  }
}

function priorityValue(p: "critical" | "normal" | "low"): number {
  switch (p) {
    case "critical": return 3;
    case "normal": return 2;
    case "low": return 1;
  }
}
