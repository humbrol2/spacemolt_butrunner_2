/**
 * Harvester routine - flexible resource extraction (ore, gas, ice).
 * Similar to miner but supports multiple target POIs and resource types.
 *
 * Params:
 *   targets: Array<{poiId: string, priority: number}> (auto-discovered if empty)
 *   depositStation: string - Base ID to deposit at (auto-discovered if empty)
 *   resourceType?: string  - "ore" | "gas" | "ice" (informational)
 */

import type { BotContext } from "../bot/types";
import {
  navigateToPoi,
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  depositItem,
  handleEmergency,
  safetyCheck,
  getParam,
  isProtectedItem,
} from "./helpers";

interface HarvestTarget {
  poiId: string;
  priority: number;
}

export async function* harvester(ctx: BotContext): AsyncGenerator<string, void, void> {
  let rawTargets = getParam<HarvestTarget[]>(ctx, "targets", []);
  let depositStation = getParam(ctx, "depositStation", "");
  const resourceType = getParam(ctx, "resourceType", "ore");

  // Auto-discover targets if empty
  if (rawTargets.length === 0) {
    yield "discovering harvest targets...";
    try {
      const system = await ctx.api.getSystem();
      // Filter POIs by equipped modules
      const hasIceHarvester = ctx.ship.modules.some((m) =>
        m.moduleId.includes("ice_harvester") || m.name.toLowerCase().includes("ice harvester")
      );
      const hasGasHarvester = ctx.ship.modules.some((m) =>
        m.moduleId.includes("gas_harvester") || m.name.toLowerCase().includes("gas harvester")
      );
      const resourcePois = system.pois.filter((p) =>
        p.type === "asteroid_belt" || p.type === "asteroid"
        || (p.type === "ice_field" && hasIceHarvester)
        || ((p.type === "gas_cloud" || p.type === "nebula") && hasGasHarvester)
      );
      if (resourcePois.length > 0) {
        rawTargets = resourcePois.map((p, i) => ({ poiId: p.id, priority: resourcePois.length - i }));
        yield `found ${rawTargets.length} resource sites`;
      }
      if (!depositStation) {
        const station = system.pois.find((p) => p.hasBase);
        if (station?.baseId) {
          depositStation = station.baseId;
          yield `deposit at: ${station.baseName ?? station.name}`;
        }
      }
    } catch (err) {
      yield `discovery error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (rawTargets.length === 0) {
    yield "error: no harvest targets found in current system";
    return;
  }

  // Sort by priority descending
  const targets = [...rawTargets].sort((a, b) => b.priority - a.priority);

  while (!ctx.shouldStop) {
    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) {
        yield "emergency unresolved, stopping";
        return;
      }
    }

    // ── Visit each target ──
    for (const target of targets) {
      if (ctx.shouldStop) return;

      // Check if cargo is already full
      if (!ctx.cargo.hasSpace(ctx.ship, 1)) {
        yield "cargo full, heading to depot";
        break;
      }

      // Navigate to target POI
      yield `traveling to ${target.poiId}`;
      try {
        await navigateToPoi(ctx, target.poiId);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        continue; // Try next target
      }

      if (ctx.shouldStop) return;

      // Mine/harvest at this location
      while (!ctx.shouldStop && ctx.cargo.hasSpace(ctx.ship, 1)) {
        yield `harvesting ${resourceType}`;
        try {
          const result = await ctx.api.mine();
          await ctx.refreshState();

          if (result.quantity === 0 || result.remaining === 0) {
            yield `${target.poiId} depleted`;
            break;
          }

          yield `harvested ${result.quantity} ${result.resourceId}`;
        } catch (err) {
          yield `harvest error: ${err instanceof Error ? err.message : String(err)}`;
          break;
        }

        // Fuel safety
        if (ctx.fuel.getLevel(ctx.ship) === "critical") {
          yield "fuel critical, aborting harvest";
          break;
        }
      }
    }

    if (ctx.shouldStop) return;

    // ── Deposit at station ──
    // Use faction storage station if configured
    const factionStation = ctx.fleetConfig.factionStorageStation;
    const isFactionMode = ctx.settings.storageMode === "faction_deposit"
      || ctx.fleetConfig.defaultStorageMode === "faction_deposit";
    const targetStation = (isFactionMode && factionStation)
      ? factionStation
      : depositStation;

    yield "returning to deposit station";
    try {
      if (targetStation) {
        await navigateAndDock(ctx, targetStation);
      } else {
        await findAndDock(ctx);
      }
    } catch (err) {
      yield `dock failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    if (!ctx.player.dockedAtBase) {
      yield "error: could not dock at any station";
      return;
    }

    if (ctx.shouldStop) return;

    // Deposit all cargo
    yield "depositing materials";
    for (const item of ctx.ship.cargo) {
      if (ctx.shouldStop) return;
      if (isProtectedItem(item.itemId)) continue;
      try {
        await depositItem(ctx, item.itemId);
        yield `deposited ${item.quantity} ${item.itemId}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        yield `deposit failed for ${item.itemId}: ${msg}, selling instead`;
        try {
          const result = await ctx.api.sell(item.itemId, item.quantity);
          await ctx.refreshState();
          yield `sold ${result.quantity} ${item.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
        } catch {
          yield `sell also failed for ${item.itemId}, skipping`;
        }
      }
    }

    // Service
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    yield "cycle_complete";
  }
}
