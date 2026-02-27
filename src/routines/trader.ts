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
} from "./helpers";

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
          // Check if any faction item has confirmed sell demand at a cached station
          const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
          for (const si of sellableItems) {
            for (const stationId of cachedStationIds) {
              if (stationId === factionStation) continue;
              const prices = ctx.cache.getMarketPrices(stationId);
              const sellPrice = prices?.find((p) => p.itemId === si.itemId)?.sellPrice ?? 0;
              if (sellPrice > 0) {
                const itemName = ctx.crafting.getItemName(si.itemId);
                yield `faction has ${si.quantity} ${itemName} sellable @${sellPrice}cr — selling free goods first`;
                yield* factionSellLoop(ctx, maxRoundTrips);
                return;
              }
            }
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
      const routes = ctx.market.findArbitrage(cachedStationIds, ctx.player.currentSystem)
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

  // If we still can't figure out a route, sell cargo and idle
  if (!buyStation || !sellStation || !item) {
    yield "no trade route found";
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
          const maxByCredits = Math.floor(ctx.player.credits / bestPrice);
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
      // Try next candidate route before giving up
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
      yield "no profitable routes found";
      await refuelIfNeeded(ctx);
      yield "cycle_complete";
      return;
    }

    yield "traveling to sell station";
    try {
      await navigateAndDock(ctx, sellStation);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
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

              // Invalidate cached sell price so we don't route here again
              adjustMarketCache(ctx, sellStation, item, "sell", qty);

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
      yield "cycle_complete";
      return;
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
      yield "faction storage empty, waiting";
      yield "cycle_complete";
      return;
    }

    // Rank items by base catalog price (higher value = better to sell)
    // Skip raw ores — those are for crafters
    const sellable = storageItems
      .filter((s) => !s.itemId.startsWith("ore_"))
      .map((s) => ({
        ...s,
        basePrice: ctx.crafting.getItemBasePrice(s.itemId),
        name: ctx.crafting.getItemName(s.itemId),
      }))
      .filter((s) => s.basePrice > 0)
      .sort((a, b) => (b.basePrice * b.quantity) - (a.basePrice * a.quantity)); // Total value

    if (sellable.length === 0) {
      yield "no sellable items in faction storage (only ores)";
      yield "cycle_complete";
      return;
    }

    // ── Withdraw the most valuable item(s) ──
    const freeWeight = ctx.cargo.freeSpace(ctx.ship);
    let withdrawnItem = "";
    let withdrawnQty = 0;

    for (const item of sellable) {
      if (ctx.shouldStop) return;
      const itemSize = ctx.cargo.getItemSize(ctx.ship, item.itemId);
      const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
      const withdrawQty = Math.min(item.quantity, maxByWeight);

      if (withdrawQty <= 0) continue;

      yield `withdrawing ${withdrawQty} ${item.name} from faction storage`;
      try {
        const cargoBefore = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
        await ctx.api.factionWithdrawItems(item.itemId, withdrawQty);
        await ctx.refreshState();
        const cargoAfter = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
        const actualReceived = cargoAfter - cargoBefore;
        if (actualReceived <= 0) {
          yield `withdraw warning: cargo unchanged after withdrawing ${withdrawQty} ${item.name}`;
          continue; // Try next item
        }
        withdrawnItem = item.itemId;
        withdrawnQty = actualReceived;
        yield `withdrew ${actualReceived} ${item.name} (${item.basePrice}cr base value)`;
        break; // One item type per trip
      } catch (err) {
        yield `withdraw failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (!withdrawnItem || withdrawnQty <= 0) {
      yield "could not withdraw any items";
      yield "cycle_complete";
      return;
    }

    if (ctx.shouldStop) return;

    // ── Find best sell station ──
    // Check cached market data for stations with demand for this item
    const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
    let targetStation = "";
    let bestSellPrice = 0;

    for (const stationId of cachedStationIds) {
      if (stationId === factionStation) continue; // Don't sell at our own station
      const prices = ctx.cache.getMarketPrices(stationId);
      if (!prices) continue;
      const priceData = prices.find((p) => p.itemId === withdrawnItem);
      if (priceData?.sellPrice && priceData.sellPrice > bestSellPrice) {
        bestSellPrice = priceData.sellPrice;
        targetStation = stationId;
      }
    }

    // Fallback: try local station ONLY if it has cached demand for this item
    if (!targetStation) {
      const system = await ctx.api.getSystem();
      for (const poi of system.pois) {
        if (!poi.hasBase || !poi.baseId || poi.baseId === factionStation) continue;
        const prices = ctx.cache.getMarketPrices(poi.baseId);
        const itemPrice = prices?.find((p) => p.itemId === withdrawnItem);
        if (itemPrice?.sellPrice && itemPrice.sellPrice > 0) {
          targetStation = poi.baseId;
          bestSellPrice = itemPrice.sellPrice;
          yield `found local demand: ${poi.baseName ?? poi.name} @ ${bestSellPrice}cr`;
          break;
        }
      }
      if (!targetStation) {
        yield `no station with confirmed demand for ${ctx.crafting.getItemName(withdrawnItem)}, re-depositing`;
        // Return items to faction storage
        const qty = ctx.cargo.getItemQuantity(ctx.ship, withdrawnItem);
        if (qty > 0 && ctx.player.dockedAtBase) {
          try {
            await ctx.api.factionDepositItems(withdrawnItem, qty);
            await ctx.refreshState();
            yield `re-deposited ${qty} ${ctx.crafting.getItemName(withdrawnItem)}`;
          } catch {}
        }
        await refuelIfNeeded(ctx);
        tripCount++;
        yield "cycle_complete";
        continue;
      }
    }

    if (!targetStation) {
      // Last resort: sell at current station
      yield "no other station found, selling here";
      try {
        const result = await ctx.api.sell(withdrawnItem, withdrawnQty);
        await ctx.refreshState();
        if (result.total > 0) {
          yield `sold ${result.quantity} ${withdrawnItem} @ ${result.priceEach}cr (total: ${result.total}cr)`;
          recordSellResult(ctx, factionStation, withdrawnItem, withdrawnItem, result.priceEach, result.quantity);
        } else {
          yield `no demand for ${ctx.crafting.getItemName(withdrawnItem)} here`;
        }
      } catch (err) {
        yield `sell failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      await refuelIfNeeded(ctx);
      tripCount++;
      yield "cycle_complete";
      continue;
    }

    // ── Travel to sell station ──
    yield `selling at ${bestSellPrice > 0 ? `${bestSellPrice}cr` : "best"} station`;
    try {
      await navigateAndDock(ctx, targetStation);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      yield "cycle_complete";
      return;
    }

    if (ctx.shouldStop) return;

    // ── Sell ──
    const factionSellCreditsBefore = ctx.player.credits;
    const qty = ctx.cargo.getItemQuantity(ctx.ship, withdrawnItem);
    if (qty > 0) {
      yield `selling ${qty} ${ctx.crafting.getItemName(withdrawnItem)}`;
      try {
        const result = await ctx.api.sell(withdrawnItem, qty);
        await ctx.refreshState();
        if (result.total > 0) {
          yield `sold ${result.quantity} ${withdrawnItem} @ ${result.priceEach}cr (total: ${result.total}cr)`;
          recordSellResult(ctx, targetStation, withdrawnItem, withdrawnItem, result.priceEach, result.quantity);
        } else {
          yield `no demand for ${ctx.crafting.getItemName(withdrawnItem)} at this station`;
        }
      } catch (err) {
        yield `sell failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Also sell any other non-ore cargo
    for (const cargo of ctx.ship.cargo) {
      if (cargo.itemId === withdrawnItem || cargo.itemId.startsWith("ore_") || isProtectedItem(cargo.itemId)) continue;
      try {
        const result = await ctx.api.sell(cargo.itemId, cargo.quantity);
        await ctx.refreshState();
        if (result.total > 0) {
          yield `sold ${result.quantity} ${cargo.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
        }
      } catch { /* non-critical */ }
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
