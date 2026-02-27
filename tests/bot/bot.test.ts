import { describe, test, expect, beforeEach } from "bun:test";
import { Bot } from "../../src/bot/bot";
import { buildMockDeps, MockApiClient } from "../helpers/mocks";
import type { BotContext, Routine } from "../../src/bot/types";
import type { RoutineName } from "../../src/types/protocol";

// ── Test Routines ──

/** Simple routine that yields 3 states then completes */
const simpleRoutine: Routine = async function* (ctx: BotContext) {
  yield "step 1";
  yield "step 2";
  yield "step 3";
};

/** Routine that checks shouldStop */
const stoppableRoutine: Routine = async function* (ctx: BotContext) {
  let i = 0;
  while (!ctx.shouldStop) {
    i++;
    yield `cycle ${i}`;
    // Small delay to allow stop signal
    await new Promise((r) => setTimeout(r, 10));
  }
  yield "stopping gracefully";
};

/** Routine that throws */
const errorRoutine: Routine = async function* (_ctx: BotContext) {
  yield "about to fail";
  throw new Error("Routine exploded");
};

/** Routine that reads context */
const contextRoutine: Routine = async function* (ctx: BotContext) {
  yield `bot: ${ctx.username}`;
  yield `credits: ${ctx.player.credits}`;
  yield `fuel: ${ctx.ship.fuel}`;
  yield `params: ${JSON.stringify(ctx.params)}`;
};

