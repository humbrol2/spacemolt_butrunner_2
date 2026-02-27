/**
 * Shared test mocks for Bot engine testing.
 */

import type { PlayerState, ShipState, StarSystem, PoiDetail, LoginResult } from "../../src/types/game";
import type { BotDeps } from "../../src/bot/bot";
import type { FleetStatus } from "../../src/bot/types";
import { Galaxy } from "../../src/core/galaxy";
import { Navigation } from "../../src/core/navigation";
import { Cargo } from "../../src/core/cargo";
import { Fuel } from "../../src/core/fuel";
import { Market } from "../../src/core/market";
import { Combat } from "../../src/core/combat";
import { Crafting } from "../../src/core/crafting";
import { Station } from "../../src/core/station";

// ── Mock Player/Ship ──

export function mockPlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: "player1",
    username: "TestBot",
    empire: "solarian",
    credits: 5000,
    currentSystem: "sol",
    currentPoi: "sol_earth",
    currentShipId: "ship1",
    homeBase: "base_earth",
    dockedAtBase: "base_earth",
    factionId: null,
    factionRank: null,
    statusMessage: null,
    clanTag: null,
    anonymous: false,
    isCloaked: false,
    skills: { mining: 3, trading: 2 },
    skillXp: {},
    stats: {
      shipsDestroyed: 0,
      timesDestroyed: 0,
      oreMined: 100,
      creditsEarned: 5000,
      creditsSpent: 2000,
      tradesCompleted: 10,
      systemsVisited: 5,
      itemsCrafted: 0,
      missionsCompleted: 0,
    },
    ...overrides,
  };
}

export function mockShip(overrides: Partial<ShipState> = {}): ShipState {
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
    fuel: 80,
    maxFuel: 100,
    cargoUsed: 10,
    cargoCapacity: 50,
    cpuUsed: 0,
    cpuCapacity: 10,
    powerUsed: 0,
    powerCapacity: 10,
    modules: [],
    cargo: [{ itemId: "ore_iron", quantity: 10 }],
    ...overrides,
  };
}

// ── Mock API Client ──

export class MockApiClient {
  loginCalled = false;
  logoutCalled = false;
  getStatusCalled = false;
  loginShouldFail = false;
  getStatusCount = 0;

  private _player: PlayerState;
  private _ship: ShipState;

  constructor(player?: PlayerState, ship?: ShipState) {
    this._player = player ?? mockPlayer();
    this._ship = ship ?? mockShip();
  }

  async login(_password?: string): Promise<LoginResult> {
    this.loginCalled = true;
    if (this.loginShouldFail) throw new Error("Login failed: invalid credentials");
    return {
      sessionId: "session_abc123",
      player: this._player,
      ship: this._ship,
      system: {
        id: "sol",
        name: "Sol",
        x: 0,
        y: 0,
        empire: "solarian",
        policeLevel: 3,
        connections: ["alpha"],
        pois: [],
      },
      poi: {
        id: "sol_earth",
        systemId: "sol",
        type: "planet",
        name: "Earth",
        description: "",
        position: { x: 0, y: 0 },
        resources: [],
        baseId: "base_earth",
      },
    };
  }

  async logout(): Promise<void> {
    this.logoutCalled = true;
  }

  async getStatus(): Promise<{ player: PlayerState; ship: ShipState }> {
    this.getStatusCalled = true;
    this.getStatusCount++;
    return { player: this._player, ship: this._ship };
  }

  get stats() {
    return { mutations: 0, queries: this.getStatusCount };
  }
}

// ── Mock Training Logger ──

export class MockTrainingLogger {
  snapshots: unknown[] = [];
  decisions: unknown[] = [];

  logSnapshot(params: unknown): void {
    this.snapshots.push(params);
  }

  logDecision(params: unknown): void {
    this.decisions.push(params);
  }

  logEpisode(_params: unknown): void {}
  logMarketPrices(_tick: number, _stationId: string, _prices: unknown[]): void {}
  logCommanderDecision(_params: unknown): void {}
  setGameVersion(_v: string): void {}
  configure(_opts: unknown): void {}
  getStats() {
    return { decisions: 0, snapshots: 0, episodes: 0, marketRecords: 0, commanderDecisions: 0, dbSizeBytes: 0 };
  }
}

// ── Mock Game Cache ──

export class MockGameCache {
  marketPricesData = new Map<string, Array<{ itemId: string; buyPrice: number; sellPrice: number }>>();

  getMarketPrices(stationId: string) {
    return this.marketPricesData.get(stationId) ?? null;
  }
  setMarketPrices() {}
  getSystemDetail(_id: string) {
    return null;
  }
  setSystemDetail() {}
  get version() {
    return "test";
  }
  getMarketFreshness(stationId: string) {
    return { stationId, fetchedAt: 0, ageMs: Infinity, fresh: false };
  }
  getAllMarketFreshness() {
    return [];
  }
  getFreshStationIds() {
    return [];
  }
  hasAnyMarketData() {
    return false;
  }
}

// ── Setup Galaxy ──

export function setupTestGalaxy(): Galaxy {
  const galaxy = new Galaxy();
  galaxy.load([
    {
      id: "sol",
      name: "Sol",
      x: 0,
      y: 0,
      empire: "solarian",
      policeLevel: 3,
      connections: ["alpha"],
      pois: [
        { id: "sol_earth", name: "Earth", type: "planet", hasBase: true, baseId: "base_earth", baseName: "Earth Station", resources: [] },
        { id: "sol_belt", name: "Sol Belt", type: "asteroid_belt", hasBase: false, baseId: null, baseName: null, resources: [{ resourceId: "ore_iron", richness: 3, remaining: 1000 }] },
      ],
    },
    {
      id: "alpha",
      name: "Alpha",
      x: 10,
      y: 5,
      empire: "solarian",
      policeLevel: 2,
      connections: ["sol"],
      pois: [
        { id: "alpha_station", name: "Alpha Station", type: "station", hasBase: true, baseId: "base_alpha", baseName: "Alpha", resources: [] },
      ],
    },
  ]);
  return galaxy;
}

// ── Build Full Mock Deps ──

export function buildMockDeps(overrides: Partial<BotDeps> = {}): BotDeps & { mockApi: MockApiClient; mockLogger: MockTrainingLogger } {
  const galaxy = setupTestGalaxy();
  const nav = new Navigation(galaxy);
  const cargo = new Cargo();
  const fuel = new Fuel(nav);
  const mockCache = new MockGameCache();
  const market = new Market(mockCache as any, galaxy);
  const combat = new Combat(galaxy);
  const crafting = new Crafting(cargo);
  const station = new Station(galaxy);
  const mockApi = new MockApiClient();
  const mockLogger = new MockTrainingLogger();

  return {
    api: mockApi as any,
    nav,
    market,
    cargo,
    fuel,
    combat,
    crafting,
    station,
    galaxy,
    cache: mockCache as any,
    logger: mockLogger as any,
    getFleetStatus: () => ({ bots: [], totalCredits: 0, activeBots: 0 }),
    mockApi,
    mockLogger,
    ...overrides,
  };
}
