/**
 * Miner routine - extracts ore from asteroid belts, sells/deposits at station.
 *
 * Loop: undock -> travel to belt -> mine until full -> return to station -> sell -> refuel -> repeat
 *
 * Params:
 *   targetBelt: string     - POI ID of asteroid belt (auto-discovered if empty)
 *   sellStation: string    - Base ID to sell at (auto-discovered if empty)
 *   targetOre?: string     - Preferred ore type (informational)
 *   depositToStorage?: boolean - Deposit instead of sell
 */

import type { BotContext } from "../bot/types";
import {
  navigateToPoi,
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  disposeCargo,
  depositItem,
  handleEmergency,
  safetyCheck,
  getParam,
  isProtectedItem,
  payFactionTax,
  ensureMinCredits,
} from "./helpers";

export async function* miner(ctx: BotContext): AsyncGenerator<string, void, void> {
  let targetBelt = getParam(ctx, "targetBelt", "");
  let sellStation = getParam(ctx, "sellStation", "");
  const targetOre = getParam(ctx, "targetOre", "");
  const depositToStorage = getParam(ctx, "depositToStorage", false);
  const equipModules = getParam<string[]>(ctx, "equipModules", []);
  const unequipModules = getParam<string[]>(ctx, "unequipModules", []);

  // ── Equip/unequip modules if commanded by scoring brain ──
  if ((equipModules.length > 0 || unequipModules.length > 0) && ctx.player.dockedAtBase) {
    // Unequip modules that aren't needed for this assignment
    for (const modId of unequipModules) {
      if (ctx.shouldStop) return;
      try {
        await ctx.api.uninstallMod(modId);
        await ctx.refreshState();
        yield `unequipped ${modId}`;
      } catch (err) {
        yield `unequip ${modId} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Equip modules needed for this assignment (withdraw from faction storage first)
    for (const modPattern of equipModules) {
      if (ctx.shouldStop) return;
      // Check if already equipped
      if (ctx.ship.modules.some((m) => m.moduleId.includes(modPattern))) continue;
      // Check cargo first
      const inCargo = ctx.ship.cargo.find((c) => c.itemId.includes(modPattern));
      if (inCargo) {
        try {
          await ctx.api.installMod(inCargo.itemId);
          await ctx.refreshState();
          yield `equipped ${inCargo.itemId} from cargo`;
          continue;
        } catch (err) {
          yield `equip ${inCargo.itemId} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      // Withdraw from faction storage
      try {
        // Find exact item ID in faction storage matching pattern
        const storage = await ctx.api.viewFactionStorage();
        const mod = (storage ?? []).find((s) => s.itemId.includes(modPattern) && s.quantity > 0);
        if (mod) {
          await ctx.api.factionWithdrawItems(mod.itemId, 1);
          await ctx.refreshState();
          yield `withdrew ${mod.itemId} from faction storage`;
          // Now install it
          try {
            await ctx.api.installMod(mod.itemId);
            await ctx.refreshState();
            yield `equipped ${mod.itemId}`;
          } catch (err) {
            yield `equip ${mod.itemId} failed: ${err instanceof Error ? err.message : String(err)}`;
            // Deposit it back
            try {
              await ctx.api.factionDepositItems(mod.itemId, 1);
              await ctx.refreshState();
            } catch { /* best effort */ }
          }
        }
      } catch (err) {
        yield `module withdraw failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // Auto-discover targets if not provided
  if (!targetBelt || !sellStation) {
    yield "discovering targets...";
    try {
      const system = await ctx.api.getSystem();
      // Find a mineable POI - filter by equipped modules
      if (!targetBelt) {
        const hasIceHarvester = ctx.ship.modules.some((m) =>
          m.moduleId.includes("ice_harvester") || m.name.toLowerCase().includes("ice harvester")
        );
        const hasGasHarvester = ctx.ship.modules.some((m) =>
          m.moduleId.includes("gas_harvester") || m.name.toLowerCase().includes("gas harvester")
        );
        const belt = system.pois.find((p) =>
          p.type === "asteroid_belt" || p.type === "asteroid"
          || (p.type === "ice_field" && hasIceHarvester)
          || ((p.type === "gas_cloud" || p.type === "nebula") && hasGasHarvester)
        );
        if (belt) {
          targetBelt = belt.id;
          yield `found belt: ${belt.name}`;
        }
      }
      // Find a station to sell at in current system
      if (!sellStation) {
        const station = system.pois.find((p) => p.hasBase);
        if (station && station.baseId) {
          sellStation = station.baseId;
          yield `found station: ${station.baseName ?? station.name}`;
        }
      }
    } catch (err) {
      yield `discovery error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (!targetBelt) {
    yield "error: no asteroid belt found in current system";
    return;
  }

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

    // ── Navigate to belt ──
    yield "traveling to belt";
    try {
      await navigateToPoi(ctx, targetBelt);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    if (ctx.shouldStop) return;

    // ── Mine until full ──
    const cargoBeforeMining = ctx.ship.cargo.reduce((sum, c) => sum + c.quantity, 0);
    let beltDepleted = false;

    while (!ctx.shouldStop && ctx.cargo.hasSpace(ctx.ship, 1)) {
      yield `mining${targetOre ? ` ${targetOre}` : ""}`;
      try {
        const result = await ctx.api.mine();
        await ctx.refreshState();

        if (result.quantity === 0 || result.remaining === 0) {
          yield "belt depleted";
          beltDepleted = true;
          break;
        }

        yield `mined ${result.quantity} ${result.resourceId}`;
      } catch (err) {
        yield `mining error: ${err instanceof Error ? err.message : String(err)}`;
        beltDepleted = true;
        break;
      }

      // Check fuel mid-mining
      if (ctx.fuel.getLevel(ctx.ship) === "critical") {
        yield "fuel critical, returning to station";
        break;
      }
    }

    if (ctx.shouldStop) return;

    // If belt depleted, update POI resource data so Commander/scoring knows
    if (beltDepleted && targetBelt) {
      ctx.galaxy.updatePoiResources(targetBelt, []);
      yield "marked belt as depleted in galaxy data";
    }

    // If belt depleted and we mined nothing, end cycle so Commander can reassign
    // (avoids repeatedly traveling to the same depleted belt)
    const cargoAfterMining = ctx.ship.cargo.reduce((sum, c) => sum + c.quantity, 0);
    if (beltDepleted && cargoAfterMining <= cargoBeforeMining) {
      yield "belt empty, requesting reassignment";
      yield "cycle_complete";
      return;
    }

    // ── Return to station ──
    // Determine disposal mode first (affects station choice)
    // When depositToStorage is true, always use faction storage (supply chain)
    const mode = depositToStorage
      ? "faction_deposit"
      : ctx.settings.storageMode;

    // Pick the right station: faction storage station > sell station > auto-find
    const factionStation = ctx.fleetConfig.factionStorageStation;
    const targetStation = (mode === "faction_deposit" && factionStation)
      ? factionStation
      : sellStation;

    yield "returning to station";
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

    // Verify we actually docked (critical — deposit/sell fails without docking)
    if (!ctx.player.dockedAtBase) {
      yield "error: could not dock at any station";
      return;
    }

    if (ctx.shouldStop) return;
    if (mode === "deposit" || mode === "faction_deposit") {
      yield `depositing cargo (${mode === "faction_deposit" ? "faction" : "personal"} storage)`;
      let depositFailed = false;
      for (const item of ctx.ship.cargo) {
        if (ctx.shouldStop) return;
        if (isProtectedItem(item.itemId)) continue;
        try {
          if (mode === "faction_deposit") {
            await ctx.api.factionDepositItems(item.itemId, item.quantity);
          } else {
            await depositItem(ctx, item.itemId);
          }
          await ctx.refreshState();
          yield `deposited ${item.quantity} ${item.itemId}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          yield `deposit failed for ${item.itemId}: ${msg}`;
          depositFailed = true;

          // If error says "no_faction_storage", this station doesn't have the lockbox.
          // Try to find the right station via galaxy or API search.
          if (msg.includes("no_faction_storage") && !ctx.fleetConfig.factionStorageStation) {
            // Check galaxy first
            const solSystem = ctx.galaxy.getSystemByName("Sol") ?? ctx.galaxy.getSystem("sol");
            if (solSystem) {
              const solStation = solSystem.pois.find((p) => p.hasBase && p.baseId);
              if (solStation?.baseId) {
                yield `lockbox not here — found Sol station: ${solStation.baseId}`;
                ctx.fleetConfig.factionStorageStation = solStation.baseId;
                ctx.fleetConfig.homeBase = solStation.baseId;
                ctx.fleetConfig.homeSystem = solSystem.id;
              }
            } else {
              // Galaxy doesn't have Sol — search via API
              try {
                const results = await ctx.api.searchSystems("sol");
                const sol = results.find((s) => String(s.name ?? "").toLowerCase() === "sol");
                if (sol) {
                  const pois = (sol.pois ?? []) as Array<Record<string, unknown>>;
                  const station = pois.find((p) => Boolean(p.has_base ?? p.hasBase));
                  if (station) {
                    const baseId = String(station.base_id ?? station.baseId ?? "");
                    const sysId = String(sol.id ?? sol.system_id ?? "");
                    if (baseId) {
                      yield `lockbox not here — found Sol station via API: ${baseId}`;
                      ctx.fleetConfig.factionStorageStation = baseId;
                      ctx.fleetConfig.homeBase = baseId;
                      ctx.fleetConfig.homeSystem = sysId;
                    }
                  }
                }
              } catch {
                // API search failed — will retry next cycle
              }
            }
          }
          break;
        }
      }
      // Fallback: sell remaining cargo if deposit failed
      if (depositFailed && ctx.ship.cargo.length > 0) {
        yield "deposit failed, selling remaining cargo instead";
        let sellResult = await disposeCargo(ctx);
        for (const s of sellResult.items) {
          yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
        }

        // If sell earned nothing AND cargo still has non-protected items, try home/faction station
        const remainingCargo = ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId));
        if (sellResult.totalEarned === 0 && remainingCargo.length > 0) {
          // Prefer faction storage station (may have just been discovered), then home base
          const targetBase = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
          if (targetBase && ctx.player.dockedAtBase !== targetBase) {
            yield `no demand here, traveling to ${ctx.fleetConfig.factionStorageStation ? "faction storage" : "home base"}`;
            try {
              await navigateAndDock(ctx, targetBase);
              // Try faction deposit first if in faction mode
              if (mode === "faction_deposit") {
                for (const item of ctx.ship.cargo) {
                  if (isProtectedItem(item.itemId)) continue;
                  try {
                    await ctx.api.factionDepositItems(item.itemId, item.quantity);
                    await ctx.refreshState();
                    yield `deposited ${item.quantity} ${item.itemId} to faction storage`;
                  } catch {
                    // If deposit still fails, fall through to sell
                    break;
                  }
                }
              }
              // Sell anything remaining
              if (ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId)).length > 0) {
                sellResult = await disposeCargo(ctx);
                for (const s of sellResult.items) {
                  yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
                }
                yield `fallback earned: ${sellResult.totalEarned} credits`;
              }
            } catch (err) {
              yield `fallback navigation failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            yield "fallback earned: 0 credits (no demand, no home base configured)";
          }
        } else {
          yield `fallback earned: ${sellResult.totalEarned} credits`;
        }
      }
    } else {
      yield "selling cargo";
      const sellResult = await disposeCargo(ctx);
      for (const s of sellResult.items) {
        yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
      }
      yield `total earned: ${sellResult.totalEarned} credits`;
    }

    // ── Ensure minimum credits ──
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;

    // ── Service ship ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    yield "cycle_complete";
  }
}
