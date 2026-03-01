/**
 * Market service - price lookups, arbitrage detection, trade route scoring.
 * Uses GameCache for price data and Galaxy for distance calculations.
 */

import type { MarketPrice, MarketOrder } from "../types/game";
import type { Galaxy } from "./galaxy";
import type { GameCache } from "../data/game-cache";

export interface TradeRoute {
  itemId: string;
  itemName: string;
  buyStationId: string;
  sellStationId: string;
  buyPrice: number;
  sellPrice: number;
  profitPerUnit: number;
  /** Max tradeable volume (min of buy/sell availability) */
  volume: number;
  jumps: number;
  /** Profit per unit per tick (travel-time-adjusted margin) */
  profitPerTick: number;
  /** Total trip profit estimate per tick (volume-aware, the key ranking metric) */
  tripProfitPerTick: number;
}

export interface StationPrice {
  stationId: string;
  price: number;
  volume: number;
}

export class Market {
  constructor(
    private cache: GameCache,
    private galaxy: Galaxy
  ) {}

  /** Get cached market prices for a station, or null if stale */
  getPrices(stationId: string): MarketPrice[] | null {
    return this.cache.getMarketPrices(stationId);
  }

  /** Get best buy price (cheapest sell order) for an item across all cached stations */
  findBestBuy(itemId: string, cachedStationIds: string[]): StationPrice | null {
    let best: StationPrice | null = null;

    for (const stationId of cachedStationIds) {
      const prices = this.cache.getMarketPrices(stationId);
      if (!prices) continue;

      const item = prices.find((p) => p.itemId === itemId);
      if (!item?.buyPrice) continue;

      if (!best || item.buyPrice < best.price) {
        best = { stationId, price: item.buyPrice, volume: item.buyVolume };
      }
    }

    return best;
  }

  /** Get best sell price (highest buy order) for an item across cached stations */
  findBestSell(itemId: string, cachedStationIds: string[]): StationPrice | null {
    let best: StationPrice | null = null;

    for (const stationId of cachedStationIds) {
      const prices = this.cache.getMarketPrices(stationId);
      if (!prices) continue;

      const item = prices.find((p) => p.itemId === itemId);
      if (!item?.sellPrice) continue;

      if (!best || item.sellPrice > best.price) {
        best = { stationId, price: item.sellPrice, volume: item.sellVolume };
      }
    }

    return best;
  }

