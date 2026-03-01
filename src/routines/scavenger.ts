/**
 * Scavenger routine - roams system to system collecting jettisoned goods from wrecks.
 *
 * Unlike salvager (tows whole ship wrecks) or hunter (fights then loots),
 * the scavenger is a peaceful collector: fly to a POI, check for wrecks/containers,
 * loot items, move on. Sells or deposits cargo when full.
 *
 * Loop: pick system → visit POIs → loot wrecks → sell when full → repeat
 *
 * Params:
 *   sellMode?: string    - "sell" | "deposit" | "faction_deposit" (default: "sell")
 *   avoidEmpires?: string[] - Empire IDs to avoid roaming into
 */

import type { BotContext } from "../bot/types";
import type { StarSystem, PoiSummary } from "../types/game";
import {
  navigateTo,
  travelToPoi,
  findAndDock,
  dockAtCurrent,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
  interruptibleSleep,
  disposeCargo,
} from "./helpers";

/** Loot all items from wrecks at the current POI. Returns number of items looted. */
async function* lootWrecksAtPoi(
  ctx: BotContext,
  attemptedWrecks: Set<string>,
): AsyncGenerator<string, number, void> {
  let totalLooted = 0;

  let wrecks: Array<Record<string, unknown>>;
  try {
    wrecks = await ctx.api.getWrecks();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no_wrecks") && !msg.includes("not_found")) {
      yield `wreck scan failed: ${msg}`;
    }
    return 0;
  }

  if (wrecks.length === 0) return 0;

  yield `found ${wrecks.length} wreck(s) — looting`;

  for (const wreck of wrecks) {
    if (ctx.shouldStop) break;

    const wreckId = wreck.id as string;
    if (!wreckId) continue;
    if (attemptedWrecks.has(wreckId)) continue;
    attemptedWrecks.add(wreckId);

    const items = (wreck.items as Array<{ item_id: string; quantity: number }>) ?? [];
    if (items.length === 0) continue;

    // Check cargo space before attempting
    if (!ctx.cargo.hasSpace(ctx.ship, 1)) {
      yield "cargo full — need to sell";
      return totalLooted;
    }

    for (const item of items) {
      if (ctx.shouldStop) break;
      if (!ctx.cargo.hasSpace(ctx.ship, 1)) break;

      try {
        await ctx.api.lootWreck(wreckId, item.item_id, item.quantity);
        await ctx.refreshState();
        totalLooted += item.quantity;
        yield `looted ${item.quantity}x ${item.item_id}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Skip expected errors (already looted, empty, gone)
        if (!msg.includes("no_items") && !msg.includes("empty") && !msg.includes("not_found")) {
          yield `loot failed: ${msg}`;
        }
        break; // Move to next wreck
      }
    }
  }

  return totalLooted;
}

/** Pick the next system to roam to. Prefers unvisited/low-police systems with more POIs. */
function pickNextSystem(
  ctx: BotContext,
  recentlyVisited: Set<string>,
  avoidEmpires: string[],
): StarSystem | null {
  const currentSystemId = ctx.player.currentSystem;
  if (!currentSystemId) return null;

  const neighbors = ctx.galaxy.getNeighbors(currentSystemId);
  if (neighbors.length === 0) return null;

  // Score each neighbor
  const scored = neighbors
    .filter((sys) => {
      // Skip avoided empires
      if (avoidEmpires.length > 0 && sys.empire && avoidEmpires.includes(sys.empire)) {
        return false;
      }
      return true;
    })
    .map((sys) => {
      let score = 10;
      // Prefer systems not recently visited
      if (!recentlyVisited.has(sys.id)) score += 30;
      // Prefer more POIs (more places to scavenge)
      score += Math.min(sys.pois.length, 8) * 5;
      // Prefer unvisited systems (might have uncollected wrecks)
      if (!sys.visited) score += 20;
      // Low police = more combat = more wrecks
      if (sys.policeLevel <= 1) score += 15;
      else if (sys.policeLevel <= 3) score += 5;
      return { sys, score };
    });

  if (scored.length === 0) return null;

  // Pick best, with small random tiebreak
  scored.sort((a, b) => b.score - a.score);
  // Top 3 candidates, pick one randomly for variety
  const topN = scored.slice(0, Math.min(3, scored.length));
  return topN[Math.floor(Math.random() * topN.length)].sys;
}

/** Get all POIs in current system worth visiting for scavenging. */
function getScavengePois(ctx: BotContext): PoiSummary[] {
  const systemId = ctx.player.currentSystem;
  if (!systemId) return [];

  const system = ctx.galaxy.getSystem(systemId);
  if (!system) return [];

  // Wrecks appear at any POI type, but asteroid belts and planets are hotspots
  // Visit all POIs in the system — prioritize belts and planets (more traffic = more wrecks)
  return [...system.pois].sort((a, b) => {
    const priority = (poi: PoiSummary) => {
      switch (poi.type) {
        case "asteroid_belt":
        case "asteroid": return 3; // Miners die here
        case "planet":
        case "moon": return 2;     // Common travel spots
        default: return 1;
      }
    };
    return priority(b) - priority(a);
  });
}

export async function* scavenger(ctx: BotContext): AsyncGenerator<string, void, void> {
  const sellMode = getParam(ctx, "sellMode", "sell");
  const avoidEmpires = getParam<string[]>(ctx, "avoidEmpires", []);

  const attemptedWrecks = new Set<string>();
  let lastWreckClear = Date.now();
  const WRECK_RESET_INTERVAL = 600_000; // 10 minutes

  const recentlyVisited = new Set<string>();
  let totalItemsCollected = 0;

  // ── Main loop ──
  while (!ctx.shouldStop) {
    // Safety check
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // Periodic wreck memory clear
    if (Date.now() - lastWreckClear > WRECK_RESET_INTERVAL) {
      attemptedWrecks.clear();
      lastWreckClear = Date.now();
    }

    // ── Cargo management: sell/deposit when >80% full ──
    const cargoPct = ctx.ship.cargoCapacity > 0
      ? (ctx.ship.cargoUsed / ctx.ship.cargoCapacity) * 100
      : 0;
    if (cargoPct > 80) {
      yield "cargo getting full — docking to sell";
      try {
        await findAndDock(ctx);
        await disposeCargo(ctx);
        await refuelIfNeeded(ctx);
        await repairIfNeeded(ctx);
        await ctx.refreshState();
        yield "cargo cleared, continuing scavenge";
      } catch (err) {
        yield `sell trip failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Undock if docked
    if (ctx.player.dockedAtBase) {
      await refuelIfNeeded(ctx);
      try {
        await ctx.api.undock();
        await ctx.refreshState();
      } catch {
        // Already undocked
      }
    }

    if (ctx.shouldStop) break;

    // ── Scan all POIs in current system ──
    const pois = getScavengePois(ctx);
    let foundAnything = false;

    for (const poi of pois) {
      if (ctx.shouldStop) break;

      // Don't travel if cargo is nearly full
      if (ctx.ship.cargoCapacity > 0 && ctx.ship.cargoUsed / ctx.ship.cargoCapacity > 0.9) {
        break;
      }

      // Travel to POI
      if (ctx.player.currentPoi !== poi.id) {
        try {
          yield `traveling to ${poi.name}`;
          await travelToPoi(ctx, poi.id);
          await ctx.refreshState();
        } catch (err) {
          yield `travel failed: ${err instanceof Error ? err.message : String(err)}`;
          continue;
        }
      }

      if (ctx.shouldStop) break;

      // Loot wrecks at this POI
      const gen = lootWrecksAtPoi(ctx, attemptedWrecks);
      let looted = 0;
      while (true) {
        const result = await gen.next();
        if (result.done) {
          looted = result.value;
          break;
        }
        yield result.value; // Forward status messages
      }

      if (looted > 0) {
        totalItemsCollected += looted;
        foundAnything = true;
        yield `collected ${totalItemsCollected} items total this session`;
      }
    }

    // Track visited system
    if (ctx.player.currentSystem) {
      recentlyVisited.add(ctx.player.currentSystem);
      if (recentlyVisited.size > 15) recentlyVisited.clear();
    }

    // ── Fuel check before roaming ──
    const fuelPct = ctx.fuel.getLevel(ctx.ship) === "critical" ? 0
      : ctx.fuel.getLevel(ctx.ship) === "low" ? 25
      : 50;
    if (fuelPct < 30) {
      yield "fuel low — docking to refuel";
      try {
        await findAndDock(ctx);
        await refuelIfNeeded(ctx);
        await ctx.refreshState();
      } catch (err) {
        yield `refuel failed: ${err instanceof Error ? err.message : String(err)}`;
        return; // Can't continue without fuel
      }
      // Undock to continue roaming
      if (ctx.player.dockedAtBase) {
        try {
          await ctx.api.undock();
          await ctx.refreshState();
        } catch { /* ok */ }
      }
    }

    if (ctx.shouldStop) break;

    // ── Jump to next system ──
    const nextSystem = pickNextSystem(ctx, recentlyVisited, avoidEmpires);
    if (nextSystem) {
      yield `roaming to ${nextSystem.name}`;
      try {
        await navigateTo(ctx, nextSystem.id);
        await ctx.refreshState();
      } catch (err) {
        yield `jump failed: ${err instanceof Error ? err.message : String(err)}`;
        // Wait and retry
        const interrupted = await interruptibleSleep(ctx, 30_000);
        if (interrupted) break;
      }
    } else {
      // No neighbors available — wait and retry
      yield "no systems to roam to — waiting";
      const interrupted = await interruptibleSleep(ctx, 30_000);
      if (interrupted) break;
    }

    yield "cycle_complete";
  }
}
