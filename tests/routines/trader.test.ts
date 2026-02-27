import { describe, test, expect } from "bun:test";
import { trader } from "../../src/routines/trader";
import { buildMockContext, collectYields, runUntilYield } from "./test-utils";
import { MockGameCache } from "../helpers/mocks";

/** Set up sell station prices so trader's profit guard passes */
function setSellStationPrices(ctx: any, stationId: string, items: Array<{ itemId: string; sellPrice: number }>) {
  const cache = ctx.cache as MockGameCache;
  cache.marketPricesData.set(stationId, items.map((i) => ({ itemId: i.itemId, buyPrice: 0, sellPrice: i.sellPrice })));
}

describe("Trader Routine", () => {
  test("auto-discovers trade route when params empty", async () => {
    const { ctx } = buildMockContext({ params: {} });
    const yields = await collectYields(trader(ctx));
    expect(yields[0]).toContain("discovering trade route...");
  });

  test("completes a buy-sell round trip", async () => {
    const { ctx, tracker } = buildMockContext({
      params: {
        buyStation: "base_earth",
        sellStation: "base_alpha",
        item: "refined_steel",
        maxRoundTrips: 1,
      },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", credits: 10000 },
      ship: { cargoCapacity: 50, cargoUsed: 0, cargo: [] },
    });

    // Provide cached sell prices so profit guard passes (sell 50 > buy 25)
    setSellStationPrices(ctx, "base_alpha", [{ itemId: "refined_steel", sellPrice: 50 }]);

    const yields = await collectYields(trader(ctx));

    expect(yields).toContain("traveling to buy station");
    expect(yields.some((y) => y.includes("buying") || y.includes("bought"))).toBe(true);
    expect(yields).toContain("traveling to sell station");
    expect(yields.some((y) => y.includes("selling") || y.includes("sold"))).toBe(true);
    expect(yields).toContain("cycle_complete");
    expect(yields.some((y) => y.includes("completed 1 round trip"))).toBe(true);

    // Verify API flow
    expect(tracker.calls.some((c) => c.startsWith("buy:"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("sell:"))).toBe(true);
  });

  test("uses orders when useOrders is true", async () => {
    const { ctx, tracker } = buildMockContext({
      params: {
        buyStation: "base_earth",
        sellStation: "base_alpha",
        item: "refined_steel",
        maxRoundTrips: 1,
        useOrders: true,
        maxBuyPrice: 30,
        minSellPrice: 35,
      },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { cargoCapacity: 50, cargoUsed: 0, cargo: [] },
    });

    // Provide cached sell prices so profit guard passes
    setSellStationPrices(ctx, "base_alpha", [{ itemId: "refined_steel", sellPrice: 50 }]);

    // Order-based buy doesn't add cargo, so routine will try next route then wait — stop after order placed
    const yields = await runUntilYield(ctx, trader(ctx), "buy order placed");

    expect(yields.some((y) => y.includes("buy order placed"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("createBuyOrder:"))).toBe(true);
  });

  test("respects maxRoundTrips", async () => {
    const { ctx } = buildMockContext({
      params: {
        buyStation: "base_earth",
        sellStation: "base_alpha",
        item: "refined_steel",
        maxRoundTrips: 2,
      },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", credits: 50000 },
      ship: { cargoCapacity: 50, cargoUsed: 0, cargo: [] },
    });

    // Provide cached sell prices so profit guard passes
    setSellStationPrices(ctx, "base_alpha", [{ itemId: "refined_steel", sellPrice: 50 }]);

    const yields = await collectYields(trader(ctx));
    const cycleCompletes = yields.filter((y) => y === "cycle_complete");
    expect(cycleCompletes.length).toBe(2);
    expect(yields.some((y) => y.includes("completed 2 round trips"))).toBe(true);
  });

  test("handles fuel emergency", async () => {
    const { ctx } = buildMockContext({
      params: {
        buyStation: "base_earth",
        sellStation: "base_alpha",
        item: "refined_steel",
        maxRoundTrips: 1,
      },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { fuel: 5, maxFuel: 100, cargoCapacity: 50, cargoUsed: 0, cargo: [] },
    });

    // Provide cached sell prices so profit guard passes
    setSellStationPrices(ctx, "base_alpha", [{ itemId: "refined_steel", sellPrice: 50 }]);

    const yields = await collectYields(trader(ctx), 20);
    expect(yields.some((y) => y.includes("emergency"))).toBe(true);
  });
});
