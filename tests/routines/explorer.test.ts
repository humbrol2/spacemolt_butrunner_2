import { describe, test, expect } from "bun:test";
import { explorer } from "../../src/routines/explorer";
import { buildMockContext, collectYields } from "./test-utils";

describe("Explorer Routine", () => {
  test("auto-discovers nearby systems when no target systems", async () => {
    const { ctx } = buildMockContext({ params: {} });
    const yields = await collectYields(explorer(ctx));
    expect(yields[0]).toContain("planning exploration route...");
  });

  test("explores a single system", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { targetSystems: ["sol"] },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: null },
    });

    const yields = await collectYields(explorer(ctx));

    expect(yields.some((y) => y.includes("surveying sol"))).toBe(true);
    expect(yields.some((y) => y.includes("scanning"))).toBe(true);
    expect(yields).toContain("exploration complete");
    expect(yields).toContain("cycle_complete");

    expect(tracker.calls).toContain("getSystem");
    expect(tracker.calls.some((c) => c.startsWith("travel:"))).toBe(true);
  });

  test("jumps to a different system", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { targetSystems: ["alpha"] },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: null },
    });

    const yields = await collectYields(explorer(ctx));

    expect(yields.some((y) => y.includes("jumping to alpha"))).toBe(true);
    expect(tracker.calls).toContain("jump:alpha");
  });

  test("explores multiple systems", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { targetSystems: ["sol", "alpha"] },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: null },
    });

    const yields = await collectYields(explorer(ctx));

    expect(yields.filter((y) => y.includes("surveying")).length).toBe(2);
    expect(yields).toContain("exploration complete");
  });

  test("enables cloaking when requested", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { targetSystems: ["sol"], useCloaking: true },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: null },
    });

    const yields = await collectYields(explorer(ctx));

    expect(yields).toContain("cloaking enabled");
    expect(tracker.calls).toContain("cloak:true");
    expect(tracker.calls).toContain("cloak:false");
  });

  test("submits intel to faction when enabled", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { targetSystems: ["sol"], submitIntel: true },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: null, factionId: "faction_1" },
    });

    const yields = await collectYields(explorer(ctx));

    expect(yields.some((y) => y.includes("intel submitted"))).toBe(true);
    expect(tracker.calls).toContain("factionSubmitIntel");
  });
});
