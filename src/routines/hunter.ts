/**
 * Hunter routine - roaming combat patrol.
 *
 * Roams system-to-system hunting drifters/pirates, preferring low-security
 * space. Only engages targets it can take (equal or weaker combat power).
 * Verifies weapons are equipped before engaging.
 *
 * Loop: check equipment → roam to next system → scan → engage → loot → repair → repeat
 *
 * Params:
 *   huntZone?: string         - POI ID to patrol (overrides roaming)
 *   fleeThreshold?: number    - Hull % to flee at (default: 25)
 *   engagementRules?: string  - "all" | "npcs_only" | "faction_enemies"
 *   autoRepair?: boolean      - Return to station for repair (default: true)
 *   roam?: boolean            - Roam between systems (default: true)
 */

import type { BotContext } from "../bot/types";
import type { NearbyPlayer, StarSystem } from "../types/game";
import {
  navigateTo,
  navigateToPoi,
  navigateAndDock,
  findAndDock,
  dockAtCurrent,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
  interruptibleSleep,
} from "./helpers";

// Weapon module patterns — hunter must have at least one
const WEAPON_PATTERNS = [
  "weapon", "laser", "cannon", "turret", "missile", "gun", "blaster", "railgun",
];

/** Estimate combat power from ship stats (hull + shield + armor) */
function combatPower(hull: number, shield: number, armor: number): number {
  return hull + shield + armor * 2;
}

