import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BotManager } from "../../src/bot/bot-manager";
import { buildMockDeps, MockApiClient, MockTrainingLogger, MockGameCache, setupTestGalaxy, mockPlayer, mockShip } from "../helpers/mocks";
import { Galaxy } from "../../src/core/galaxy";
import { Navigation } from "../../src/core/navigation";
import { Cargo } from "../../src/core/cargo";
import { Fuel } from "../../src/core/fuel";
import { Market } from "../../src/core/market";
import { Combat } from "../../src/core/combat";
import { Crafting } from "../../src/core/crafting";
import { Station } from "../../src/core/station";
import type { BotContext, Routine } from "../../src/bot/types";
import type { RoutineName } from "../../src/types/protocol";
import type { SharedServices, BotManagerConfig, ApiClientFactory } from "../../src/bot/bot-manager";

// ── Test Routines ──

const testMinerRoutine: Routine = async function* (ctx: BotContext) {
  yield "mining iron";
  yield "mining complete";
};

const testTraderRoutine: Routine = async function* (ctx: BotContext) {
  yield "buying goods";
  yield "selling goods";
};

const longRoutine: Routine = async function* (ctx: BotContext) {
  while (!ctx.shouldStop) {
    yield "looping";
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ── Setup ──

function setupManager(): {
  manager: BotManager;
  mockApis: Map<string, MockApiClient>;
  mockLogger: MockTrainingLogger;
} {
  const galaxy = setupTestGalaxy();
  const nav = new Navigation(galaxy);
  const cargo = new Cargo();
  const fuel = new Fuel(nav);
  const mockCache = new MockGameCache();
  const market = new Market(mockCache as any, galaxy);
  const combat = new Combat(galaxy);
  const crafting = new Crafting(cargo);
  const station = new Station(galaxy);
  const mockLogger = new MockTrainingLogger();

  const services: SharedServices = {
    galaxy,
    nav,
    market,
    cargo,
    fuel,
    combat,
    crafting,
    station,
    cache: mockCache as any,
    logger: mockLogger as any,
    sessionStore: null as any, // Not used in tests
  };

  const config: BotManagerConfig = {
    maxBots: 5,
    loginStaggerMs: 10, // Fast for tests
    snapshotIntervalSec: 1,
  };

  const mockApis = new Map<string, MockApiClient>();
  const apiFactory: ApiClientFactory = (username: string) => {
    const api = new MockApiClient(mockPlayer({ username }), mockShip());
    mockApis.set(username, api);
    return api as any;
  };

  const manager = new BotManager(config, services, apiFactory);
  manager.registerRoutines({
    miner: testMinerRoutine,
    trader: testTraderRoutine,
  });

  return { manager, mockApis, mockLogger };
}

describe("BotManager", () => {
  let manager: BotManager;
  let mockApis: Map<string, MockApiClient>;
  let mockLogger: MockTrainingLogger;

  beforeEach(() => {
    ({ manager, mockApis, mockLogger } = setupManager());
  });

  afterEach(async () => {
    await manager.shutdownAll();
  });

  // ── Bot Management ──

  test("addBot creates a bot", () => {
    const bot = manager.addBot("Bot1");
    expect(bot.username).toBe("Bot1");
    expect(bot.status).toBe("idle");
    expect(manager.botCount).toBe(1);
  });

  test("addBot respects max capacity", () => {
    for (let i = 0; i < 5; i++) {
      manager.addBot(`Bot${i}`);
    }
    expect(() => manager.addBot("Bot5")).toThrow("max capacity");
  });

  test("addBot rejects duplicates", () => {
    manager.addBot("Bot1");
    expect(() => manager.addBot("Bot1")).toThrow("already exists");
  });

  test("getBot returns bot by ID", () => {
    manager.addBot("Bot1");
    expect(manager.getBot("Bot1")).not.toBeNull();
    expect(manager.getBot("NonExistent")).toBeNull();
  });

  test("getAllBots returns all bots", () => {
    manager.addBot("Bot1");
    manager.addBot("Bot2");
    expect(manager.getAllBots().length).toBe(2);
  });

  test("removeBot shuts down and removes", async () => {
    manager.addBot("Bot1");
    expect(manager.botCount).toBe(1);

    const removed = await manager.removeBot("Bot1");
    expect(removed).toBe(true);
    expect(manager.botCount).toBe(0);
    expect(manager.getBot("Bot1")).toBeNull();
  });

  test("removeBot returns false for unknown bot", async () => {
    expect(await manager.removeBot("NonExistent")).toBe(false);
  });

  // ── Login ──

  test("loginBot logs in a single bot", async () => {
    manager.addBot("Bot1");
    await manager.loginBot("Bot1");
    expect(manager.getBot("Bot1")!.status).toBe("ready");
    expect(mockApis.get("Bot1")!.loginCalled).toBe(true);
  });

  test("loginBot throws for unknown bot", async () => {
    await expect(manager.loginBot("NonExistent")).rejects.toThrow("not found");
  });

  test("loginAll logs in all idle bots with staggering", async () => {
    manager.addBot("Bot1");
    manager.addBot("Bot2");
    manager.addBot("Bot3");

    const result = await manager.loginAll();
    expect(result.success.length).toBe(3);
    expect(result.failed.length).toBe(0);

    for (const bot of manager.getAllBots()) {
      expect(bot.status).toBe("ready");
    }
  });

  test("loginAll reports failures", async () => {
    manager.addBot("Bot1");
    manager.addBot("FailBot");

    // Make FailBot's API fail
    // We need to login Bot1 first so the factory creates its API
    // Actually, the API is created when addBot is called via the factory
    mockApis.get("FailBot")!.loginShouldFail = true;

    const result = await manager.loginAll();
    expect(result.success.length).toBe(1);
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].username).toBe("FailBot");
  });

  // ── Routine Assignment ──

  test("assignRoutine starts a routine on a bot", async () => {
    manager.addBot("Bot1");
    await manager.loginBot("Bot1");
    await manager.assignRoutine("Bot1", "miner" as RoutineName);

    const bot = manager.getBot("Bot1")!;
    expect(bot.status).toBe("running");
    expect(bot.routine).toBe("miner");
  });

  test("assignRoutine throws for unknown routine", async () => {
    manager.addBot("Bot1");
    await manager.loginBot("Bot1");
    await expect(
      manager.assignRoutine("Bot1", "nonexistent" as RoutineName)
    ).rejects.toThrow("Unknown routine");
  });

  test("assignRoutine throws for unknown bot", async () => {
    await expect(
      manager.assignRoutine("NonExistent", "miner" as RoutineName)
    ).rejects.toThrow("not found");
  });

  test("stopBot stops a running bot", async () => {
    manager.addBot("Bot1");
    await manager.loginBot("Bot1");

    // Register long routine for testing
    manager.registerRoutines({ miner: longRoutine });
    await manager.assignRoutine("Bot1", "miner" as RoutineName);
    await new Promise((r) => setTimeout(r, 30));

    await manager.stopBot("Bot1");
    expect(manager.getBot("Bot1")!.status).toBe("ready");
  });

  // ── Fleet Status ──

  test("getFleetStatus returns correct data", async () => {
    manager.addBot("Bot1");
    manager.addBot("Bot2");
    await manager.loginBot("Bot1");

    const status = manager.getFleetStatus();
    expect(status.bots.length).toBe(2);
    expect(status.totalCredits).toBe(5000); // Only Bot1 is logged in
    expect(status.activeBots).toBe(0); // None running
  });

  test("getFleetStatus tracks active bots", async () => {
    manager.addBot("Bot1");
    await manager.loginBot("Bot1");

    manager.registerRoutines({ miner: longRoutine });
    await manager.assignRoutine("Bot1", "miner" as RoutineName);
    await new Promise((r) => setTimeout(r, 20));

    const status = manager.getFleetStatus();
    expect(status.activeBots).toBe(1);
  });

  test("getSummaries returns BotSummary array", async () => {
    manager.addBot("Bot1");
    await manager.loginBot("Bot1");

    const summaries = manager.getSummaries();
    expect(summaries.length).toBe(1);
    expect(summaries[0].username).toBe("Bot1");
    expect(summaries[0].status).toBe("ready");
    expect(summaries[0].credits).toBe(5000);
  });

  // ── Shutdown ──

  test("shutdownBot shuts down a single bot", async () => {
    manager.addBot("Bot1");
    await manager.loginBot("Bot1");
    await manager.shutdownBot("Bot1");

    expect(manager.getBot("Bot1")!.status).toBe("idle");
  });

  test("shutdownAll shuts down all bots", async () => {
    manager.addBot("Bot1");
    manager.addBot("Bot2");
    await manager.loginAll();

    await manager.shutdownAll();

    for (const bot of manager.getAllBots()) {
      expect(bot.status).toBe("idle");
    }
  });

  // ── Snapshots ──

  test("startSnapshots creates timer", () => {
    manager.addBot("Bot1");
    manager.startSnapshots();
    // Just verify it doesn't throw
    manager.stopSnapshots();
  });

  test("snapshots capture running bot state", async () => {
    manager.addBot("Bot1");
    await manager.loginBot("Bot1");

    manager.registerRoutines({ miner: longRoutine });
    await manager.assignRoutine("Bot1", "miner" as RoutineName);
    await new Promise((r) => setTimeout(r, 20));

    manager.startSnapshots();
    // Wait for at least one snapshot interval (1s in test config)
    await new Promise((r) => setTimeout(r, 1200));
    manager.stopSnapshots();

    expect(mockLogger.snapshots.length).toBeGreaterThanOrEqual(1);
  });
});
