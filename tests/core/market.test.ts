import { describe, test, expect, beforeEach } from "bun:test";
import { Market } from "../../src/core/market";
import { Galaxy } from "../../src/core/galaxy";
import type { GameCache } from "../../src/data/game-cache";
import type { MarketPrice } from "../../src/types/game";

// Minimal mock for GameCache
class MockGameCache {
  private prices = new Map<string, MarketPrice[]>();

  setMockPrices(stationId: string, prices: MarketPrice[]) {
    this.prices.set(stationId, prices);
  }

  getMarketPrices(stationId: string): MarketPrice[] | null {
    return this.prices.get(stationId) ?? null;
  }
}

function setupGalaxy(): Galaxy {
  const galaxy = new Galaxy();
  galaxy.load([
    {
      id: "sol", name: "Sol", x: 0, y: 0, empire: "solarian", policeLevel: 3,
      connections: ["alpha"],
      pois: [
        { id: "sol_earth", name: "Earth", type: "planet", hasBase: true, baseId: "base_sol", baseName: "Sol Station", resources: [] },
      ],
    },
    {
      id: "alpha", name: "Alpha", x: 10, y: 5, empire: "solarian", policeLevel: 2,
      connections: ["sol", "gamma"],
      pois: [
        { id: "alpha_station", name: "Alpha Station", type: "station", hasBase: true, baseId: "base_alpha", baseName: "Alpha", resources: [] },
      ],
    },
    {
      id: "gamma", name: "Gamma", x: 20, y: 10, empire: null, policeLevel: 0,
      connections: ["alpha"],
      pois: [
        { id: "gamma_outpost", name: "Gamma Outpost", type: "station", hasBase: true, baseId: "base_gamma", baseName: "Gamma", resources: [] },
      ],
    },
  ]);
  return galaxy;
}

describe("Market", () => {
  let market: Market;
  let mockCache: MockGameCache;
  let galaxy: Galaxy;

  beforeEach(() => {
    galaxy = setupGalaxy();
    mockCache = new MockGameCache();
    market = new Market(mockCache as unknown as GameCache, galaxy);

    // Set up market data
    mockCache.setMockPrices("base_sol", [
      { itemId: "ore_iron", itemName: "Iron Ore", buyPrice: 10, sellPrice: 8, buyVolume: 100, sellVolume: 50 },
      { itemId: "ore_copper", itemName: "Copper Ore", buyPrice: 15, sellPrice: 12, buyVolume: 50, sellVolume: 30 },
    ]);
    mockCache.setMockPrices("base_alpha", [
      { itemId: "ore_iron", itemName: "Iron Ore", buyPrice: 8, sellPrice: 6, buyVolume: 200, sellVolume: 80 },
      { itemId: "ore_copper", itemName: "Copper Ore", buyPrice: 20, sellPrice: 18, buyVolume: 30, sellVolume: 20 },
    ]);
    mockCache.setMockPrices("base_gamma", [
      { itemId: "ore_iron", itemName: "Iron Ore", buyPrice: 12, sellPrice: 15, buyVolume: 50, sellVolume: 100 },
      { itemId: "rare_mineral", itemName: "Rare Mineral", buyPrice: 50, sellPrice: null, buyVolume: 10, sellVolume: 0 },
    ]);
  });

  test("getPrices returns cached data", () => {
    const prices = market.getPrices("base_sol");
    expect(prices).not.toBeNull();
    expect(prices!.length).toBe(2);
  });

  test("getPrices returns null for uncached station", () => {
    expect(market.getPrices("unknown_station")).toBeNull();
  });

  test("findBestBuy finds cheapest buy price", () => {
    const stations = ["base_sol", "base_alpha", "base_gamma"];
    const best = market.findBestBuy("ore_iron", stations);
    expect(best).not.toBeNull();
    expect(best!.stationId).toBe("base_alpha"); // 8 cr cheapest
    expect(best!.price).toBe(8);
  });

  test("findBestBuy returns null when item not found", () => {
    expect(market.findBestBuy("nonexistent", ["base_sol"])).toBeNull();
  });

  test("findBestSell finds highest sell price", () => {
    const stations = ["base_sol", "base_alpha", "base_gamma"];
    const best = market.findBestSell("ore_iron", stations);
    expect(best).not.toBeNull();
    expect(best!.stationId).toBe("base_gamma"); // 15 cr highest
    expect(best!.price).toBe(15);
  });

  test("findBestSell returns null when no buy orders", () => {
    // rare_mineral only has buyPrice (sell orders), no sellPrice (buy orders)
    expect(market.findBestSell("rare_mineral", ["base_gamma"])).toBeNull();
  });

  test("findArbitrage finds profitable routes", () => {
    const stations = ["base_sol", "base_alpha", "base_gamma"];
    const routes = market.findArbitrage(stations, "sol");

    expect(routes.length).toBeGreaterThan(0);
    // All routes should have positive profit
    for (const route of routes) {
      expect(route.profitPerUnit).toBeGreaterThan(0);
      expect(route.profitPerTick).toBeGreaterThan(0);
    }
  });

  test("findArbitrage sorts by trip profit per tick (volume-aware)", () => {
    const stations = ["base_sol", "base_alpha", "base_gamma"];
    const routes = market.findArbitrage(stations, "sol");

    for (let i = 1; i < routes.length; i++) {
      expect(routes[i - 1].tripProfitPerTick).toBeGreaterThanOrEqual(routes[i].tripProfitPerTick);
    }
  });

  test("findArbitrage includes iron: buy cheap at alpha, sell high at gamma", () => {
    const stations = ["base_sol", "base_alpha", "base_gamma"];
    const routes = market.findArbitrage(stations, "sol");

    const ironRoute = routes.find(
      (r) => r.itemId === "ore_iron" && r.buyStationId === "base_alpha" && r.sellStationId === "base_gamma"
    );
    expect(ironRoute).not.toBeUndefined();
    expect(ironRoute!.buyPrice).toBe(8);
    expect(ironRoute!.sellPrice).toBe(15);
    expect(ironRoute!.profitPerUnit).toBe(7);
  });

  test("scoreTradeRoute factors in distance and cargo", () => {
    const routes = market.findArbitrage(["base_sol", "base_alpha", "base_gamma"], "sol");
    if (routes.length > 0) {
      const score = market.scoreTradeRoute(routes[0], 50, "sol");
      expect(score).toBeGreaterThan(0);
    }
  });

  test("getTrackedItems returns all unique item IDs", () => {
    const items = market.getTrackedItems(["base_sol", "base_alpha", "base_gamma"]);
    expect(items.has("ore_iron")).toBe(true);
    expect(items.has("ore_copper")).toBe(true);
    expect(items.has("rare_mineral")).toBe(true);
    expect(items.size).toBe(3);
  });

  test("buildPriceMap builds item → price map", () => {
    const priceMap = market.buildPriceMap("base_sol");
    expect(priceMap.get("ore_iron")).toBe(8); // sellPrice preferred
    expect(priceMap.get("ore_copper")).toBe(12);
  });

  test("buildPriceMap returns empty for unknown station", () => {
    const priceMap = market.buildPriceMap("unknown");
    expect(priceMap.size).toBe(0);
  });
});