describe("Bot", () => {
  let bot: Bot;
  let deps: ReturnType<typeof buildMockDeps>;

  beforeEach(() => {
    bot = new Bot("bot1", "TestBot");
    deps = buildMockDeps();
    bot.setDeps(deps);
  });

  // ── State Machine ──

  test("starts in idle state", () => {
    expect(bot.status).toBe("idle");
    expect(bot.routine).toBeNull();
    expect(bot.player).toBeNull();
    expect(bot.ship).toBeNull();
  });

  test("login transitions to ready", async () => {
    await bot.login();
    expect(bot.status).toBe("ready");
    expect(bot.player).not.toBeNull();
    expect(bot.ship).not.toBeNull();
    expect(bot.player!.credits).toBe(5000);
    expect(deps.mockApi.loginCalled).toBe(true);
  });

  test("login failure transitions to error", async () => {
    deps.mockApi.loginShouldFail = true;
    await expect(bot.login()).rejects.toThrow("Login failed");
    expect(bot.status).toBe("error");
    expect(bot.error).toContain("Login failed");
  });

  test("login from error state works (retry)", async () => {
    deps.mockApi.loginShouldFail = true;
    try { await bot.login(); } catch {}
    expect(bot.status).toBe("error");

    deps.mockApi.loginShouldFail = false;
    await bot.login();
    expect(bot.status).toBe("ready");
  });

  test("login is idempotent when already ready", async () => {
    await bot.login();
    expect(bot.status).toBe("ready");
    // Calling login again should be a no-op, not throw
    await bot.login();
    expect(bot.status).toBe("ready");
  });

  test("cannot assign routine without deps", async () => {
    const rawBot = new Bot("raw", "Raw");
    await expect(
      rawBot.assignRoutine("miner" as RoutineName, simpleRoutine)
    ).rejects.toThrow("Bot deps not set");
  });

  test("cannot assign routine when idle", async () => {
    await expect(
      bot.assignRoutine("miner" as RoutineName, simpleRoutine)
    ).rejects.toThrow("Cannot assign routine from state: idle");
  });

  // ── Routine Execution ──

  test("assign routine transitions to running", async () => {
    await bot.login();
    await bot.assignRoutine("miner" as RoutineName, simpleRoutine);
    expect(bot.status).toBe("running");
    expect(bot.routine).toBe("miner");
  });

  test("simple routine completes and returns to ready", async () => {
    await bot.login();
    await bot.assignRoutine("miner" as RoutineName, simpleRoutine);

    // Wait for the generator to finish
    await new Promise((r) => setTimeout(r, 50));

    expect(bot.status).toBe("ready");
    expect(bot.routine).toBeNull();
  });

  test("routine state label updates as it runs", async () => {
    await bot.login();
    await bot.assignRoutine("miner" as RoutineName, simpleRoutine);

    // The routine runs async, first state should be set quickly
    expect(bot.routineState).not.toBe("");
  });

  test("stoppable routine responds to stop signal", async () => {
    await bot.login();
    await bot.assignRoutine("miner" as RoutineName, stoppableRoutine);

    // Let it run a few cycles
    await new Promise((r) => setTimeout(r, 50));
    expect(bot.status).toBe("running");

    // Request stop
    bot.requestStop();
    expect(bot.status).toBe("stopping");

    // Wait for graceful stop
    await new Promise((r) => setTimeout(r, 100));
    expect(bot.status).toBe("ready");
    expect(bot.routine).toBeNull();
  });

  test("stopRoutine stops and returns to ready", async () => {
    await bot.login();
    await bot.assignRoutine("miner" as RoutineName, stoppableRoutine);

    await new Promise((r) => setTimeout(r, 30));
    await bot.stopRoutine();

    expect(bot.status).toBe("ready");
    expect(bot.routine).toBeNull();
    expect(bot.routineState).toBe("");
  });

  test("error routine transitions to error state", async () => {
    await bot.login();
    await bot.assignRoutine("miner" as RoutineName, errorRoutine);

    // Wait for error
    await new Promise((r) => setTimeout(r, 50));

    expect(bot.status).toBe("error");
    expect(bot.error).toContain("Routine exploded");
  });

  test("context routine accesses BotContext correctly", async () => {
    await bot.login();
    await bot.assignRoutine("miner" as RoutineName, contextRoutine, { target: "iron" });

    // Wait for completion
    await new Promise((r) => setTimeout(r, 50));
    expect(bot.status).toBe("ready");
  });

  // ── Reassignment ──

  test("assigning new routine while running stops old one", async () => {
    await bot.login();

    // Dummy long-running routine
    const longRoutine: Routine = async function* (ctx) {
      while (!ctx.shouldStop) {
        yield "looping";
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    await bot.assignRoutine("miner" as RoutineName, longRoutine);
    await new Promise((r) => setTimeout(r, 30));
    expect(bot.routine).toBe("miner");

    // Reassign to trader
    await bot.assignRoutine("trader" as RoutineName, simpleRoutine, { route: "test" });
    expect(bot.routine).toBe("trader");
    expect(bot.status).toBe("running");
  });

  // ── Shutdown ──

  test("shutdown stops everything and returns to idle", async () => {
    await bot.login();
    await bot.assignRoutine("miner" as RoutineName, stoppableRoutine);
    await new Promise((r) => setTimeout(r, 30));

    await bot.shutdown();

    expect(bot.status).toBe("idle");
    expect(bot.player).toBeNull();
    expect(bot.ship).toBeNull();
    expect(bot.routine).toBeNull();
    expect(deps.mockApi.logoutCalled).toBe(true);
  });

  test("shutdown from ready state works", async () => {
    await bot.login();
    await bot.shutdown();

    expect(bot.status).toBe("idle");
    expect(deps.mockApi.logoutCalled).toBe(true);
  });

  // ── Summary ──

  test("toSummary returns correct shape", async () => {
    await bot.login();
    const summary = bot.toSummary();

    expect(summary.id).toBe("bot1");
    expect(summary.username).toBe("TestBot");
    expect(summary.empire).toBe("solarian");
    expect(summary.status).toBe("ready");
    expect(summary.credits).toBe(5000);
    expect(summary.fuelPct).toBe(80);
    expect(summary.cargoPct).toBe(20); // 10/50
    expect(summary.hullPct).toBe(100);
    expect(summary.docked).toBe(true);
  });

  test("toSummary handles null state", () => {
    const summary = bot.toSummary();
    expect(summary.credits).toBe(0);
    expect(summary.fuelPct).toBe(0);
    expect(summary.status).toBe("idle");
  });

  test("uptime tracks login time", async () => {
    expect(bot.uptime).toBe(0);
    await bot.login();
    await new Promise((r) => setTimeout(r, 20));
    expect(bot.uptime).toBeGreaterThan(10);
  });
});
