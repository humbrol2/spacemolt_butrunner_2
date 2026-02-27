/**
 * Hunter routine - engages hostiles, loots wrecks, earns combat XP.
 *
 * Loop: scan for targets → engage → loot wrecks → repair → repeat
 *
 * Params:
 *   huntZone?: string         - POI ID to patrol (stays in current if empty)
 *   fleeThreshold?: number    - Hull % to flee at (default: 25)
 *   engagementRules?: string  - "npcs_only" | "all" | "faction_enemies"
 *   autoRepair?: boolean      - Return to station for repair (default: true)
 */

import type { BotContext } from "../bot/types";
import type { NearbyPlayer } from "../types/game";
import {
  navigateToPoi,
  navigateAndDock,
  dockAtCurrent,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
} from "./helpers";

export async function* hunter(ctx: BotContext): AsyncGenerator<string, void, void> {
  const huntZone = getParam(ctx, "huntZone", "");
  const fleeThreshold = getParam(ctx, "fleeThreshold", 25);
  const engagementRules = getParam(ctx, "engagementRules", "npcs_only");
  const autoRepair = getParam(ctx, "autoRepair", true);

  while (!ctx.shouldStop) {
    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) {
        yield "emergency unresolved, retreating";
        return;
      }
    }

    // ── Navigate to hunt zone ──
    if (huntZone && ctx.player.currentPoi !== huntZone) {
      yield "traveling to hunt zone";
      try {
        await navigateToPoi(ctx, huntZone);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    } else if (ctx.player.dockedAtBase) {
      // Undock to begin patrol
      await ctx.api.undock();
      await ctx.refreshState();
    }

    if (ctx.shouldStop) return;

    // ── Scan for targets ──
    yield "scanning for targets";
    let nearby: NearbyPlayer[];
    try {
      nearby = await ctx.api.getNearby();
    } catch {
      yield "scan failed";
      continue;
    }

    // Filter targets by engagement rules
    const targets = nearby.filter((p) => {
      if (p.anonymous) return false;
      if (engagementRules === "npcs_only") return false; // NPCs aren't in nearby, skip
      if (engagementRules === "faction_enemies") {
        return p.factionId && p.factionId !== ctx.player.factionId;
      }
      return true; // "all"
    });

    if (targets.length === 0) {
      yield "no targets found, patrolling";

      // Check for wrecks to loot while patrolling
      yield* lootNearbyWrecks(ctx);

      yield "cycle_complete";
      continue;
    }

    // ── Engage target ──
    const target = targets[0]; // Pick first target
    yield `engaging ${target.username}`;

    try {
      await ctx.api.attack(target.playerId);
      await ctx.refreshState();
    } catch (err) {
      yield `attack failed: ${err instanceof Error ? err.message : String(err)}`;
      yield "cycle_complete";
      continue;
    }

    // ── Battle loop ──
    yield* battleLoop(ctx, fleeThreshold);

    if (ctx.shouldStop) return;

    // ── Loot wrecks ──
    yield* lootNearbyWrecks(ctx);

    // ── Repair if needed ──
    const hullPct = (ctx.ship.hull / ctx.ship.maxHull) * 100;
    if (autoRepair && hullPct < 70) {
      yield "returning to station for repair";
      try {
        // Find nearest station
        const dockTarget = ctx.station.chooseDockTarget(ctx.player, ctx.ship);
        if (dockTarget) {
          const system = ctx.galaxy.getSystem(dockTarget.systemId);
          const poi = system?.pois.find((p) => p.id === dockTarget.poiId);
          if (poi?.baseId) {
            await navigateAndDock(ctx, poi.baseId);
          } else {
            await dockAtCurrent(ctx);
          }
        } else {
          await dockAtCurrent(ctx);
        }
        await repairIfNeeded(ctx, 90);
        await refuelIfNeeded(ctx);
      } catch {
        yield "repair trip failed";
      }
    }

    yield "cycle_complete";
  }
}

/** Inner battle loop - fights until battle ends or flee threshold hit */
async function* battleLoop(
  ctx: BotContext,
  fleeThreshold: number
): AsyncGenerator<string, void, void> {
  let battleActive = true;

  while (battleActive && !ctx.shouldStop) {
    try {
      const battle = await ctx.api.getBattleStatus();
      if (!battle) {
        yield "battle ended";
        battleActive = false;
        break;
      }

      await ctx.refreshState();
      const hullPct = (ctx.ship.hull / ctx.ship.maxHull) * 100;

      // Flee check
      if (hullPct <= fleeThreshold) {
        yield `hull at ${Math.round(hullPct)}%, fleeing!`;
        try {
          await ctx.api.battle("flee");
        } catch (err) {
          console.warn(`[${ctx.botId}] flee failed: ${err instanceof Error ? err.message : err}`);
        }
        battleActive = false;
        break;
      }

      // Choose stance based on combat analysis
      const stance = ctx.combat.chooseStance(ctx.ship, battle);
      yield `fighting (hull: ${Math.round(hullPct)}%, stance: ${stance})`;

      try {
        await ctx.api.battle("continue", { stance });
      } catch (err) {
        // Battle may have ended
        console.warn(`[${ctx.botId}] battle continue failed (may have ended): ${err instanceof Error ? err.message : err}`);
        battleActive = false;
      }
    } catch (err) {
      console.warn(`[${ctx.botId}] battle status check failed: ${err instanceof Error ? err.message : err}`);
      battleActive = false;
    }
  }

  await ctx.refreshState();
}

/** Loot any nearby wrecks */
async function* lootNearbyWrecks(ctx: BotContext): AsyncGenerator<string, void, void> {
  try {
    const wrecks = await ctx.api.getWrecks();
    for (const wreck of wrecks) {
      if (ctx.shouldStop) break;
      if (!ctx.cargo.hasSpace(ctx.ship, 1)) {
        yield "cargo full, can't loot more";
        break;
      }

      const wreckId = wreck.id as string;
      if (!wreckId) continue;

      yield `looting wreck ${wreckId}`;
      try {
        // Try to loot all items from the wreck
        const items = (wreck.items as Array<{ item_id: string; quantity: number }>) ?? [];
        for (const item of items) {
          if (!ctx.cargo.hasSpace(ctx.ship, 1)) break;
          await ctx.api.lootWreck(wreckId, item.item_id, item.quantity);
          await ctx.refreshState();
          yield `looted ${item.quantity} ${item.item_id}`;
        }
      } catch (err) {
        yield `loot failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } catch (err) {
    // No wrecks accessible in this area
    if (err instanceof Error && !err.message.includes("no_wrecks")) {
      console.warn(`[wreck scan] ${err.message}`);
    }
  }
}
