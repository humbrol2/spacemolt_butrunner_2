/**
 * Shared routine helpers - common patterns used across multiple routines.
 * These handle navigation, docking, emergency responses, and state refresh.
 */

import type { BotContext } from "../bot/types";
import type { TravelResult, MiningYield, TradeResult, MarketOrder, MarketPrice } from "../types/game";

/** Items that should never be sold or deposited — kept as emergency reserves */
const PROTECTED_ITEMS = new Set(["fuel_cell"]);

/** Check if an item is protected from selling/depositing */
export function isProtectedItem(itemId: string): boolean {
  return PROTECTED_ITEMS.has(itemId);
}

/** Consistent logging prefix for a bot */
function log(ctx: BotContext, msg: string): void {
  console.log(`[${ctx.botId}] ${msg}`);
}

function logWarn(ctx: BotContext, msg: string): void {
  console.warn(`[${ctx.botId}] ${msg}`);
}

function logError(ctx: BotContext, msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  console.error(`[${ctx.botId}] ${msg}${detail ? `: ${detail}` : ""}`);
}

// ── Navigation ──

/**
 * Navigate to a POI within the current system.
 * If already at the POI, does nothing.
 * Returns the travel result or null if already there.
 */
export async function travelToPoi(ctx: BotContext, poiId: string): Promise<TravelResult | null> {
  if (ctx.player.currentPoi === poiId) return null;

  // Must undock first if docked - refuel before leaving
  if (ctx.player.dockedAtBase) {
    await ensureFuelSafety(ctx);
    log(ctx, `undocking from ${ctx.player.dockedAtBase}`);
    await ctx.api.undock();
    await ctx.refreshState();
  }

  log(ctx, `traveling to POI ${poiId}`);
  const result = await ctx.api.travel(poiId);
  await ctx.refreshState();
  return result;
}

/**
 * Jump to a different system and optionally travel to a POI within it.
 * Uses the game's find_route API for path planning (knows the full map),
 * with local BFS as fallback if the API fails.
 * Auto-updates galaxy with system details at each hop (data gathering).
 */
