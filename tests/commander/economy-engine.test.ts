import { describe, test, expect, beforeEach } from "bun:test";
import { EconomyEngine } from "../../src/commander/economy-engine";
import type { FleetStatus, FleetBotInfo } from "../../src/bot/types";

function makeBot(overrides: Partial<FleetBotInfo> = {}): FleetBotInfo {
  return {
    botId: "bot1",
    username: "TestBot",
    status: "running",
    routine: "miner",
    routineState: "mining",
    systemId: "sol",
    poiId: "sol_belt",
    docked: false,
    credits: 5000,
    fuelPct: 80,
    cargoPct: 50,
    hullPct: 100,
    moduleIds: ["mining_laser_1"],
    shipClass: "shuttle",
    skills: { mining: 3 },
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

describe("EconomyEngine", () => {
  let engine: EconomyEngine;

  beforeEach(() => {
    engine = new EconomyEngine();
  });

  test("analyze produces empty snapshot for empty fleet", () => {
    const result = engine.analyze(makeFleet([]));
    expect(result.deficits).toEqual([]);
    expect(result.surpluses).toEqual([]);
    expect(result.inventoryAlerts).toEqual([]);
    expect(result.netProfit).toBe(0);
  });

  test("detects fuel demand for running bots", () => {
    const fleet = makeFleet([makeBot({ botId: "bot1", routine: "miner" })]);
    const result = engine.analyze(fleet);

    // Running bots create fuel demand
    const fuelDeficit = result.deficits.find((d) => d.itemId === "fuel");
    expect(fuelDeficit).toBeDefined();
    expect(fuelDeficit!.demandPerHour).toBeGreaterThan(0);
  });

  test("detects supply from miners", () => {
    const fleet = makeFleet([
      makeBot({ botId: "bot1", routine: "miner" }),
      makeBot({ botId: "bot2", routine: "miner" }),
    ]);
    const result = engine.analyze(fleet);

    // Miners should produce ore_iron surplus (2 miners produce 60/hr, no consumers)
    const ironSurplus = result.surpluses.find((s) => s.itemId === "ore_iron");
    expect(ironSurplus).toBeDefined();
    expect(ironSurplus!.excessPerHour).toBeGreaterThan(0);
  });

  test("detects consumption from crafters creating deficits", () => {
    const fleet = makeFleet([
      makeBot({ botId: "bot1", routine: "crafter" }),
    ]);
    const result = engine.analyze(fleet);

    // Crafter consumes ore_iron (20/hr) but also produces refined_steel (10/hr)
    // With no miner, ore_iron demand exceeds supply → deficit
    const ironDeficit = result.deficits.find((d) => d.itemId === "ore_iron");
    expect(ironDeficit).toBeDefined();
    expect(ironDeficit!.shortfall).toBeGreaterThan(0);
  });

  test("miner supply offsets crafter demand", () => {
    const fleet = makeFleet([
      makeBot({ botId: "bot1", routine: "miner" }),
      makeBot({ botId: "bot2", routine: "miner" }),
      makeBot({ botId: "bot3", routine: "crafter" }),
    ]);
    const result = engine.analyze(fleet);

    // 2 miners produce 60 ore_iron/hr, 1 crafter consumes 20/hr → 40/hr surplus
    const ironSurplus = result.surpluses.find((s) => s.itemId === "ore_iron");
    expect(ironSurplus).toBeDefined();
  });

  test("critical fuel demand when bot fuel is low", () => {
    const fleet = makeFleet([
      makeBot({ botId: "bot1", routine: "miner", fuelPct: 10 }),
    ]);
    const result = engine.analyze(fleet);

    const fuelDeficit = result.deficits.find((d) => d.itemId === "fuel");
    expect(fuelDeficit).toBeDefined();
    expect(fuelDeficit!.priority).toBe("critical");
  });

  test("deficits sorted by priority then shortfall", () => {
    const fleet = makeFleet([
      makeBot({ botId: "bot1", routine: "crafter", fuelPct: 10 }),
      makeBot({ botId: "bot2", routine: "hunter" }),
    ]);
    const result = engine.analyze(fleet);

    if (result.deficits.length >= 2) {
      // Critical deficits should come first
      const criticalIdx = result.deficits.findIndex((d) => d.priority === "critical");
      const normalIdx = result.deficits.findIndex((d) => d.priority === "normal");
      if (criticalIdx >= 0 && normalIdx >= 0) {
        expect(criticalIdx).toBeLessThan(normalIdx);
      }
    }
  });

  test("ignores idle bots in demand/supply", () => {
    const fleet = makeFleet([
      makeBot({ botId: "bot1", status: "idle", routine: null }),
    ]);
    const result = engine.analyze(fleet);

    expect(result.deficits).toEqual([]);
    expect(result.surpluses).toEqual([]);
  });

  // ── Inventory Alerts ──

  test("detects below_min inventory alert", () => {
    engine.setStockTargets([{
      station_id: "base_earth",
      item_id: "ore_iron",
      min_stock: 100,
      max_stock: 500,
      purpose: "crafting",
    }]);

    // Station has only 50 items
    engine.updateStationInventory("base_earth", new Map([["ore_iron", 50]]));

    const result = engine.analyze(makeFleet([]));
    expect(result.inventoryAlerts.length).toBe(1);
    expect(result.inventoryAlerts[0].type).toBe("below_min");
    expect(result.inventoryAlerts[0].current).toBe(50);
  });

  test("detects above_max inventory alert", () => {
    engine.setStockTargets([{
      station_id: "base_earth",
      item_id: "ore_iron",
      min_stock: 100,
      max_stock: 500,
      purpose: "crafting",
    }]);

    engine.updateStationInventory("base_earth", new Map([["ore_iron", 600]]));

    const result = engine.analyze(makeFleet([]));
    expect(result.inventoryAlerts.length).toBe(1);
    expect(result.inventoryAlerts[0].type).toBe("above_max");
  });

  test("no alert when stock within range", () => {
    engine.setStockTargets([{
      station_id: "base_earth",
      item_id: "ore_iron",
      min_stock: 100,
      max_stock: 500,
      purpose: "crafting",
    }]);

    engine.updateStationInventory("base_earth", new Map([["ore_iron", 250]]));

    const result = engine.analyze(makeFleet([]));
    expect(result.inventoryAlerts.length).toBe(0);
  });

  // ── Profit Tracking ──

  test("tracks revenue and costs", () => {
    engine.recordRevenue(1000);
    engine.recordRevenue(500);
    engine.recordCost(300);

    const result = engine.analyze(makeFleet([]));
    expect(result.totalRevenue).toBe(1500);
    expect(result.totalCosts).toBe(300);
    expect(result.netProfit).toBe(1200);
  });

  test("resetProfitTracking clears history", () => {
    engine.recordRevenue(1000);
    engine.recordCost(300);
    engine.resetProfitTracking();

    const result = engine.analyze(makeFleet([]));
    expect(result.totalRevenue).toBe(0);
    expect(result.totalCosts).toBe(0);
    expect(result.netProfit).toBe(0);
  });

  // ── Faction Storage ──

  test("tracks faction inventory", () => {
    const items = new Map([["ore_iron", 50], ["ore_copper", 30]]);
    engine.updateFactionInventory(items);

    expect(engine.getFactionStock("ore_iron")).toBe(50);
    expect(engine.getFactionStock("ore_copper")).toBe(30);
    expect(engine.getFactionStock("nonexistent")).toBe(0);
  });

  test("faction inventory appears in economy snapshot", () => {
    engine.updateFactionInventory(new Map([["ore_iron", 100]]));

    const result = engine.analyze(makeFleet([]));
    expect(result.factionStorage.get("ore_iron")).toBe(100);
    expect(result.factionStorage.size).toBe(1);
  });

  test("hasFactionMaterials checks patterns", () => {
    engine.updateFactionInventory(new Map([["ore_iron", 50], ["component_circuit", 10]]));

    expect(engine.hasFactionMaterials(["ore"])).toBe(true);
    expect(engine.hasFactionMaterials(["component"])).toBe(true);
    expect(engine.hasFactionMaterials(["fuel"])).toBe(false);
  });

  test("getFactionInventory returns a copy", () => {
    engine.updateFactionInventory(new Map([["ore_iron", 50]]));

    const copy = engine.getFactionInventory();
    copy.set("ore_iron", 999);

    expect(engine.getFactionStock("ore_iron")).toBe(50); // Original unchanged
  });
});