  /**
   * Find arbitrage opportunities between cached stations.
   * Ranks by profit-per-tick (factors in travel time, fuel cost, return trip).
   * @param cargoCapacity - Bot's actual cargo capacity (defaults to 100 if unknown)
   * @param fuelCostPerJump - Estimated credit cost per jump for fuel (default 50)
   */
  findArbitrage(
    cachedStationIds: string[],
    fromSystemId: string,
    cargoCapacity: number = 100,
    fuelCostPerJump: number = 50,
  ): TradeRoute[] {
    const routes: TradeRoute[] = [];

    // Collect all items with price data
    const allPrices = new Map<string, Map<string, MarketPrice>>(); // itemId → stationId → price
    for (const stationId of cachedStationIds) {
      const prices = this.cache.getMarketPrices(stationId);
      if (!prices) continue;
      for (const p of prices) {
        if (!allPrices.has(p.itemId)) allPrices.set(p.itemId, new Map());
        allPrices.get(p.itemId)!.set(stationId, p);
      }
    }

    // Find profitable pairs
    for (const [itemId, stationPrices] of allPrices) {
      const entries = Array.from(stationPrices.entries());

      for (const [buyStationId, buyPriceData] of entries) {
        if (!buyPriceData.buyPrice) continue; // No sell orders (nothing to buy)

        for (const [sellStationId, sellPriceData] of entries) {
          if (buyStationId === sellStationId) continue;
          if (!sellPriceData.sellPrice) continue; // No buy orders (no demand)

          const profitPerUnit = sellPriceData.sellPrice - buyPriceData.buyPrice;
          if (profitPerUnit <= 0) continue;

          // Estimate travel distance
          const buySystemId = this.galaxy.getSystemForBase(buyStationId);
          const sellSystemId = this.galaxy.getSystemForBase(sellStationId);
          if (!buySystemId || !sellSystemId) continue;

          const distFromHere = this.galaxy.getDistance(fromSystemId, buySystemId);
          const tradeDist = this.galaxy.getDistance(buySystemId, sellSystemId);
          if (distFromHere < 0 || tradeDist < 0) continue;

          // Each jump = ~10s (1 tick). Add 4 ticks for dock/buy/sell/undock overhead.
          // Include return trip (buy→sell→buy) for repeatable routes.
          const totalTicks = distFromHere + tradeDist * 2 + 4;
          const profitPerTick = profitPerUnit / Math.max(1, totalTicks);

          // Volume-aware: how many units can actually be traded?
          const tradeableVolume = Math.min(
            buyPriceData.buyVolume || Infinity,
            sellPriceData.sellVolume || Infinity,
          );
          // Clamp to actual cargo capacity (not hardcoded 100)
          const effectiveVolume = Math.min(tradeableVolume, cargoCapacity);

          // Minimum margin: at least 10% profit on buy price (avoid risky high-value low-margin trades)
          if (profitPerUnit / buyPriceData.buyPrice < 0.10) continue;

          // Subtract fuel cost from profit (round trip: to buy + buy→sell + sell→buy)
          const totalJumps = distFromHere + tradeDist * 2;
          const fuelCost = totalJumps * fuelCostPerJump;
          const tripProfit = Math.max(0, profitPerUnit * effectiveVolume - fuelCost);
          if (tripProfit < 200) continue; // Skip routes netting under 200cr after fuel

          // Age-weight: discount older data (0.97^ageMinutes — 5min=~85%, 15min=~63%, 30min=~40%)
          const buyAge = this.cache.getMarketFreshness(buyStationId).ageMs;
          const sellAge = this.cache.getMarketFreshness(sellStationId).ageMs;
          const maxAgeMin = Math.max(buyAge, sellAge) / 60_000;
          const confidence = Math.pow(0.97, Math.min(maxAgeMin, 60)); // Cap at 60 min
          const tripProfitPerTick = (tripProfit * confidence) / Math.max(1, totalTicks);

          routes.push({
            itemId,
            itemName: buyPriceData.itemName,
            buyStationId,
            sellStationId,
            buyPrice: buyPriceData.buyPrice,
            sellPrice: sellPriceData.sellPrice,
            profitPerUnit,
            volume: tradeableVolume === Infinity ? 0 : tradeableVolume,
            jumps: tradeDist,
            profitPerTick,
            tripProfitPerTick,
          });
        }
      }
    }

    // Sort by total trip profit per tick (volume × margin / travel time)
    routes.sort((a, b) => b.tripProfitPerTick - a.tripProfitPerTick);
    return routes;
  }

  /**
   * Score a trade route for a specific bot.
   * Factors in: profit margin, travel distance, cargo capacity, fuel cost.
   */
  scoreTradeRoute(
    route: TradeRoute,
    cargoSpace: number,
    fromSystemId: string,
    fuelCostPerJump: number = 50,
  ): number {
    const buySystemId = this.galaxy.getSystemForBase(route.buyStationId);
    if (!buySystemId) return 0;

    const distToStart = this.galaxy.getDistance(fromSystemId, buySystemId);
    if (distToStart < 0) return 0;

    const totalTicks = distToStart + route.jumps * 2 + 4;
    const totalJumps = distToStart + route.jumps * 2;
    const totalProfit = Math.max(0, route.profitPerUnit * cargoSpace - totalJumps * fuelCostPerJump);
    return totalProfit / Math.max(1, totalTicks);
  }

  /** Get all item IDs that appear in cached market data */
  getTrackedItems(cachedStationIds: string[]): Set<string> {
    const items = new Set<string>();
    for (const stationId of cachedStationIds) {
      const prices = this.cache.getMarketPrices(stationId);
      if (!prices) continue;
      for (const p of prices) items.add(p.itemId);
    }
    return items;
  }

  /** Build a price-per-unit map for items at a given station */
  buildPriceMap(stationId: string): Map<string, number> {
    const map = new Map<string, number>();
    const prices = this.cache.getMarketPrices(stationId);
    if (!prices) return map;

    for (const p of prices) {
      // Use sell price (what we'd get) for valuation
      if (p.sellPrice !== null) map.set(p.itemId, p.sellPrice);
      else if (p.buyPrice !== null) map.set(p.itemId, p.buyPrice);
    }
    return map;
  }
}
