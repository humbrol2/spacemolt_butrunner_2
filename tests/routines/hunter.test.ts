import { describe, test, expect } from "bun:test";
import { hunter } from "../../src/routines/hunter";
import { buildMockContext, collectYields, runUntilYield } from "./test-utils";

describe("Hunter Routine", () => {
  test("patrols and yields cycle_complete with no targets", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { engagementRules: "all" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
    });

    const yields = await runUntilYield(ctx, hunter(ctx), "cycle_complete");

    expect(yields).toContain("scanning for targets");
    expect(yields).toContain("no targets found, patrolling");
    expect(yields).toContain("cycle_complete");
    expect(tracker.calls).toContain("getNearby");
  });

  test("undocks before patrolling", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { engagementRules: "all" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
    });

    const yields = await runUntilYield(ctx, hunter(ctx), "cycle_complete");

    expect(tracker.calls).toContain("undock");
  });

  test("travels to hunt zone if specified", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { huntZone: "sol_belt", engagementRules: "all" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: null },
    });

    const yields = await runUntilYield(ctx, hunter(ctx), "cycle_complete");

    expect(yields).toContain("traveling to hunt zone");
    expect(tracker.calls).toContain("travel:sol_belt");
  });

  test("engages targets when found", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { engagementRules: "all" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
    });

    // Mock getNearby to return a target
    (ctx.api as any).getNearby = async () => {
      tracker.calls.push("getNearby");
      return [
        { playerId: "enemy1", username: "Pirate", shipClass: "fighter", factionId: null, factionTag: null, anonymous: false, inCombat: false },
      ];
    };

    const yields = await runUntilYield(ctx, hunter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("engaging Pirate"))).toBe(true);
    expect(tracker.calls).toContain("attack:enemy1");
  });

  test("flees when hull drops below threshold during battle", async () => {
    const { ctx, tracker, ship } = buildMockContext({
      params: { engagementRules: "all", fleeThreshold: 30 },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
      ship: { hull: 90, maxHull: 100 },
    });

    // Mock getNearby to return a target
    (ctx.api as any).getNearby = async () => {
      tracker.calls.push("getNearby");
      return [
        { playerId: "enemy1", username: "Pirate", shipClass: "fighter", factionId: null, factionTag: null, anonymous: false, inCombat: false },
      ];
    };

    // Mock getBattleStatus - simulate hull dropping during battle
    let battleTick = 0;
    (ctx.api as any).getBattleStatus = async () => {
      tracker.calls.push("getBattleStatus");
      battleTick++;
      // Simulate taking damage
      ship.hull = Math.max(10, 90 - battleTick * 30);
      return { id: "battle1", tick: battleTick, zone: "mid", stance: "fire", sides: [] };
    };

    const yields = await runUntilYield(ctx, hunter(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("fleeing"))).toBe(true);
    expect(tracker.calls).toContain("battle:flee");
  });

  test("checks wrecks during patrol", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { engagementRules: "all" },
      player: { currentSystem: "sol", currentPoi: "sol_belt", dockedAtBase: null },
    });

    const yields = await runUntilYield(ctx, hunter(ctx), "cycle_complete");

    expect(tracker.calls).toContain("getWrecks");
  });

  test("handles safety emergency", async () => {
    const { ctx } = buildMockContext({
      params: { engagementRules: "all" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
      ship: { fuel: 5, maxFuel: 100 },
    });

    const yields = await runUntilYield(ctx, hunter(ctx), "cycle_complete", 15);

    expect(yields.some((y) => y.includes("emergency"))).toBe(true);
  });
});
