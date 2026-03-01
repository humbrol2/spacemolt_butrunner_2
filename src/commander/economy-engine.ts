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

/** Fallback production rates per routine (used when no observed data yet) */
const FALLBACK_PRODUCTION: Record<string, { itemId: string; qtyPerHour: number }[]> = {
  miner: [{ itemId: "ore_iron", qtyPerHour: 20 }],
  harvester: [{ itemId: "ore_ice_nitrogen", qtyPerHour: 15 }],
  crafter: [{ itemId: "refined_steel", qtyPerHour: 5 }],
};

/** Fallback consumption rates per routine */
const FALLBACK_CONSUMPTION: Record<string, { itemId: string; qtyPerHour: number }[]> = {
  crafter: [{ itemId: "ore_iron", qtyPerHour: 10 }],
};

/** Sliding window duration for observed production tracking (1 hour) */
const OBSERVATION_WINDOW_MS = 3_600_000;

export class EconomyEngine {
  private demands: MaterialDemand[] = [];
  private supplies: MaterialSupply[] = [];
  private stockTargets: StockTarget[] = [];
  private stationInventory = new Map<string, Map<string, number>>(); // station → item → qty
  private factionInventory = new Map<string, number>(); // item → qty (shared faction storage)

  // Profit tracking (running totals — reset daily)
  private totalRevenue = 0;
  private totalCosts = 0;

  /**
   * Observed production/consumption per bot: botId → itemId → timestamped events.
   * Events are trimmed to the observation window on each analyze() call.
   */
  private observedProduction = new Map<string, Array<{ itemId: string; qty: number; at: number }>>();
  private observedConsumption = new Map<string, Array<{ itemId: string; qty: number; at: number }>>();

  /** Record an observed production event (e.g., miner deposited 10 ore_iron) */
  recordProduction(botId: string, itemId: string, qty: number): void {
    if (qty <= 0) return;
    if (!this.observedProduction.has(botId)) this.observedProduction.set(botId, []);
    this.observedProduction.get(botId)!.push({ itemId, qty, at: Date.now() });
  }

  /** Record an observed consumption event (e.g., crafter consumed 5 ore_iron) */
  recordConsumption(botId: string, itemId: string, qty: number): void {
    if (qty <= 0) return;
    if (!this.observedConsumption.has(botId)) this.observedConsumption.set(botId, []);
    this.observedConsumption.get(botId)!.push({ itemId, qty, at: Date.now() });
  }

  /** Get observed per-hour rates for a bot (production) */
  private getObservedRates(botId: string, type: "production" | "consumption"): Map<string, number> {
    const store = type === "production" ? this.observedProduction : this.observedConsumption;
    const events = store.get(botId);
    if (!events || events.length === 0) return new Map();

    const now = Date.now();
    const cutoff = now - OBSERVATION_WINDOW_MS;
    // Trim old events
    const recent = events.filter((e) => e.at >= cutoff);
    store.set(botId, recent);

    if (recent.length === 0) return new Map();

    // Sum quantities per item
    const sums = new Map<string, number>();
    for (const e of recent) {
      sums.set(e.itemId, (sums.get(e.itemId) ?? 0) + e.qty);
    }

    // Convert to per-hour rate: qty / (window hours elapsed)
    const oldestEvent = recent[0].at;
    const elapsed = Math.max(now - oldestEvent, 60_000); // Min 1 minute to avoid division by tiny number
    const hoursElapsed = elapsed / 3_600_000;

    const rates = new Map<string, number>();
    for (const [itemId, total] of sums) {
      rates.set(itemId, total / hoursElapsed);
    }
    return rates;
  }

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
    this.totalRevenue += amount;
  }

  /** Record cost (credits spent on buying/refueling/repair) */
  recordCost(amount: number): void {
    this.totalCosts += amount;
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

    const totalRevenue = this.totalRevenue;
    const totalCosts = this.totalCosts;
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
    this.totalRevenue = 0;
    this.totalCosts = 0;
  }

  // ── Internal ──

  private calculateDemandSupply(fleet: FleetStatus): void {
    this.demands = [];
    this.supplies = [];

    for (const bot of fleet.bots) {
      if (bot.status !== "running" || !bot.routine) continue;

      // Production: prefer observed rates, fall back to estimates
      const observedProd = this.getObservedRates(bot.botId, "production");
      if (observedProd.size > 0) {
        for (const [itemId, qtyPerHour] of observedProd) {
          this.supplies.push({ itemId, quantityPerHour: qtyPerHour, source: bot.botId });
        }
      } else {
        const fallback = FALLBACK_PRODUCTION[bot.routine];
        if (fallback) {
          for (const p of fallback) {
            this.supplies.push({ itemId: p.itemId, quantityPerHour: p.qtyPerHour, source: bot.botId });
          }
        }
      }

      // Consumption: prefer observed rates, fall back to estimates
      const observedCons = this.getObservedRates(bot.botId, "consumption");
      if (observedCons.size > 0) {
        for (const [itemId, qtyPerHour] of observedCons) {
          this.demands.push({ itemId, quantityPerHour: qtyPerHour, source: bot.botId, priority: "normal" });
        }
      } else {
        const fallback = FALLBACK_CONSUMPTION[bot.routine];
        if (fallback) {
          for (const c of fallback) {
            this.demands.push({ itemId: c.itemId, quantityPerHour: c.qtyPerHour, source: bot.botId, priority: "normal" });
          }
        }
      }

      // Fuel demand for all active bots
      this.demands.push({
        itemId: "fuel",
        quantityPerHour: 10,
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
