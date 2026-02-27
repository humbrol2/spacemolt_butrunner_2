import { describe, test, expect, beforeEach } from "bun:test";
import { Galaxy } from "../../src/core/galaxy";
import { Navigation } from "../../src/core/navigation";
import { Fuel } from "../../src/core/fuel";
import type { ShipState } from "../../src/types/game";

function makeShip(overrides: Partial<ShipState> = {}): ShipState {
  return {
    id: "ship1",
    ownerId: "player1",
    classId: "scout",
    name: null,
    hull: 100,
    maxHull: 100,
    shield: 50,
    maxShield: 50,
    shieldRecharge: 1,
    armor: 10,
    speed: 5,
    fuel: 50,
    maxFuel: 100,
    cargoUsed: 0,
    cargoCapacity: 50,
    cpuUsed: 0,
    cpuCapacity: 10,
    powerUsed: 0,
    powerCapacity: 10,
    modules: [],
    cargo: [],
    ...overrides,
  };
}

function setup() {
  const galaxy = new Galaxy();
  galaxy.load([
    {
      id: "sol", name: "Sol", x: 0, y: 0, empire: "solarian", policeLevel: 3,
      connections: ["alpha"],
      pois: [{ id: "sol_earth", name: "Earth", type: "planet", hasBase: true, baseId: "base_earth", baseName: "Earth Station", resources: [] }],
    },
    {
      id: "alpha", name: "Alpha", x: 10, y: 5, empire: "solarian", policeLevel: 2,
      connections: ["sol", "gamma"],
      pois: [{ id: "alpha_station", name: "Alpha Station", type: "station", hasBase: true, baseId: "base_alpha", baseName: "Alpha", resources: [] }],
    },
    {
      id: "gamma", name: "Gamma", x: 20, y: 10, empire: null, policeLevel: 0,
      connections: ["alpha"],
      pois: [],
    },
  ]);
  const nav = new Navigation(galaxy);
  const fuel = new Fuel(nav);
  return { galaxy, nav, fuel };
}

describe("Fuel", () => {
  let fuel: Fuel;

  beforeEach(() => {
    ({ fuel } = setup());
  });

  test("getPercentage calculates correctly", () => {
    expect(fuel.getPercentage(makeShip({ fuel: 50, maxFuel: 100 }))).toBe(50);
    expect(fuel.getPercentage(makeShip({ fuel: 0, maxFuel: 100 }))).toBe(0);
    expect(fuel.getPercentage(makeShip({ fuel: 100, maxFuel: 100 }))).toBe(100);
    expect(fuel.getPercentage(makeShip({ fuel: 0, maxFuel: 0 }))).toBe(0);
  });

  test("getLevel returns correct category", () => {
    expect(fuel.getLevel(makeShip({ fuel: 10, maxFuel: 100 }))).toBe("critical"); // 10%
    expect(fuel.getLevel(makeShip({ fuel: 25, maxFuel: 100 }))).toBe("low"); // 25%
    expect(fuel.getLevel(makeShip({ fuel: 50, maxFuel: 100 }))).toBe("comfortable"); // 50%
    expect(fuel.getLevel(makeShip({ fuel: 90, maxFuel: 100 }))).toBe("full"); // 90%
  });

  test("needsRefuel checks threshold", () => {
    expect(fuel.needsRefuel(makeShip({ fuel: 20, maxFuel: 100 }))).toBe(true); // 20% < 30%
    expect(fuel.needsRefuel(makeShip({ fuel: 50, maxFuel: 100 }))).toBe(false); // 50% > 30%
    expect(fuel.needsRefuel(makeShip({ fuel: 50, maxFuel: 100 }), 60)).toBe(true); // custom threshold
  });

  test("estimateRange returns jump count", () => {
    const ship = makeShip({ fuel: 25 }); // 25 fuel / 5 per jump = 5 jumps
    expect(fuel.estimateRange(ship)).toBe(5);
  });

  test("estimateRange with zero fuel returns 0", () => {
    expect(fuel.estimateRange(makeShip({ fuel: 0 }))).toBe(0);
  });

  test("canReach checks fuel sufficiency", () => {
    expect(fuel.canReach("sol", "alpha", makeShip({ fuel: 50 }))).toBe(true);
    expect(fuel.canReach("sol", "gamma", makeShip({ fuel: 5 }))).toBe(false); // 2 jumps, only 5 fuel
  });

  test("isStranded detects when we cant reach any station", () => {
    expect(fuel.isStranded("gamma", makeShip({ fuel: 0 }))).toBe(true); // No fuel, no station in gamma
    expect(fuel.isStranded("sol", makeShip({ fuel: 50 }))).toBe(false); // At a station
  });

  test("roundTripFuel calculates both legs", () => {
    const ship = makeShip({ fuel: 100 });
    const cost = fuel.roundTripFuel("sol", "alpha", ship);
    expect(cost).toBe(10); // 5 there + 5 back
  });

  test("canRoundTrip checks both legs", () => {
    expect(fuel.canRoundTrip("sol", "alpha", makeShip({ fuel: 10 }))).toBe(true);
    expect(fuel.canRoundTrip("sol", "alpha", makeShip({ fuel: 8 }))).toBe(false);
  });
});
