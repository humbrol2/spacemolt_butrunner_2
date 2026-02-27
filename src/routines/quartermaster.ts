/**
 * Quartermaster routine - Faction home base commander & merchant.
 *
 * Stays docked at faction home station and manages faction commerce:
 * 1. Sells crafted goods from faction storage at competitive prices
 *    (priced below competing stations to attract buyers to our system)
 * 2. Buys equipment modules (ice/gas harvesters, survey scanners)
 *    slowly, stockpiling them in faction storage for fleet bots to equip
 *
 * This bot acts as the faction leader — it never leaves home.
 *
 * Params:
 *   homeBase: string     - Base ID of faction home (auto from fleetConfig)
 *   moduleTarget: number - Target count per module type (default: 4)
 *   undercutPct: number  - Price undercut percentage vs competitors (default: 0.05)
 */

import type { BotContext } from "../bot/types";
import type { MarketOrder } from "../types/game";
import {
  navigateAndDock,
  refuelIfNeeded,
  getParam,
  cacheMarketData,
  interruptibleSleep,
} from "./helpers";

// Equipment modules to accumulate for fleet use
const MODULE_TARGETS = [
  { pattern: "ice_harvester", target: 4, label: "Ice Harvester" },
  { pattern: "gas_harvester", target: 4, label: "Gas Harvester" },
  { pattern: "survey", target: 3, label: "Survey Scanner" },
];

// Items that look like ship modules (don't sell these from faction storage)
const MODULE_PATTERNS = [
  "harvester", "scanner", "laser", "cannon", "turret",
  "shield", "armor", "engine", "thruster", "cloak",
  "tow", "salvage", "drill", "weapon", "mod_", "module",
];

