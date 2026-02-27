/**
 * Scout routine - one-shot system exploration and data gathering.
 *
 * Navigates to a target system, docks at station, scans market,
 * gathers faction info and storage data, then completes.
 * Designed to be scored highest when the fleet needs data about
 * a system it hasn't visited (e.g. Sol for faction storage).
 *
 * One-shot: yields cycle_complete after gathering, so the bot
 * gets reassigned by the Commander on the next eval.
 *
 * Params:
 *   targetSystem: string   - System ID to scout (default: homeSystem)
 *   scanMarket: boolean    - Scan market on dock (default: true)
 *   checkFaction: boolean  - Check faction storage/info (default: true)
 */

import type { BotContext } from "../bot/types";
import {
  navigateTo,
  ensureSystemDetail,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  cacheMarketData,
  getParam,
} from "./helpers";

export async function* scout(ctx: BotContext): AsyncGenerator<string, void, void> {
  const targetSystem = getParam(ctx, "targetSystem", ctx.fleetConfig.homeSystem);
  const scanMarket = getParam(ctx, "scanMarket", true);
  const checkFaction = getParam(ctx, "checkFaction", true);

  if (!targetSystem) {
    yield "no target system configured";
    yield "cycle_complete";
    return;
  }

  // Already in the target system?
  if (ctx.player.currentSystem === targetSystem) {
    yield `already in ${targetSystem}`;
  } else {
    // Navigate to target system
    yield `scouting ${targetSystem}`;
    try {
      await navigateTo(ctx, targetSystem);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      yield "cycle_complete";
      return;
    }
  }

  if (ctx.shouldStop) return;

  // Ensure we have full system detail (POIs, bases, resources)
  await ensureSystemDetail(ctx);
  yield `system data cached for ${targetSystem}`;

  // Find a station and dock
  yield "finding station to dock";
  try {
    await findAndDock(ctx);
  } catch (err) {
    yield `dock failed: ${err instanceof Error ? err.message : String(err)}`;
    yield "cycle_complete";
    return;
  }

  if (!ctx.player.dockedAtBase) {
    yield "no station found in system";
    yield "cycle_complete";
    return;
  }

  yield `docked at ${ctx.player.dockedAtBase}`;

  if (ctx.shouldStop) return;

  // Scan market
  if (scanMarket) {
    try {
      const market = await ctx.api.viewMarket();
      if (market.length > 0) {
        cacheMarketData(ctx, ctx.player.dockedAtBase, market);
        yield `market scanned: ${market.length} orders`;
      } else {
        yield "no market data at this station";
      }
    } catch (err) {
      yield `market scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (ctx.shouldStop) return;

  // Check faction info and storage
  if (checkFaction && ctx.player.factionId) {
    // Faction info (free query, works anywhere)
    try {
      const info = await ctx.api.factionInfo();
      const factionName = String(info.name ?? "Unknown");
      yield `faction: ${factionName}`;
    } catch (err) {
      yield `faction info failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Faction storage (requires docking — we're docked)
    try {
      const storage = await ctx.api.viewFactionStorageFull();
      yield `faction storage: ${storage.items.length} items, ${storage.credits} credits`;

      // If we found faction storage at this station, update fleet config
      if (storage.items.length > 0 || storage.credits > 0) {
        const dockedBase = ctx.player.dockedAtBase;
        if (dockedBase && !ctx.fleetConfig.factionStorageStation) {
          ctx.fleetConfig.factionStorageStation = dockedBase;
          ctx.fleetConfig.homeBase = dockedBase;
          ctx.fleetConfig.homeSystem = targetSystem;
          yield `faction storage confirmed at ${dockedBase}`;
        }
      }
    } catch (err) {
      yield `faction storage check failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Service ship
  await refuelIfNeeded(ctx);
  await repairIfNeeded(ctx);

  yield "scout complete";
  yield "cycle_complete";
}
