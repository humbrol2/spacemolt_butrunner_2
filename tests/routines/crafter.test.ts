import { describe, test, expect } from "bun:test";
import { crafter } from "../../src/routines/crafter";
import { buildMockContext, collectYields, runUntilYield } from "./test-utils";

describe("Crafter Routine", () => {
  test("auto-discovers craftable recipes when no recipe specified", async () => {
    const { ctx } = buildMockContext({ params: {} });
    const yields = await collectYields(crafter(ctx));
    expect(yields[0]).toContain("analyzing recipes");
  });

  test("yields error for unknown recipe", async () => {
    const { ctx } = buildMockContext({ params: { recipeId: "unknown" } });
    const yields = await collectYields(crafter(ctx));
    expect(yields.some((y) => y.includes("unknown recipe"))).toBe(true);
  });

  test("crafts when materials are in cargo", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { recipeId: "recipe_iron_bar", count: 1 },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", skills: { crafting: 2 } },
      ship: { cargo: [{ itemId: "ore_iron", quantity: 10 }], cargoUsed: 10 },
    });

    const yields = await runUntilYield(ctx, crafter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("crafting"))).toBe(true);
    expect(yields.some((y) => y.includes("crafted"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("craft:"))).toBe(true);
    expect(yields).toContain("cycle_complete");
  });

  test("buys missing materials from market", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { recipeId: "recipe_iron_bar", count: 1, materialSource: "market" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", skills: { crafting: 2 }, credits: 10000 },
      ship: { cargo: [], cargoUsed: 0 },
    });

    const yields = await runUntilYield(ctx, crafter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("bought"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("buy:"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("craft:"))).toBe(true);
  });

  test("withdraws from storage when materialSource is storage", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { recipeId: "recipe_iron_bar", count: 1, materialSource: "storage" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", skills: { crafting: 2 } },
      ship: { cargo: [], cargoUsed: 0 },
    });

    const yields = await runUntilYield(ctx, crafter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("withdrew"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("withdrawItems:"))).toBe(true);
  });

  test("reports missing materials when source is cargo", async () => {
    const { ctx } = buildMockContext({
      params: { recipeId: "recipe_iron_bar", count: 1, materialSource: "cargo" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", skills: { crafting: 2 } },
      ship: { cargo: [], cargoUsed: 0 },
    });

    const yields = await collectYields(crafter(ctx));

    expect(yields.some((y) => y.includes("need") && y.includes("more"))).toBe(true);
    expect(yields).toContain("cycle_complete");
  });

  test("sells output when sellOutput is true", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { recipeId: "recipe_iron_bar", count: 1, sellOutput: true },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", skills: { crafting: 2 } },
      ship: { cargo: [{ itemId: "ore_iron", quantity: 10 }], cargoUsed: 10 },
    });

    const yields = await runUntilYield(ctx, crafter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("selling"))).toBe(true);
  });

  test("uses faction storage withdrawal when factionStorage setting is true", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { recipeId: "recipe_iron_bar", count: 1, materialSource: "storage" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", skills: { crafting: 2 } },
      ship: { cargo: [], cargoUsed: 0 },
    });

    // Enable faction storage
    ctx.settings.factionStorage = true;

    const yields = await runUntilYield(ctx, crafter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("withdrew") && y.includes("faction"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("factionWithdrawItems:"))).toBe(true);
  });

  test("uses faction withdrawal when fleet defaultStorageMode is faction_deposit", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { recipeId: "recipe_iron_bar", count: 1, materialSource: "storage" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", skills: { crafting: 2 } },
      ship: { cargo: [], cargoUsed: 0 },
    });

    // Enable via fleet config
    ctx.fleetConfig.defaultStorageMode = "faction_deposit";

    const yields = await runUntilYield(ctx, crafter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("withdrew") && y.includes("faction"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("factionWithdrawItems:"))).toBe(true);
  });

  test("deposits output when sellOutput is false", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { recipeId: "recipe_iron_bar", count: 1, sellOutput: false },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth", skills: { crafting: 2 } },
      ship: { cargo: [{ itemId: "ore_iron", quantity: 10 }], cargoUsed: 10 },
    });

    // Need iron_bar in cargo after craft for deposit
    (ctx.api as any).craft = async (recipeId: string, count?: number) => {
      tracker.calls.push(`craft:${recipeId}:${count ?? 1}`);
      ctx.ship.cargo.push({ itemId: "iron_bar", quantity: 1 });
      ctx.ship.cargoUsed += 1;
      return { recipeId, outputItem: "iron_bar", outputQuantity: 1, xpGained: {} };
    };

    const yields = await runUntilYield(ctx, crafter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("deposited"))).toBe(true);
    expect(tracker.calls.some((c) => c.startsWith("depositItems:iron_bar"))).toBe(true);
  });
});
