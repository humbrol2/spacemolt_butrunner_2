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
import type { MarketOrder, Recipe } from "../types/game";
import {
  navigateAndDock,
  refuelIfNeeded,
  getParam,
  cacheMarketData,
  interruptibleSleep,
} from "./helpers";

// Equipment modules to accumulate for fleet use
const MODULE_TARGETS = [
  { pattern: "ice_harvester", target: 4, label: "Ice Harvester", fallbackIds: ["ice_harvester_1", "ice_harvester_2"], fallbackPrice: 15000 },
  { pattern: "gas_harvester", target: 4, label: "Gas Harvester", fallbackIds: ["gas_harvester_1", "gas_harvester_2"], fallbackPrice: 15000 },
  { pattern: "survey", target: 3, label: "Survey Scanner", fallbackIds: ["survey_scanner_1", "survey_scanner_2"], fallbackPrice: 20000 },
];

// Items that look like ship modules (don't sell these from faction storage)
const MODULE_PATTERNS = [
  "harvester", "scanner", "laser", "cannon", "turret",
  "shield", "armor", "engine", "thruster", "cloak",
  "tow", "salvage", "drill", "weapon", "mod_", "module",
];

// ── Supply chain buy order tracking ──

interface BuyOrderTarget {
  itemId: string;
  itemName: string;
  quantityNeeded: number;
  maxBuyPrice: number;
  recommendedPrice: number;
  recipeIds: string[];
  expectedMargin: number;
}

interface MaterialBuyOrder {
  orderId: string;
  itemId: string;
  itemName: string;
  quantity: number;
  priceEach: number;
  placedAt: number;
  forRecipeId: string;
  maxAgeMs: number;
}