export async function navigateTo(
  ctx: BotContext,
  targetSystemId: string,
  targetPoiId?: string
): Promise<void> {
  // Undock first if docked - refuel before leaving
  if (ctx.player.dockedAtBase) {
    await ensureFuelSafety(ctx);
    log(ctx, `undocking from ${ctx.player.dockedAtBase}`);
    await ctx.api.undock();
    await ctx.refreshState();
  }

  // Jump through systems if needed
  if (ctx.player.currentSystem !== targetSystemId) {
    // Use the game's find_route API (free query, knows full map)
    let path: string[] | null = null;
    try {
      const routeResult = await ctx.api.findRoute(targetSystemId);
      if (routeResult.found && routeResult.route.length > 0) {
        // Route includes current system as first entry - extract system IDs
        path = routeResult.route.map((r) => r.systemId);
      }
    } catch (err) {
      logWarn(ctx, `API route planning failed, using BFS fallback: ${err instanceof Error ? err.message : err}`);
    }

    // Fallback: local BFS pathfinding
    if (!path) {
      path = ctx.galaxy.findPath(ctx.player.currentSystem, targetSystemId);
    }

    if (!path || path.length === 0) {
      throw new Error(`No route from ${ctx.player.currentSystem} to ${targetSystemId}`);
    }

    log(ctx, `navigating ${ctx.player.currentSystem} → ${targetSystemId} (${path.length - 1} jump(s))`);

    // Skip first element (current system)
    for (let i = 1; i < path.length; i++) {
      if (ctx.shouldStop) return;

      // Mid-route fuel check: burn cargo cells if running low
      if (ctx.fuel.getLevel(ctx.ship) === "critical" || ctx.fuel.getLevel(ctx.ship) === "low") {
        logWarn(ctx, `low fuel mid-route, burning fuel cells`);
        await burnFuelCells(ctx);
      }

      log(ctx, `jumping to ${path[i]} (${i}/${path.length - 1})`);
      await ctx.api.jump(path[i]);
      await ctx.refreshState();

      // Auto-update galaxy with detailed system data (getSystem is a free query)
      try {
        const systemDetail = await ctx.api.getSystem();
        if (systemDetail?.id) {
          ctx.galaxy.updateSystem(systemDetail);
          ctx.cache.setSystemDetail(systemDetail.id, systemDetail);
        }
      } catch (err) {
        logWarn(ctx, `failed to update system detail after jump: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Travel to POI within the system
  if (targetPoiId && ctx.player.currentPoi !== targetPoiId) {
    await ctx.api.travel(targetPoiId);
    await ctx.refreshState();
  }
}

/**
 * Navigate to a POI by ID, resolving the system automatically.
 */
export async function navigateToPoi(ctx: BotContext, poiId: string): Promise<void> {
  const systemId = ctx.galaxy.getSystemForPoi(poiId);
  if (!systemId) throw new Error(`Unknown POI: ${poiId}`);
  await navigateTo(ctx, systemId, poiId);
}

// ── System Data ──

/**
 * Ensure the current system has full POI data in the galaxy graph.
 * get_map only returns system coordinates (no POIs), so we call getSystem
 * (free query) to get full details including which POIs have bases.
 */
export async function ensureSystemDetail(ctx: BotContext): Promise<void> {
  const system = ctx.galaxy.getSystem(ctx.player.currentSystem);
  if (system && system.pois.length > 0) return; // Already have POI data

  try {
    const detail = await ctx.api.getSystem();
    if (detail?.id) {
      ctx.galaxy.updateSystem(detail);
      ctx.cache.setSystemDetail(detail.id, detail);
    }
  } catch (err) {
    logWarn(ctx, `failed to fetch system detail for ${ctx.player.currentSystem}: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Docking ──

/**
 * Dock at the station at the current POI.
 * Does nothing if already docked or if the POI has no base.
 * Auto-scans market and services ship (refuel + repair) on every dock.
 */
export async function dockAtCurrent(ctx: BotContext): Promise<void> {
  if (ctx.player.dockedAtBase) return;

  // Ensure we have POI data for this system before checking dockability
  await ensureSystemDetail(ctx);

  // Only attempt dock if the POI has a base
  if (!ctx.station.canDock(ctx.player)) return;

  log(ctx, `docking at ${ctx.player.currentPoi ?? "current POI"}`);
  await ctx.api.dock();
  await ctx.refreshState();

  if (ctx.player.dockedAtBase) {
    log(ctx, `docked at ${ctx.player.dockedAtBase}`);
    // Always service ship when docking
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    // Auto-scan market to build intel (viewMarket is a free query)
    try {
      const orders = await ctx.api.viewMarket();
      if (orders.length > 0) {
        cacheMarketData(ctx, ctx.player.dockedAtBase, orders);
      }
    } catch (err) {
      logWarn(ctx, `market scan failed at ${ctx.player.dockedAtBase}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Navigate to a base (station) and dock.
 */
export async function navigateAndDock(ctx: BotContext, baseId: string): Promise<void> {
  const systemId = ctx.galaxy.getSystemForBase(baseId);
  if (!systemId) throw new Error(`Unknown base: ${baseId}`);

  // Find the POI that has this base
  const system = ctx.galaxy.getSystem(systemId);
  const poi = system?.pois.find((p) => p.baseId === baseId);
  if (!poi) throw new Error(`No POI for base: ${baseId}`);

  await navigateTo(ctx, systemId, poi.id);
  await dockAtCurrent(ctx);
}

/**
 * Find the nearest station and dock. Used when no specific station is provided
 * and the current POI has no base. Guarantees docking or throws.
 */
export async function findAndDock(ctx: BotContext): Promise<void> {
  if (ctx.player.dockedAtBase) return;

  // Try current POI first
  await ensureSystemDetail(ctx);
  if (ctx.station.canDock(ctx.player)) {
    log(ctx, `docking at current POI ${ctx.player.currentPoi}`);
    await ctx.api.dock();
    await ctx.refreshState();
    if (ctx.player.dockedAtBase) {
      await refuelIfNeeded(ctx);
      await repairIfNeeded(ctx);
      try {
        const orders = await ctx.api.viewMarket();
        if (orders.length > 0) cacheMarketData(ctx, ctx.player.dockedAtBase, orders);
      } catch {}
      return;
    }
  }

  // Find nearest station in current system or nearby
  const target = ctx.station.chooseDockTarget(ctx.player, ctx.ship);
  if (!target) throw new Error("no station found to dock at");

  log(ctx, `navigating to nearest station: ${target.systemId}/${target.poiId}`);
  await navigateTo(ctx, target.systemId, target.poiId);
  await dockAtCurrent(ctx);

  if (!ctx.player.dockedAtBase) {
    throw new Error(`failed to dock at ${target.poiId}`);
  }
}

// ── Services ──

/**
 * Refuel if below threshold. Works anywhere:
 *   - Docked: uses station refuel (credits) then burns cargo cells if still low
 *   - Undocked: burns fuel cells from cargo
 */
export async function refuelIfNeeded(ctx: BotContext, threshold = 60): Promise<boolean> {
  const fuelPct = ctx.fuel.getPercentage(ctx.ship);
  if (fuelPct >= threshold) return false;

  // Station refuel (costs credits, only works docked)
  if (ctx.player.dockedAtBase) {
    try {
      await ctx.api.refuel();
      await ctx.refreshState();
    } catch {
      // tank_full or other refuel errors — continue to try fuel cells
    }
    if (ctx.fuel.getPercentage(ctx.ship) >= threshold) return true;

    // Try withdrawing fuel cells from faction storage if still low
    if (ctx.fuel.getPercentage(ctx.ship) < threshold) {
      if (ctx.settings.factionStorage || ctx.fleetConfig.defaultStorageMode === "faction_deposit") {
        try {
          await ctx.api.factionWithdrawItems("fuel_cell", 5);
          await ctx.refreshState();
        } catch {
          // No fuel in faction storage
        }
      }
    }
  }

  // Burn fuel cells from cargo (works anywhere)
  await burnFuelCells(ctx);
  return true;
}

/**
 * Burn fuel cells from cargo to refuel. Works docked or undocked.
 * The API auto-selects cheapest cells and caps to tank capacity.
 */
export async function burnFuelCells(ctx: BotContext): Promise<boolean> {
  const totalCells = ctx.ship.cargo
    .filter((c) => c.itemId.includes("fuel") && c.quantity > 0)
    .reduce((sum, c) => sum + c.quantity, 0);
  if (totalCells === 0) return false;

  try {
    await ctx.api.refuel(undefined, totalCells);
    await ctx.refreshState();
    return true;
  } catch {
    return false;
  }
}

/**
 * Repair at the current station if hull is damaged. Must be docked.
 */
export async function repairIfNeeded(ctx: BotContext, threshold = 80): Promise<boolean> {
  const hullPct = (ctx.ship.hull / ctx.ship.maxHull) * 100;
  if (hullPct >= threshold) return false;

  await ctx.api.repair();
  await ctx.refreshState();
  return true;
}

/**
 * Full station service: refuel + repair + ensure fuel safety before undocking.
 */
export async function serviceShip(ctx: BotContext): Promise<void> {
  await repairIfNeeded(ctx, 90);
  await refuelIfNeeded(ctx, 80);
}

/**
 * Ensure the bot won't run out of fuel before reaching a station.
 * Call this while docked before beginning a new work cycle.
 * Refuels first, then checks if fuel is still low (station out of fuel)
 * and attempts to buy fuel cells from the local market as a backup.
 */
/** Minimum fuel cells to carry as emergency reserve */
const FUEL_CELL_RESERVE = 5;

export async function ensureFuelSafety(ctx: BotContext): Promise<void> {
  if (!ctx.player.dockedAtBase) return;

  // Only refuel if not already full
  const currentFuel = ctx.fuel.getPercentage(ctx.ship);
  if (currentFuel < 95) {
    try {
      await ctx.api.refuel();
      await ctx.refreshState();
    } catch {
      // tank_full or other refuel errors are non-critical
    }
  }

  // If fuel is still low after refuel, burn cargo fuel cells
  const fuelPct = ctx.fuel.getPercentage(ctx.ship);
  if (fuelPct < 50) {
    await burnFuelCells(ctx);
  }

  // Maintain fuel cell reserve: try faction storage first, then buy from market
  try {
    const currentCells = ctx.cargo.getItemQuantity(ctx.ship, "fuel_cell");
    const needCells = FUEL_CELL_RESERVE - currentCells;
    const fuelSize = ctx.cargo.getItemSize(ctx.ship, "fuel_cell");
    if (needCells > 0 && ctx.cargo.hasSpace(ctx.ship, needCells, fuelSize)) {
      let gotFromFaction = false;

      // Try faction storage first (free, no credits needed)
      if (ctx.settings.factionStorage || ctx.fleetConfig.defaultStorageMode === "faction_deposit") {
        try {
          await ctx.api.factionWithdrawItems("fuel_cell", needCells);
          await ctx.refreshState();
          const afterWithdraw = ctx.cargo.getItemQuantity(ctx.ship, "fuel_cell");
          if (afterWithdraw > currentCells) {
            log(ctx, `withdrew ${afterWithdraw - currentCells}x fuel_cell from faction storage`);
            gotFromFaction = true;
          }
        } catch {
          // No fuel cells in faction storage — fall through to market
        }
      }

      // Buy from market if faction didn't cover it
      const stillNeed = FUEL_CELL_RESERVE - ctx.cargo.getItemQuantity(ctx.ship, "fuel_cell");
      if (!gotFromFaction || stillNeed > 0) {
        const orders = await ctx.api.viewMarket();
        const MAX_FUEL_CELL_PRICE = 300; // Fuel cells are craftable cheaply — don't overpay
        const fuelOrders = orders.filter(
          (o) =>
            o.type === "sell" &&
            o.quantity > 0 &&
            o.priceEach <= MAX_FUEL_CELL_PRICE &&
            (o.itemId === "fuel_cell" || o.itemId === "comp_fuel_tank" || o.itemId === "fuel_cell_premium")
        );
        if (fuelOrders.length > 0) {
          fuelOrders.sort((a, b) => a.priceEach - b.priceEach);
          const best = fuelOrders[0];
          const freeWeight = ctx.cargo.freeSpace(ctx.ship);
          const maxByWeight = Math.floor(freeWeight / Math.max(1, fuelSize));
          const buyQty = Math.min(Math.max(0, stillNeed), best.quantity, Math.floor(ctx.player.credits / best.priceEach), maxByWeight);
          if (buyQty > 0) {
            await ctx.api.buy(best.itemId, buyQty);
            await ctx.refreshState();
            log(ctx, `bought ${buyQty}x ${best.itemId} fuel cells @ ${best.priceEach}cr`);
          }
        } else {
          log(ctx, `fuel cells too expensive or unavailable — crafters should produce them`);
        }
      }
    }
  } catch (err) {
    logWarn(ctx, `fuel cell acquisition failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Cargo ──

/**
 * Sell all of a specific item from cargo at the current station.
 * Returns the trade result or null if nothing to sell.
 */
export async function sellItem(ctx: BotContext, itemId: string): Promise<TradeResult | null> {
  const qty = ctx.cargo.getItemQuantity(ctx.ship, itemId);
  if (qty <= 0) return null;

  const result = await ctx.api.sell(itemId, qty);
  await ctx.refreshState();
  return result;
}

export interface SellResult {
  totalEarned: number;
  items: Array<{ itemId: string; quantity: number; priceEach: number; total: number }>;
}

/**
 * Sell all cargo items at the current station.
 * Skips protected items (fuel cells etc.) — those are kept as emergency reserves.
 * Skips items that would sell for 0cr (no demand at this station).
 * Returns total credits earned and per-item details.
 */
export async function sellAllCargo(ctx: BotContext): Promise<SellResult> {
  let totalEarned = 0;
  const items: SellResult["items"] = [];
  for (const item of ctx.ship.cargo) {
    if (ctx.shouldStop) break;
    if (isProtectedItem(item.itemId)) continue;
    try {
      const result = await ctx.api.sell(item.itemId, item.quantity);
      if (result.priceEach === 0 && result.total === 0) {
        log(ctx, `skipped ${item.itemId} (no demand at this station)`);
        continue;
      }
      totalEarned += result.total;
      items.push({ itemId: item.itemId, quantity: result.quantity, priceEach: result.priceEach, total: result.total });
      log(ctx, `sold ${result.quantity}x ${item.itemId} @ ${result.priceEach}cr = ${result.total}cr`);
      // Record successful sell as demand signal for arbitrage discovery
      if (ctx.player.dockedAtBase && result.priceEach > 0) {
        recordSellResult(ctx, ctx.player.dockedAtBase, item.itemId, item.itemId, result.priceEach, result.quantity);
      }
      await ctx.refreshState();
    } catch (err) {
      logWarn(ctx, `sell failed for ${item.itemId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (totalEarned > 0) log(ctx, `total sold: ${totalEarned}cr`);
  return { totalEarned, items };
}

/**
 * Deposit all of a specific item to storage.
 * Skips protected items (fuel cells etc.).
 * Uses faction storage if: bot settings.factionStorage is true,
 * OR bot settings.storageMode is "faction_deposit",
 * OR fleet config defaultStorageMode is "faction_deposit".
 *
 * Throws on failure — callers should catch and handle (e.g., fallback to sell).
 */
export async function depositItem(ctx: BotContext, itemId: string): Promise<void> {
  const qty = ctx.cargo.getItemQuantity(ctx.ship, itemId);
  if (qty <= 0) return;
  if (isProtectedItem(itemId)) return;

  const useFaction = ctx.settings.factionStorage
    || ctx.settings.storageMode === "faction_deposit"
    || ctx.fleetConfig.defaultStorageMode === "faction_deposit";

  if (useFaction) {
    await ctx.api.factionDepositItems(itemId, qty);
  } else {
    await ctx.api.depositItems(itemId, qty);
  }
  await ctx.refreshState();
}

/**
 * Dispose of cargo based on bot settings:
 *   - "sell": sell all items (default)
 *   - "deposit": deposit to personal storage
 *   - "faction_deposit": deposit to faction storage
 * Returns total credits earned (0 if depositing).
 */
export async function disposeCargo(ctx: BotContext): Promise<SellResult> {
  const mode = ctx.settings.storageMode;
  log(ctx, `disposing cargo (mode: ${mode})`);

  if (mode === "deposit" || mode === "faction_deposit") {
    const items: SellResult["items"] = [];
    let depositFailed = false;
    for (const item of ctx.ship.cargo) {
      if (ctx.shouldStop) break;
      if (isProtectedItem(item.itemId)) continue;
      const qty = item.quantity;
      try {
        if (mode === "faction_deposit") {
          await ctx.api.factionDepositItems(item.itemId, qty);
        } else {
          await ctx.api.depositItems(item.itemId, qty);
        }
        log(ctx, `deposited ${qty}x ${item.itemId} to ${mode === "faction_deposit" ? "faction" : "personal"} storage`);
        items.push({ itemId: item.itemId, quantity: qty, priceEach: 0, total: 0 });
        await ctx.refreshState();
      } catch (err) {
        logWarn(ctx, `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : err}`);
        depositFailed = true;
        break;
      }
    }
    // If deposit failed, sell remaining cargo so bots don't get stuck
    if (depositFailed && ctx.ship.cargo.length > 0) {
      logWarn(ctx, "falling back to selling remaining cargo");
      const sellResult = await sellAllCargo(ctx);
      return { totalEarned: sellResult.totalEarned, items: [...items, ...sellResult.items] };
    }
    return { totalEarned: 0, items };
  }

  // Default: sell
  return sellAllCargo(ctx);
}

// ── Emergency ──

/**
 * Check if fuel is critically low and handle emergency.
 * Tries: burn cargo cells → dock at current → navigate to station.
 * Returns true if emergency action was taken.
 */
export async function handleFuelEmergency(ctx: BotContext): Promise<boolean> {
  const level = ctx.fuel.getLevel(ctx.ship);
  if (level !== "critical" && level !== "low") return false;

  logWarn(ctx, `fuel emergency (${level}) at ${ctx.player.currentSystem}/${ctx.player.currentPoi ?? "space"}, fuel=${ctx.fuel.getPercentage(ctx.ship).toFixed(0)}%`);

  // If docked, just refuel
  if (ctx.player.dockedAtBase) {
    try {
      await ctx.api.refuel();
      log(ctx, "emergency refuel at station");
    } catch (err) {
      logWarn(ctx, `emergency refuel failed: ${err instanceof Error ? err.message : err}`);
    }
    await ctx.refreshState();
    return true;
  }

  // Try burning fuel cells from cargo first (works anywhere)
  const burned = await burnFuelCells(ctx);
  if (burned) {
    log(ctx, "burned fuel cells in emergency");
    await ctx.refreshState();
    const newLevel = ctx.fuel.getLevel(ctx.ship);
    if (newLevel !== "critical" && newLevel !== "low") return true;
  }

  // Refresh system data so we know which POIs have bases
  await ensureSystemDetail(ctx);

  // Try docking at current POI (only if it has a base)
  if (ctx.station.canDock(ctx.player)) {
    try {
      log(ctx, "emergency docking at current POI");
      await ctx.api.dock();
      await ctx.refreshState();
      if (ctx.player.dockedAtBase) {
        try { await ctx.api.refuel(); } catch { /* tank_full */ }
        await ctx.refreshState();
        return true;
      }
    } catch (err) {
      logWarn(ctx, `emergency dock failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Only attempt navigation if we have ENOUGH fuel (>10%) — don't burn last drops
  const fuelPct = ctx.fuel.getPercentage(ctx.ship);
  if (fuelPct > 10) {
    const nearest = ctx.station.chooseDockTarget(ctx.player, ctx.ship);
    if (nearest && nearest.systemId === ctx.player.currentSystem) {
      // Only travel within current system — don't attempt jumps on critical fuel
      try {
        log(ctx, `emergency travel to nearest station: ${nearest.poiId}`);
        await ctx.api.travel(nearest.poiId);
        await ctx.refreshState();
        await dockAtCurrent(ctx);
        return true;
      } catch (err) {
        logError(ctx, `emergency travel failed`, err);
      }
    }
  }

  // Stranded — stop the routine so commander can reassign (and rescue can find us)
  logError(ctx, `STRANDED at ${ctx.player.currentSystem} with ${fuelPct.toFixed(0)}% fuel — waiting for rescue`);
  return false;
}

/**
 * Check if ship needs emergency repair.
 */
export function needsEmergencyRepair(ctx: BotContext): boolean {
  return (ctx.ship.hull / ctx.ship.maxHull) * 100 < 25;
}

/**
 * Full safety check - returns a reason string if unsafe, null if ok.
 * Triggers at low fuel (<30%) and critical hull (<25%).
 * Proactive fuel safety is handled by ensureFuelSafety() before undocking.
 */
export function safetyCheck(ctx: BotContext): string | null {
  const fuelLevel = ctx.fuel.getLevel(ctx.ship);
  if (fuelLevel === "critical") return "fuel_critical";
  if (fuelLevel === "low") return "fuel_low";
  if (needsEmergencyRepair(ctx)) return "hull_critical";
  return null;
}

/**
 * Handle any emergency condition by docking and servicing.
 * If not at a station, navigates to the nearest one.
 * Returns true if emergency was handled.
 */
export async function handleEmergency(ctx: BotContext): Promise<boolean> {
  const issue = safetyCheck(ctx);
  if (!issue) return false;

  logWarn(ctx, `emergency: ${issue}`);

  // If already docked, just service
  if (ctx.player.dockedAtBase) {
    log(ctx, "servicing at current station for emergency");
    await serviceShip(ctx);
    return true;
  }

  // Refresh system data so we know which POIs have bases
  await ensureSystemDetail(ctx);

  // Try to dock at current POI (only if it has a base)
  if (ctx.station.canDock(ctx.player)) {
    try {
      log(ctx, "emergency: attempting dock at current POI");
      await ctx.api.dock();
      await ctx.refreshState();
      if (ctx.player.dockedAtBase) {
        await serviceShip(ctx);
        return true;
      }
    } catch (err) {
      logWarn(ctx, `emergency dock failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Navigate to nearest station (with fresh POI data)
  const target = ctx.station.chooseDockTarget(ctx.player, ctx.ship);
  if (target) {
    try {
      log(ctx, `emergency: navigating to ${target.systemId}/${target.poiId}`);
      await navigateTo(ctx, target.systemId, target.poiId);
      await dockAtCurrent(ctx);
      return true;
    } catch (err) {
      logError(ctx, `emergency navigation failed`, err);
    }
  }

  logError(ctx, `emergency unresolved: ${issue} — bot may be stranded`);
  return false;
}

// ── Mining ──

/**
 * Mine until cargo is full or resource is depleted.
 * Yields state labels for each mining cycle.
 */
export async function* mineUntilFull(
  ctx: BotContext,
  targetOre?: string
): AsyncGenerator<string, MiningYield | null, void> {
  let mineCount = 0;
  while (!ctx.shouldStop && ctx.cargo.hasSpace(ctx.ship, 1)) {
    try {
      const result = await ctx.api.mine();
      mineCount++;
      if (mineCount % 5 === 0 || result.quantity === 0 || result.remaining === 0) {
        await ctx.refreshState();
      }

      if (result.quantity === 0 || result.remaining === 0) {
        yield `resource depleted`;
        return null;
      }

      yield `mined ${result.quantity} ${result.resourceId}`;
    } catch (err) {
      yield `mining error: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
  }
  if (mineCount > 0) await ctx.refreshState();

  yield "cargo full";
  return null;
}

// ── Utility ──

// ── Market Data ──

/**
 * Aggregate MarketOrder[] into MarketPrice[] and cache for the station.
 * Call this whenever a routine fetches market orders to feed the market pipeline.
 */
export function cacheMarketData(ctx: BotContext, stationId: string, orders: MarketOrder[]): void {
  if (!stationId || orders.length === 0) return;

  // Group orders by item
  const byItem = new Map<string, { name: string; sells: { price: number; qty: number }[]; buys: { price: number; qty: number }[] }>();

  for (const order of orders) {
    if (!byItem.has(order.itemId)) {
      byItem.set(order.itemId, { name: order.itemName, sells: [], buys: [] });
    }
    const bucket = byItem.get(order.itemId)!;
    if (order.type === "sell") {
      bucket.sells.push({ price: order.priceEach, qty: order.quantity });
    } else {
      bucket.buys.push({ price: order.priceEach, qty: order.quantity });
    }
  }

  const prices: MarketPrice[] = [];
  for (const [itemId, data] of byItem) {
    prices.push({
      itemId,
      itemName: data.name,
      buyPrice: data.sells.length > 0 ? Math.min(...data.sells.map((s) => s.price)) : null,
      sellPrice: data.buys.length > 0 ? Math.max(...data.buys.map((b) => b.price)) : null,
      buyVolume: data.sells.reduce((sum, s) => sum + s.qty, 0),
      sellVolume: data.buys.reduce((sum, b) => sum + b.qty, 0),
    });
  }

  ctx.cache.setMarketPrices(stationId, prices, Math.floor(Date.now() / 1000));
}

/**
 * Record a successful sell as a demand signal in the market cache.
 * NPC demand doesn't appear in view_market, so we enrich the cache
 * with actual sell results to help arbitrage discovery.
 */
export function recordSellResult(
  ctx: BotContext, stationId: string, itemId: string, itemName: string,
  priceEach: number, quantity: number,
): void {
  if (!stationId || !itemId || priceEach <= 0 || quantity <= 0) return;

  const existing = ctx.cache.getMarketPrices(stationId) ?? [];
  const entry = existing.find((p) => p.itemId === itemId);
  if (entry) {
    // Update sell price (demand) if our actual result is better data
    if (!entry.sellPrice || priceEach > 0) {
      entry.sellPrice = priceEach;
      entry.sellVolume = Math.max(entry.sellVolume, quantity);
    }
  } else {
    // Add new item to cache — we know there's demand here
    existing.push({
      itemId,
      itemName,
      buyPrice: null,
      sellPrice: priceEach,
      buyVolume: 0,
      sellVolume: quantity,
    });
  }
  ctx.cache.setMarketPrices(stationId, existing, Math.floor(Date.now() / 1000));
}

/**
 * Optimistic market update: adjust cached volumes after a buy or sell.
 * Prevents other bots from targeting the same depleted supply/demand.
 * Call after a successful buy() or sell() API call.
 *
 * action "buy": we bought from sell orders → reduce buyVolume (available supply)
 * action "sell": we sold into buy orders → reduce sellVolume (available demand)
 */
export function adjustMarketCache(
  ctx: BotContext, stationId: string, itemId: string,
  action: "buy" | "sell", quantity: number,
  opts?: { zeroDemand?: boolean },
): void {
  if (!stationId || !itemId || quantity <= 0) return;
  const prices = ctx.cache.getMarketPrices(stationId);
  if (!prices) return;

  const entry = prices.find((p) => p.itemId === itemId);
  if (!entry) return;

  if (action === "buy") {
    // We bought from sell orders → less supply available
    entry.buyVolume = Math.max(0, entry.buyVolume - quantity);
  } else {
    // We sold into buy orders → less demand available
    entry.sellVolume = Math.max(0, entry.sellVolume - quantity);
    // Zero out sell price when confirmed no demand (prevents stale arbitrage rediscovery)
    if (opts?.zeroDemand) {
      entry.sellPrice = 0;
      entry.sellVolume = 0;
    }
  }

  ctx.cache.setMarketPrices(stationId, prices, Math.floor(Date.now() / 1000));
}

/**
 * Get a typed param from context with a default.
 */
export function getParam<T>(ctx: BotContext, key: string, defaultValue: T): T {
  const val = ctx.params[key];
  return val !== undefined ? (val as T) : defaultValue;
}

/**
 * Sleep for a duration, respecting shouldStop.
 */
export async function interruptibleSleep(ctx: BotContext, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ctx.shouldStop) return false;
    await new Promise((r) => setTimeout(r, Math.min(1000, ms - (Date.now() - start))));
  }
  return true;
}

// ── Module Equipment ──

/**
 * Equip/unequip modules for a routine. Handles docking if needed, withdraws from
 * faction storage, and yields progress messages. Caches faction storage lookup.
 *
 * Returns an async generator of status messages (yields).
 */
export async function* equipModulesForRoutine(
  ctx: BotContext,
  equipModules: string[],
  unequipModules: string[] = [],
): AsyncGenerator<string, void, void> {
  if (equipModules.length === 0 && unequipModules.length === 0) return;

  // Dock if not already docked
  const wasDocked = !!ctx.player.dockedAtBase;
  if (!wasDocked) {
    try {
      await findAndDock(ctx);
    } catch {
      yield "could not dock for module equip — continuing without";
      return;
    }
  }

  // Unequip modules that aren't needed
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

  // Equip modules — single faction storage fetch for all lookups
  let factionStorage: Array<{ itemId: string; quantity: number }> | null = null;
  for (const modPattern of equipModules) {
    if (ctx.shouldStop) return;
    // Already equipped?
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
    // Withdraw from faction storage (cached lookup)
    try {
      if (!factionStorage) {
        factionStorage = await ctx.api.viewFactionStorage() ?? [];
      }
      const mod = factionStorage.find((s) => s.itemId.includes(modPattern) && s.quantity > 0);
      if (mod) {
        await ctx.api.factionWithdrawItems(mod.itemId, 1);
        await ctx.refreshState();
        // Decrement cached quantity
        mod.quantity--;
        yield `withdrew ${mod.itemId} from faction storage`;
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
      } else {
        yield `no ${modPattern} in faction storage — continuing without`;
      }
    } catch (err) {
      yield `module withdraw failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Undock if we docked just for equipping
  if (!wasDocked && ctx.player.dockedAtBase) {
    await ctx.api.undock();
    await ctx.refreshState();
  }
}

// ── Faction Treasury ──

/**
 * Deposit a percentage of earned credits into faction treasury.
 * Call after a profitable sell. Returns the amount deposited, or 0 if skipped.
 * Must be docked to deposit.
 */
export async function payFactionTax(ctx: BotContext, earned: number): Promise<{ deposited: number; message: string }> {
  const pct = ctx.fleetConfig.factionTaxPercent;
  if (pct <= 0 || earned <= 0 || !ctx.player.dockedAtBase) {
    return { deposited: 0, message: "" };
  }

  const taxAmount = Math.floor(earned * pct / 100);
  if (taxAmount <= 0) return { deposited: 0, message: "" };

  try {
    await ctx.api.factionDepositCredits(taxAmount);
    await ctx.refreshState();
    return { deposited: taxAmount, message: `faction tax: deposited ${taxAmount}cr (${pct}%)` };
  } catch (err) {
    log(ctx, `faction tax failed: ${err instanceof Error ? err.message : String(err)}`);
    return { deposited: 0, message: "" };
  }
}

/**
 * Withdraw credits from faction treasury if bot is below minimum.
 * Call at the end of a cycle when docked. Returns amount withdrawn.
 */
export async function ensureMinCredits(ctx: BotContext): Promise<{ withdrawn: number; message: string }> {
  const minCredits = ctx.fleetConfig.minBotCredits;
  if (minCredits <= 0 || !ctx.player.dockedAtBase) {
    return { withdrawn: 0, message: "" };
  }

  const deficit = minCredits - ctx.player.credits;
  if (deficit <= 0) return { withdrawn: 0, message: "" };

  try {
    await ctx.api.factionWithdrawCredits(deficit);
    await ctx.refreshState();
    ctx.recordFactionWithdrawal(deficit); // Exclude from revenue tracking
    return { withdrawn: deficit, message: `withdrew ${deficit}cr from faction treasury (credits were below ${minCredits}cr minimum)` };
  } catch (err) {
    log(ctx, `faction withdraw failed: ${err instanceof Error ? err.message : String(err)}`);
    return { withdrawn: 0, message: "" };
  }
}
