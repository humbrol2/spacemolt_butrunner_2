/**
 * Test utilities for routine testing.
 * Provides a mock BotContext with API call tracking and controllable state.
 */

import type { BotContext } from "../../src/bot/types";
import type { PlayerState, ShipState, MiningYield, TravelResult, TradeResult, CraftResult } from "../../src/types/game";
import { Galaxy } from "../../src/core/galaxy";
import { Navigation } from "../../src/core/navigation";
import { Cargo } from "../../src/core/cargo";
import { Fuel } from "../../src/core/fuel";
import { Market } from "../../src/core/market";
import { Combat } from "../../src/core/combat";
import { Crafting } from "../../src/core/crafting";
import { Station } from "../../src/core/station";
import { setupTestGalaxy, mockPlayer, mockShip, MockGameCache, MockTrainingLogger } from "../helpers/mocks";

/** Tracks all API calls made during a test */
export class MockApiTracker {
  calls: string[] = [];
  mineResults: MiningYield = { resourceId: "ore_iron", quantity: 5, remaining: 100, xpGained: { mining: 10 } };
  travelResults: TravelResult = { destination: "", arrivalTick: 1, fuelConsumed: 5 };
  sellResults: TradeResult = { itemId: "", quantity: 0, priceEach: 10, total: 0 };
  craftResults: CraftResult = { recipeId: "", outputItem: "", outputQuantity: 1, xpGained: {} };
  mineShouldFail = false;
  mineDepletedAfter = Infinity;
  private mineCount = 0;

  reset(): void {
    this.calls = [];
    this.mineCount = 0;
  }

  recordMine(): MiningYield {
    this.mineCount++;
    this.calls.push("mine");
    if (this.mineShouldFail) throw new Error("Mining failed");
    if (this.mineCount > this.mineDepletedAfter) {
      return { ...this.mineResults, quantity: 0, remaining: 0 };
    }
    return { ...this.mineResults };
  }
}

