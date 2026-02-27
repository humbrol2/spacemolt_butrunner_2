import { describe, test, expect, beforeEach } from "bun:test";
import { Galaxy } from "../../src/core/galaxy";
import type { StarSystem } from "../../src/types/game";

function makeSystems(): StarSystem[] {
  return [
    {
      id: "sol",
      name: "Sol",
      x: 0,
      y: 0,
      empire: "solarian",
      policeLevel: 3,
      connections: ["alpha", "beta"],
      pois: [
        { id: "sol_earth", name: "Earth", type: "planet", hasBase: true, baseId: "base_earth", baseName: "Earth Station", resources: [] },
        { id: "sol_belt", name: "Sol Belt", type: "asteroid_belt", hasBase: false, baseId: null, baseName: null, resources: [] },
      ],
    },
    {
      id: "alpha",
      name: "Alpha Centauri",
      x: 10,
      y: 5,
      empire: "solarian",
      policeLevel: 2,
      connections: ["sol", "gamma"],
      pois: [
        { id: "alpha_station", name: "Alpha Station", type: "station", hasBase: true, baseId: "base_alpha", baseName: "Alpha Base", resources: [] },
      ],
    },
    {
      id: "beta",
      name: "Beta Crucis",
      x: -5,
      y: 10,
      empire: "nebula",
      policeLevel: 1,
      connections: ["sol", "gamma"],
      pois: [
        { id: "beta_ice", name: "Ice Fields", type: "ice_field", hasBase: false, baseId: null, baseName: null, resources: [] },
      ],
    },
    {
      id: "gamma",
      name: "Gamma Draconis",
      x: 15,
      y: 15,
      empire: null,
      policeLevel: 0,
      connections: ["alpha", "beta", "delta"],
      pois: [
        { id: "gamma_nebula", name: "Dark Nebula", type: "nebula", hasBase: false, baseId: null, baseName: null, resources: [] },
        { id: "gamma_station", name: "Outpost", type: "station", hasBase: true, baseId: "base_gamma", baseName: "Gamma Outpost", resources: [] },
      ],
    },
    {
      id: "delta",
      name: "Delta Pavonis",
      x: 25,
      y: 20,
      empire: "crimson",
      policeLevel: 0,
      connections: ["gamma"],
      pois: [
        { id: "delta_belt", name: "Crimson Belt", type: "asteroid_belt", hasBase: false, baseId: null, baseName: null, resources: [] },
      ],
    },
  ];
}