export async function* quartermaster(ctx: BotContext): AsyncGenerator<string, void, void> {
  const homeBase = getParam(ctx, "homeBase",
    ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase);
  const moduleTarget = getParam(ctx, "moduleTarget", 4);
  const undercutPct = getParam(ctx, "undercutPct", 0.05);
  const buyOrderBudgetPct = getParam(ctx, "buyOrderBudgetPct", 0.30);
  const maxOrderAge = getParam(ctx, "maxOrderAge", 7_200_000); // 2 hours

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

  // Resolve station name for chat ads
  let stationName = homeBase;
  const homeSystemId = ctx.galaxy.getSystemForBase(homeBase);
  if (homeSystemId) {
    const homeSys = ctx.galaxy.getSystem(homeSystemId);
    const basePoi = homeSys?.pois.find((p) => p.baseId === homeBase);
    stationName = basePoi?.baseName ?? basePoi?.name ?? homeBase;
  }

  // Track items we've already listed to avoid double-listing within a session
  const listedItems = new Set<string>();
  // Items too heavy for our cargo — skip in future cycles
  const oversizedItems = new Set<string>();
  // Track material buy orders placed this session
  const trackedMaterialOrders = new Map<string, MaterialBuyOrder>();
  // Rate-limited global chat advertisement (max 1 message per 5 minutes)
  const adState: AdChatState = { lastAdChatTime: 0, stationName };

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
    yield* manageFactionSales(ctx, homeBase, market, undercutPct, listedItems, oversizedItems, adState);

    if (ctx.shouldStop) return;

    // ── 2. Buy equipment modules for fleet ──
    yield* buyEquipmentModules(ctx, homeBase, market, moduleTarget);

    if (ctx.shouldStop) return;

    // ── 3. Check and collect filled buy orders ──
    // Modules bought via buy orders arrive in cargo — deposit them to faction storage
    yield* collectFilledOrders(ctx);

    if (ctx.shouldStop) return;

    // ── 4. Manage supply chain buy orders ──
    yield* manageMaterialBuyOrders(
      ctx, homeBase, market, trackedMaterialOrders,
      buyOrderBudgetPct, maxOrderAge, adState,
    );

    if (ctx.shouldStop) return;

    await refuelIfNeeded(ctx);

    // Moderate cycle — shorter sleep to capitalize on opportunities faster
    await interruptibleSleep(ctx, 30_000);
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
  oversizedItems: Set<string>,
  adState: AdChatState,
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
    // Skip items known to be too heavy for our cargo
    if (oversizedItems.has(item.itemId)) continue;

    const itemName = ctx.crafting.getItemName(item.itemId) || item.itemId;
    let costBasis = estimateCostBasis(ctx, item.itemId);

    // Fallback: use any known market sell price as cost basis estimate
    if (costBasis <= 0) {
      for (const stationId of cachedStationIds) {
        const prices = ctx.cache.getMarketPrices(stationId);
        const p = prices?.find((pd) => pd.itemId === item.itemId);
        if (p?.sellPrice && p.sellPrice > costBasis) costBasis = p.sellPrice;
        if (p?.buyPrice && p.buyPrice > costBasis) costBasis = p.buyPrice;
      }
      // Check home station too
      const homePrices = ctx.cache.getMarketPrices(homeBase);
      const hp = homePrices?.find((pd) => pd.itemId === item.itemId);
      if (hp?.sellPrice && hp.sellPrice > costBasis) costBasis = hp.sellPrice;
      if (hp?.buyPrice && hp.buyPrice > costBasis) costBasis = hp.buyPrice;
    }

    if (costBasis <= 0) continue; // Truly unknown — can't price it

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

    // Calculate list price: undercut competitors to attract buyers
    let listPrice: number;
    if (cheapestElsewhere < Infinity) {
      listPrice = Math.floor(cheapestElsewhere * (1 - undercutPct));
    } else if (bestDemandPrice > 0) {
      // No sell data elsewhere — price slightly below demand
      listPrice = Math.floor(bestDemandPrice * (1 - undercutPct / 2));
    } else {
      // No competitor data at all — use cost basis markup as fallback
      listPrice = Math.ceil(costBasis * 1.25);
    }

    // Floor: at least 10% above cost basis
    const minPrice = Math.ceil(costBasis * 1.10);
    if (listPrice < minPrice) {
      listPrice = minPrice;
    }

    if (listPrice <= 0) continue;

    // Skip items where total revenue is too low to be worth a game tick
    const totalRevenue = listPrice * Math.min(item.quantity, 50);
    if (totalRevenue < 100) continue;

    // Check if there are local buy orders (instant demand) at a good price
    const localBuyOrders = localMarket
      .filter((o) => o.type === "buy" && o.itemId === item.itemId && o.quantity > 0 && o.priceEach >= minPrice);
    const bestBuyOrder = localBuyOrders.length > 0
      ? localBuyOrders.reduce((a, b) => a.priceEach > b.priceEach ? a : b)
      : null;

    // Withdraw from faction storage and sell/list
    const freeSpace = ctx.cargo.freeSpace(ctx.ship);
    if (freeSpace <= 0) break; // Cargo full — stop trying
    const itemSize = ctx.cargo.getItemSize(ctx.ship, item.itemId);
    const maxBySpace = Math.floor(freeSpace / Math.max(1, itemSize));
    let listQty = Math.min(item.quantity, 50, maxBySpace); // Don't flood, respect cargo
    if (listQty <= 0) continue; // Item too heavy for remaining space
    try {
      try {
        await ctx.api.factionWithdrawItems(item.itemId, listQty);
      } catch (wErr: unknown) {
        // Item heavier than expected (size unknown until in cargo) — retry with less
        if (wErr instanceof Error && wErr.message.includes("cargo_full")) {
          if (listQty <= 1) {
            // Even 1 unit doesn't fit — permanently skip this item
            oversizedItems.add(item.itemId);
            yield `${itemName} too heavy for cargo (${freeSpace} free) — skipping`;
            continue;
          }
          listQty = Math.max(1, Math.floor(listQty / 3));
          try {
            await ctx.api.factionWithdrawItems(item.itemId, listQty);
          } catch (wErr2: unknown) {
            if (wErr2 instanceof Error && wErr2.message.includes("cargo_full")) {
              oversizedItems.add(item.itemId);
              yield `${itemName} too heavy for cargo — skipping`;
              continue;
            }
            throw wErr2;
          }
        } else {
          throw wErr;
        }
      }
      await ctx.refreshState();

      const inCargo = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
      if (inCargo <= 0) {
        yield `withdraw failed: ${itemName} not in cargo after withdrawal`;
        continue;
      }

      const sellQty = Math.min(inCargo, listQty);

      // Prefer direct sell to buy orders (instant revenue) over listing
      if (bestBuyOrder && bestBuyOrder.priceEach >= listPrice * 0.9) {
        const directQty = Math.min(sellQty, bestBuyOrder.quantity);
        const result = await ctx.api.sell(item.itemId, directQty);
        await ctx.refreshState();
        if (result.total > 0) {
          yield `sold ${result.quantity} ${itemName} @ ${result.priceEach}cr (${result.total}cr) — direct to buyer`;
          ordersCreated++;
          // Re-deposit leftover
          const remaining = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
          if (remaining > 0) {
            try {
              await ctx.api.factionDepositItems(item.itemId, remaining);
              await ctx.refreshState();
            } catch { /* best effort */ }
          }
        } else {
          // Direct sell returned 0 — fall through to sell order
          await ctx.api.createSellOrder(item.itemId, sellQty, listPrice);
          await ctx.refreshState();
          yield `listed ${sellQty} ${itemName} @ ${listPrice}cr/ea (+${listPrice - costBasis}cr margin)`;
          listedItems.add(item.itemId);
          ordersCreated++;
          await advertiseInChat(ctx, `Selling ${sellQty}x ${itemName} @ ${listPrice}cr`, adState);
        }
      } else {
        await ctx.api.createSellOrder(item.itemId, sellQty, listPrice);
        await ctx.refreshState();

        const margin = listPrice - costBasis;
        const vsCompetitor = cheapestElsewhere < Infinity
          ? ` (${Math.round(undercutPct * 100)}% below ${cheapestElsewhere}cr elsewhere)`
          : "";
        yield `listed ${sellQty} ${itemName} @ ${listPrice}cr/ea (+${margin}cr margin)${vsCompetitor}`;

        listedItems.add(item.itemId);
        ordersCreated++;
        await advertiseInChat(ctx, `Selling ${sellQty}x ${itemName} @ ${listPrice}cr`, adState);
      }

      // Up to 5 actions per cycle (game allows 1 mutation per 10s tick = 6/min max)
      if (ordersCreated >= 5) break;
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

  // Budget: keep a 2000cr reserve, spend the rest on modules
  // Module buying is the quartermaster's primary job — don't be stingy
  const reserve = 2000;
  const budget = Math.max(0, ctx.player.credits - reserve);
  if (budget < 100) {
    yield `low credits (${ctx.player.credits}cr, reserve ${reserve}cr) — skipping module purchases`;
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
      yield `${target.label}: not in stock at this station`;
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
// Supply Chain Buy Orders
// ════════════════════════════════════════════════════════════════════

/**
 * Manage buy orders for supply chain gap materials.
 * Gap materials are recipe inputs the fleet can't mine or craft internally.
 *
 * Flow: Reconcile filled orders → cancel stale → adjust slow prices → place new.
 * Action budget: max 2 new + 1 cancel + 1 modify = 4 ticks per cycle.
 */
async function* manageMaterialBuyOrders(
  ctx: BotContext,
  homeBase: string,
  localMarket: MarketOrder[],
  tracked: Map<string, MaterialBuyOrder>,
  budgetPct: number,
  maxAge: number,
  adState: AdChatState,
): AsyncGenerator<string, void, void> {
  const now = Date.now();
  let actionsThisCycle = 0;
  const MAX_ACTIONS = 4;

  // ── Reconcile: check current orders vs tracked ──
  let myBuyOrders: MarketOrder[] = [];
  try {
    const allOrders = await ctx.api.viewOrders();
    myBuyOrders = allOrders.filter(
      (o) => o.type === "buy" && o.playerId === ctx.player.id,
    );
  } catch (err) {
    yield `order check failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  const currentOrderIds = new Set(myBuyOrders.map((o) => o.id));

  // Detect fully filled orders (tracked but no longer in viewOrders)
  for (const [orderId, order] of tracked) {
    if (!currentOrderIds.has(orderId)) {
      tracked.delete(orderId);
      yield `buy order filled: ${order.itemName} x${order.quantity}`;
    }
  }

  // Adopt untracked buy orders (from previous sessions or API tracking gaps)
  for (const order of myBuyOrders) {
    if (!tracked.has(order.id) && !isModuleItem(order.itemId)) {
      tracked.set(order.id, {
        orderId: order.id,
        itemId: order.itemId,
        itemName: order.itemName,
        quantity: order.remaining,
        priceEach: order.priceEach,
        placedAt: now - 600_000, // Assume 10min old if unknown
        forRecipeId: "",
        maxAgeMs: maxAge,
      });
      yield `adopted existing buy order: ${order.itemName} x${order.remaining} @ ${order.priceEach}cr`;
    }
  }

  // Deposit any non-module material items in cargo to faction storage (from filled orders)
  await ctx.refreshState();
  for (const item of ctx.ship.cargo) {
    if (ctx.shouldStop) return;
    if (isModuleItem(item.itemId)) continue; // Handled by collectFilledOrders
    if (item.itemId.startsWith("ore_")) continue;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      await ctx.refreshState();
      const itemName = ctx.crafting.getItemName(item.itemId) || item.itemId;
      yield `deposited ${item.quantity}x ${itemName} to faction (from buy order)`;
    } catch (err) {
      yield `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Update tracking for partially filled orders
  for (const order of myBuyOrders) {
    const t = tracked.get(order.id);
    if (t && order.remaining < t.quantity) {
      const filled = t.quantity - order.remaining;
      yield `buy order partial fill: ${t.itemName} x${filled}/${t.quantity}`;
      t.quantity = order.remaining;
    }
  }

  // ── Get faction storage for stock checks ──
  let factionStock = new Map<string, number>();
  try {
    const storage = await ctx.api.viewFactionStorage();
    for (const s of storage ?? []) {
      if (s.quantity > 0) factionStock.set(s.itemId, s.quantity);
    }
  } catch { /* proceed with empty stock */ }

  // ── Cancel stale orders ──
  for (const [orderId, order] of tracked) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS) break;

    const age = now - order.placedAt;
    const stock = factionStock.get(order.itemId) ?? 0;

    if (age > order.maxAgeMs || stock >= 20) {
      try {
        await ctx.api.cancelOrder(orderId);
        tracked.delete(orderId);
        actionsThisCycle++;
        const reason = stock >= 20 ? "sufficient stock" : "expired";
        yield `cancelled buy order: ${order.itemName} (${reason})`;
      } catch (err) {
        yield `cancel failed for ${order.itemName}: ${err instanceof Error ? err.message : String(err)}`;
      }
      break; // Max 1 cancel per cycle
    }
  }

  // ── Adjust prices on slow orders (>30min without fills) ──
  for (const [orderId, order] of tracked) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS) break;

    const age = now - order.placedAt;
    if (age < 1_800_000) continue; // < 30 min — too early to adjust

    // Need a recipe context to recalculate price
    if (!order.forRecipeId) continue;
    const recipe = ctx.crafting.getRecipe(order.forRecipeId);
    if (!recipe) continue;

    const priceInfo = calculateBuyPrice(ctx, order.itemId, recipe);
    if (!priceInfo) continue;

    const priceDiff = Math.abs(priceInfo.recommendedPrice - order.priceEach) / order.priceEach;
    if (priceDiff < 0.10) continue; // < 10% difference — not worth a tick

    try {
      await ctx.api.modifyOrder(orderId, priceInfo.recommendedPrice);
      order.priceEach = priceInfo.recommendedPrice;
      order.placedAt = now; // Reset age after adjustment
      actionsThisCycle++;
      yield `adjusted buy order: ${order.itemName} → ${priceInfo.recommendedPrice}cr`;
    } catch (err) {
      yield `modify failed for ${order.itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
    break; // Max 1 modify per cycle
  }

  // ── Place new orders ──
  const reserve = 2000;
  const totalBudget = Math.max(0, (ctx.player.credits - reserve) * budgetPct);
  const outstandingValue = [...tracked.values()].reduce(
    (sum, o) => sum + o.priceEach * o.quantity, 0,
  );
  let remainingBudget = totalBudget - outstandingValue;
  const perOrderCap = totalBudget * 0.15;

  if (remainingBudget < 100) {
    if (tracked.size > 0) {
      yield `buy orders: ${tracked.size} active, budget exhausted`;
    }
    return;
  }

  const orderedItems = new Set([...tracked.values()].map((o) => o.itemId));
  const targets = identifyBuyOrderTargets(ctx, factionStock, remainingBudget);
  let newOrdersPlaced = 0;

  for (const target of targets) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS || newOrdersPlaced >= 2) break;
    if (orderedItems.has(target.itemId)) continue;

    // Calculate order size within budget
    const maxByBudget = Math.floor(Math.min(remainingBudget, perOrderCap) / target.recommendedPrice);
    const buyQty = Math.min(target.quantityNeeded, maxByBudget);
    if (buyQty <= 0 || target.recommendedPrice <= 0) continue;

    const orderCost = target.recommendedPrice * buyQty;

    try {
      const result = await ctx.api.createBuyOrder(target.itemId, buyQty, target.recommendedPrice);
      const orderId = String(
        (result as Record<string, unknown>).order_id ??
        (result as Record<string, unknown>).id ??
        `pending_${target.itemId}_${now}`,
      );

      tracked.set(orderId, {
        orderId,
        itemId: target.itemId,
        itemName: target.itemName,
        quantity: buyQty,
        priceEach: target.recommendedPrice,
        placedAt: now,
        forRecipeId: target.recipeIds[0],
        maxAgeMs: maxAge,
      });

      remainingBudget -= orderCost;
      actionsThisCycle++;
      newOrdersPlaced++;

      yield `placed buy order: ${buyQty}x ${target.itemName} @ ${target.recommendedPrice}cr (${orderCost}cr total)`;
      await advertiseInChat(ctx, `Buying ${buyQty}x ${target.itemName} @ ${target.recommendedPrice}cr`, adState);
    } catch (err) {
      yield `buy order failed for ${target.itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (tracked.size > 0) {
    yield `buy orders: ${tracked.size} active, ${Math.floor(remainingBudget)}cr budget remaining`;
  }
}

/**
 * Identify gap materials the fleet can't self-produce.
 * Walks all profitable recipes, finds inputs that aren't ores and aren't craftable.
 * Returns top 5 targets sorted by expected margin descending.
 */
function identifyBuyOrderTargets(
  ctx: BotContext,
  factionStock: Map<string, number>,
  budget: number,
): BuyOrderTarget[] {
  const recipes = ctx.crafting.getAllRecipes();
  const targets = new Map<string, BuyOrderTarget>();

  for (const recipe of recipes) {
    const profit = ctx.crafting.estimateProfit(recipe.id);
    if (profit <= 0) continue;

    const rawMaterials = ctx.crafting.getRawMaterials(recipe.id);

    for (const [itemId, _qty] of rawMaterials) {
      // Skip ores (miners produce these)
      if (itemId.startsWith("ore_")) continue;
      // Skip craftable items (crafters handle these)
      if (ctx.crafting.isCraftable(itemId)) continue;

      // Check faction stock — skip if well-stocked
      const stock = factionStock.get(itemId) ?? 0;
      if (stock >= 20) continue;

      const quantityNeeded = Math.max(1, 20 - stock);

      // Calculate price from recipe profitability
      const priceInfo = calculateBuyPrice(ctx, itemId, recipe);
      if (!priceInfo) continue;

      const existing = targets.get(itemId);
      if (existing) {
        existing.recipeIds.push(recipe.id);
        // Use lowest maxBuyPrice across recipes (most conservative)
        if (priceInfo.maxBuyPrice < existing.maxBuyPrice) {
          existing.maxBuyPrice = priceInfo.maxBuyPrice;
          existing.recommendedPrice = priceInfo.recommendedPrice;
          existing.expectedMargin = priceInfo.expectedMargin;
        }
      } else {
        targets.set(itemId, {
          itemId,
          itemName: ctx.crafting.getItemName(itemId) || itemId,
          quantityNeeded,
          maxBuyPrice: priceInfo.maxBuyPrice,
          recommendedPrice: priceInfo.recommendedPrice,
          recipeIds: [recipe.id],
          expectedMargin: priceInfo.expectedMargin,
        });
      }
    }
  }

  return [...targets.values()]
    .sort((a, b) => b.expectedMargin - a.expectedMargin)
    .slice(0, 5);
}

/**
 * Calculate the maximum profitable buy price for a gap material
 * in the context of a specific recipe.
 *
 * Pricing strategy:
 *   maxBuyPrice = (endProductSellPrice - otherInputCosts) / qtyNeeded * 0.70  (30% margin)
 *   attractivePrice = min(cheapestSellPrice * 0.92, catalogBasePrice)
 *   finalPrice = min(maxBuyPrice, attractivePrice)
 *   floor = catalogBasePrice * 0.50  (don't lowball too hard)
 */
function calculateBuyPrice(
  ctx: BotContext,
  gapItemId: string,
  recipe: Recipe,
): { maxBuyPrice: number; recommendedPrice: number; expectedMargin: number } | null {
  const rawMaterials = ctx.crafting.getRawMaterials(recipe.id);
  const gapQty = rawMaterials.get(gapItemId);
  if (!gapQty || gapQty <= 0) return null;

  // End product sell price
  const endProductPrice = ctx.crafting.getItemBasePrice(recipe.outputItem) * recipe.outputQuantity;

  // Cost of all other raw materials
  let otherCosts = 0;
  for (const [itemId, qty] of rawMaterials) {
    if (itemId === gapItemId) continue;
    otherCosts += ctx.crafting.getItemBasePrice(itemId) * qty;
  }

  // Max buy price with 30% margin
  const maxBuyPrice = Math.floor((endProductPrice - otherCosts) / gapQty * 0.70);
  if (maxBuyPrice <= 0) return null;

  // Find cheapest sell price across all cached stations
  let cheapestSellPrice = Infinity;
  const freshness = ctx.cache.getAllMarketFreshness();
  for (const { stationId } of freshness) {
    const prices = ctx.cache.getMarketPrices(stationId);
    if (!prices) continue;
    const p = prices.find((pd) => pd.itemId === gapItemId);
    if (p?.buyPrice && p.buyPrice > 0 && p.buyPrice < cheapestSellPrice) {
      cheapestSellPrice = p.buyPrice;
    }
  }

  const catalogPrice = ctx.crafting.getItemBasePrice(gapItemId);
  if (catalogPrice <= 0) return null;

  // Attractive price: undercut market or use catalog
  const attractivePrice = cheapestSellPrice < Infinity
    ? Math.min(Math.floor(cheapestSellPrice * 0.92), catalogPrice)
    : catalogPrice;

  // Final price: lower of max and attractive
  const finalPrice = Math.min(maxBuyPrice, attractivePrice);

  // Floor: don't lowball too hard
  const floor = Math.floor(catalogPrice * 0.50);
  if (finalPrice < floor || finalPrice <= 0) return null;

  const expectedMargin = endProductPrice - otherCosts - (finalPrice * gapQty);

  return { maxBuyPrice, recommendedPrice: finalPrice, expectedMargin };
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

// ── Chat advertisement ──

interface AdChatState { lastAdChatTime: number; stationName: string }

const AD_CHAT_COOLDOWN = 300_000; // 5 minutes

/** Post a trade advertisement to system chat, rate-limited to 1 per 5 minutes. */
async function advertiseInChat(
  ctx: BotContext,
  message: string,
  state: AdChatState,
): Promise<boolean> {
  const now = Date.now();
  if (now - state.lastAdChatTime < AD_CHAT_COOLDOWN) return false;
  try {
    const fullMsg = state.stationName ? `${message} at ${state.stationName}` : message;
    await ctx.api.chat("system", fullMsg);
    state.lastAdChatTime = now;
    return true;
  } catch { return false; }
}
