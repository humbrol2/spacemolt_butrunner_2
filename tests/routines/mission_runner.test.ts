import { describe, test, expect } from "bun:test";
import { mission_runner } from "../../src/routines/mission_runner";
import { buildMockContext, collectYields, runUntilYield } from "./test-utils";
import type { Mission } from "../../src/types/game";

const testMission: Mission = {
  id: "mission_1",
  title: "Deliver Iron Ore",
  description: "Deliver 10 iron ore to Alpha Station",
  type: "delivery",
  objectives: [{ description: "Deliver 10 iron ore", progress: 0, target: 10, complete: false }],
  rewards: [{ type: "credits", amount: 500 }],
};

const exploreMission: Mission = {
  id: "mission_2",
  title: "Survey Alpha System",
  description: "Survey the Alpha system",
  type: "explore",
  objectives: [{ description: "Survey Alpha", progress: 0, target: 1, complete: false }],
  rewards: [{ type: "credits", amount: 200 }],
};

describe("Mission Runner Routine", () => {
  test("yields no suitable missions when none match", async () => {
    const { ctx } = buildMockContext({
      params: { autoAccept: true, missionTypes: ["delivery"], minReward: 1000 },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
    });

    // Mock missions with low reward
    (ctx.api as any).getMissions = async () => [exploreMission];

    const yields = await runUntilYield(ctx, mission_runner(ctx), "cycle_complete");

    expect(yields).toContain("browsing missions");
    expect(yields.some((y) => y.includes("no suitable missions"))).toBe(true);
    expect(yields).toContain("cycle_complete");
  });

  test("accepts and completes a mission", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { autoAccept: true },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
    });

    (ctx.api as any).getMissions = async () => {
      tracker.calls.push("getMissions");
      return [testMission];
    };

    (ctx.api as any).getActiveMissions = async () => {
      tracker.calls.push("getActiveMissions");
      return [testMission];
    };

    const yields = await runUntilYield(ctx, mission_runner(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("accepting"))).toBe(true);
    expect(tracker.calls).toContain("acceptMission:mission_1");
    expect(yields.some((y) => y.includes("executing mission"))).toBe(true);
    expect(yields).toContain("cycle_complete");
  });

  test("filters by mission type", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { autoAccept: true, missionTypes: ["delivery"] },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
    });

    (ctx.api as any).getMissions = async () => [testMission, exploreMission];

    const yields = await runUntilYield(ctx, mission_runner(ctx), "cycle_complete");

    // Should accept delivery mission, not explore
    expect(tracker.calls).toContain("acceptMission:mission_1");
    expect(tracker.calls).not.toContain("acceptMission:mission_2");
  });

  test("filters by minimum reward", async () => {
    const { ctx } = buildMockContext({
      params: { autoAccept: true, minReward: 300 },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
    });

    (ctx.api as any).getMissions = async () => [testMission, exploreMission];

    const yields = await runUntilYield(ctx, mission_runner(ctx), "cycle_complete");

    // Should pick testMission (500cr) not exploreMission (200cr)
    expect(yields.some((y) => y.includes("accepting: Deliver Iron Ore"))).toBe(true);
  });

  test("does not accept when autoAccept is false", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { autoAccept: false },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
    });

    (ctx.api as any).getMissions = async () => [testMission];

    const yields = await runUntilYield(ctx, mission_runner(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("best mission:"))).toBe(true);
    expect(tracker.calls).not.toContain("acceptMission:mission_1");
  });

  test("abandons mission when completion fails", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { autoAccept: true },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: "base_earth" },
    });

    (ctx.api as any).getMissions = async () => [testMission];
    (ctx.api as any).getActiveMissions = async () => [testMission];
    (ctx.api as any).completeMission = async () => {
      tracker.calls.push("completeMission:fail");
      throw new Error("Objectives not met");
    };

    const yields = await runUntilYield(ctx, mission_runner(ctx), "cycle_complete");

    expect(yields.some((y) => y.includes("completion failed"))).toBe(true);
    expect(tracker.calls).toContain("abandonMission:mission_1");
  });

  test("navigates to hub station", async () => {
    const { ctx, tracker } = buildMockContext({
      params: { autoAccept: true, hubStation: "base_alpha" },
      player: { currentSystem: "sol", currentPoi: "sol_earth", dockedAtBase: null },
    });

    (ctx.api as any).getMissions = async () => [testMission];
    (ctx.api as any).getActiveMissions = async () => [testMission];

    const yields = await runUntilYield(ctx, mission_runner(ctx), "cycle_complete");

    expect(yields).toContain("traveling to mission hub");
    expect(tracker.calls).toContain("jump:alpha");
  });
});
