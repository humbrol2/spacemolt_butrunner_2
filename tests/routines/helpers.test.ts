import { describe, test, expect, beforeEach } from "bun:test";
import {
  travelToPoi,
  navigateTo,
  navigateToPoi,
  dockAtCurrent,
  navigateAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  serviceShip,
  sellItem,
  sellAllCargo,
  depositItem,
  handleFuelEmergency,
  needsEmergencyRepair,
  safetyCheck,
  handleEmergency,
  getParam,
  interruptibleSleep,
} from "../../src/routines/helpers";
import { buildMockContext, MockApiTracker } from "./test-utils";
import type { BotContext } from "../../src/bot/types";

describe("Routine Helpers", () => {
  let ctx: BotContext;
  let tracker: MockApiTracker;

  beforeEach(() => {
    ({ ctx, tracker } = buildMockContext());
  });

  // ── Navigation ──

  describe("travelToPoi", () => {
    test("does nothing if already at POI", async () => {
      ctx.player.currentPoi = "sol_belt";
      const result = await travelToPoi(ctx, "sol_belt");
      expect(result).toBeNull();
      expect(tracker.calls.length).toBe(0);
    });

    test("refuels and undocks before traveling if docked", async () => {
      ctx.player.currentPoi = "sol_earth";
      ctx.player.dockedAtBase = "base_earth";
      await travelToPoi(ctx, "sol_belt");

      expect(tracker.calls).toContain("refuel");
      expect(tracker.calls).toContain("undock");
      expect(tracker.calls).toContain("travel:sol_belt");
      // Refuel before undock
      const refuelIdx = tracker.calls.indexOf("refuel");
      const undockIdx = tracker.calls.indexOf("undock");
      expect(refuelIdx).toBeLessThan(undockIdx);
    });

    test("travels directly if not docked", async () => {
      ctx.player.currentPoi = "sol_earth";
      ctx.player.dockedAtBase = null;
      await travelToPoi(ctx, "sol_belt");

      expect(tracker.calls[0]).toBe("travel:sol_belt");
    });
  });

  describe("navigateTo", () => {
    test("jumps through systems", async () => {
      ctx.player.currentSystem = "sol";
      ctx.player.dockedAtBase = null;
      await navigateTo(ctx, "alpha");

      expect(tracker.calls).toContain("jump:alpha");
    });

    test("refuels and undocks before jumping", async () => {
      ctx.player.currentSystem = "sol";
      ctx.player.dockedAtBase = "base_earth";
      await navigateTo(ctx, "alpha");

      expect(tracker.calls).toContain("refuel");
      expect(tracker.calls).toContain("undock");
      expect(tracker.calls).toContain("jump:alpha");
      const refuelIdx = tracker.calls.indexOf("refuel");
      const undockIdx = tracker.calls.indexOf("undock");
      expect(refuelIdx).toBeLessThan(undockIdx);
    });

    test("travels to POI within destination system", async () => {
      ctx.player.currentSystem = "sol";
      ctx.player.dockedAtBase = null;
      await navigateTo(ctx, "alpha", "alpha_station");

      expect(tracker.calls).toContain("jump:alpha");
      expect(tracker.calls).toContain("travel:alpha_station");
    });

    test("skips jump if already in system", async () => {
      ctx.player.currentSystem = "sol";
      ctx.player.dockedAtBase = null;
      await navigateTo(ctx, "sol", "sol_belt");

      expect(tracker.calls).not.toContain("jump:sol");
      expect(tracker.calls).toContain("travel:sol_belt");
    });

    test("throws for unreachable system", async () => {
      ctx.player.currentSystem = "sol";
      ctx.player.dockedAtBase = null;
      await expect(navigateTo(ctx, "nonexistent")).rejects.toThrow("No route");
    });
  });

  describe("navigateToPoi", () => {
    test("resolves system from POI and navigates", async () => {
      ctx.player.currentSystem = "sol";
      ctx.player.dockedAtBase = null;
      await navigateToPoi(ctx, "alpha_station");

      expect(tracker.calls).toContain("jump:alpha");
      expect(tracker.calls).toContain("travel:alpha_station");
    });

    test("throws for unknown POI", async () => {
      await expect(navigateToPoi(ctx, "unknown_poi")).rejects.toThrow("Unknown POI");
    });
  });

  // ── Docking ──

  describe("dockAtCurrent", () => {
    test("does nothing if already docked", async () => {
      ctx.player.dockedAtBase = "base_earth";
      await dockAtCurrent(ctx);
      expect(tracker.calls.length).toBe(0);
    });

    test("docks if not docked", async () => {
      ctx.player.dockedAtBase = null;
      await dockAtCurrent(ctx);
      expect(tracker.calls[0]).toBe("dock");
    });
  });

  describe("navigateAndDock", () => {
    test("navigates to base and docks", async () => {
      ctx.player.currentSystem = "sol";
      ctx.player.dockedAtBase = null;
      await navigateAndDock(ctx, "base_alpha");

      expect(tracker.calls).toContain("jump:alpha");
      expect(tracker.calls).toContain("travel:alpha_station");
      expect(tracker.calls).toContain("dock");
    });

    test("throws for unknown base", async () => {
      await expect(navigateAndDock(ctx, "unknown_base")).rejects.toThrow("Unknown base");
    });
  });

  // ── Services ──

  describe("refuelIfNeeded", () => {
    test("refuels when below threshold", async () => {
      ctx.ship.fuel = 30;
      ctx.ship.maxFuel = 100;
      const did = await refuelIfNeeded(ctx, 60);
      expect(did).toBe(true);
      expect(tracker.calls).toContain("refuel");
    });

    test("skips when above threshold", async () => {
      ctx.ship.fuel = 80;
      ctx.ship.maxFuel = 100;
      const did = await refuelIfNeeded(ctx, 60);
      expect(did).toBe(false);
      expect(tracker.calls.length).toBe(0);
    });
  });

  describe("repairIfNeeded", () => {
    test("repairs when hull below threshold", async () => {
      ctx.ship.hull = 50;
      ctx.ship.maxHull = 100;
      const did = await repairIfNeeded(ctx, 80);
      expect(did).toBe(true);
      expect(tracker.calls).toContain("repair");
    });

    test("skips when hull above threshold", async () => {
      ctx.ship.hull = 90;
      ctx.ship.maxHull = 100;
      const did = await repairIfNeeded(ctx, 80);
      expect(did).toBe(false);
    });
  });

  describe("serviceShip", () => {
    test("repairs and refuels", async () => {
      ctx.ship.hull = 50;
      ctx.ship.maxHull = 100;
      ctx.ship.fuel = 30;
      ctx.ship.maxFuel = 100;
      await serviceShip(ctx);
      expect(tracker.calls).toContain("repair");
      expect(tracker.calls).toContain("refuel");
    });
  });

  // ── Cargo ──

  describe("sellItem", () => {
    test("sells item from cargo", async () => {
      ctx.ship.cargo = [{ itemId: "ore_iron", quantity: 10 }];
      ctx.ship.cargoUsed = 10;
      const result = await sellItem(ctx, "ore_iron");
      expect(result).not.toBeNull();
      expect(tracker.calls).toContain("sell:ore_iron:10");
    });

    test("returns null if item not in cargo", async () => {
      ctx.ship.cargo = [];
      const result = await sellItem(ctx, "ore_iron");
      expect(result).toBeNull();
    });
  });

  describe("sellAllCargo", () => {
    test("sells all cargo items", async () => {
      ctx.ship.cargo = [
        { itemId: "ore_iron", quantity: 10 },
        { itemId: "ore_copper", quantity: 5 },
      ];
      ctx.ship.cargoUsed = 15;
      const result = await sellAllCargo(ctx);
      expect(result.totalEarned).toBeGreaterThan(0);
      expect(result.items).toHaveLength(2);
      expect(tracker.calls).toContain("sell:ore_iron:10");
      expect(tracker.calls).toContain("sell:ore_copper:5");
    });
  });

  describe("depositItem", () => {
    test("deposits item to storage", async () => {
      ctx.ship.cargo = [{ itemId: "ore_iron", quantity: 10 }];
      ctx.ship.cargoUsed = 10;
      await depositItem(ctx, "ore_iron");
      expect(tracker.calls).toContain("depositItems:ore_iron:10");
    });

    test("does nothing if item not in cargo", async () => {
      ctx.ship.cargo = [];
      await depositItem(ctx, "ore_iron");
      expect(tracker.calls.length).toBe(0);
    });
  });

  // ── Emergency ──

  describe("safetyCheck", () => {
    test("returns null when safe", () => {
      ctx.ship.fuel = 80;
      ctx.ship.maxFuel = 100;
      ctx.ship.hull = 90;
      ctx.ship.maxHull = 100;
      expect(safetyCheck(ctx)).toBeNull();
    });

    test("detects fuel critical", () => {
      ctx.ship.fuel = 10;
      ctx.ship.maxFuel = 100;
      ctx.ship.hull = 90;
      ctx.ship.maxHull = 100;
      expect(safetyCheck(ctx)).toBe("fuel_critical");
    });

    test("detects hull critical", () => {
      ctx.ship.fuel = 80;
      ctx.ship.maxFuel = 100;
      ctx.ship.hull = 20;
      ctx.ship.maxHull = 100;
      expect(safetyCheck(ctx)).toBe("hull_critical");
    });
  });

  describe("needsEmergencyRepair", () => {
    test("true when hull below 25%", () => {
      ctx.ship.hull = 20;
      ctx.ship.maxHull = 100;
      expect(needsEmergencyRepair(ctx)).toBe(true);
    });

    test("false when hull above 25%", () => {
      ctx.ship.hull = 30;
      ctx.ship.maxHull = 100;
      expect(needsEmergencyRepair(ctx)).toBe(false);
    });
  });

  // ── Utility ──

  describe("getParam", () => {
    test("returns param value if set", () => {
      ctx.params = { target: "belt_1" };
      expect(getParam(ctx, "target", "default")).toBe("belt_1");
    });

    test("returns default if not set", () => {
      ctx.params = {};
      expect(getParam(ctx, "target", "default")).toBe("default");
    });
  });

  describe("interruptibleSleep", () => {
    test("sleeps for duration", async () => {
      const start = Date.now();
      await interruptibleSleep(ctx, 1500);
      expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
    });

    test("interrupts when shouldStop", async () => {
      setTimeout(() => { (ctx as any)._shouldStop = true; }, 20);
      const start = Date.now();
      const completed = await interruptibleSleep(ctx, 5000);
      expect(completed).toBe(false);
      expect(Date.now() - start).toBeLessThan(2000); // 1s polling interval + tolerance
    });
  });
});