export async function* hunter(ctx: BotContext): AsyncGenerator<string, void, void> {
  const huntZone = getParam(ctx, "huntZone", "");
  const fleeThreshold = getParam(ctx, "fleeThreshold", 25);
  const engagementRules = getParam(ctx, "engagementRules", "all");
  const autoRepair = getParam(ctx, "autoRepair", true);
  const roam = getParam(ctx, "roam", true);

  // Track wrecks we've already attempted to loot
  const attemptedWrecks = new Set<string>();
  let lastWreckClear = Date.now();
  const WRECK_RESET_INTERVAL = 600_000; // 10 minutes

  // Track visited systems for roaming variety
  const recentlyVisited = new Set<string>();
  let idleCycles = 0;

  // ── Equipment check ──
  const hasWeapon = ctx.ship.modules.some((m) =>
    WEAPON_PATTERNS.some((p) => m.moduleId.includes(p)),
  );
  if (!hasWeapon) {
    yield "no weapons equipped — cannot hunt";
    yield "cycle_complete";
    return;
  }

  while (!ctx.shouldStop) {
    // Periodically reset wreck blacklist
    if (Date.now() - lastWreckClear > WRECK_RESET_INTERVAL) {
      attemptedWrecks.clear();
      lastWreckClear = Date.now();
    }

    // Reset visited systems periodically so we can revisit
    if (recentlyVisited.size > 10) {
      recentlyVisited.clear();
    }

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

    // ── Navigate: huntZone overrides roaming ──
    if (huntZone && ctx.player.currentPoi !== huntZone) {
      yield "traveling to hunt zone";
      try {
        await navigateToPoi(ctx, huntZone);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    } else if (ctx.player.dockedAtBase) {
      await ctx.api.undock();
      await ctx.refreshState();
    }

    if (ctx.shouldStop) return;

    // ── Sell loot if cargo is full (before scanning — can't loot with full cargo) ──
    const cargoPctPre = ctx.ship.cargoCapacity > 0
      ? (ctx.ship.cargoUsed / ctx.ship.cargoCapacity) * 100
      : 0;
    if (cargoPctPre > 70) {
      yield "cargo getting full — docking to sell loot";
      try {
        await findAndDock(ctx);
        for (const item of [...ctx.ship.cargo]) {
          if (ctx.shouldStop) break;
          if (item.itemId === "fuel_cell") continue;
          // Try sell first
          try {
            await ctx.api.sell(item.itemId, item.quantity);
            await ctx.refreshState();
            continue;
          } catch { /* sell failed */ }
          // Fallback: deposit to faction storage
          try {
            await ctx.api.factionDepositItems(item.itemId, item.quantity);
            await ctx.refreshState();
            yield `deposited ${item.quantity} ${item.itemId} to faction`;
          } catch { /* can't sell or deposit — leave it */ }
        }
        await refuelIfNeeded(ctx);
        if (ctx.player.dockedAtBase) {
          await ctx.api.undock();
          await ctx.refreshState();
        }
      } catch {
        yield "sell trip failed";
      }
    }

    // ── Check if current system is too safe for hunting ──
    const currentSystemData = ctx.galaxy.getSystem(ctx.player.currentSystem);
    const isHighSec = currentSystemData && currentSystemData.policeLevel >= 4;

    if (isHighSec && roam && !huntZone) {
      // Skip scanning — police will block all combat here. Roam immediately.
      const nextSystem = pickNextSystem(ctx, recentlyVisited);
      if (nextSystem) {
        yield `high security system — roaming to ${nextSystem.name}`;
        recentlyVisited.add(ctx.player.currentSystem);
        try {
          await navigateTo(ctx, nextSystem.id);
          await ctx.refreshState();
          idleCycles = 0;
          continue;
        } catch (err) {
          yield `roam failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // ── Scan for targets ──
    yield "scanning for targets";
    let nearby: NearbyPlayer[];
    try {
      nearby = await ctx.api.getNearby();
    } catch {
      yield "scan failed";
      continue;
    }

    // Filter by engagement rules + combat power check
    const ourPower = combatPower(ctx.ship.maxHull, ctx.ship.maxShield, ctx.ship.armor);
    const targets = filterTargets(ctx, nearby, engagementRules, ourPower);

    if (targets.length === 0) {
      // Check for wrecks while patrolling
      yield* lootNearbyWrecks(ctx, attemptedWrecks);

      idleCycles++;

      // ── Roam to next system after 1 idle cycle ──
      if (roam && !huntZone && idleCycles >= 1) {
        const nextSystem = pickNextSystem(ctx, recentlyVisited);
        if (nextSystem) {
          yield `no targets — roaming to ${nextSystem.name}`;
          recentlyVisited.add(ctx.player.currentSystem);
          try {
            await navigateTo(ctx, nextSystem.id);
            await ctx.refreshState();
            idleCycles = 0;
            continue;
          } catch (err) {
            yield `roam failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          yield "no reachable systems to roam to";
        }
      } else {
        yield "no targets found, patrolling";
      }

      await interruptibleSleep(ctx, 30_000);
      yield "cycle_complete";
      continue;
    }

    idleCycles = 0;

    // ── Engage best target (weakest first) ──
    const target = targets[0];

    // Use combat service's engagement check (hull %, security, faction)
    const check = ctx.combat.shouldEngage(ctx.ship, target, ctx.player.currentSystem);
    if (!check.engage) {
      yield `skipping ${target.username}: ${check.reason}`;
      await interruptibleSleep(ctx, 15_000);
      yield "cycle_complete";
      continue;
    }

    yield `engaging ${target.username} (${target.shipClass})`;

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

    // ── Loot wrecks after combat ──
    yield* lootNearbyWrecks(ctx);

    // ── Repair if needed ──
    const hullPct = (ctx.ship.hull / ctx.ship.maxHull) * 100;
    if (autoRepair && hullPct < 70) {
      yield "returning to station for repair";
      try {
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

// ════════════════════════════════════════════════════════════════════
// Target Filtering
// ════════════════════════════════════════════════════════════════════

/**
 * Filter nearby players to valid, beatable targets.
 * Only returns targets the hunter's ship can take (equal or weaker combat power).
 * Sorted weakest-first for easy pickings.
 */
function filterTargets(
  ctx: BotContext,
  nearby: NearbyPlayer[],
  rules: string,
  ourPower: number,
): NearbyPlayer[] {
  return nearby
    .filter((p) => {
      if (p.anonymous) return false;
      if (p.inCombat) return false;
      // Don't attack own faction members
      if (p.factionId && p.factionId === ctx.player.factionId) return false;

      // Engagement rules
      if (rules === "npcs_only") {
        // NPCs typically have no faction
        if (p.factionId) return false;
      } else if (rules === "faction_enemies") {
        if (!p.factionId || p.factionId === ctx.player.factionId) return false;
      }
      // "all" — no additional filter

      return true;
    })
    // Sort weakest first — prioritize easy wins
    .sort((a, b) => {
      // Prefer factionless targets (likely NPCs/drifters) over faction players
      const aIsNpc = !a.factionId ? 0 : 1;
      const bIsNpc = !b.factionId ? 0 : 1;
      return aIsNpc - bIsNpc;
    });
}

// ════════════════════════════════════════════════════════════════════
// System Roaming
// ════════════════════════════════════════════════════════════════════

/**
 * Pick the next system to roam to.
 * Prefers: low security (lawless/low police) → unvisited → connected neighbors.
 * Avoids recently visited systems for variety.
 */
function pickNextSystem(
  ctx: BotContext,
  recentlyVisited: Set<string>,
): StarSystem | null {
  const currentSystem = ctx.player.currentSystem;
  const neighbors = ctx.galaxy.getNeighbors(currentSystem);
  if (neighbors.length === 0) return null;

  // Check fuel — only roam if we have enough for a round trip
  const fuelPct = ctx.ship.maxFuel > 0 ? (ctx.ship.fuel / ctx.ship.maxFuel) * 100 : 0;
  if (fuelPct < 40) return null; // Too low to roam safely

  // Score each neighbor
  const scored = neighbors
    .filter((s) => !recentlyVisited.has(s.id))
    .map((s) => {
      let score = 0;
      // Low security = more targets (lawless is best for hunting)
      score += Math.max(0, 5 - s.policeLevel) * 20;
      // Prefer systems with POIs (more activity)
      score += Math.min(s.pois.length, 5) * 5;
      return { system: s, score };
    })
    .sort((a, b) => b.score - a.score);

  // If all neighbors are visited, allow revisiting (pick best-scored neighbor)
  if (scored.length === 0) {
    const allScored = neighbors
      .map((s) => ({
        system: s,
        score: Math.max(0, 5 - s.policeLevel) * 20 + Math.min(s.pois.length, 5) * 5,
      }))
      .sort((a, b) => b.score - a.score);
    return allScored[0]?.system ?? null;
  }

  return scored[0].system;
}

// ════════════════════════════════════════════════════════════════════
// Battle
// ════════════════════════════════════════════════════════════════════

/** Inner battle loop - fights until battle ends or flee threshold hit */
async function* battleLoop(
  ctx: BotContext,
  fleeThreshold: number,
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

// ════════════════════════════════════════════════════════════════════
// Wreck Looting
// ════════════════════════════════════════════════════════════════════

/** Loot any nearby wrecks (max 5 per scan to avoid spam) */
async function* lootNearbyWrecks(
  ctx: BotContext,
  attemptedWrecks?: Set<string>,
): AsyncGenerator<string, void, void> {
  try {
    const wrecks = await ctx.api.getWrecks();
    if (wrecks.length === 0) return;

    let looted = 0;
    const MAX_LOOT_ATTEMPTS = 5;

    for (const wreck of wrecks) {
      if (ctx.shouldStop) break;
      if (looted >= MAX_LOOT_ATTEMPTS) break;
      if (!ctx.cargo.hasSpace(ctx.ship, 1)) {
        yield "cargo full, can't loot more";
        break;
      }

      const wreckId = wreck.id as string;
      if (!wreckId) continue;

      // Skip wrecks we already tried recently
      if (attemptedWrecks?.has(wreckId)) continue;
      attemptedWrecks?.add(wreckId);

      // Only attempt wrecks that have items
      const items = (wreck.items as Array<{ item_id: string; quantity: number }>) ?? [];
      if (items.length === 0) continue;

      try {
        for (const item of items) {
          if (!ctx.cargo.hasSpace(ctx.ship, 1)) break;
          await ctx.api.lootWreck(wreckId, item.item_id, item.quantity);
          await ctx.refreshState();
          yield `looted ${item.quantity} ${item.item_id} from wreck`;
          looted++;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("no_items") && !msg.includes("empty") && !msg.includes("not_found")) {
          yield `loot failed: ${msg}`;
        }
      }
    }

    if (looted === 0 && wrecks.length > 0) {
      yield `${wrecks.length} wreck(s) nearby — none lootable`;
    }
  } catch (err) {
    if (err instanceof Error && !err.message.includes("no_wrecks")) {
      console.warn(`[wreck scan] ${err.message}`);
    }
  }
}
