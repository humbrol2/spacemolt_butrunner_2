import { describe, test, expect } from "bun:test";
import { salvager } from "../../src/routines/salvager";
import { buildMockContext, collectYields, runUntilYield } from "./test-utils";

describe("Salvager Routine", () => {
  test("yields cycle_complete when no wrecks found", async () => {
    const { ctx } = buildMockContext({
      params: {},
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
    });

    const yields = await runUntilYield(ctx, salvager(ctx), "cycle_complete");

    expect(yields).toContain("scanning for wrecks");
    expect(yields).toContain("no wrecks found");
    expect(yields).toContain("cycle_complete");
  });

  test("tows and scraps a wreck", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { salvageYard: "base_earth", scrapMethod: "scrap" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
    });

    // Mock wrecks
    (ctx.api as any).getWrecks = async () => {
      tracker.calls.push("getWrecks");
      return [{ id: "wreck_1", items: [] }];
    };

    const yields = await runUntilYield(ctx, salvager(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("towing wreck wreck_1"))).toBe(true);
    expect(tracker.calls).toContain("towWreck:wreck_1");
    expect(tracker.calls).toContain("scrapWreck");
    expect(yields).toContain("cycle_complete");
  });

  test("sells wreck when scrapMethod is sell", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { salvageYard: "base_earth", scrapMethod: "sell" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
    });

    (ctx.api as any).getWrecks = async () => {
      tracker.calls.push("getWrecks");
      return [{ id: "wreck_1", items: [] }];
    };

    const yields = await runUntilYield(ctx, salvager(ctx), "cycle_complete");

    expect(tracker.calls).toContain("sellWreck");
  });

  test("falls back to sell when scrap fails", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { salvageYard: "base_earth", scrapMethod: "scrap" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
    });

    (ctx.api as any).getWrecks = async () => {
      tracker.calls.push("getWrecks");
      return [{ id: "wreck_1", items: [] }];
    };

    (ctx.api as any).scrapWreck = async () => {
      tracker.calls.push("scrapWreck");
      throw new Error("Insufficient salvaging skill");
    };

    const yields = await runUntilYield(ctx, salvager(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("scrap failed, selling instead"))).toBe(true);
    expect(tracker.calls).toContain("sellWreck");
  });

  test("filters by target wrecks", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { targetWrecks: ["wreck_2"], salvageYard: "base_earth" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
    });

    (ctx.api as any).getWrecks = async () => {
      tracker.calls.push("getWrecks");
      return [{ id: "wreck_1", items: [] }, { id: "wreck_2", items: [] }];
    };

    const yields = await runUntilYield(ctx, salvager(ctx), "cycle_complete");

    expect(tracker.calls).toContain("towWreck:wreck_2");
    expect(tracker.calls).not.toContain("towWreck:wreck_1");
  });
});
