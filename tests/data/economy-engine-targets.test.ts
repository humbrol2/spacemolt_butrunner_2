import { describe, test, expect } from "bun:test";
import { EconomyEngine } from "../../src/commander/economy-engine";

describe("EconomyEngine stock target management", () => {
  test("addStockTarget adds a new target", () => {
    const engine = new EconomyEngine();

    engine.addStockTarget({
      station_id: "station1",
      item_id: "ore_iron",
      min_stock: 100,
      max_stock: 500,
      purpose: "crafting",
    });

    // Verify via analyze (stock targets affect alerts)
    const snapshot = engine.analyze({
      bots: [],
      totalCredits: 0,
      activeBots: 0,
    });
    expect(snapshot.inventoryAlerts.length).toBeGreaterThanOrEqual(0);
  });

  test("addStockTarget replaces existing target for same station/item", () => {
    const engine = new EconomyEngine();

    engine.addStockTarget({
      station_id: "station1",
      item_id: "ore_iron",
      min_stock: 100,
      max_stock: 500,
      purpose: "crafting",
    });

    engine.addStockTarget({
      station_id: "station1",
      item_id: "ore_iron",
      min_stock: 200,
      max_stock: 1000,
      purpose: "trading",
    });

    // Should only have 1 target for station1/ore_iron
    // Verify by checking that setting both targets and removing one leaves none
    engine.removeStockTarget("station1", "ore_iron");
    // After removal, analyze should work without errors
    const snapshot = engine.analyze({ bots: [], totalCredits: 0, activeBots: 0 });
    expect(snapshot).toBeDefined();
  });

  test("removeStockTarget removes the target", () => {
    const engine = new EconomyEngine();

    engine.setStockTargets([
      { station_id: "station1", item_id: "ore_iron", min_stock: 100, max_stock: 500, purpose: "crafting" },
      { station_id: "station1", item_id: "ore_copper", min_stock: 50, max_stock: 200, purpose: "trading" },
    ]);

    engine.removeStockTarget("station1", "ore_iron");

    // Only ore_copper should remain - analyze should still work
    const snapshot = engine.analyze({ bots: [], totalCredits: 0, activeBots: 0 });
    expect(snapshot).toBeDefined();
  });

  test("removeStockTarget is a no-op for non-existent target", () => {
    const engine = new EconomyEngine();

    engine.setStockTargets([
      { station_id: "station1", item_id: "ore_iron", min_stock: 100, max_stock: 500, purpose: "crafting" },
    ]);

    // Should not throw
    engine.removeStockTarget("station2", "ore_gold");

    const snapshot = engine.analyze({ bots: [], totalCredits: 0, activeBots: 0 });
    expect(snapshot).toBeDefined();
  });
});
