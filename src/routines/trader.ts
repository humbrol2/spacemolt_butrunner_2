/**
 * Trader routine - buy low at one station, sell high at another.
 *
 * Smart trading:
 * 1. Scans market at buy station, finds items with known profitable sell targets
 * 2. Calculates max buy quantity (cargo space + credits)
 * 3. Only buys when profit margin is confirmed
 * 4. Scans sell station market to verify prices before selling
 *
 * Params:
 *   buyStation: string      - Base ID to buy from (auto-discovered if empty)
 *   sellStation: string     - Base ID to sell at (auto-discovered if empty)
 *   item: string            - Item ID to trade (auto-discovered if empty)
 *   maxBuyPrice?: number    - Don't pay more than this
 *   minSellPrice?: number   - Don't accept less than this
 *   maxRoundTrips?: number  - Max trips before yielding cycle_complete
 *   useOrders?: boolean     - Place market orders instead of instant buy/sell
 */

import type { BotContext } from "../bot/types";
import type { MarketOrder } from "../types/game";
import {
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
  sellAllCargo,
  cacheMarketData,
  isProtectedItem,
  recordSellResult,
  adjustMarketCache,
  payFactionTax,
  ensureMinCredits,
  interruptibleSleep,
} from "./helpers";

/** Resolve current station name for chat messages */
function getStationName(ctx: BotContext): string {
  const baseId = ctx.player.dockedAtBase;
  if (!baseId) return "";
  const systemId = ctx.galaxy.getSystemForBase(baseId);
  if (!systemId) return baseId;
  const sys = ctx.galaxy.getSystem(systemId);
  const poi = sys?.pois.find((p) => p.baseId === baseId);
  return poi?.baseName ?? poi?.name ?? baseId;
}

/**
 * Find an alternate station to sell cargo at, using cached market data.
 * Scores stations by total expected revenue for items currently in cargo,
 * skipping the failed station. Returns the best reachable station base ID or null.
 */
function findAlternateBuyer(ctx: BotContext, failedStation: string): string | null {
  const cargoItems = ctx.ship.cargo.filter((c) => c.itemId !== "fuel_cell" && c.quantity > 0);
  if (cargoItems.length === 0) return null;

  const freshStations = ctx.cache.getAllMarketFreshness();
  let bestStation = "";
  let bestRevenue = 0;

  for (const { stationId } of freshStations) {
    if (stationId === failedStation) continue;
    const prices = ctx.cache.getMarketPrices(stationId);
    if (!prices) continue;

    let revenue = 0;
    for (const cargo of cargoItems) {
      const price = prices.find((p) => p.itemId === cargo.itemId);
      if (price?.sellPrice && price.sellPrice > 0) {
        revenue += price.sellPrice * cargo.quantity;
      }
    }

    if (revenue > bestRevenue) {
      bestRevenue = revenue;
      bestStation = stationId;
    }
  }

  return bestStation || null;
}

