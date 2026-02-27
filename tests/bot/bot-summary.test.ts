import { describe, test, expect } from "bun:test";
import { Bot } from "../../src/bot/bot";
import { buildMockDeps, mockPlayer, mockShip } from "../helpers/mocks";

describe("Bot.toSummary name resolution", () => {
  test("resolves systemName from Galaxy", async () => {
    const bot = new Bot("bot1", "TestBot");
    const { mockApi, ...deps } = buildMockDeps();

    bot.setDeps(deps);
    await bot.login();

    const summary = bot.toSummary();
    // The mock galaxy has system "sol" with name "Sol"
    expect(summary.systemId).toBe("sol");
    expect(summary.systemName).toBe("Sol");
  });

  test("resolves poiName from Galaxy", async () => {
    const bot = new Bot("bot1", "TestBot");
    const { mockApi, ...deps } = buildMockDeps();

    bot.setDeps(deps);
    await bot.login();

    const summary = bot.toSummary();
    // The mock login result has currentPoi "sol_earth", galaxy has poi "sol_earth" named "Earth"
    expect(summary.poiId).toBe("sol_earth");
    expect(summary.poiName).toBe("Earth");
  });

  test("falls back to systemId when Galaxy has no data", async () => {
    const bot = new Bot("bot1", "TestBot");
    const player = mockPlayer({ currentSystem: "unknown_system", currentPoi: null });
    const ship = mockShip();
    const { mockApi, ...deps } = buildMockDeps();

    // Override the mock API to return a player in an unknown system
    const customApi = {
      ...deps.api,
      async login() {
        return {
          sessionId: "sess",
          player,
          ship,
          system: { id: "unknown_system", name: "Unknown", x: 0, y: 0, empire: null, policeLevel: 0, connections: [], pois: [] },
          poi: null,
        };
      },
      async logout() {},
      async getStatus() {
        return { player, ship };
      },
      get stats() {
        return { mutations: 0, queries: 0 };
      },
    };

    bot.setDeps({ ...deps, api: customApi as any });
    await bot.login();

    const summary = bot.toSummary();
    expect(summary.systemId).toBe("unknown_system");
    // Galaxy doesn't know about this system, so systemName falls back to systemId
    expect(summary.systemName).toBe("unknown_system");
    expect(summary.poiName).toBeNull();
  });

  test("returns null names when player is not logged in", () => {
    const bot = new Bot("bot1", "TestBot");
    const summary = bot.toSummary();

    expect(summary.systemId).toBeNull();
    expect(summary.systemName).toBeNull();
    expect(summary.poiId).toBeNull();
    expect(summary.poiName).toBeNull();
  });
});
