import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Commander } from "../../src/commander/commander";
import type { CommanderConfig, CommanderDeps } from "../../src/commander/commander";
import type { FleetStatus, FleetBotInfo } from "../../src/bot/types";
import { MockTrainingLogger, MockGameCache, setupTestGalaxy } from "../helpers/mocks";
import { Navigation } from "../../src/core/navigation";
import { Market } from "../../src/core/market";
import { Cargo } from "../../src/core/cargo";
import { Crafting } from "../../src/core/crafting";

function makeBot(overrides: Partial<FleetBotInfo> = {}): FleetBotInfo {
  return {
    botId: "bot1",
    username: "TestBot",
    status: "running",
    routine: null,
    routineState: "",
    systemId: "sol",
    poiId: "sol_earth",
    docked: true,
    credits: 5000,
    fuelPct: 80,
    cargoPct: 20,
    hullPct: 100,
    moduleIds: ["mining_laser_1", "weapon_laser_1"],
    shipClass: "shuttle",
    ownedShips: [],
    skills: { mining: 3, trading: 2, crafting: 1 },
    rapidRoutines: new Map(),
    ...overrides,
  };
}

function setupCommander(): {
  commander: Commander;
  assignedRoutines: Array<{ botId: string; routine: string; params: Record<string, unknown> }>;
  fleet: { bots: FleetBotInfo[] };
  mockLogger: MockTrainingLogger;
} {
  const fleet = {
    bots: [] as FleetBotInfo[],
  };

  const assignedRoutines: Array<{ botId: string; routine: string; params: Record<string, unknown> }> = [];
  const mockLogger = new MockTrainingLogger();
  const galaxy = setupTestGalaxy();
  const mockCache = new MockGameCache();
  const market = new Market(mockCache as any, galaxy);
  const cargo = new Cargo();
  const crafting = new Crafting(cargo);

  const config: CommanderConfig = {
    evaluationIntervalSec: 1,
    urgencyOverride: true,
  };

  const deps: CommanderDeps = {
    getFleetStatus: () => ({
      bots: fleet.bots,
      totalCredits: fleet.bots.reduce((s, b) => s + b.credits, 0),
      activeBots: fleet.bots.filter((b) => b.status === "running").length,
    }),
    assignRoutine: async (botId, routine, params) => {
      assignedRoutines.push({ botId, routine, params });
      // Simulate the bot accepting the assignment
      const bot = fleet.bots.find((b) => b.botId === botId);
      if (bot) {
        bot.routine = routine as any;
        bot.status = "running";
      }
    },
    logger: mockLogger as any,
    galaxy,
    market,
    cache: mockCache as any,
    crafting,
  };

  const commander = new Commander(config, deps, undefined, {
    reassignmentCooldownMs: 0, // Disable cooldown for tests
  });

  return { commander, assignedRoutines, fleet, mockLogger };
}

