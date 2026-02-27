/**
 * Salvager routine - tows wrecks to station, scraps or sells them.
 *
 * Loop: find wrecks → tow to station → scrap/sell → deposit materials → repeat
 *
 * Params:
 *   salvageYard?: string      - Base ID for scrapping (default: nearest station)
 *   scrapMethod?: string      - "scrap" | "sell" (default: "scrap")
 *   targetWrecks?: string[]   - Specific wreck IDs to target
 */

import type { BotContext } from "../bot/types";
import {
  navigateAndDock,
  dockAtCurrent,
  refuelIfNeeded,
  repairIfNeeded,
  depositItem,
  handleEmergency,
  safetyCheck,
  getParam,
} from "./helpers";

export async function* salvager(ctx: BotContext): AsyncGenerator<string, void, void> {
  const salvageYard = getParam(ctx, "salvageYard", "");
  const scrapMethod = getParam(ctx, "scrapMethod", "scrap");
  const targetWrecks = getParam<string[]>(ctx, "targetWrecks", []);

  while (!ctx.shouldStop) {
    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // Undock if docked
    if (ctx.player.dockedAtBase) {
      await ctx.api.undock();
      await ctx.refreshState();
    }

    if (ctx.shouldStop) return;

    // ── Find wrecks ──
    yield "scanning for wrecks";
    let wrecks: Array<Record<string, unknown>>;
    try {
      wrecks = await ctx.api.getWrecks();
    } catch {
      yield "wreck scan failed";
      yield "cycle_complete";
      continue;
    }

    // Filter to target wrecks if specified
    if (targetWrecks.length > 0) {
      wrecks = wrecks.filter((w) => targetWrecks.includes(w.id as string));
    }

    if (wrecks.length === 0) {
      yield "no wrecks found";
      yield "cycle_complete";
      continue;
    }

    yield `found ${wrecks.length} wrecks`;

    // ── Process each wreck ──
    for (const wreck of wrecks) {
      if (ctx.shouldStop) break;

      const wreckId = wreck.id as string;
      if (!wreckId) continue;

      // Tow the wreck
      yield `towing wreck ${wreckId}`;
      try {
        await ctx.api.towWreck(wreckId);
        await ctx.refreshState();
      } catch (err) {
        yield `tow failed: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }

      // Fuel check while towing (towing burns more fuel)
      if (ctx.fuel.getLevel(ctx.ship) === "critical") {
        yield "fuel critical while towing, releasing";
        try {
          await ctx.api.releaseTow();
        } catch { /* ok */ }
        break;
      }

      // Navigate to salvage yard
      yield "towing to salvage yard";
      try {
        if (salvageYard) {
          await navigateAndDock(ctx, salvageYard);
        } else {
          await dockAtCurrent(ctx);
        }
      } catch (err) {
        yield `dock failed: ${err instanceof Error ? err.message : String(err)}`;
        try { await ctx.api.releaseTow(); } catch { /* ok */ }
        continue;
      }

      if (ctx.shouldStop) break;

      // Scrap or sell
      if (scrapMethod === "scrap") {
        yield "scrapping wreck";
        try {
          await ctx.api.scrapWreck();
          await ctx.refreshState();
          yield "wreck scrapped, materials obtained";

          // Deposit materials to storage
          for (const item of ctx.ship.cargo) {
            await depositItem(ctx, item.itemId);
          }
        } catch (err) {
          // Fall back to selling
          yield `scrap failed, selling instead: ${err instanceof Error ? err.message : String(err)}`;
          try {
            await ctx.api.sellWreck();
            await ctx.refreshState();
            yield "wreck sold";
          } catch {
            yield "sell also failed";
          }
        }
      } else {
        yield "selling wreck";
        try {
          await ctx.api.sellWreck();
          await ctx.refreshState();
          yield "wreck sold";
        } catch (err) {
          yield `sell failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Service between wrecks
      await refuelIfNeeded(ctx);
      await repairIfNeeded(ctx);
    }

    yield "cycle_complete";
  }
}
