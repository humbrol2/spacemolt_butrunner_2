import { describe, test, expect, beforeEach } from "bun:test";
import { Galaxy } from "../../src/core/galaxy";
import { Combat } from "../../src/core/combat";
import type { ShipState, BattleStatus, NearbyPlayer } from "../../src/types/game";

function makeShip(overrides: Partial<ShipState> = {}): ShipState {
  return {
    id: "ship1",
    ownerId: "player1",
    classId: "fighter",
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

function makeNearby(overrides: Partial<NearbyPlayer> = {}): NearbyPlayer {
  return {
    playerId: "enemy1",
    username: "EnemyPilot",
    shipClass: "fighter",
    factionId: null,
    factionTag: null,
    anonymous: false,
    inCombat: false,
    ...overrides,
  };
}

function setupGalaxy(): Galaxy {
  const galaxy = new Galaxy();
  galaxy.load([
    {
      id: "highsec", name: "High Sec", x: 0, y: 0, empire: "solarian", policeLevel: 3,
      connections: ["lowsec"],
      pois: [],
    },
    {
      id: "lowsec", name: "Low Sec", x: 10, y: 0, empire: null, policeLevel: 1,
      connections: ["highsec", "nullsec"],
      pois: [],
    },
    {
      id: "nullsec", name: "Null Sec", x: 20, y: 0, empire: null, policeLevel: 0,
      connections: ["lowsec"],
      pois: [],
    },
  ]);
  return galaxy;
}

describe("Combat", () => {
  let combat: Combat;

  beforeEach(() => {
    combat = new Combat(setupGalaxy());
  });

  // ── Threat Assessment ──

  test("safe in high-sec with no hostiles", () => {
    const result = combat.assessThreat("highsec", makeShip(), []);
    expect(result.level).toBe("safe");
    expect(result.shouldFlee).toBe(false);
  });

  test("dangerous when hull is low", () => {
    const result = combat.assessThreat("highsec", makeShip({ hull: 20, maxHull: 100 }), []);
    expect(result.level).toBe("dangerous");
    expect(result.shouldFlee).toBe(true);
  });

  test("hostile in nullsec with enemies", () => {
    const result = combat.assessThreat("nullsec", makeShip(), [makeNearby()]);
    expect(result.level).toBe("hostile");
  });

  test("caution in lawless but alone", () => {
    const result = combat.assessThreat("nullsec", makeShip(), []);
    expect(result.level).toBe("caution");
    expect(result.shouldFlee).toBe(false);
  });

  // ── Stance Selection ──

  test("flee when hull critical", () => {
    const ship = makeShip({ hull: 15, maxHull: 100 });
    const battle: BattleStatus = {
      id: "b1", tick: 100, zone: "mid", stance: "fire",
      sides: [{ id: "s1", participants: [] }],
    };
    expect(combat.chooseStance(ship, battle)).toBe("flee");
  });

  test("brace when hull low", () => {
    const ship = makeShip({ hull: 35, maxHull: 100, shield: 10, maxShield: 50 });
    const battle: BattleStatus = {
      id: "b1", tick: 100, zone: "mid", stance: "fire",
      sides: [{ id: "s1", participants: [] }],
    };
    expect(combat.chooseStance(ship, battle)).toBe("brace");
  });

  test("fire when shields good", () => {
    const ship = makeShip({ hull: 80, shield: 40, maxShield: 50 });
    const battle: BattleStatus = {
      id: "b1", tick: 100, zone: "mid", stance: "fire",
      sides: [{ id: "s1", participants: [] }],
    };
    expect(combat.chooseStance(ship, battle)).toBe("fire");
  });

  test("evade when shields depleted", () => {
    const ship = makeShip({ hull: 80, maxHull: 100, shield: 5, maxShield: 50 });
    const battle: BattleStatus = {
      id: "b1", tick: 100, zone: "mid", stance: "fire",
      sides: [{ id: "s1", participants: [] }],
    };
    expect(combat.chooseStance(ship, battle)).toBe("evade");
  });

  // ── Engagement Decision ──

  test("dont engage in high-sec", () => {
    const result = combat.shouldEngage(makeShip(), makeNearby(), "highsec");
    expect(result.engage).toBe(false);
    expect(result.reason).toContain("police");
  });

  test("dont engage with low hull", () => {
    const result = combat.shouldEngage(
      makeShip({ hull: 40, maxHull: 100 }),
      makeNearby(),
      "nullsec"
    );
    expect(result.engage).toBe(false);
  });

  test("engage in nullsec with good hull", () => {
    const result = combat.shouldEngage(makeShip(), makeNearby(), "nullsec");
    expect(result.engage).toBe(true);
  });

  test("engage target already in combat", () => {
    const result = combat.shouldEngage(
      makeShip(),
      makeNearby({ inCombat: true }),
      "nullsec"
    );
    expect(result.engage).toBe(true);
    expect(result.reason).toContain("weakened");
  });

  // ── Battle Helpers ──

  test("findWeakestEnemy finds lowest hull", () => {
    const battle: BattleStatus = {
      id: "b1",
      tick: 100,
      zone: "mid",
      stance: "fire",
      sides: [
        {
          id: "our_side",
          participants: [
            { playerId: "player1", username: "Us", shipClass: "fighter", hull: 80, maxHull: 100, shield: 50, maxShield: 50, zone: "mid", stance: "fire" },
          ],
        },
        {
          id: "enemy_side",
          participants: [
            { playerId: "e1", username: "Strong", shipClass: "cruiser", hull: 90, maxHull: 100, shield: 50, maxShield: 50, zone: "mid", stance: "fire" },
            { playerId: "e2", username: "Weak", shipClass: "scout", hull: 20, maxHull: 100, shield: 10, maxShield: 50, zone: "mid", stance: "evade" },
          ],
        },
      ],
    };

    const weakest = combat.findWeakestEnemy(battle, "player1");
    expect(weakest).not.toBeNull();
    expect(weakest!.playerId).toBe("e2");
    expect(weakest!.hull).toBe(20);
  });

  test("findWeakestEnemy returns null for no enemies", () => {
    const battle: BattleStatus = {
      id: "b1",
      tick: 100,
      zone: "mid",
      stance: "fire",
      sides: [
        {
          id: "our_side",
          participants: [
            { playerId: "player1", username: "Us", shipClass: "fighter", hull: 80, maxHull: 100, shield: 50, maxShield: 50, zone: "mid", stance: "fire" },
          ],
        },
      ],
    };
    expect(combat.findWeakestEnemy(battle, "player1")).toBeNull();
  });

  test("shouldFlee when hull critical in battle", () => {
    const ship = makeShip({ hull: 15, maxHull: 100 });
    const battle: BattleStatus = {
      id: "b1", tick: 100, zone: "mid", stance: "fire",
      sides: [
        { id: "s1", participants: [{ playerId: "player1", username: "Us", shipClass: "fighter", hull: 15, maxHull: 100, shield: 0, maxShield: 50, zone: "mid", stance: "fire" }] },
        { id: "s2", participants: [{ playerId: "e1", username: "Enemy", shipClass: "fighter", hull: 80, maxHull: 100, shield: 50, maxShield: 50, zone: "mid", stance: "fire" }] },
      ],
    };
    expect(combat.shouldFlee(ship, battle)).toBe(true);
  });

  test("shouldFlee when vastly outnumbered", () => {
    const ship = makeShip({ hull: 80, maxHull: 100 });
    const makeParticipant = (id: string) => ({
      playerId: id, username: id, shipClass: "fighter", hull: 80, maxHull: 100, shield: 50, maxShield: 50, zone: "mid" as const, stance: "fire" as const,
    });
    const battle: BattleStatus = {
      id: "b1", tick: 100, zone: "mid", stance: "fire",
      sides: [
        { id: "s1", participants: [makeParticipant("player1")] },
        { id: "s2", participants: [makeParticipant("e1"), makeParticipant("e2"), makeParticipant("e3")] },
      ],
    };
    expect(combat.shouldFlee(ship, battle)).toBe(true);
  });
});
