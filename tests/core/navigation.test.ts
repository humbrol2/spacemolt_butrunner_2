import { describe, test, expect, beforeEach } from "bun:test";
import { Galaxy } from "../../src/core/galaxy";
import { Navigation } from "../../src/core/navigation";
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

function setupGalaxy(): Galaxy {
  const galaxy = new Galaxy();
  galaxy.load([
    {
      id: "sol", name: "Sol", x: 0, y: 0, empire: "solarian", policeLevel: 3,
      connections: ["alpha", "beta"],
      pois: [
        { id: "sol_earth", name: "Earth", type: "planet", hasBase: true, baseId: "base_earth", baseName: "Earth Station", resources: [] },
        { id: "sol_belt", name: "Sol Belt", type: "asteroid_belt", hasBase: false, baseId: null, baseName: null, resources: [] },
      ],
    },
    {
      id: "alpha", name: "Alpha", x: 10, y: 5, empire: "solarian", policeLevel: 2,
      connections: ["sol", "gamma"],
      pois: [
        { id: "alpha_station", name: "Alpha Station", type: "station", hasBase: true, baseId: "base_alpha", baseName: "Alpha Base", resources: [] },
      ],
    },
    {
      id: "beta", name: "Beta", x: -5, y: 10, empire: "nebula", policeLevel: 1,
      connections: ["sol"],
      pois: [],
    },
    {
      id: "gamma", name: "Gamma", x: 15, y: 15, empire: null, policeLevel: 0,
      connections: ["alpha", "delta"],
      pois: [
        { id: "gamma_belt", name: "Gamma Belt", type: "asteroid_belt", hasBase: false, baseId: null, baseName: null, resources: [] },
      ],
    },
    {
      id: "delta", name: "Delta", x: 25, y: 20, empire: "crimson", policeLevel: 0,
      connections: ["gamma"],
      pois: [],
    },
  ]);
  return galaxy;
}

describe("Navigation", () => {
  let nav: Navigation;
  let galaxy: Galaxy;

  beforeEach(() => {
    galaxy = setupGalaxy();
    nav = new Navigation(galaxy);
  });

  test("planRoute returns direct route", () => {
    const ship = makeShip({ fuel: 50 });
    const route = nav.planRoute("sol", "alpha", ship);
    expect(route.totalJumps).toBe(1);
    expect(route.steps.length).toBe(1);
    expect(route.steps[0].systemId).toBe("alpha");
    expect(route.steps[0].action).toBe("jump");
    expect(route.reachable).toBe(true);
  });

  test("planRoute returns multi-hop route", () => {
    const ship = makeShip({ fuel: 50 });
    const route = nav.planRoute("sol", "delta", ship);
    expect(route.totalJumps).toBe(3); // sol → alpha → gamma → delta
    expect(route.steps.length).toBe(3);
    expect(route.reachable).toBe(true);
  });

  test("planRoute marks unreachable with low fuel", () => {
    const ship = makeShip({ fuel: 3 }); // Not enough for 3 jumps at 5/jump
    const route = nav.planRoute("sol", "delta", ship);
    expect(route.totalJumps).toBe(3);
    expect(route.reachable).toBe(false);
    expect(route.refuelNeeded).toBe(true);
  });

  test("planRoute same system returns empty route", () => {
    const ship = makeShip();
    const route = nav.planRoute("sol", "sol", ship);
    expect(route.totalJumps).toBe(0);
    expect(route.steps.length).toBe(0);
    expect(route.reachable).toBe(true);
  });

  test("planRoute unreachable system returns empty", () => {
    const ship = makeShip();
    const route = nav.planRoute("sol", "nonexistent", ship);
    expect(route.reachable).toBe(false);
    expect(route.steps.length).toBe(0);
  });

  test("planRouteToPoI adds travel step at end", () => {
    const ship = makeShip({ fuel: 50 });
    const route = nav.planRouteToPoI("sol", "gamma_belt", ship);
    expect(route.steps.length).toBe(3); // 2 jumps + 1 travel
    expect(route.steps[route.steps.length - 1].action).toBe("travel");
    expect(route.steps[route.steps.length - 1].poiId).toBe("gamma_belt");
  });

  test("planRouteToPoI for unknown POI returns unreachable", () => {
    const ship = makeShip();
    const route = nav.planRouteToPoI("sol", "nonexistent_poi", ship);
    expect(route.reachable).toBe(false);
  });

  test("planMultiStopRoute chains legs", () => {
    const ship = makeShip({ fuel: 100 });
    const route = nav.planMultiStopRoute("sol", ["alpha", "gamma", "delta"], ship);
    expect(route.totalJumps).toBe(3);
    expect(route.reachable).toBe(true);
  });

  test("canMakeTrip returns correct boolean", () => {
    expect(nav.canMakeTrip("sol", "alpha", makeShip({ fuel: 50 }))).toBe(true);
    expect(nav.canMakeTrip("sol", "delta", makeShip({ fuel: 3 }))).toBe(false);
  });

  test("findNearestRefuel finds closest station", () => {
    const result = nav.findNearestRefuel("gamma");
    expect(result).not.toBeNull();
    expect(result!.systemId).toBe("alpha"); // gamma → alpha (has station)
    expect(result!.distance).toBe(1);
  });

  test("planRouteWithRefuel includes refuel stop", () => {
    const ship = makeShip({ fuel: 8, maxFuel: 100 }); // Only enough for ~1 jump
    const route = nav.planRouteWithRefuel("sol", "delta", ship);
    // Should route to nearest station first, then to delta
    expect(route).not.toBeNull();
    expect(route!.refuelNeeded).toBe(true);
  });
});
