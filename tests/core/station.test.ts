import { describe, test, expect, beforeEach } from "bun:test";
import { Galaxy } from "../../src/core/galaxy";
import { Station } from "../../src/core/station";
import type { PlayerState, ShipState } from "../../src/types/game";

function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: "player1",
    username: "TestBot",
    empire: "solarian",
    credits: 1000,
    currentSystem: "sol",
    currentPoi: "sol_earth",
    currentShipId: "ship1",
    homeBase: "base_earth",
    dockedAtBase: null,
    factionId: null,
    factionRank: null,
    statusMessage: null,
    clanTag: null,
    anonymous: false,
    isCloaked: false,
    skills: {},
    skillXp: {},
    stats: { shipsDestroyed: 0, timesDestroyed: 0, oreMined: 0, creditsEarned: 0, creditsSpent: 0, tradesCompleted: 0, systemsVisited: 0, itemsCrafted: 0, missionsCompleted: 0 },
    ...overrides,
  };
}

function makeShip(overrides: Partial<ShipState> = {}): ShipState {
  return {
    id: "ship1",
    ownerId: "player1",
    classId: "scout",
    name: null,
    hull: 80,
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
      connections: ["alpha"],
      pois: [
        { id: "sol_earth", name: "Earth", type: "planet", hasBase: true, baseId: "base_earth", baseName: "Earth Station", resources: [] },
        { id: "sol_belt", name: "Sol Belt", type: "asteroid_belt", hasBase: false, baseId: null, baseName: null, resources: [] },
      ],
    },
    {
      id: "alpha", name: "Alpha", x: 10, y: 5, empire: "solarian", policeLevel: 2,
      connections: ["sol", "void"],
      pois: [
        { id: "alpha_station", name: "Alpha Station", type: "station", hasBase: true, baseId: "base_alpha", baseName: "Alpha", resources: [] },
      ],
    },
    {
      id: "void", name: "Void", x: 20, y: 10, empire: null, policeLevel: 0,
      connections: ["alpha"],
      pois: [
        { id: "void_rock", name: "Void Rock", type: "asteroid", hasBase: false, baseId: null, baseName: null, resources: [] },
      ],
    },
  ]);
  return galaxy;
}

describe("Station", () => {
  let station: Station;

  beforeEach(() => {
    station = new Station(setupGalaxy());
  });

  test("isDocked checks dockedAtBase", () => {
    expect(station.isDocked(makePlayer({ dockedAtBase: "base_earth" }))).toBe(true);
    expect(station.isDocked(makePlayer({ dockedAtBase: null }))).toBe(false);
  });

  test("canDock checks if current POI has a base", () => {
    expect(station.canDock(makePlayer({ currentPoi: "sol_earth" }))).toBe(true);
    expect(station.canDock(makePlayer({ currentPoi: "sol_belt" }))).toBe(false);
  });

  test("needsRepair checks hull threshold", () => {
    expect(station.needsRepair(makeShip({ hull: 40, maxHull: 100 }))).toBe(true); // 40% < 50%
    expect(station.needsRepair(makeShip({ hull: 60, maxHull: 100 }))).toBe(false); // 60% > 50%
    expect(station.needsRepair(makeShip({ hull: 60, maxHull: 100 }), 70)).toBe(true); // custom threshold
  });

  test("hullPercentage calculates correctly", () => {
    expect(station.hullPercentage(makeShip({ hull: 75, maxHull: 100 }))).toBe(75);
    expect(station.hullPercentage(makeShip({ hull: 0, maxHull: 0 }))).toBe(0);
  });

  test("shouldRepairBeforeUndock with threshold", () => {
    expect(station.shouldRepairBeforeUndock(makeShip({ hull: 70, maxHull: 100 }))).toBe(true); // 70 < 80
    expect(station.shouldRepairBeforeUndock(makeShip({ hull: 90, maxHull: 100 }))).toBe(false); // 90 > 80
  });

  test("getHomeSystem returns system for home base", () => {
    expect(station.getHomeSystem(makePlayer({ homeBase: "base_earth" }))).toBe("sol");
    expect(station.getHomeSystem(makePlayer({ homeBase: null }))).toBeNull();
  });

  test("isAtHomeBase checks current dock", () => {
    expect(station.isAtHomeBase(makePlayer({ homeBase: "base_earth", dockedAtBase: "base_earth" }))).toBe(true);
    expect(station.isAtHomeBase(makePlayer({ homeBase: "base_earth", dockedAtBase: null }))).toBe(false);
    expect(station.isAtHomeBase(makePlayer({ homeBase: "base_earth", dockedAtBase: "base_alpha" }))).toBe(false);
  });

  test("getStationsInSystem lists all bases", () => {
    const stations = station.getStationsInSystem("sol");
    expect(stations.length).toBe(1);
    expect(stations[0].baseName).toBe("Earth Station");
  });

  test("getStationsInSystem returns empty for system with no bases", () => {
    expect(station.getStationsInSystem("void").length).toBe(0);
  });

  test("chooseDockTarget prefers local station", () => {
    const target = station.chooseDockTarget(makePlayer({ currentSystem: "sol" }), makeShip());
    expect(target).not.toBeNull();
    expect(target!.systemId).toBe("sol");
    expect(target!.poiId).toBe("sol_earth");
  });

  test("chooseDockTarget prefers home base when local", () => {
    const target = station.chooseDockTarget(
      makePlayer({ currentSystem: "sol", homeBase: "base_earth" }),
      makeShip()
    );
    expect(target!.poiId).toBe("sol_earth");
  });

  test("chooseDockTarget finds nearest station when not in system with base", () => {
    const target = station.chooseDockTarget(
      makePlayer({ currentSystem: "void", currentPoi: "void_rock", homeBase: null }),
      makeShip()
    );
    expect(target).not.toBeNull();
    expect(target!.systemId).toBe("alpha");
  });

  test("chooseDockTarget prefers home base within detour range", () => {
    const target = station.chooseDockTarget(
      makePlayer({ currentSystem: "alpha", homeBase: "base_earth" }),
      makeShip(),
      5 // allow 5 jump detour
    );
    // Alpha has its own station but home base in Sol is 1 jump away
    // However alpha_station is local, so it should prefer local first
    expect(target!.systemId).toBe("alpha");
  });
});
