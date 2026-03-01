import { describe, test, expect } from "bun:test";
import { miner } from "../../src/routines/miner";
import { buildMockContext, collectYields, runUntilYield } from "./test-utils";

describe("Miner Routine", () => {
  test("auto-discovers targets when no target belt specified", async () => {
    const { ctx } = buildMockContext({ params: {} });
    const yields = await collectYields(miner(ctx));
    expect(yields[0]).toContain("discovering targets...");
  });

  test("completes a mining cycle", async () => {
    const { ctx, tracker, ship } = buildMockContext({
      params: { targetBelt: "sol_belt", sellStation: "base_earth" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { cargoCapacity: 15, cargoUsed: 0, cargo: [] },
    });

    // Mine depletes after 3 cycles, cargo becomes full
    tracker.mineDepletedAfter = 3;

    // Override mine to actually add items to cargo (like the real game does)
    (ctx.api as any).mine = async () => {
      const result = tracker.recordMine();
      if (result.quantity > 0) {
        const existing = ship.cargo.find((c) => c.itemId === result.resourceId);
        if (existing) existing.quantity += result.quantity;
        else ship.cargo.push({ itemId: result.resourceId, quantity: result.quantity });
        ship.cargoUsed += result.quantity;
      }
      return result;
    };

    const yields = await runUntilYield(ctx, miner(ctx), "cycle_complete");

    expect(yields).toContain("traveling to belt");
    expect(yields.some((y) => y.includes("mined"))).toBe(true);
    expect(yields.some((y) => y.includes("returning to station") || y.includes("selling"))).toBe(true);
    expect(yields).toContain("cycle_complete");

    // Verify API calls
    expect(tracker.calls).toContain("undock");
    expect(tracker.calls).toContain("travel:sol_belt");
    expect(tracker.calls.filter((c) => c === "mine").length).toBeGreaterThan(0);
  });

  test("deposits to storage when depositToStorage is true", async () => {
    const { ctx, tracker, ship } = buildMockContext({
      params: { targetBelt: "sol_belt", sellStation: "base_earth", depositToStorage: true },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { cargoCapacity: 10, cargoUsed: 0, cargo: [] },
    });

    // Override mine to actually add items to cargo
    (ctx.api as any).mine = async () => {
      const result = tracker.recordMine();
      if (result.quantity > 0) {
        const existing = ship.cargo.find((c) => c.itemId === result.resourceId);
        if (existing) existing.quantity += result.quantity;
        else ship.cargo.push({ itemId: result.resourceId, quantity: result.quantity });
        ship.cargoUsed += result.quantity;
      }
      return result;
    };

    tracker.mineDepletedAfter = 2;
    const yields = await runUntilYield(ctx, miner(ctx), "cycle_complete");

    expect(yields.some((y) => y.startsWith("depositing cargo"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("factionDepositItems:"))).toBe(true);
  });

  test("handles belt depletion", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { targetBelt: "sol_belt", sellStation: "base_earth" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
      ship: { cargoCapacity: 100, cargoUsed: 0, cargo: [] },
    });

    // Deplete immediately
    tracker.mineDepletedAfter = 0;
    const yields = await runUntilYield(ctx, miner(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("belt depleted"))).toBe(true);
  });

  test("handles fuel emergency", async () => {
    const { ctx } = buildMockContext({
      params: { targetBelt: "sol_belt" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { fuel: 5, maxFuel: 100, cargoCapacity: 50, cargoUsed: 0, cargo: [] },
    });

    const yields = await runUntilYield(ctx, miner(ctx), "cycle_complete", 20);
    expect(yields.some((y) => y.includes("emergency") || y.includes("fuel"))).toBe(true);
  });

  test("stops when shouldStop is set", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { targetBelt: "sol_belt", sellStation: "base_earth" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
      ship: { cargoCapacity: 100, cargoUsed: 0, cargo: [] },
    });

    // Stop after first mine
    let mineCount = 0;
    const origMine = ctx.api.mine.bind(ctx.api);
    (ctx.api as any).mine = async () => {
      mineCount++;
      if (mineCount >= 2) ctx.shouldStop = true;
      return tracker.recordMine();
    };

    const yields = await collectYields(miner(ctx), 20);
    expect(yields.length).toBeLessThan(20);
  });
});