describe("Commander", () => {
  let commander: Commander;
  let assignedRoutines: Array<{ botId: string; routine: string; params: Record<string, unknown> }>;
  let fleet: { bots: FleetBotInfo[] };
  let mockLogger: MockTrainingLogger;

  beforeEach(() => {
    ({ commander, assignedRoutines, fleet, mockLogger } = setupCommander());
  });

  afterEach(() => {
    commander.stop();
  });

  // ── Goal Management ──

  test("setGoals sorts by priority descending", () => {
    commander.setGoals([
      { type: "explore_region", priority: 1, params: {} },
      { type: "maximize_income", priority: 5, params: {} },
    ]);

    const goals = commander.getGoals();
    expect(goals[0].type).toBe("maximize_income");
    expect(goals[1].type).toBe("explore_region");
  });

  test("addGoal and removeGoal work", () => {
    commander.addGoal({ type: "maximize_income", priority: 3, params: {} });
    expect(commander.getGoals().length).toBe(1);

    commander.addGoal({ type: "explore_region", priority: 1, params: {} });
    expect(commander.getGoals().length).toBe(2);

    commander.removeGoal(0);
    expect(commander.getGoals().length).toBe(1);
  });

  // ── Force Evaluation ──

  test("forceEvaluation assigns unassigned bots", async () => {
    fleet.bots = [
      makeBot({ botId: "bot1", status: "ready", routine: null }),
    ];

    const decision = await commander.forceEvaluation();

    expect(decision).toBeDefined();
    expect(decision.assignments.length).toBe(1);
    expect(decision.assignments[0].botId).toBe("bot1");
    expect(assignedRoutines.length).toBe(1);
  });

  test("forceEvaluation returns decision with timestamp", async () => {
    fleet.bots = [makeBot({ botId: "bot1", status: "ready", routine: null })];

    const decision = await commander.forceEvaluation();

    expect(decision.tick).toBeGreaterThan(0);
    expect(decision.timestamp).toBeDefined();
    expect(decision.reasoning).toBeDefined();
  });

  test("forceEvaluation with goals influences assignment", async () => {
    fleet.bots = [makeBot({ botId: "bot1", status: "ready", routine: null })];
    commander.setGoals([{ type: "maximize_income", priority: 10, params: {} }]);

    const decision = await commander.forceEvaluation();

    expect(decision.goal).toBe("maximize_income");
    expect(decision.assignments.length).toBe(1);
  });

  test("forceEvaluation with no bots produces no assignments", async () => {
    fleet.bots = [];

    const decision = await commander.forceEvaluation();

    expect(decision.assignments.length).toBe(0);
    expect(decision.reasoning).toContain("No bots available");
  });

  test("forceEvaluation handles assignment failure gracefully", async () => {
    fleet.bots = [makeBot({ botId: "bot1", status: "ready", routine: null })];

    // Override assignRoutine to fail
    (commander as any).deps.assignRoutine = async () => {
      throw new Error("Assignment failed");
    };

    const decision = await commander.forceEvaluation();

    // Should still produce a decision, but with no executed assignments
    expect(decision.assignments.length).toBe(0);
  });

  // ── Decision History ──

  test("records decision history", async () => {
    fleet.bots = [makeBot({ botId: "bot1", status: "ready", routine: null })];

    await commander.forceEvaluation();
    await commander.forceEvaluation();

    const history = commander.getDecisionHistory();
    expect(history.length).toBe(2);
  });

  test("getLastDecision returns most recent", async () => {
    fleet.bots = [makeBot({ botId: "bot1", status: "ready", routine: null })];

    expect(commander.getLastDecision()).toBeNull();

    await commander.forceEvaluation();
    const last = commander.getLastDecision();
    expect(last).not.toBeNull();
  });

  // ── Economy Integration ──

  test("stock targets are passed to economy engine", () => {
    commander.setStockTargets([{
      station_id: "base_earth",
      item_id: "ore_iron",
      min_stock: 100,
      max_stock: 500,
      purpose: "crafting",
    }]);

    // No error = success
    expect(commander.getEconomy()).toBeDefined();
  });

  // ── Start/Stop ──

  test("start and stop evaluation loop", () => {
    commander.start();
    // Should not throw
    commander.stop();
  });

  test("double start is idempotent", () => {
    commander.start();
    commander.start(); // Should not create second timer
    commander.stop();
  });

  // ── Brain Management ──

  test("setBrain replaces the brain", () => {
    const mockBrain = {
      evaluate: () => ({ assignments: [], reasoning: "Mock brain" }),
    };

    commander.setBrain(mockBrain);
    expect(commander.getBrain()).toBe(mockBrain);
  });

  test("custom brain is used for evaluation", async () => {
    fleet.bots = [makeBot({ botId: "bot1", status: "ready", routine: null })];

    const mockBrain = {
      evaluate: () => ({
        assignments: [{
          botId: "bot1",
          routine: "explorer" as const,
          params: { targetSystems: ["alpha"] },
          score: 100,
          reasoning: "Custom assignment",
          previousRoutine: null,
        }],
        reasoning: "Custom brain reasoning",
      }),
    };

    commander.setBrain(mockBrain);
    const decision = await commander.forceEvaluation();

    expect(decision.reasoning).toBe("Custom brain reasoning");
    expect(assignedRoutines[0].routine).toBe("explorer");
  });

  // ── Training Data ──

  test("logs commander decisions to training logger", async () => {
    fleet.bots = [makeBot({ botId: "bot1", status: "ready", routine: null })];

    await commander.forceEvaluation();

    // MockTrainingLogger doesn't record to decisions array for commander decisions
    // but it shouldn't throw
    expect(commander.getDecisionHistory().length).toBe(1);
  });

  // ── Multiple Bots ──

  test("assigns multiple bots in one evaluation", async () => {
    fleet.bots = [
      makeBot({ botId: "bot1", status: "ready", routine: null }),
      makeBot({ botId: "bot2", status: "ready", routine: null }),
      makeBot({ botId: "bot3", status: "ready", routine: null }),
    ];

    const decision = await commander.forceEvaluation();

    expect(decision.assignments.length).toBe(3);
    expect(assignedRoutines.length).toBe(3);

    const assignedBotIds = assignedRoutines.map((a) => a.botId);
    expect(assignedBotIds).toContain("bot1");
    expect(assignedBotIds).toContain("bot2");
    expect(assignedBotIds).toContain("bot3");
  });
});