export async function* quartermaster(ctx: BotContext): AsyncGenerator<string, void, void> {
  const homeBase = getParam(ctx, "homeBase",
    ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase);
  const moduleTarget = getParam(ctx, "moduleTarget", 4);
  const undercutPct = getParam(ctx, "undercutPct", 0.05);

  if (!homeBase) {
    yield "no faction home base configured";
    yield "cycle_complete";
    return;
  }

  // Navigate to faction home and dock (one-time)
  if (ctx.player.dockedAtBase !== homeBase) {
    yield `traveling to faction home`;
    try {
      await navigateAndDock(ctx, homeBase);
    } catch (err) {
      yield `failed to reach faction home: ${err instanceof Error ? err.message : String(err)}`;
      yield "cycle_complete";
      return;
    }
  }

  yield "stationed at faction home — managing commerce";

  // Track items we've already listed to avoid double-listing within a session
  const listedItems = new Set<string>();

  while (!ctx.shouldStop) {
    // Ensure still docked at home
    if (ctx.player.dockedAtBase !== homeBase) {
      try {
        await navigateAndDock(ctx, homeBase);
      } catch {
        yield "lost home dock — retrying next cycle";
        yield "cycle_complete";
        continue;
      }
    }

    // Scan local market
    let market: MarketOrder[] = [];
    try {
      market = await ctx.api.viewMarket();
      if (market.length > 0) {
        cacheMarketData(ctx, homeBase, market);
      }
    } catch (err) {
      yield `market scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (ctx.shouldStop) return;

    // ── 1. Sell faction goods at competitive prices ──
    yield* manageFactionSales(ctx, homeBase, market, undercutPct, listedItems);

    if (ctx.shouldStop) return;

    // ── 2. Buy equipment modules for fleet ──
    yield* buyEquipmentModules(ctx, homeBase, market, moduleTarget);

    if (ctx.shouldStop) return;

    // ── 3. Check and collect filled buy orders ──
    // Modules bought via buy orders arrive in cargo — deposit them to faction storage
    yield* collectFilledOrders(ctx);

    if (ctx.shouldStop) return;

    await refuelIfNeeded(ctx);

    // Slow cycle — quartermaster doesn't need to rush
    await interruptibleSleep(ctx, 60_000);
    yield "cycle_complete";
  }
}

// ════════════════════════════════════════════════════════════════════
// Faction Sales Management
// ════════════════════════════════════════════════════════════════════

/**
 * Withdraw crafted goods from faction storage and create sell orders
 * priced to attract buyers to our station.
 *
 * Strategy: price BELOW the cheapest buy price at other stations.
 * Traders see cheap goods at our station and come to buy them,
 * then resell elsewhere for profit. This stimulates faction home traffic.
 */
async function* manageFactionSales(
  ctx: BotContext,
  homeBase: string,
  localMarket: MarketOrder[],
  undercutPct: number,
  listedItems: Set<string>,
): AsyncGenerator<string, void, void> {
  // Get faction storage
  let storageItems: Array<{ itemId: string; quantity: number }> = [];
  try {
    const storage = await ctx.api.viewFactionStorage();
    storageItems = (storage ?? []).filter((s) => s.quantity > 0);
  } catch (err) {
    yield `faction storage check failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  if (storageItems.length === 0) {
    yield "faction storage empty";
    return;
  }

  // Filter for sellable goods (not raw ores; modules only if excess above fleet targets)
  const sellable: Array<{ itemId: string; quantity: number }> = [];
  for (const s of storageItems) {
    if (s.itemId.startsWith("ore_")) continue;

    if (isModuleItem(s.itemId)) {
      // Check if this module is a target type — only sell excess above target
      const target = MODULE_TARGETS.find((t) => s.itemId.includes(t.pattern));
      if (target) {
        const excess = s.quantity - target.target;
        if (excess > 0) {
          sellable.push({ itemId: s.itemId, quantity: excess });
        }
      } else {
        // Non-targeted module (weapons, shields, etc.) — sell freely
        sellable.push(s);
      }
      continue;
    }

    sellable.push(s);
  }

  if (sellable.length === 0) {
    const oreCount = storageItems.filter((s) => s.itemId.startsWith("ore_")).length;
    const modCount = storageItems.filter((s) => isModuleItem(s.itemId)).length;
    yield `faction storage: ${oreCount} ore type(s), ${modCount} module type(s) — nothing to sell`;
    return;
  }

  // Get competing prices at other stations
  const cachedStationIds = ctx.cache.getAllMarketFreshness()
    .map((f) => f.stationId)
    .filter((id) => id !== homeBase);

  // Check what we already have listed at our station
  const ourSellOrders = localMarket.filter(
    (o) => o.type === "sell" && o.playerId === ctx.player.id,
  );
  const alreadyListed = new Set(ourSellOrders.map((o) => o.itemId));

  let ordersCreated = 0;

  for (const item of sellable) {
    if (ctx.shouldStop) return;

    // Skip if we already have a sell order for this item
    if (alreadyListed.has(item.itemId) || listedItems.has(item.itemId)) continue;

    const itemName = ctx.crafting.getItemName(item.itemId) || item.itemId;
    const costBasis = estimateCostBasis(ctx, item.itemId);

    if (costBasis <= 0) continue; // Unknown item — can't price it

    // Find cheapest buy price at OTHER stations
    // (buyPrice = cheapest sell order there = what it costs a buyer to purchase elsewhere)
    let cheapestElsewhere = Infinity;
    for (const stationId of cachedStationIds) {
      const prices = ctx.cache.getMarketPrices(stationId);
      if (!prices) continue;
      const p = prices.find((pd) => pd.itemId === item.itemId);
      if (p?.buyPrice && p.buyPrice > 0 && p.buyPrice < cheapestElsewhere) {
        cheapestElsewhere = p.buyPrice;
      }
    }

    // Also check demand prices (what buyers will pay when selling to buy orders)
    let bestDemandPrice = 0;
    for (const stationId of cachedStationIds) {
      const prices = ctx.cache.getMarketPrices(stationId);
      if (!prices) continue;
      const p = prices.find((pd) => pd.itemId === item.itemId);
      if (p?.sellPrice && p.sellPrice > bestDemandPrice) {
        bestDemandPrice = p.sellPrice;
      }
    }

    // No market data — skip
    if (cheapestElsewhere === Infinity && bestDemandPrice === 0) continue;

    // Calculate list price: undercut competitors to attract buyers
    let listPrice: number;
    if (cheapestElsewhere < Infinity) {
      listPrice = Math.floor(cheapestElsewhere * (1 - undercutPct));
    } else {
      // No sell data elsewhere — price slightly below demand
      listPrice = Math.floor(bestDemandPrice * (1 - undercutPct / 2));
    }

    // Floor: at least 10% above cost basis
    const minPrice = Math.ceil(costBasis * 1.10);
    if (listPrice < minPrice) {
      if (bestDemandPrice > minPrice) {
        listPrice = minPrice;
      } else {
        continue; // Not profitable
      }
    }

    if (listPrice <= 0) continue;

    // Withdraw from faction storage and create sell order
    const listQty = Math.min(item.quantity, 50); // Don't flood — max 50 per listing
    try {
      await ctx.api.factionWithdrawItems(item.itemId, listQty);
      await ctx.refreshState();

      const inCargo = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
      if (inCargo <= 0) {
        yield `withdraw failed: ${itemName} not in cargo after withdrawal`;
        continue;
      }

      const sellQty = Math.min(inCargo, listQty);
      await ctx.api.createSellOrder(item.itemId, sellQty, listPrice);
      await ctx.refreshState();

      const margin = listPrice - costBasis;
      const vsCompetitor = cheapestElsewhere < Infinity
        ? ` (${Math.round(undercutPct * 100)}% below ${cheapestElsewhere}cr elsewhere)`
        : "";
      yield `listed ${sellQty} ${itemName} @ ${listPrice}cr/ea (+${margin}cr margin)${vsCompetitor}`;

      listedItems.add(item.itemId);
      ordersCreated++;

      // Only list 2-3 items per cycle to stay within rate limits
      if (ordersCreated >= 3) break;
    } catch (err) {
      yield `sell order failed for ${itemName}: ${err instanceof Error ? err.message : String(err)}`;
      // Re-deposit anything stuck in cargo
      const leftover = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
      if (leftover > 0) {
        try {
          await ctx.api.factionDepositItems(item.itemId, leftover);
          await ctx.refreshState();
        } catch { /* best effort */ }
      }
    }
  }

  if (ordersCreated === 0 && sellable.length > 0) {
    yield `${sellable.length} sellable item(s) in faction — no profitable listings found`;
  }
}

// ════════════════════════════════════════════════════════════════════
// Equipment Module Purchasing
// ════════════════════════════════════════════════════════════════════

/**
 * Slowly buy equipment modules and stockpile in faction storage.
 * Buys at most ONE module per cycle to conserve credits.
 */
async function* buyEquipmentModules(
  ctx: BotContext,
  homeBase: string,
  localMarket: MarketOrder[],
  targetCount: number,
): AsyncGenerator<string, void, void> {
  // Check faction storage for existing modules
  let storageItems: Array<{ itemId: string; quantity: number }> = [];
  try {
    const storage = await ctx.api.viewFactionStorage();
    storageItems = (storage ?? []).filter((s) => s.quantity > 0);
  } catch {
    return;
  }

  // Count modules per target type (faction storage + equipped on fleet bots)
  const fleet = ctx.getFleetStatus();
  const targets = MODULE_TARGETS.map((t) => {
    const inStorage = storageItems
      .filter((s) => s.itemId.includes(t.pattern))
      .reduce((sum, s) => sum + s.quantity, 0);
    const equippedOnBots = fleet.bots
      .filter((b) => b.moduleIds.some((m) => m.includes(t.pattern)))
      .length;
    return {
      ...t,
      target: Math.min(t.target, targetCount), // Respect param override
      count: inStorage + equippedOnBots,
      inStorage,
      equippedOnBots,
    };
  });

  // Report inventory
  const inv = targets.map((t) =>
    `${t.label}: ${t.count}/${t.target} (${t.inStorage} stored, ${t.equippedOnBots} equipped)`
  ).join(", ");
  yield `modules: ${inv}`;

  // Find what's still needed
  const needed = targets.filter((t) => t.count < t.target);
  if (needed.length === 0) {
    yield "all module targets met";
    return;
  }

  // Budget: max 15% of credits per cycle on modules
  const budget = Math.floor(ctx.player.credits * 0.15);
  if (budget < 100) {
    yield `low credits (${ctx.player.credits}cr) — skipping module purchases`;
    return;
  }

  // Try to buy ONE module (most needed first = lowest count/target ratio)
  needed.sort((a, b) => (a.count / a.target) - (b.count / b.target));

  for (const target of needed) {
    if (ctx.shouldStop) return;

    // Check local market for this module
    const available = localMarket
      .filter((o) =>
        o.type === "sell"
        && o.quantity > 0
        && o.itemId.includes(target.pattern),
      )
      .sort((a, b) => a.priceEach - b.priceEach);

    if (available.length > 0) {
      const cheapest = available[0];
      if (cheapest.priceEach <= budget) {
        try {
          const result = await ctx.api.buy(cheapest.itemId, 1);
          await ctx.refreshState();

          if (result.quantity > 0) {
            // Deposit to faction storage
            try {
              await ctx.api.factionDepositItems(cheapest.itemId, 1);
              await ctx.refreshState();
              yield `bought & stored 1x ${target.label} @ ${result.priceEach || cheapest.priceEach}cr (${target.count + 1}/${target.target})`;
            } catch {
              yield `bought 1x ${target.label} @ ${result.priceEach || cheapest.priceEach}cr (in cargo — deposit failed)`;
            }
            return; // One purchase per cycle
          }
        } catch (err) {
          yield `buy failed for ${target.label}: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        yield `${target.label} @ ${cheapest.priceEach}cr exceeds budget (${budget}cr)`;
      }
    } else {
      // Check if we already have a buy order for this module type
      const existingBuyOrder = localMarket.some(
        (o) => o.type === "buy" && o.playerId === ctx.player.id && o.itemId.includes(target.pattern),
      );
      if (existingBuyOrder) {
        yield `${target.label}: buy order already placed, waiting for fill`;
        continue;
      }

      // No modules on local market — place a buy order to attract sellers
      // Need exact item ID from catalog (pattern alone isn't a valid item ID)
      const catalogItems = ctx.crafting.findItemsByPattern(target.pattern);
      const exactItem = catalogItems.length > 0 ? catalogItems[0] : null;
      const exactId = exactItem?.id ?? target.pattern;
      const basePrice = exactItem?.basePrice ?? ctx.crafting.getItemBasePrice(target.pattern);
      const offerPrice = basePrice > 0 ? Math.ceil(basePrice * 1.1) : 0; // 10% above base to attract
      if (offerPrice > 0 && offerPrice <= budget) {
        try {
          await ctx.api.createBuyOrder(exactId, 1, offerPrice);
          yield `buy order: 1x ${target.label} (${exactId}) @ ${offerPrice}cr (attracting sellers)`;
          return; // One order per cycle
        } catch (err) {
          yield `buy order failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Filled Order Collection
// ════════════════════════════════════════════════════════════════════

/**
 * Check cargo for module items that arrived via filled buy orders.
 * Deposit them to faction storage so fleet bots can withdraw and equip.
 */
async function* collectFilledOrders(
  ctx: BotContext,
): AsyncGenerator<string, void, void> {
  await ctx.refreshState();
  for (const item of ctx.ship.cargo) {
    if (ctx.shouldStop) return;
    if (!isModuleItem(item.itemId)) continue;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      await ctx.refreshState();
      yield `deposited ${item.quantity}x ${item.itemId} to faction storage (filled order)`;
    } catch (err) {
      yield `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

/**
 * Estimate cost basis of an item for pricing sell orders.
 * Uses crafting ingredient costs if available, else base catalog price.
 */
function estimateCostBasis(ctx: BotContext, itemId: string): number {
  // If craftable, sum ingredient base prices for more accurate cost
  if (ctx.crafting.isCraftable(itemId)) {
    const recipes = ctx.crafting.getAllRecipes();
    const recipe = recipes.find((r) => r.outputItem === itemId);
    if (recipe) {
      const ingredientCost = recipe.ingredients.reduce(
        (sum, ing) => sum + ctx.crafting.getItemBasePrice(ing.itemId) * ing.quantity,
        0,
      );
      if (ingredientCost > 0) {
        return Math.ceil(ingredientCost / Math.max(1, recipe.outputQuantity));
      }
    }
  }

  // Fallback: catalog base price
  return ctx.crafting.getItemBasePrice(itemId);
}

/** Check if an item ID looks like a ship module */
function isModuleItem(itemId: string): boolean {
  return MODULE_PATTERNS.some((p) => itemId.includes(p));
}