describe("Galaxy", () => {
  let galaxy: Galaxy;

  beforeEach(() => {
    galaxy = new Galaxy();
    galaxy.load(makeSystems());
  });

  test("loads systems correctly", () => {
    expect(galaxy.systemCount).toBe(5);
    expect(galaxy.poiCount).toBe(7);
  });

  test("getSystem returns system by ID", () => {
    const sol = galaxy.getSystem("sol");
    expect(sol).not.toBeNull();
    expect(sol!.name).toBe("Sol");
    expect(sol!.empire).toBe("solarian");
  });

  test("getSystem returns null for unknown ID", () => {
    expect(galaxy.getSystem("unknown")).toBeNull();
  });

  test("getSystemByName is case-insensitive", () => {
    const sol = galaxy.getSystemByName("sol");
    expect(sol).not.toBeNull();
    expect(sol!.id).toBe("sol");

    const solUpper = galaxy.getSystemByName("SOL");
    expect(solUpper).not.toBeNull();
  });

  test("getNeighbors returns connected systems", () => {
    const neighbors = galaxy.getNeighbors("sol");
    expect(neighbors.length).toBe(2);
    expect(neighbors.map((n) => n.id).sort()).toEqual(["alpha", "beta"]);
  });

  test("getSystemForPoi returns correct system", () => {
    expect(galaxy.getSystemForPoi("sol_earth")).toBe("sol");
    expect(galaxy.getSystemForPoi("alpha_station")).toBe("alpha");
    expect(galaxy.getSystemForPoi("unknown")).toBeNull();
  });

  test("getSystemForBase returns correct system", () => {
    expect(galaxy.getSystemForBase("base_earth")).toBe("sol");
    expect(galaxy.getSystemForBase("base_gamma")).toBe("gamma");
    expect(galaxy.getSystemForBase("unknown")).toBeNull();
  });

  test("findPoisByType finds all matching POIs", () => {
    const belts = galaxy.findPoisByType("asteroid_belt");
    expect(belts.length).toBe(2);
    expect(belts.map((b) => b.poi.id).sort()).toEqual(["delta_belt", "sol_belt"]);
  });

  test("findStations finds all stations", () => {
    const stations = galaxy.findStations();
    expect(stations.length).toBe(3); // earth, alpha, gamma
  });

  test("findEmpireSystems filters by empire", () => {
    const solarian = galaxy.findEmpireSystems("solarian");
    expect(solarian.length).toBe(2);
    expect(solarian.map((s) => s.id).sort()).toEqual(["alpha", "sol"]);
  });

  // ── Pathfinding ──

  test("findPath returns direct connection", () => {
    const path = galaxy.findPath("sol", "alpha");
    expect(path).toEqual(["sol", "alpha"]);
  });

  test("findPath returns same node for self", () => {
    expect(galaxy.findPath("sol", "sol")).toEqual(["sol"]);
  });

  test("findPath finds multi-hop route", () => {
    const path = galaxy.findPath("sol", "delta");
    expect(path).not.toBeNull();
    // sol → alpha → gamma → delta or sol → beta → gamma → delta
    expect(path!.length).toBe(4);
    expect(path![0]).toBe("sol");
    expect(path![path!.length - 1]).toBe("delta");
  });

  test("findPath returns null for disconnected graph", () => {
    // Load isolated system
    const isolated = new Galaxy();
    isolated.load([
      { id: "a", name: "A", x: 0, y: 0, empire: null, policeLevel: 0, connections: [], pois: [] },
      { id: "b", name: "B", x: 1, y: 0, empire: null, policeLevel: 0, connections: [], pois: [] },
    ]);
    expect(isolated.findPath("a", "b")).toBeNull();
  });

  test("findPath returns null for unknown systems", () => {
    expect(galaxy.findPath("sol", "unknown")).toBeNull();
    expect(galaxy.findPath("unknown", "sol")).toBeNull();
  });

  test("getDistance returns correct hop count", () => {
    expect(galaxy.getDistance("sol", "sol")).toBe(0);
    expect(galaxy.getDistance("sol", "alpha")).toBe(1);
    expect(galaxy.getDistance("sol", "gamma")).toBe(2);
    expect(galaxy.getDistance("sol", "delta")).toBe(3);
  });

  test("getDistance returns -1 for unreachable", () => {
    const isolated = new Galaxy();
    isolated.load([
      { id: "a", name: "A", x: 0, y: 0, empire: null, policeLevel: 0, connections: [], pois: [] },
      { id: "b", name: "B", x: 1, y: 0, empire: null, policeLevel: 0, connections: [], pois: [] },
    ]);
    expect(isolated.getDistance("a", "b")).toBe(-1);
  });

  // ── Find Nearest ──

  test("findNearest returns starting system if it matches", () => {
    const result = galaxy.findNearest("sol", (s) => s.policeLevel >= 3);
    expect(result).not.toBeNull();
    expect(result!.system.id).toBe("sol");
    expect(result!.path).toEqual(["sol"]);
  });

  test("findNearest finds closest match", () => {
    const result = galaxy.findNearest("sol", (s) => s.policeLevel === 0);
    expect(result).not.toBeNull();
    expect(result!.system.id).toBe("gamma"); // 2 hops: sol → alpha/beta → gamma
    expect(result!.path.length).toBe(3);
  });

  test("findNearest returns null if no match", () => {
    const result = galaxy.findNearest("sol", (s) => s.name === "Nonexistent");
    expect(result).toBeNull();
  });

  test("findNearestStation finds closest station", () => {
    const result = galaxy.findNearestStation("delta");
    expect(result).not.toBeNull();
    expect(result!.systemId).toBe("gamma");
    expect(result!.distance).toBe(1);
  });

  test("findNearestStation from system with station returns distance 0", () => {
    const result = galaxy.findNearestStation("sol");
    expect(result).not.toBeNull();
    expect(result!.distance).toBe(0);
  });

  test("findNearestResource finds closest resource POI", () => {
    const result = galaxy.findNearestResource("alpha", "ice_field");
    expect(result).not.toBeNull();
    expect(result!.systemId).toBe("beta");
  });

  test("getSecurityLevel returns police level", () => {
    expect(galaxy.getSecurityLevel("sol")).toBe(3);
    expect(galaxy.getSecurityLevel("gamma")).toBe(0);
    expect(galaxy.getSecurityLevel("unknown")).toBe(0);
  });

  // ── Coordinate preservation ──

  test("updateSystem preserves existing coordinates when API returns (0,0)", () => {
    // Sol has coords (0, 0) by default in test data, so use Alpha which has (10, 5)
    const alpha = galaxy.getSystem("alpha");
    expect(alpha!.x).toBe(10);
    expect(alpha!.y).toBe(5);

    // Simulate API returning full system detail with (0, 0) coords
    galaxy.updateSystem({
      id: "alpha",
      name: "Alpha Centauri",
      x: 0,
      y: 0,
      empire: "solarian",
      policeLevel: 2,
      connections: ["sol", "gamma"],
      pois: [
        { id: "alpha_station", name: "Alpha Station", type: "station", hasBase: true, baseId: "base_alpha", baseName: "Alpha Base", resources: [] },
      ],
    });

    // Should preserve original coordinates
    const updated = galaxy.getSystem("alpha");
    expect(updated!.x).toBe(10);
    expect(updated!.y).toBe(5);
  });

  test("updateSystem allows non-zero coordinate updates", () => {
    galaxy.updateSystem({
      id: "alpha",
      name: "Alpha Centauri",
      x: 20,
      y: 30,
      empire: "solarian",
      policeLevel: 2,
      connections: ["sol", "gamma"],
      pois: [
        { id: "alpha_station", name: "Alpha Station", type: "station", hasBase: true, baseId: "base_alpha", baseName: "Alpha Base", resources: [] },
      ],
    });

    const updated = galaxy.getSystem("alpha");
    expect(updated!.x).toBe(20);
    expect(updated!.y).toBe(30);
  });

  // ── POI resource updates ──

  test("updatePoiResources updates resource data on existing POI", () => {
    const poi = galaxy.getPoi("sol_belt");
    expect(poi).not.toBeNull();
    expect(poi!.resources).toEqual([]);

    galaxy.updatePoiResources("sol_belt", [
      { resourceId: "iron_ore", richness: 0.8, remaining: 500 },
      { resourceId: "copper_ore", richness: 0.3, remaining: 200 },
    ]);

    const updated = galaxy.getPoi("sol_belt");
    expect(updated!.resources.length).toBe(2);
    expect(updated!.resources[0].resourceId).toBe("iron_ore");
    expect(updated!.resources[1].remaining).toBe(200);
  });

  test("updatePoiResources is no-op for unknown POI", () => {
    // Should not throw
    galaxy.updatePoiResources("nonexistent_poi", [{ resourceId: "x", richness: 1, remaining: 100 }]);
  });

  // ── Force-directed layout ──

  test("allCoordsZero detects when all systems are at origin", () => {
    const g = new Galaxy();
    g.load([
      { id: "a", name: "A", x: 0, y: 0, empire: null, policeLevel: 0, connections: ["b"], pois: [] },
      { id: "b", name: "B", x: 0, y: 0, empire: null, policeLevel: 0, connections: ["a"], pois: [] },
    ]);
    expect(g.allCoordsZero).toBe(true);
  });

  test("allCoordsZero is false when any system has coordinates", () => {
    expect(galaxy.allCoordsZero).toBe(false);
  });

  test("allCoordsZero is false for single system", () => {
    const g = new Galaxy();
    g.load([{ id: "a", name: "A", x: 0, y: 0, empire: null, policeLevel: 0, connections: [], pois: [] }]);
    expect(g.allCoordsZero).toBe(false);
  });

  test("generateLayout assigns non-zero coordinates to systems", () => {
    const g = new Galaxy();
    g.load([
      { id: "a", name: "A", x: 0, y: 0, empire: null, policeLevel: 0, connections: ["b", "c"], pois: [] },
      { id: "b", name: "B", x: 0, y: 0, empire: null, policeLevel: 0, connections: ["a"], pois: [] },
      { id: "c", name: "C", x: 0, y: 0, empire: null, policeLevel: 0, connections: ["a", "d"], pois: [] },
      { id: "d", name: "D", x: 0, y: 0, empire: null, policeLevel: 0, connections: ["c"], pois: [] },
    ]);
    expect(g.allCoordsZero).toBe(true);
    g.generateLayout();
    expect(g.allCoordsZero).toBe(false);

    // All systems should have different positions
    const positions = new Set<string>();
    for (const sys of g.getAllSystems()) {
      positions.add(`${sys.x},${sys.y}`);
    }
    expect(positions.size).toBe(4);
  });
});
