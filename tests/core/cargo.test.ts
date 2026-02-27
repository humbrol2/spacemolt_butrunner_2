import { describe, test, expect } from "bun:test";
import { Cargo } from "../../src/core/cargo";
import type { ShipState } from "../../src/types/game";

function makeShip(overrides: Partial<ShipState> = {}): ShipState {
  return {
    id: "ship1",
    ownerId: "player1",
    classId: "hauler",
    name: null,
    hull: 100,
    maxHull: 100,
    shield: 50,
    maxShield: 50,
    shieldRecharge: 1,
    armor: 10,
    speed: 3,
    fuel: 80,
    maxFuel: 100,
    cargoUsed: 30,
    cargoCapacity: 100,
    cpuUsed: 0,
    cpuCapacity: 10,
    powerUsed: 0,
    powerCapacity: 10,
    modules: [],
    cargo: [
      { itemId: "ore_iron", quantity: 20 },
      { itemId: "ore_copper", quantity: 10 },
    ],
    ...overrides,
  };
}

describe("Cargo", () => {
  const cargo = new Cargo();

  test("getSummary returns correct values", () => {
    const ship = makeShip();
    const summary = cargo.getSummary(ship);
    expect(summary.used).toBe(30);
    expect(summary.capacity).toBe(100);
    expect(summary.free).toBe(70);
    expect(summary.pctFull).toBe(30);
    expect(summary.items.length).toBe(2);
  });

  test("hasSpace checks available space", () => {
    const ship = makeShip();
    expect(cargo.hasSpace(ship, 70)).toBe(true);
    expect(cargo.hasSpace(ship, 71)).toBe(false);
  });

  test("freeSpace returns available space", () => {
    expect(cargo.freeSpace(makeShip())).toBe(70);
    expect(cargo.freeSpace(makeShip({ cargoUsed: 100, cargoCapacity: 100 }))).toBe(0);
  });

  test("getItemQuantity returns correct amount", () => {
    const ship = makeShip();
    expect(cargo.getItemQuantity(ship, "ore_iron")).toBe(20);
    expect(cargo.getItemQuantity(ship, "ore_copper")).toBe(10);
    expect(cargo.getItemQuantity(ship, "nonexistent")).toBe(0);
  });

  test("hasItems checks all requirements", () => {
    const ship = makeShip();
    expect(cargo.hasItems(ship, [{ itemId: "ore_iron", quantity: 10 }])).toBe(true);
    expect(cargo.hasItems(ship, [{ itemId: "ore_iron", quantity: 20 }])).toBe(true);
    expect(cargo.hasItems(ship, [{ itemId: "ore_iron", quantity: 21 }])).toBe(false);
    expect(
      cargo.hasItems(ship, [
        { itemId: "ore_iron", quantity: 10 },
        { itemId: "ore_copper", quantity: 10 },
      ])
    ).toBe(true);
    expect(
      cargo.hasItems(ship, [
        { itemId: "ore_iron", quantity: 10 },
        { itemId: "ore_gold", quantity: 1 },
      ])
    ).toBe(false);
  });

  test("getMissing returns missing items", () => {
    const ship = makeShip();
    const missing = cargo.getMissing(ship, [
      { itemId: "ore_iron", quantity: 25 },
      { itemId: "ore_copper", quantity: 5 },
      { itemId: "ore_gold", quantity: 10 },
    ]);
    expect(missing.length).toBe(2);
    expect(missing.find((m) => m.itemId === "ore_iron")?.needed).toBe(5);
    expect(missing.find((m) => m.itemId === "ore_gold")?.needed).toBe(10);
  });

  test("getMissing returns empty for satisfied requirements", () => {
    const ship = makeShip();
    const missing = cargo.getMissing(ship, [{ itemId: "ore_iron", quantity: 10 }]);
    expect(missing.length).toBe(0);
  });

  test("planSellOrder sorts by value descending", () => {
    const ship = makeShip();
    const prices = new Map([
      ["ore_iron", 5],    // 20 * 5 = 100
      ["ore_copper", 15], // 10 * 15 = 150
    ]);
    const plans = cargo.planSellOrder(ship, prices);
    expect(plans.length).toBe(2);
    expect(plans[0].itemId).toBe("ore_copper"); // Higher value first
    expect(plans[0].estimatedValue).toBe(150);
    expect(plans[1].itemId).toBe("ore_iron");
    expect(plans[1].estimatedValue).toBe(100);
  });

  test("estimateCargoValue totals correctly", () => {
    const ship = makeShip();
    const prices = new Map([
      ["ore_iron", 5],
      ["ore_copper", 15],
    ]);
    expect(cargo.estimateCargoValue(ship, prices)).toBe(250);
  });

  test("estimateCargoValue handles unknown item prices", () => {
    const ship = makeShip();
    const prices = new Map([["ore_iron", 5]]); // No copper price
    expect(cargo.estimateCargoValue(ship, prices)).toBe(100);
  });

  test("maxBuyQuantity respects space and credits", () => {
    const ship = makeShip(); // 70 free weight
    expect(cargo.maxBuyQuantity(ship, 10, 1000)).toBe(70); // Space-limited (size=1 default)
    expect(cargo.maxBuyQuantity(ship, 10, 500)).toBe(50); // Credit-limited
    expect(cargo.maxBuyQuantity(ship, 10, 100)).toBe(10); // Credit-limited
    expect(cargo.maxBuyQuantity(ship, 0, 1000)).toBe(0); // Free items, but no div by zero
  });

  test("maxBuyQuantity accounts for item weight (size > 1)", () => {
    const ship = makeShip(); // 70 free weight
    // Item weighs 2 per unit: can fit 35 units in 70 weight
    expect(cargo.maxBuyQuantity(ship, 10, 10000, 2)).toBe(35);
    // Item weighs 5 per unit: can fit 14 units in 70 weight
    expect(cargo.maxBuyQuantity(ship, 10, 10000, 5)).toBe(14);
    // Item weighs 10 per unit: can fit 7 units, but credits limit to 5
    expect(cargo.maxBuyQuantity(ship, 100, 500, 10)).toBe(5);
    // Item weighs 100: can fit 0 units
    expect(cargo.maxBuyQuantity(ship, 10, 10000, 100)).toBe(0);
  });

  test("hasSpace accounts for item size", () => {
    const ship = makeShip(); // 70 free weight
    expect(cargo.hasSpace(ship, 35, 2)).toBe(true);  // 35 * 2 = 70 weight, fits exactly
    expect(cargo.hasSpace(ship, 36, 2)).toBe(false); // 36 * 2 = 72 weight, too much
    expect(cargo.hasSpace(ship, 10, 1)).toBe(true);  // default size
  });

  test("getItemSize returns size from cargo items", () => {
    const ship = makeShip({
      cargo: [
        { itemId: "ore_iron", quantity: 20, size: 1 },
        { itemId: "heavy_armor", quantity: 2, size: 5 },
      ],
    });
    expect(cargo.getItemSize(ship, "ore_iron")).toBe(1);
    expect(cargo.getItemSize(ship, "heavy_armor")).toBe(5);
    expect(cargo.getItemSize(ship, "unknown")).toBe(1); // defaults to 1
  });
});