export async function* trader(ctx: BotContext): AsyncGenerator<string, void, void> {
  let buyStation = getParam(ctx, "buyStation", "");
  let sellStation = getParam(ctx, "sellStation", "");
  let item = getParam(ctx, "item", "");
  let maxBuyPrice = getParam(ctx, "maxBuyPrice", Infinity);
  let minSellPrice = getParam(ctx, "minSellPrice", 0);
  const maxRoundTrips = getParam(ctx, "maxRoundTrips", Infinity);
  const useOrders = getParam(ctx, "useOrders", false);
  const sellFromFaction = getParam(ctx, "sellFromFaction", false);

  // Guard: traders don't trade ores (miners handle those via supply chain)
  if (item && item.startsWith("ore_")) {
    yield `skipping ore trade (${item}) — miners handle ores`;
    item = ""; // Force auto-discovery of non-ore items
  }

  // ── Faction supply chain mode ──
  // Withdraw crafted goods from faction storage and sell at best station
  if (sellFromFaction) {
    yield* factionSellLoop(ctx, maxRoundTrips);
    return;
  }

  // ── Check faction storage for free sellable goods before buying ──
  // Faction items cost nothing to acquire — any confirmed sell price is pure profit.
  // viewFactionStorage requires docking, so this only fires when the bot is currently docked.
  {
    const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
    if (factionStation) {
      try {
        const storage = await ctx.api.viewFactionStorage();
        const sellableItems = (storage ?? [])
          .filter((s: { itemId: string; quantity: number }) => s.quantity > 0 && !s.itemId.startsWith("ore_"));

        if (sellableItems.length > 0) {
          // Check if faction goods have enough total value to justify a sell trip
          const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
          let bestTotalValue = 0;
          let bestItemName = "";
          let bestItemQty = 0;
          let bestItemPrice = 0;
          for (const si of sellableItems) {
            for (const stationId of cachedStationIds) {
              if (stationId === factionStation) continue;
              const prices = ctx.cache.getMarketPrices(stationId);
              const sellPrice = prices?.find((p) => p.itemId === si.itemId)?.sellPrice ?? 0;
              const totalValue = sellPrice * si.quantity;
              if (totalValue > bestTotalValue) {
                bestTotalValue = totalValue;
                bestItemName = ctx.crafting.getItemName(si.itemId);
                bestItemQty = si.quantity;
                bestItemPrice = sellPrice;
              }
            }
          }
          // Only divert to faction sell if total value justifies the trip (>500cr)
          if (bestTotalValue >= 500) {
            yield `faction has ${bestItemQty} ${bestItemName} sellable @${bestItemPrice}cr (~${bestTotalValue}cr total) — selling free goods first`;
            yield* factionSellLoop(ctx, maxRoundTrips);
            return;
          }
        }
      } catch {
        // viewFactionStorage may fail if not docked or not in a faction — continue normally
      }
    }
  }

  // ── Auto-discover trade routes (ranked by profitability) ──
  type CandidateRoute = { itemId: string; itemName: string; buyStation: string; sellStation: string; buyPrice: number; sellPrice: number; profitPerUnit: number; volume: number; jumps: number };
  const candidateRoutes: CandidateRoute[] = [];

  if (!buyStation || !sellStation || !item) {
    yield "discovering trade routes...";

    // Use Commander's cached market data to find arbitrage
    const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
    if (cachedStationIds.length >= 2) {
      const routes = ctx.market.findArbitrage(cachedStationIds, ctx.player.currentSystem, ctx.cargo.freeSpace(ctx.ship))
        .filter((r) => !r.itemId.startsWith("ore_")); // Traders don't trade ores
      for (const r of routes) {
        candidateRoutes.push({
          itemId: r.itemId, itemName: r.itemName,
          buyStation: r.buyStationId, sellStation: r.sellStationId,
          buyPrice: r.buyPrice, sellPrice: r.sellPrice,
          profitPerUnit: r.profitPerUnit, volume: r.volume, jumps: r.jumps,
        });
      }
      if (candidateRoutes.length > 0) {
        yield `found ${candidateRoutes.length} potential route(s)`;
      }
    }

    // Use best route initially
    if (candidateRoutes.length > 0) {
      const best = candidateRoutes[0];
      if (!item) item = best.itemId;
      if (!buyStation) buyStation = best.buyStation;
      if (!sellStation) sellStation = best.sellStation;
      maxBuyPrice = best.buyPrice;
      minSellPrice = best.sellPrice * 0.9;
      yield `route 1/${candidateRoutes.length}: buy ${best.itemName} @${best.buyPrice}cr → sell @${best.sellPrice}cr (+${best.profitPerUnit}cr/unit, ${best.volume > 0 ? best.volume + " avail" : "?"}, ${best.jumps} jump${best.jumps !== 1 ? "s" : ""})`;
    }

    // Fallback: scan local market if docked — but only if there's a second station to sell at
    if ((!buyStation || !item) && ctx.player.dockedAtBase) {
      // Check for a sell station FIRST — no point picking items with nowhere to sell
      const system = await ctx.api.getSystem();
      const otherStations = system.pois.filter((p) => p.hasBase && p.baseId !== ctx.player.dockedAtBase);

      if (otherStations.length === 0) {
        yield "only one station in system, cannot trade locally";
      } else {
        const market = await ctx.api.viewMarket();
        if (market.length > 0) {
          cacheMarketData(ctx, ctx.player.dockedAtBase, market);

          if (!buyStation) {
            buyStation = ctx.player.dockedAtBase;
          }

          // Pick a tradeable item — skip ores (miners handle those), prefer high margins
          if (!item) {
            const sellOrders = market
              .filter((m) => m.type === "sell" && m.quantity > 0 && m.priceEach > 0 && !m.itemId.startsWith("ore_"))
              .sort((a, b) => b.priceEach - a.priceEach); // Most expensive first

            // If we have cached data for any sell station, prefer items with confirmed demand there
            const sellStationId = otherStations[0]?.baseId;
            if (sellStationId) {
              const sellStationPrices = ctx.cache.getMarketPrices(sellStationId);
              if (sellStationPrices) {
                // Items that have buy orders (demand) at the sell station, ranked by margin
                const withDemand = sellOrders
                  .map((o) => {
                    const sellData = sellStationPrices.find((p) => p.itemId === o.itemId);
                    const sellPrice = sellData?.sellPrice ?? 0; // Best bid at destination
                    const margin = sellPrice - o.priceEach;
                    return { order: o, margin, sellPrice };
                  })
                  .filter((x) => x.margin > 0)
                  .sort((a, b) => b.margin - a.margin);

                if (withDemand.length > 0) {
                  const best = withDemand[0];
                  item = best.order.itemId;
                  yield `trading: ${best.order.itemName} (margin +${best.margin}cr/unit)`;
                }
              }
            }

            // No demand-verified pick — do NOT buy without confirmed sell price
            if (!item) {
              yield "no items with confirmed profitable sell destination";
            }
          }
        }

        // Set sell station from discovered other stations
        if (!sellStation && otherStations.length > 0 && otherStations[0].baseId) {
          sellStation = otherStations[0].baseId;
          yield `sell at: ${otherStations[0].baseName ?? otherStations[0].name}`;
        }
      }
    }
  }

  // If we still can't figure out a route, sell cargo and wait for market data
  if (!buyStation || !sellStation || !item) {
    yield "no trade route found — waiting for market data";
    if (ctx.ship.cargo.length > 0) {
      try {
        if (!ctx.player.dockedAtBase) await findAndDock(ctx);
        if (ctx.player.dockedAtBase) {
          const sellResult = await sellAllCargo(ctx);
          for (const s of sellResult.items) {
            yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
          }
          yield `sold cargo for ${sellResult.totalEarned} credits`;
        }
      } catch {}
    }
    await refuelIfNeeded(ctx);
    await interruptibleSleep(ctx, 120_000);
    yield "cycle_complete";
    return;
  }

  let tripCount = 0;
  let lastBuyPrice = 0; // Track what we paid to verify profit at sell station
  let routeIndex = 0; // Track which candidate route we're on

  while (!ctx.shouldStop && tripCount < maxRoundTrips) {
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

    // ── Navigate to buy station ──
    yield "traveling to buy station";
    try {
      await navigateAndDock(ctx, buyStation);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    if (ctx.shouldStop) return;

    // ── Scan market at buy station ──
    let buyOrders: MarketOrder[] = [];
    try {
      const market = await ctx.api.viewMarket();
      if (market.length > 0) {
        cacheMarketData(ctx, buyStation, market);
      }
      // Find sell orders for our item (these are what we can buy)
      buyOrders = market.filter(
        (m) => m.type === "sell" && m.itemId === item && m.quantity > 0
      );
    } catch (err) {
      yield `market scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // ── Buy goods ──
    let freeWeight = ctx.cargo.freeSpace(ctx.ship);

    // If cargo is full of non-trade items (leftover from previous routine), dispose them
    if (freeWeight <= 0 && ctx.cargo.getItemQuantity(ctx.ship, item) === 0) {
      const otherItems = ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId) && c.itemId !== item);
      if (otherItems.length > 0 && ctx.player.dockedAtBase) {
        yield `disposing ${otherItems.length} leftover item(s) blocking cargo`;
        for (const other of otherItems) {
          let disposed = false;

          // Try sell first (earns credits)
          try {
            const result = await ctx.api.sell(other.itemId, other.quantity);
            await ctx.refreshState();
            if (result.total > 0) {
              yield `sold ${result.quantity} ${other.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
              disposed = true;
            }
          } catch (err) {
            yield `sell failed for ${other.itemId}: ${err instanceof Error ? err.message : String(err)}`;
          }

          // Try faction deposit if sell didn't work
          if (!disposed) {
            try {
              await ctx.api.factionDepositItems(other.itemId, other.quantity);
              await ctx.refreshState();
              yield `deposited ${other.quantity} ${other.itemId} to faction storage`;
              disposed = true;
            } catch (err) {
              yield `deposit failed for ${other.itemId}: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          // Try personal storage deposit as last resort
          if (!disposed) {
            try {
              await ctx.api.depositItems(other.itemId, other.quantity);
              await ctx.refreshState();
              yield `stored ${other.quantity} ${other.itemId} in personal storage`;
              disposed = true;
            } catch (err) {
              yield `storage failed for ${other.itemId}: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          if (!disposed) {
            yield `WARNING: cannot dispose ${other.quantity} ${other.itemId} — stuck in cargo`;
          }
        }
        freeWeight = ctx.cargo.freeSpace(ctx.ship);
      }
    }

    if (freeWeight <= 0) {
      yield "no cargo space, skipping buy";
    } else {
      // Calculate safe buy quantity: limited by cargo weight, credits, AND item size
      const bestPrice = buyOrders.length > 0 ? buyOrders[0].priceEach : 0;
      const availableQty = buyOrders.reduce((sum, o) => sum + o.quantity, 0);
      // Get item size (weight per unit) from cargo if we already have some, else default 1
      const itemSize = ctx.cargo.getItemSize(ctx.ship, item);

      // Pre-buy profit check: REQUIRE known sell price > buy price
      const sellStationPrices = ctx.cache.getMarketPrices(sellStation);
      const expectedSellPrice = sellStationPrices?.find((p) => p.itemId === item)?.sellPrice ?? 0;
      const noSellData = expectedSellPrice <= 0;
      const wouldLose = bestPrice > 0 && (noSellData || expectedSellPrice < bestPrice);

      if (buyOrders.length === 0) {
        yield `no sell orders for ${item} at this station, skipping buy`;
      } else if (bestPrice <= 0) {
        yield `${item} listed at 0cr, skipping buy`;
      } else if (bestPrice > maxBuyPrice && maxBuyPrice < Infinity) {
        yield `price too high (${bestPrice} > max ${maxBuyPrice}), skipping buy`;
      } else if (wouldLose) {
        yield noSellData
          ? `no sell price data for ${item} at sell station, skipping (won't buy blind)`
          : `unprofitable: buy ${bestPrice}cr > sell ${expectedSellPrice}cr for ${item}, skipping`;
      } else {
        // Weight-aware: divide free cargo weight by per-unit size
        let buyQty = Math.floor(freeWeight / Math.max(1, itemSize));
        if (bestPrice > 0) {
          // Spend cap: don't risk more than 50% of credits on a single trade
          const spendCap = Math.floor(ctx.player.credits * 0.50);
          const maxByCredits = Math.floor(spendCap / bestPrice);
          buyQty = Math.min(buyQty, maxByCredits, availableQty || buyQty);
        }
        // Cap by known sell demand volume — don't buy more than we can sell
        const sellDemandVol = sellStationPrices?.find((p) => p.itemId === item)?.sellVolume ?? 0;
        if (sellDemandVol > 0) {
          buyQty = Math.min(buyQty, sellDemandVol);
        }

        if (buyQty <= 0) {
          yield `cannot afford ${item} (${bestPrice}cr each, have ${ctx.player.credits}cr)`;
        } else {
          yield `buying ${buyQty} ${item}${bestPrice > 0 ? ` @ ${bestPrice}cr` : ""}${itemSize > 1 ? ` (size ${itemSize}/unit)` : ""}`;
          try {
            if (useOrders) {
              // Place a buy order at a specific price
              const orderPrice = maxBuyPrice < Infinity ? maxBuyPrice : bestPrice;
              if (orderPrice <= 0) {
                yield "cannot place order without price data";
              } else {
                await ctx.api.createBuyOrder(item, buyQty, orderPrice);
                yield `buy order placed: ${buyQty}x @ ${orderPrice}cr`;
                try { const stn = getStationName(ctx); await ctx.api.chat("system", `Buying ${buyQty}x ${item} @ ${orderPrice}cr${stn ? ` at ${stn}` : ""}`); } catch { /* best effort */ }
              }
            } else {
              const cargoBefore = ctx.cargo.getItemQuantity(ctx.ship, item);
              const result = await ctx.api.buy(item, buyQty);
              await ctx.refreshState();
              // Verify purchase landed in cargo
              const cargoAfter = ctx.cargo.getItemQuantity(ctx.ship, item);
              const actualReceived = cargoAfter - cargoBefore;
              if (result.quantity > 0 && actualReceived <= 0) {
                yield `buy warning: API reports ${result.quantity} bought but cargo unchanged (before=${cargoBefore}, after=${cargoAfter})`;
              }
              // API sometimes returns 0 for priceEach — use expected price as fallback
              const actualPrice = result.priceEach > 0 ? result.priceEach : bestPrice;
              const actualTotal = result.total > 0 ? result.total : result.quantity * actualPrice;
              lastBuyPrice = actualPrice;
              // Optimistic update: reduce cached supply so other bots don't target same stock
              adjustMarketCache(ctx, buyStation, item, "buy", actualReceived > 0 ? actualReceived : result.quantity);
              yield `bought ${actualReceived > 0 ? actualReceived : result.quantity} ${item} @ ${actualPrice}cr each (${actualTotal}cr)`;
            }
          } catch (err) {
            yield `buy failed: ${err instanceof Error ? err.message : String(err)}`;
            // Continue to sell what we already have
          }
        }
      }
    }

    if (ctx.shouldStop) return;

    // ── Navigate to sell station ──
    const cargoQty = ctx.cargo.getItemQuantity(ctx.ship, item);
    if (cargoQty === 0) {
      // Opportunistic buy: we're already at this station, scan for anything profitable here
      if (ctx.player.dockedAtBase) {
        const localMarket = await ctx.api.viewMarket();
        if (localMarket.length > 0) {
          cacheMarketData(ctx, ctx.player.dockedAtBase, localMarket);
          const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
          const freeWeight = ctx.cargo.freeSpace(ctx.ship);
          // Find anything here we can buy profitably
          for (const order of localMarket.filter((m) => m.type === "sell" && m.quantity > 0 && m.priceEach > 0 && !m.itemId.startsWith("ore_"))) {
            for (const sid of cachedStationIds) {
              if (sid === ctx.player.dockedAtBase) continue;
              const prices = ctx.cache.getMarketPrices(sid);
              const sellData = prices?.find((p) => p.itemId === order.itemId);
              if (sellData?.sellPrice && sellData.sellPrice > order.priceEach) {
                const profit = sellData.sellPrice - order.priceEach;
                const itemSize = ctx.cargo.getItemSize(ctx.ship, order.itemId);
                const spendCap = Math.floor(ctx.player.credits * 0.50);
                const maxQty = Math.min(
                  Math.floor(freeWeight / Math.max(1, itemSize)),
                  Math.floor(spendCap / order.priceEach),
                  order.quantity,
                );
                if (maxQty > 0 && profit * maxQty > 100) { // Only if total profit > 100cr
                  yield `opportunistic: buying ${maxQty} ${order.itemName ?? order.itemId} (+${profit}cr/unit)`;
                  try {
                    await ctx.api.buy(order.itemId, maxQty);
                    await ctx.refreshState();
                    item = order.itemId;
                    sellStation = sid;
                    lastBuyPrice = order.priceEach;
                    break;
                  } catch { /* continue looking */ }
                }
              }
            }
            if (ctx.cargo.getItemQuantity(ctx.ship, item) > 0) break;
          }
        }
      }

      // If opportunistic buy didn't land anything, try next candidate route
      if (ctx.cargo.getItemQuantity(ctx.ship, item) === 0) {
        routeIndex++;
        if (routeIndex < candidateRoutes.length) {
          const next = candidateRoutes[routeIndex];
          yield `route ${routeIndex}/${candidateRoutes.length} unprofitable, trying next: ${next.itemName} (+${next.profitPerUnit}cr/unit)`;
          item = next.itemId;
          buyStation = next.buyStation;
          sellStation = next.sellStation;
          maxBuyPrice = next.buyPrice;
          minSellPrice = next.sellPrice * 0.9;
          continue; // Re-enter loop with new route
        }
        yield "no profitable routes found — waiting for new opportunities";
        await refuelIfNeeded(ctx);
        await interruptibleSleep(ctx, 120_000);
        yield "cycle_complete";
        return;
      }
    }

    yield "traveling to sell station";
    try {
      await navigateAndDock(ctx, sellStation);
    } catch (err) {
      yield `navigation to sell station failed: ${err instanceof Error ? err.message : String(err)}`;
      // Find an alternate buyer from cached market data
      const altStation = findAlternateBuyer(ctx, sellStation);
      if (altStation) {
        yield `rerouting to alternate buyer: ${altStation}`;
        try {
          await navigateAndDock(ctx, altStation);
          // Fall through to normal sell logic below with the new station
          sellStation = altStation;
        } catch (altErr) {
          yield `alternate route also failed: ${altErr instanceof Error ? altErr.message : String(altErr)}`;
          // Last resort: sell at nearest reachable station
          try {
            await findAndDock(ctx);
            await sellAllCargo(ctx);
            await ctx.refreshState();
            yield "sold cargo at nearest station";
          } catch { yield "all sell attempts failed — cargo stranded"; }
          yield "cycle_complete";
          return;
        }
      } else {
        // No cached alternate — sell at nearest station
        yield "no alternate buyers known — selling at nearest station";
        try {
          await findAndDock(ctx);
          await sellAllCargo(ctx);
          await ctx.refreshState();
          yield "sold cargo at fallback station";
        } catch { yield "fallback sell failed — cargo stranded"; }
        yield "cycle_complete";
        return;
      }
    }

    if (ctx.shouldStop) return;

    // Track credits to calculate profit for faction tax
    const creditsBeforeSell = ctx.player.credits;

    // ── Scan sell station market & verify profit ──
    let sellMarketOrders: MarketOrder[] = [];
    try {
      sellMarketOrders = await ctx.api.viewMarket();
      if (sellMarketOrders.length > 0) {
        cacheMarketData(ctx, sellStation, sellMarketOrders);
      }
    } catch {}

    const qty = ctx.cargo.getItemQuantity(ctx.ship, item);
    if (qty > 0) {
      // Check if sell price is profitable vs what we paid
      const buyOrdersAtSell = sellMarketOrders.filter(
        (m) => m.type === "buy" && m.itemId === item && m.quantity > 0
      );
      const liveSellPrice = buyOrdersAtSell.length > 0
        ? Math.max(...buyOrdersAtSell.map((o) => o.priceEach))
        : 0;

      // If we know the buy price and the sell price would be a loss, return to faction storage
      if (lastBuyPrice > 0 && liveSellPrice > 0 && liveSellPrice < lastBuyPrice) {
        yield `unprofitable: paid ${lastBuyPrice}cr, sell price ${liveSellPrice}cr — returning goods to faction storage`;

        // Try faction deposit
        const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
        let deposited = false;

        // If we're at a station with faction storage, deposit directly
        if (ctx.player.dockedAtBase) {
          try {
            await ctx.api.factionDepositItems(item, qty);
            await ctx.refreshState();
            yield `deposited ${qty} ${item} to faction storage (saved from loss)`;
            deposited = true;
          } catch {
            // No faction storage here — travel to faction station
          }
        }

        // Travel to faction storage station if needed
        if (!deposited && factionStation && factionStation !== ctx.player.dockedAtBase) {
          try {
            yield `traveling to faction storage to deposit`;
            await navigateAndDock(ctx, factionStation);
            await ctx.api.factionDepositItems(item, qty);
            await ctx.refreshState();
            yield `deposited ${qty} ${item} to faction storage (saved from loss)`;
            deposited = true;
          } catch (err) {
            yield `faction deposit failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // If all deposit attempts fail, sell anyway (better than holding forever)
        if (!deposited) {
          yield `cannot deposit, selling at loss to avoid holding`;
          try {
            const result = await ctx.api.sell(item, qty);
            await ctx.refreshState();
            yield `sold ${result.quantity} ${item} @ ${result.priceEach}cr (total: ${result.total}cr) [LOSS]`;
          } catch (err) {
            yield `sell failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      } else {
        // ── Sell goods (profitable or no price data) ──
        yield `selling ${qty} ${item}`;
        try {
          if (useOrders) {
            const orderPrice = minSellPrice > 0 ? minSellPrice : undefined;
            if (orderPrice) {
              await ctx.api.createSellOrder(item, qty, orderPrice);
              yield `sell order placed: ${qty}x @ ${orderPrice}cr`;
              try { const stn = getStationName(ctx); await ctx.api.chat("system", `Selling ${qty}x ${item} @ ${orderPrice}cr${stn ? ` at ${stn}` : ""}`); } catch { /* best effort */ }
            } else {
              const result = await ctx.api.sell(item, qty);
              await ctx.refreshState();
              yield `sold ${result.quantity} ${item} @ ${result.priceEach}cr (total: ${result.total}cr)`;
            }
          } else {
            const cargoBeforeSell = ctx.cargo.getItemQuantity(ctx.ship, item);
            const creditsBefore = ctx.player.credits;
            const result = await ctx.api.sell(item, qty);
            await ctx.refreshState();
            const cargoAfterSell = ctx.cargo.getItemQuantity(ctx.ship, item);
            const creditsGained = ctx.player.credits - creditsBefore;

            // Detect actual sell even if API returns 0 (check credit change)
            const actuallySold = creditsGained > 0 || (cargoAfterSell < cargoBeforeSell);

            if (!actuallySold && result.priceEach === 0 && result.total === 0) {
              yield `no demand for ${item} at this station`;

              // Zero out cached sell price so arbitrage won't rediscover this route
              adjustMarketCache(ctx, sellStation, item, "sell", qty, { zeroDemand: true });

              // Try other stations with cached demand before dumping
              const remainingQty = ctx.cargo.getItemQuantity(ctx.ship, item);
              if (remainingQty > 0) {
                let soldElsewhere = false;
                const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
                for (const altStation of cachedStationIds) {
                  if (altStation === sellStation) continue;
                  const altPrices = ctx.cache.getMarketPrices(altStation);
                  const altSellPrice = altPrices?.find((p) => p.itemId === item)?.sellPrice ?? 0;
                  if (altSellPrice > 0 && (lastBuyPrice === 0 || altSellPrice >= lastBuyPrice)) {
                    yield `trying alternate station (sell @${altSellPrice}cr)`;
                    try {
                      await navigateAndDock(ctx, altStation);
                      const altResult = await ctx.api.sell(item, remainingQty);
                      await ctx.refreshState();
                      if (altResult.total > 0) {
                        yield `sold ${altResult.quantity} ${item} @ ${altResult.priceEach}cr at alternate station (total: ${altResult.total}cr)`;
                        recordSellResult(ctx, altStation, altResult.itemId || item, item, altResult.priceEach, altResult.quantity);
                        soldElsewhere = true;
                        break;
                      }
                    } catch {
                      // Try next station
                    }
                  }
                }

                // Last resort: deposit to faction storage
                if (!soldElsewhere) {
                  const finalQty = ctx.cargo.getItemQuantity(ctx.ship, item);
                  if (finalQty > 0 && ctx.player.dockedAtBase) {
                    try {
                      await ctx.api.factionDepositItems(item, finalQty);
                      await ctx.refreshState();
                      yield `deposited ${finalQty} ${item} to faction storage (no buyers found)`;
                    } catch {
                      // Not a faction storage station — will try next cycle
                    }
                  }
                }
              }
            } else {
              // Successful sell — use actual credit gain if API response was weird
              const soldQty = actuallySold && result.quantity === 0
                ? cargoBeforeSell - cargoAfterSell
                : result.quantity;
              const soldPrice = creditsGained > 0 && result.priceEach === 0
                ? Math.round(creditsGained / Math.max(1, soldQty))
                : result.priceEach;
              const soldTotal = creditsGained > 0 ? creditsGained : result.total;

              if (cargoAfterSell >= cargoBeforeSell && result.quantity > 0) {
                yield `sell warning: API reports ${result.quantity} sold but cargo unchanged (${cargoBeforeSell} → ${cargoAfterSell})`;
              }
              yield `sold ${soldQty} ${item} @ ${soldPrice}cr (total: ${soldTotal}cr)`;
              recordSellResult(ctx, sellStation, result.itemId || item, item, soldPrice, soldQty);
              adjustMarketCache(ctx, sellStation, item, "sell", soldQty);
            }
          }
        } catch (err) {
          yield `sell failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // Also sell any other cargo items we might have picked up
    if (ctx.ship.cargo.length > 0) {
      const otherItems = ctx.ship.cargo.filter((c) => c.itemId !== item && !isProtectedItem(c.itemId));
      for (const other of otherItems) {
        try {
          const result = await ctx.api.sell(other.itemId, other.quantity);
          await ctx.refreshState();
          if (result.quantity > 0 && result.total > 0) {
            yield `sold ${result.quantity} ${other.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
          }
        } catch {
          // Non-critical — some items may not be sellable here
        }
      }
    }

    // ── Multi-hop: buy something here for the return trip ──
    if (!ctx.shouldStop && ctx.player.dockedAtBase && ctx.cargo.freeSpace(ctx.ship) > 0) {
      const returnMarket = await ctx.api.viewMarket();
      if (returnMarket.length > 0) {
        cacheMarketData(ctx, sellStation, returnMarket);
        // Check if anything here sells for more at the buy station (or any known station)
        const freeWeight = ctx.cargo.freeSpace(ctx.ship);
        const cachedStations = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
        let bestReturnItem: { itemId: string; buyPrice: number; sellPrice: number; targetStation: string; qty: number; name: string } | null = null;
        let bestReturnProfit = 0;
        for (const order of returnMarket.filter((m) => m.type === "sell" && m.quantity > 0 && m.priceEach > 0 && !m.itemId.startsWith("ore_"))) {
          for (const sid of cachedStations) {
            if (sid === sellStation) continue;
            const prices = ctx.cache.getMarketPrices(sid);
            const sellData = prices?.find((p) => p.itemId === order.itemId);
            if (sellData?.sellPrice && sellData.sellPrice > order.priceEach) {
              const profitPerUnit = sellData.sellPrice - order.priceEach;
              const itemSize = ctx.cargo.getItemSize(ctx.ship, order.itemId);
              const returnSpendCap = Math.floor(ctx.player.credits * 0.50);
              const maxQty = Math.min(
                Math.floor(freeWeight / Math.max(1, itemSize)),
                Math.floor(returnSpendCap / order.priceEach),
                order.quantity,
              );
              const totalProfit = profitPerUnit * maxQty;
              if (totalProfit > bestReturnProfit && totalProfit > 100) {
                bestReturnProfit = totalProfit;
                bestReturnItem = { itemId: order.itemId, buyPrice: order.priceEach, sellPrice: sellData.sellPrice, targetStation: sid, qty: maxQty, name: order.itemName ?? order.itemId };
              }
            }
          }
        }
        if (bestReturnItem) {
          yield `multi-hop: buying ${bestReturnItem.qty} ${bestReturnItem.name} (+${bestReturnItem.sellPrice - bestReturnItem.buyPrice}cr/unit) for return trip`;
          try {
            await ctx.api.buy(bestReturnItem.itemId, bestReturnItem.qty);
            await ctx.refreshState();
            // Set up for next iteration to sell at the target station
            item = bestReturnItem.itemId;
            buyStation = sellStation;
            sellStation = bestReturnItem.targetStation;
            lastBuyPrice = bestReturnItem.buyPrice;
            maxBuyPrice = bestReturnItem.buyPrice;
            minSellPrice = bestReturnItem.sellPrice * 0.9;
          } catch (err) {
            yield `return buy failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }

    // ── Faction tax on profit ──
    const profit = ctx.player.credits - creditsBeforeSell;
    if (profit > 0) {
      const tax = await payFactionTax(ctx, profit);
      if (tax.message) yield tax.message;
    }

    // ── Ensure minimum credits ──
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;

    // ── Service ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    tripCount++;
    yield "cycle_complete";
  }

  if (tripCount >= maxRoundTrips) {
    yield `completed ${tripCount} round trips`;
  }
}

// ── Faction Supply Chain Selling ──

/**
 * Withdraw crafted goods from faction storage, sell at best station.
 * Flow: dock at faction station → check storage → withdraw most valuable → sell at station with demand
 */
async function* factionSellLoop(
  ctx: BotContext,
  maxTrips: number,
): AsyncGenerator<string, void, void> {
  let tripCount = 0;

  while (!ctx.shouldStop && tripCount < maxTrips) {
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // ── Navigate to faction storage station ──
    const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
    if (!factionStation) {
      yield "no faction storage station configured";
      yield "cycle_complete";
      return;
    }

    yield "traveling to faction storage";
    try {
      await navigateAndDock(ctx, factionStation);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      await interruptibleSleep(ctx, 60_000);
      yield "cycle_complete";
      continue;
    }

    if (ctx.shouldStop) return;

    // ── Check faction storage for valuable items ──
    let storageItems: Array<{ itemId: string; quantity: number }> = [];
    try {
      const storage = await ctx.api.viewFactionStorage();
      storageItems = (storage ?? [])
        .filter((s: { itemId: string; quantity: number }) => s.quantity > 0)
        .map((s: { itemId: string; quantity: number }) => ({ itemId: s.itemId, quantity: s.quantity }));
    } catch (err) {
      yield `faction storage check failed: ${err instanceof Error ? err.message : String(err)}`;
      yield "cycle_complete";
      return;
    }

    if (storageItems.length === 0) {
      yield "faction storage empty — waiting for crafters to produce";
      await interruptibleSleep(ctx, 120_000);
      yield "cycle_complete";
      continue;
    }

    // ── Pre-select sell station BEFORE withdrawing ──
    // Only consider items with KNOWN buyers (cached sellPrice > 0 at some station).
    // This prevents blind withdrawals that end up re-deposited.
    const cachedStations = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
    const nonOreStorage = storageItems.filter((s) => !s.itemId.startsWith("ore_") && s.quantity > 0);

    // Build a ranked list of stations by total revenue for items in storage
    const stationBids: Array<{
      stationId: string;
      revenue: number;
      jumps: number;
      items: Array<{ itemId: string; name: string; qty: number; price: number }>;
    }> = [];

    for (const stationId of cachedStations) {
      if (stationId === factionStation) continue;
      const prices = ctx.cache.getMarketPrices(stationId);
      if (!prices) continue;
      const sellSystemId = ctx.galaxy.getSystemForBase(stationId);
      const jumps = sellSystemId ? ctx.galaxy.getDistance(ctx.player.currentSystem, sellSystemId) : -1;
      if (jumps < 0) continue;

      const stationItems: typeof stationBids[0]["items"] = [];
      let revenue = 0;
      for (const si of nonOreStorage) {
        const priceData = prices.find((p) => p.itemId === si.itemId);
        if (priceData?.sellPrice && priceData.sellPrice > 0) {
          const qty = si.quantity;
          const total = priceData.sellPrice * qty;
          revenue += total;
          stationItems.push({ itemId: si.itemId, name: ctx.crafting.getItemName(si.itemId), qty, price: priceData.sellPrice });
        }
      }

      if (revenue <= 0) continue;
      const fuelCost = jumps * 2 * 15;
      const netRevenue = revenue - fuelCost;
      if (netRevenue >= 200) { // Minimum trip profit
        stationBids.push({ stationId, revenue: netRevenue, jumps, items: stationItems });
      }
    }

    stationBids.sort((a, b) => b.revenue - a.revenue);

    if (stationBids.length === 0) {
      yield "no known buyers for faction goods — waiting for market data";
      await interruptibleSleep(ctx, 300_000);
      yield "cycle_complete";
      continue;
    }

    // Use the top bid's items as what to withdraw (only items with confirmed buyers)
    const topBid = stationBids[0];
    const sellable = topBid.items.map((i) => ({
      itemId: i.itemId,
      quantity: i.qty,
      basePrice: i.price,
      name: i.name,
    }));

    yield `${stationBids.length} station(s) want our goods — best: ~${topBid.revenue}cr net (${topBid.jumps} jumps)`;

    // ── Free up cargo space if needed (leftover from previous routine) ──
    if (ctx.cargo.freeSpace(ctx.ship) <= 0 && ctx.ship.cargo.length > 0 && ctx.player.dockedAtBase) {
      yield "clearing cargo before faction withdrawal";
      for (const c of ctx.ship.cargo) {
        if (isProtectedItem(c.itemId)) continue;
        // Deposit to faction storage first (free, keeps goods in supply chain)
        try {
          await ctx.api.factionDepositItems(c.itemId, c.quantity);
          await ctx.refreshState();
          yield `deposited ${c.quantity} ${c.itemId} to faction storage`;
          continue;
        } catch { /* try sell */ }
        // Sell as fallback
        try {
          const result = await ctx.api.sell(c.itemId, c.quantity);
          await ctx.refreshState();
          if (result.total > 0) yield `sold ${result.quantity} ${c.itemId} @ ${result.priceEach}cr`;
        } catch { /* skip */ }
      }
    }

    // ── Withdraw valuable items — fill cargo with multiple types ──
    const withdrawnItems: Array<{ itemId: string; qty: number; name: string }> = [];

    for (const item of sellable) {
      if (ctx.shouldStop) return;
      const freeWeight = ctx.cargo.freeSpace(ctx.ship); // Recalculate each iteration
      if (freeWeight <= 0) break; // Cargo full

      const itemSize = ctx.cargo.getItemSize(ctx.ship, item.itemId);
      const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
      const withdrawQty = Math.min(item.quantity, maxByWeight);

      if (withdrawQty <= 0) continue;

      yield `withdrawing ${withdrawQty} ${item.name} from faction storage`;
      let actualQty = withdrawQty;
      try {
        const cargoBefore = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
        await ctx.api.factionWithdrawItems(item.itemId, actualQty);
        await ctx.refreshState();
        const cargoAfter = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
        const actualReceived = cargoAfter - cargoBefore;
        if (actualReceived <= 0) {
          yield `withdraw warning: cargo unchanged after withdrawing ${actualQty} ${item.name}`;
          continue; // Try next item
        }
        withdrawnItems.push({ itemId: item.itemId, qty: actualReceived, name: item.name });
        yield `withdrew ${actualReceived} ${item.name} (${item.basePrice}cr base value)`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // cargo_full: item weighs more than 1 per unit — retry with halved qty
        if (msg.includes("cargo_full") && actualQty > 1) {
          actualQty = Math.max(1, Math.floor(actualQty / 2));
          yield `retrying with ${actualQty} ${item.name} (item heavier than expected)`;
          try {
            const cargoBefore = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
            await ctx.api.factionWithdrawItems(item.itemId, actualQty);
            await ctx.refreshState();
            const cargoAfter = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
            const actualReceived = cargoAfter - cargoBefore;
            if (actualReceived > 0) {
              withdrawnItems.push({ itemId: item.itemId, qty: actualReceived, name: item.name });
              yield `withdrew ${actualReceived} ${item.name}`;
            }
          } catch (retryErr) {
            yield `retry withdraw failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`;
          }
        } else {
          yield `withdraw failed: ${msg}`;
        }
      }
    }

    if (withdrawnItems.length === 0) {
      yield "could not withdraw any items — waiting";
      await interruptibleSleep(ctx, 120_000);
      yield "cycle_complete";
      continue;
    }

    if (withdrawnItems.length > 1) {
      yield `loaded ${withdrawnItems.length} item types (${withdrawnItems.reduce((s, w) => s + w.qty, 0)} total units)`;
    }

    if (ctx.shouldStop) return;

    // ── Try sell stations in ranked order (best revenue first) ──
    // If first station fails (nav error, no demand), try the next one.
    // Only re-deposit as last resort after all known buyers exhausted.
    let sold = false;
    const factionSellCreditsBefore = ctx.player.credits;

    for (let bidIdx = 0; bidIdx < Math.min(stationBids.length, 3); bidIdx++) {
      if (ctx.shouldStop) return;
      const bid = stationBids[bidIdx];

      yield `trying station ${bidIdx + 1}/${Math.min(stationBids.length, 3)}: ~${bid.revenue}cr expected (${bid.jumps} jumps)`;
      try {
        await navigateAndDock(ctx, bid.stationId);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        continue; // Try next station
      }

      // Sell all withdrawn items at this station
      let stationSoldAny = false;
      const withdrawnIds = new Set(withdrawnItems.map((w) => w.itemId));
      for (const wi of withdrawnItems) {
        const qty = ctx.cargo.getItemQuantity(ctx.ship, wi.itemId);
        if (qty <= 0) continue;
        yield `selling ${qty} ${wi.name}`;
        try {
          const result = await ctx.api.sell(wi.itemId, qty);
          await ctx.refreshState();
          if (result.total > 0) {
            yield `sold ${result.quantity} ${wi.itemId} @ ${result.priceEach}cr (total: ${result.total}cr)`;
            recordSellResult(ctx, bid.stationId, wi.itemId, wi.itemId, result.priceEach, result.quantity);
            stationSoldAny = true;
          } else {
            yield `no demand for ${wi.name} at this station`;
          }
        } catch (err) {
          yield `sell failed for ${wi.name}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Also sell any other non-ore cargo while docked
      for (const cargo of ctx.ship.cargo) {
        if (withdrawnIds.has(cargo.itemId) || cargo.itemId.startsWith("ore_") || isProtectedItem(cargo.itemId)) continue;
        try {
          const result = await ctx.api.sell(cargo.itemId, cargo.quantity);
          await ctx.refreshState();
          if (result.total > 0) {
            yield `sold ${result.quantity} ${cargo.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
            stationSoldAny = true;
          }
        } catch { /* non-critical */ }
      }

      if (stationSoldAny) {
        sold = true;
        // Check if cargo is empty — no need to try more stations
        const remainingCargo = ctx.ship.cargo.filter((c) => !c.itemId.startsWith("ore_") && !isProtectedItem(c.itemId) && c.quantity > 0);
        if (remainingCargo.length === 0) break;
        yield `${remainingCargo.length} item(s) unsold — trying next station`;
      } else {
        yield "nothing sold here — trying next station";
      }
    }

    // If still holding unsold cargo after all stations tried, re-deposit
    if (!sold) {
      yield "all known buyers failed — re-depositing cargo";
    }
    const unsoldCargo = ctx.ship.cargo.filter((c) => !c.itemId.startsWith("ore_") && !isProtectedItem(c.itemId) && c.quantity > 0);
    if (unsoldCargo.length > 0) {
      // Navigate back to faction station to re-deposit leftovers
      try {
        await navigateAndDock(ctx, factionStation);
        for (const c of unsoldCargo) {
          try {
            await ctx.api.factionDepositItems(c.itemId, c.quantity);
            yield `re-deposited ${c.quantity} ${ctx.crafting.getItemName(c.itemId)}`;
          } catch { /* best effort */ }
        }
        await ctx.refreshState();
      } catch {
        yield "could not return to faction station — cargo stranded";
      }
    }

    // Faction tax on sell profits
    const factionSellProfit = ctx.player.credits - factionSellCreditsBefore;
    if (factionSellProfit > 0) {
      const tax = await payFactionTax(ctx, factionSellProfit);
      if (tax.message) yield tax.message;
    }

    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;

    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    tripCount++;
    yield "cycle_complete";
  }
}
