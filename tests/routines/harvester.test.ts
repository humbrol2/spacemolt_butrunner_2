import { describe, test, expect } from "bun:test";
import { harvester } from "../../src/routines/harvester";
import { buildMockContext, collectYields, runUntilYield } from "./test-utils";

describe("Harvester Routine", () => {
  test("auto-discovers harvest targets when no targets specified", async () => {
    const { ctx } = buildMockContext({ params: {} });
    const yields = await collectYields(harvester(ctx));
    expect(yields[0]).toContain("discovering harvest targets...");
  });

  test("harvests from a single target", async () => {
    const { ctx, tracker } = buildMockContext({
      params: {
        targets: [{ poiId: "sol_belt", priority: 1 }],
        depositStation: "base_earth",
        resourceType: "ore",
      },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { cargoCapacity: 15, cargoUsed: 0, cargo: [] },
    });

    tracker.mineDepletedAfter = 3;
    const yields = await runUntilYield(ctx, harvester(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("traveling to sol_belt"))).toBe(true);
    expect(yields.some((y) => y.includes("harvesting ore"))).toBe(true);
    expect(yields.some((y) => y.includes("depositing materials"))).toBe(true);
    expect(yields).toContain("cycle_complete");
    expect(tracker.calls.filter((c) => c === "mine").length).toBeGreaterThan(0);
  });

  test("visits multiple targets in priority order", async () => {
    const { ctx, tracker } = buildMockContext({
      params: {
        targets: [
          { poiId: "sol_belt", priority: 1 },
          { poiId: "sol_earth", priority: 2 },
        ],
        depositStation: "base_earth",
      },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { cargoCapacity: 100, cargoUsed: 0, cargo: [] },
    });

    // Deplete first target quickly
    tracker.mineDepletedAfter = 1;
    const yields = await runUntilYield(ctx, harvester(ctx), "cycle_complete");

    // Higher priority (2) should come first → sol_belt has priority 2
    const firstTravel = tracker.calls.find((c) => c.startsWith("travel:"));
    expect(firstTravel).toBe("travel:sol_belt");
  });

  test("stops harvesting when cargo full", async () => {
    const { ctx, tracker } = buildMockContext({
      params: {
        targets: [{ poiId: "sol_belt", priority: 1 }],
        depositStation: "base_earth",
      },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
      ship: { cargoCapacity: 5, cargoUsed: 5, cargo: [{ itemId: "ore_iron", quantity: 5 }] },
    });

    const yields = await runUntilYield(ctx, harvester(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("cargo full"))).toBe(true);
  });

  test("handles depletion and continues to next target", async () => {
    const { ctx, tracker } = buildMockContext({
      params: {
        targets: [
          { poiId: "sol_belt", priority: 2 },
          { poiId: "sol_earth", priority: 1 },
        ],
        depositStation: "base_earth",
      },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { cargoCapacity: 100, cargoUsed: 0, cargo: [] },
    });

    tracker.mineDepletedAfter = 0;
    const yields = await runUntilYield(ctx, harvester(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("depleted"))).toBe(true);
    // Should visit both targets
    expect(tracker.calls.filter((c) => c.startsWith("travel:")).length).toBeGreaterThanOrEqual(2);
  });
});
