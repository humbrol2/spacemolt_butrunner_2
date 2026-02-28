import { describe, test, expect, beforeEach } from "bun:test";
import { ScoringBrain } from "../../src/commander/scoring-brain";
import type { FleetBotInfo, FleetStatus } from "../../src/bot/types";
import type { EconomySnapshot } from "../../src/commander/types";
import type { Goal } from "../../src/types/config";

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

function makeFleet(bots: FleetBotInfo[]): FleetStatus {
  return {
    bots,
    totalCredits: bots.reduce((s, b) => s + b.credits, 0),
    activeBots: bots.filter((b) => b.status === "running").length,
  };
}

const emptyEconomy: EconomySnapshot = {
  deficits: [],
  surpluses: [],
  inventoryAlerts: [],
  totalRevenue: 0,
  totalCosts: 0,
  netProfit: 0,
  factionStorage: new Map(),
};

describe("ScoringBrain", () => {
  let brain: ScoringBrain;

  beforeEach(() => {
    brain = new ScoringBrain({
      reassignmentCooldownMs: 0, // Disable cooldown for tests
    });
  });

  // ── Basic Evaluation ──

  test("returns empty assignments for empty fleet", () => {
    const result = brain.evaluate({
      fleet: makeFleet([]),
      goals: [],
      economy: emptyEconomy,
      tick: 1,
    });

    expect(result.assignments).toEqual([]);
    expect(result.reasoning).toContain("No bots available");
  });

  test("assigns idle bots (ready status) to routines", () => {
    const bot = makeBot({ botId: "bot1", status: "ready", routine: null });
    const result = brain.evaluate({
      fleet: makeFleet([bot]),
      goals: [],
      economy: emptyEconomy,
      tick: 1,
    });

    // Should recommend an assignment for the unassigned bot
    expect(result.assignments.length).toBe(1);
    expect(result.assignments[0].botId).toBe("bot1");
    expect(result.assignments[0].routine).toBeDefined();
    expect(result.assignments[0].score).toBeGreaterThan(0);
  });

  test("does not reassign bots already on optimal routine (no improvement)", () => {
    // Bot already on miner (highest base score = 60)
    const bot = makeBot({ botId: "bot1", status: "running", routine: "miner" });
    const result = brain.evaluate({
      fleet: makeFleet([bot]),
      goals: [],
      economy: emptyEconomy,
      tick: 1,
    });

    // With no goals, miner has highest base score, should stay
    expect(result.assignments.length).toBe(0);
  });

  // ── Goal Influence ──

  test("maximize_income shifts assignments toward trader/miner", () => {
    const bot = makeBot({ botId: "bot1", status: "ready", routine: null });
    const goals: Goal[] = [{ type: "maximize_income", priority: 5, params: {} }];

    const result = brain.evaluate({
      fleet: makeFleet([bot]),
      goals,
      economy: emptyEconomy,
      tick: 1,
    });

    expect(result.assignments.length).toBe(1);
    // Should pick trader or miner (both have high weight × base score)
    expect(["trader", "miner", "crafter"]).toContain(result.assignments[0].routine);
  });

  test("prepare_for_war shifts assignments toward hunter", () => {
    const bot = makeBot({ botId: "bot1", status: "ready", routine: null });
    const goals: Goal[] = [{ type: "prepare_for_war", priority: 10, params: {} }];

    const result = brain.evaluate({
      fleet: makeFleet([bot]),
      goals,
      economy: emptyEconomy,
      tick: 1,
    });

    expect(result.assignments.length).toBe(1);
    // Hunter has 2.0x weight, miner has 1.2x but higher base - all are boosted for war
    expect(["hunter", "crafter", "miner"]).toContain(result.assignments[0].routine);
  });

  // ── Supply Chain Influence ──

  test("supply deficits boost relevant routines", () => {
    const bot = makeBot({ botId: "bot1", status: "ready", routine: null });
    const economy: EconomySnapshot = {
      ...emptyEconomy,
      deficits: [{
        itemId: "ore_iron",
        demandPerHour: 100,
        supplyPerHour: 0,
        shortfall: 100,
        priority: "critical",
      }],
    };

    const result = brain.evaluate({
      fleet: makeFleet([bot]),
      goals: [],
      economy,
      tick: 1,
    });

    expect(result.assignments.length).toBe(1);
    // Ore deficit should boost miner/harvester
    expect(["miner", "harvester", "trader"]).toContain(result.assignments[0].routine);
  });

  // ── Switch Cost ──

  test("switch cost penalizes role changes", () => {
    const bot = makeBot({ botId: "bot1", status: "running", routine: "miner", docked: false });

    // Score miner vs trader for this bot
    const fleet = makeFleet([bot]);
    const weights = { miner: 1, harvester: 1, trader: 1, explorer: 1, crafter: 1, hunter: 1, salvager: 1, mission_runner: 1, return_home: 0.1, scout: 0.1 };

    const minerScore = brain.scoreAssignment(bot, "miner", weights, emptyEconomy, fleet);
    const traderScore = brain.scoreAssignment(bot, "trader", weights, emptyEconomy, fleet);

    // Miner has no switch cost, trader has switch cost (not docked = 6 ticks)
    expect(minerScore.switchCost).toBe(0);
    expect(traderScore.switchCost).toBeGreaterThan(0);
  });

  test("docked bots have lower switch cost", () => {
    const dockedBot = makeBot({ botId: "bot1", routine: "miner", docked: true });
    const undockedBot = makeBot({ botId: "bot2", routine: "miner", docked: false });

    const fleet = makeFleet([dockedBot, undockedBot]);
    const weights = { miner: 1, harvester: 1, trader: 1, explorer: 1, crafter: 1, hunter: 1, salvager: 1, mission_runner: 1, return_home: 0.1, scout: 0.1 };

    const dockedScore = brain.scoreAssignment(dockedBot, "trader", weights, emptyEconomy, fleet);
    const undockedScore = brain.scoreAssignment(undockedBot, "trader", weights, emptyEconomy, fleet);

    expect(dockedScore.switchCost).toBeLessThan(undockedScore.switchCost);
  });

  // ── Diversity ──

  test("diversity penalty kicks in when too many bots on same routine", () => {
    const bots = [
      makeBot({ botId: "bot1", routine: "miner" }),
      makeBot({ botId: "bot2", routine: "miner" }),
      makeBot({ botId: "bot3", routine: "miner" }),
      makeBot({ botId: "bot4", status: "ready", routine: null }),
    ];
    const fleet = makeFleet(bots);
    const weights = { miner: 1, harvester: 1, trader: 1, explorer: 1, crafter: 1, hunter: 1, salvager: 1, mission_runner: 1, return_home: 0.1, scout: 0.1 };

    // Scoring miner for bot4 should have diversity penalty (3 miners already)
    const minerScore = brain.scoreAssignment(bots[3], "miner", weights, emptyEconomy, fleet);
    const traderScore = brain.scoreAssignment(bots[3], "trader", weights, emptyEconomy, fleet);

    expect(minerScore.diversityPenalty).toBeGreaterThan(0);
    expect(traderScore.diversityPenalty).toBe(0);
  });

  // ── Risk ──

  test("low fuel bots penalized for most routines", () => {
    const lowFuelBot = makeBot({ botId: "bot1", fuelPct: 10, routine: null, status: "ready" });
    const fleet = makeFleet([lowFuelBot]);
    const weights = { miner: 1, harvester: 1, trader: 1, explorer: 1, crafter: 1, hunter: 1, salvager: 1, mission_runner: 1, return_home: 0.1, scout: 0.1 };

    const minerScore = brain.scoreAssignment(lowFuelBot, "miner", weights, emptyEconomy, fleet);
    const traderScore = brain.scoreAssignment(lowFuelBot, "trader", weights, emptyEconomy, fleet);

    expect(minerScore.riskPenalty).toBeGreaterThan(0);
    // Trader gets heavy penalty at critical fuel
    expect(traderScore.riskPenalty).toBe(150);
  });

  // ── Cooldown ──

  test("respects reassignment cooldown", () => {
    const brain2 = new ScoringBrain({ reassignmentCooldownMs: 60_000 });
    const bot = makeBot({ botId: "bot1", status: "ready", routine: null });

    // First evaluation should assign
    const result1 = brain2.evaluate({
      fleet: makeFleet([bot]),
      goals: [],
      economy: emptyEconomy,
      tick: 1,
    });
    expect(result1.assignments.length).toBe(1);

    // Update bot to show it's now running the assigned routine
    bot.routine = result1.assignments[0].routine;
    bot.status = "running";

    // Second evaluation should not reassign (cooldown)
    const result2 = brain2.evaluate({
      fleet: makeFleet([bot]),
      goals: [{ type: "prepare_for_war", priority: 10, params: {} }],
      economy: emptyEconomy,
      tick: 2,
    });
    expect(result2.assignments.length).toBe(0);
  });

  test("clearCooldown allows immediate reassignment", () => {
    const brain2 = new ScoringBrain({ reassignmentCooldownMs: 60_000 });
    const bot = makeBot({ botId: "bot1", status: "ready", routine: null });

    brain2.evaluate({
      fleet: makeFleet([bot]),
      goals: [],
      economy: emptyEconomy,
      tick: 1,
    });

    // Clear cooldown
    brain2.clearCooldown("bot1");
    expect(brain2.canReassign("bot1", Date.now())).toBe(true);
  });

  // ── Reasoning ──

  test("reasoning includes goal and assignment summary", () => {
    const bot = makeBot({ botId: "bot1", status: "ready", routine: null });
    const goals: Goal[] = [{ type: "maximize_income", priority: 3, params: {} }];

    const result = brain.evaluate({
      fleet: makeFleet([bot]),
      goals,
      economy: emptyEconomy,
      tick: 1,
    });

    expect(result.reasoning).toContain("maximize_income");
    expect(result.reasoning).toContain("Reassigning 1 bot");
  });

  // ── Config Update ──

  test("updateConfig changes scoring behavior", () => {
    const bot = makeBot({ botId: "bot1", status: "ready", routine: null });

    // Default: miner has highest base score (60)
    const result1 = brain.evaluate({
      fleet: makeFleet([bot]),
      goals: [],
      economy: emptyEconomy,
      tick: 1,
    });
    expect(result1.assignments[0].routine).toBe("miner");

    // Boost miner base score to 100
    brain.updateConfig({
      baseScores: { ...brain["config"].baseScores, miner: 100 },
    });

    brain.clearAllCooldowns();
    const result2 = brain.evaluate({
      fleet: makeFleet([bot]),
      goals: [],
      economy: emptyEconomy,
      tick: 2,
    });
    expect(result2.assignments[0].routine).toBe("miner");
  });

  // ── Multi-Bot Assignment ──

  test("assigns different routines to multiple bots", () => {
    const bots = [
      makeBot({ botId: "bot1", status: "ready", routine: null }),
      makeBot({ botId: "bot2", status: "ready", routine: null }),
      makeBot({ botId: "bot3", status: "ready", routine: null }),
    ];

    const result = brain.evaluate({
      fleet: makeFleet(bots),
      goals: [],
      economy: emptyEconomy,
      tick: 1,
    });

    expect(result.assignments.length).toBe(3);
    // All should get assignments
    const assignedBots = result.assignments.map((a) => a.botId);
    expect(assignedBots).toContain("bot1");
    expect(assignedBots).toContain("bot2");
    expect(assignedBots).toContain("bot3");
  });
});