/** Build a fully mock BotContext for routine testing */
export function buildMockContext(overrides?: {
  player?: Partial<PlayerState>;
  ship?: Partial<ShipState>;
  params?: Record<string, unknown>;
}): { ctx: BotContext; tracker: MockApiTracker; player: PlayerState; ship: ShipState } {
  const galaxy = setupTestGalaxy();
  const nav = new Navigation(galaxy);
  const cargo = new Cargo();
  const fuel = new Fuel(nav);
  const mockCache = new MockGameCache();
  const market = new Market(mockCache as any, galaxy);
  const combat = new Combat(galaxy);
  const crafting = new Crafting(cargo);
  const station = new Station(galaxy);
  const mockLogger = new MockTrainingLogger();

  // Load test recipes
  crafting.load([
    {
      id: "recipe_iron_bar",
      name: "Iron Bar",
      description: "Smelt iron ore",
      outputItem: "iron_bar",
      outputQuantity: 1,
      ingredients: [{ itemId: "ore_iron", quantity: 3 }],
      requiredSkills: { crafting: 1 },
      xpRewards: { crafting: 5 },
    },
  ]);

  const player = mockPlayer(overrides?.player);
  const ship = mockShip(overrides?.ship);
  const tracker = new MockApiTracker();

  let _shouldStop = false;

  // Build mock API that tracks calls
  const api = {
    mine: async (): Promise<MiningYield> => {
      return tracker.recordMine();
    },
    travel: async (poi: string): Promise<TravelResult> => {
      tracker.calls.push(`travel:${poi}`);
      player.currentPoi = poi;
      return { ...tracker.travelResults, destination: poi };
    },
    jump: async (sys: string): Promise<TravelResult> => {
      tracker.calls.push(`jump:${sys}`);
      player.currentSystem = sys;
      return { ...tracker.travelResults, destination: sys };
    },
    dock: async () => {
      tracker.calls.push("dock");
      // Set docked at base for the current POI
      const poi = galaxy.getPoi(player.currentPoi);
      player.dockedAtBase = poi?.baseId ?? "base_current";
      return {};
    },
    undock: async () => {
      tracker.calls.push("undock");
      player.dockedAtBase = null;
      return {};
    },
    sell: async (itemId: string, qty: number): Promise<TradeResult> => {
      tracker.calls.push(`sell:${itemId}:${qty}`);
      // Use cached sell price if available (prevents recordSellResult from corrupting cache)
      const cachedPrices = mockCache.marketPricesData.get(player.dockedAtBase ?? "");
      const cachedPrice = cachedPrices?.find((p) => p.itemId === itemId)?.sellPrice;
      const priceEach = cachedPrice ?? 10;
      const total = qty * priceEach;
      player.credits += total;
      ship.cargo = ship.cargo.filter((c) => c.itemId !== itemId);
      ship.cargoUsed = ship.cargo.reduce((s, c) => s + c.quantity, 0);
      return { itemId, quantity: qty, priceEach, total };
    },
    buy: async (itemId: string, qty: number): Promise<TradeResult> => {
      tracker.calls.push(`buy:${itemId}:${qty}`);
      const total = qty * 10;
      player.credits -= total;
      const existing = ship.cargo.find((c) => c.itemId === itemId);
      if (existing) existing.quantity += qty;
      else ship.cargo.push({ itemId, quantity: qty });
      ship.cargoUsed += qty;
      return { itemId, quantity: qty, priceEach: 10, total };
    },
    refuel: async () => {
      tracker.calls.push("refuel");
      ship.fuel = ship.maxFuel;
      return {};
    },
    repair: async () => {
      tracker.calls.push("repair");
      ship.hull = ship.maxHull;
      return {};
    },
    craft: async (recipeId: string, count?: number): Promise<CraftResult> => {
      tracker.calls.push(`craft:${recipeId}:${count ?? 1}`);
      return { ...tracker.craftResults, recipeId, outputItem: "iron_bar", outputQuantity: count ?? 1 };
    },
    depositItems: async (itemId: string, qty: number) => {
      tracker.calls.push(`depositItems:${itemId}:${qty}`);
      ship.cargo = ship.cargo.filter((c) => c.itemId !== itemId);
      ship.cargoUsed = ship.cargo.reduce((s, c) => s + c.quantity, 0);
      return {};
    },
    withdrawItems: async (itemId: string, qty: number) => {
      tracker.calls.push(`withdrawItems:${itemId}:${qty}`);
      const existing = ship.cargo.find((c) => c.itemId === itemId);
      if (existing) existing.quantity += qty;
      else ship.cargo.push({ itemId, quantity: qty });
      ship.cargoUsed += qty;
      return {};
    },
    createBuyOrder: async (itemId: string, qty: number, price: number) => {
      tracker.calls.push(`createBuyOrder:${itemId}:${qty}:${price}`);
      return {};
    },
    createSellOrder: async (itemId: string, qty: number, price: number) => {
      tracker.calls.push(`createSellOrder:${itemId}:${qty}:${price}`);
      return {};
    },
    cancelOrder: async (id: string) => {
      tracker.calls.push(`cancelOrder:${id}`);
      return {};
    },
    modifyOrder: async (id: string, price: number) => {
      tracker.calls.push(`modifyOrder:${id}:${price}`);
      return {};
    },
    sendGift: async (recipient: string, opts: any) => {
      tracker.calls.push(`sendGift:${recipient}`);
      return {};
    },
    getStatus: async () => {
      tracker.calls.push("getStatus");
      return { player, ship };
    },
    getSystem: async () => {
      tracker.calls.push("getSystem");
      return galaxy.getSystem(player.currentSystem)!;
    },
    getPoi: async () => {
      tracker.calls.push("getPoi");
      return { id: player.currentPoi, systemId: player.currentSystem, type: "planet", name: "Test", description: "", position: { x: 0, y: 0 }, resources: [], baseId: null };
    },
    getNearby: async () => {
      tracker.calls.push("getNearby");
      return [];
    },
    getWrecks: async () => {
      tracker.calls.push("getWrecks");
      return [];
    },
    getBattleStatus: async () => {
      tracker.calls.push("getBattleStatus");
      return null;
    },
    getMissions: async () => {
      tracker.calls.push("getMissions");
      return [];
    },
    getActiveMissions: async () => {
      tracker.calls.push("getActiveMissions");
      return [];
    },
    acceptMission: async (id: string) => {
      tracker.calls.push(`acceptMission:${id}`);
      return {};
    },
    completeMission: async (id: string) => {
      tracker.calls.push(`completeMission:${id}`);
      return {};
    },
    abandonMission: async (id: string) => {
      tracker.calls.push(`abandonMission:${id}`);
      return {};
    },
    viewMarket: async () => {
      tracker.calls.push("viewMarket");
      // Return sell orders for common trade items so trader tests can buy
      return [
        { type: "sell", itemId: "ore_iron", itemName: "Iron Ore", quantity: 100, priceEach: 10 },
        { type: "sell", itemId: "ore_copper", itemName: "Copper Ore", quantity: 50, priceEach: 15 },
        { type: "sell", itemId: "refined_steel", itemName: "Refined Steel", quantity: 80, priceEach: 25 },
        { type: "sell", itemId: "component_electronics", itemName: "Electronics", quantity: 30, priceEach: 50 },
      ];
    },
    findRoute: async (targetSystem: string) => {
      tracker.calls.push(`findRoute:${targetSystem}`);
      const path = galaxy.findPath(player.currentSystem, targetSystem);
      if (!path) return { found: false, route: [], totalJumps: 0 };
      return {
        found: true,
        route: path.map((id) => ({ systemId: id, name: galaxy.getSystem(id)?.name ?? id, jumps: 0 })),
        totalJumps: path.length - 1,
      };
    },
    surveySystem: async () => {
      tracker.calls.push("surveySystem");
      return {};
    },
    cloak: async (enable?: boolean) => {
      tracker.calls.push(`cloak:${enable}`);
      return {};
    },
    factionSubmitIntel: async (systems: unknown[]) => {
      tracker.calls.push("factionSubmitIntel");
      return {};
    },
    attack: async (targetId: string) => {
      tracker.calls.push(`attack:${targetId}`);
      return {};
    },
    battle: async (action: string, opts?: any) => {
      tracker.calls.push(`battle:${action}`);
      return {};
    },
    lootWreck: async (wreckId: string, itemId: string, qty: number) => {
      tracker.calls.push(`lootWreck:${wreckId}:${itemId}:${qty}`);
      return {};
    },
    towWreck: async (wreckId: string) => {
      tracker.calls.push(`towWreck:${wreckId}`);
      return {};
    },
    releaseTow: async () => {
      tracker.calls.push("releaseTow");
      return {};
    },
    scrapWreck: async () => {
      tracker.calls.push("scrapWreck");
      return {};
    },
    sellWreck: async () => {
      tracker.calls.push("sellWreck");
      return {};
    },
    salvageWreck: async (wreckId: string) => {
      tracker.calls.push(`salvageWreck:${wreckId}`);
      return {};
    },
    viewStorage: async () => {
      tracker.calls.push("viewStorage");
      return {};
    },
    depositCredits: async (amount: number) => {
      tracker.calls.push(`depositCredits:${amount}`);
      return {};
    },
    withdrawCredits: async (amount: number) => {
      tracker.calls.push(`withdrawCredits:${amount}`);
      return {};
    },
    getSkills: async () => {
      tracker.calls.push("getSkills");
      return {};
    },
    scan: async (targetId: string) => {
      tracker.calls.push(`scan:${targetId}`);
      return {};
    },
    reload: async (weaponId: string, ammoId: string) => {
      tracker.calls.push(`reload:${weaponId}:${ammoId}`);
      return {};
    },
    buyInsurance: async (ticks: number) => {
      tracker.calls.push(`buyInsurance:${ticks}`);
      return {};
    },
    factionDepositItems: async (itemId: string, qty: number) => {
      tracker.calls.push(`factionDepositItems:${itemId}:${qty}`);
      ship.cargo = ship.cargo.filter((c) => c.itemId !== itemId);
      ship.cargoUsed = ship.cargo.reduce((s, c) => s + c.quantity, 0);
      return {};
    },
    factionDepositCredits: async (amount: number) => {
      tracker.calls.push(`factionDepositCredits:${amount}`);
      return {};
    },
    factionWithdrawItems: async (itemId: string, qty: number) => {
      tracker.calls.push(`factionWithdrawItems:${itemId}:${qty}`);
      const existing = ship.cargo.find((c) => c.itemId === itemId);
      if (existing) existing.quantity += qty;
      else ship.cargo.push({ itemId, quantity: qty });
      ship.cargoUsed += qty;
      return {};
    },
    factionWithdrawCredits: async (amount: number) => {
      tracker.calls.push(`factionWithdrawCredits:${amount}`);
      return {};
    },
    viewFactionStorage: async () => {
      tracker.calls.push("viewFactionStorage");
      return [];
    },
  };

  const ctx: BotContext = {
    botId: "bot1",
    username: "TestBot",
    session: { id: "sess_1", playerId: "player1", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30 * 60000).toISOString() },
    api: api as any,
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
    params: overrides?.params ?? {},
    settings: {
      fuelEmergencyThreshold: 20,
      autoRepair: true,
      maxCargoFillPct: 90,
      storageMode: "sell",
      factionStorage: false,
    },
    fleetConfig: {
      homeSystem: "",
      homeBase: "",
      defaultStorageMode: "sell",
      factionStorageStation: "",
      factionTaxPercent: 0,
      minBotCredits: 0,
    },
    get player() { return player; },
    get ship() { return ship; },
    get shouldStop() { return _shouldStop; },
    set shouldStop(v: boolean) { _shouldStop = v; },
    refreshState: async () => {
      // No-op in tests - state is mutated directly
    },
    recordFactionWithdrawal: () => {},
  };

  // Expose _shouldStop for test manipulation
  (ctx as any)._shouldStop = false;
  Object.defineProperty(ctx, "shouldStop", {
    get: () => (ctx as any)._shouldStop,
    set: (v: boolean) => { (ctx as any)._shouldStop = v; },
  });

  return { ctx, tracker, player, ship };
}

/** Collect all yields from a routine until it completes or hits maxYields */
export async function collectYields(
  gen: AsyncGenerator<string, void, void>,
  maxYields = 100
): Promise<string[]> {
  const yields: string[] = [];
  for await (const value of gen) {
    yields.push(value);
    if (yields.length >= maxYields) break;
  }
  return yields;
}

/** Run a routine and stop it after a certain yield */
export async function runUntilYield(
  ctx: BotContext,
  gen: AsyncGenerator<string, void, void>,
  targetYield: string,
  maxYields = 50
): Promise<string[]> {
  const yields: string[] = [];
  for await (const value of gen) {
    yields.push(value);
    if (value === targetYield || value.includes(targetYield)) {
      ctx.shouldStop = true;
    }
    if (yields.length >= maxYields) break;
  }
  return yields;
}
