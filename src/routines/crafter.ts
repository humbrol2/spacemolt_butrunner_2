/**
 * Crafter routine - converts raw materials into finished goods.
 *
 * Smart enough to:
 * 1. Auto-discover the most profitable recipe based on skills
 * 2. Resolve the full material chain (ores → intermediates → final product)
 * 3. Source materials: cargo → storage → market
 * 4. Craft intermediates before the final product
 *
 * Params:
 *   recipeId?: string          - Recipe to craft (auto-discovered if empty)
 *   count?: number             - Number of batches per cycle (default: 1)
 *   craftStation?: string      - Base ID with crafting facilities
 *   materialSource?: string    - "cargo" | "storage" | "market" (priority order)
 *   sellOutput?: boolean       - Sell finished goods (default: true)
 */

import type { BotContext } from "../bot/types";
import {
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  sellItem,
  getParam,
  recordSellResult,
  payFactionTax,
  ensureMinCredits,
  interruptibleSleep,
} from "./helpers";

export async function* crafter(ctx: BotContext): AsyncGenerator<string, void, void> {
  let recipeId = getParam(ctx, "recipeId", "");
  const count = getParam(ctx, "count", 1);
  const craftStation = getParam(ctx, "craftStation", "");
  const materialSource = getParam<string>(ctx, "materialSource", "cargo");
  const sellOutput = getParam(ctx, "sellOutput", true);
  let skillTraining = false;

  // ── Recipe discovery ──
  if (!recipeId) {
    yield "analyzing recipes...";

    // First: try to find something we can craft right now
    const immediate = ctx.crafting.findCraftableNow(ctx.ship, ctx.player.skills);
    if (immediate) {
      recipeId = immediate.id;
      const profit = ctx.crafting.estimateProfit(immediate.id);
      yield `ready to craft: ${immediate.name} (est. profit ${profit}cr)`;
    } else {
      // Second: find the most profitable recipe we have skills for
      const best = ctx.crafting.findBestRecipe(ctx.player.skills);
      if (best) {
        recipeId = best.id;
        const profit = ctx.crafting.estimateProfit(best.id);
        yield `target recipe: ${best.name} (est. profit ${profit}cr, need materials)`;
      }
    }
  }

  if (!recipeId) {
    const total = ctx.crafting.recipeCount;
    const available = ctx.crafting.getAvailableRecipes(ctx.player.skills).length;

    // Skill progression: try the easiest recipe even if skill-gated
    // The API may allow crafting low-level recipes, and success grants XP to level up
    const easiest = ctx.crafting.findEasiestRecipe(ctx.player.skills);
    if (easiest && easiest.skillGap <= 2) {
      recipeId = easiest.recipe.id;
      skillTraining = true;
      yield `skill training: attempting ${easiest.recipe.name} (gap: ${easiest.missingSkills.join(", ")})`;
    } else {
      yield `no craftable recipes (${available} available of ${total} total, skill-gated${easiest ? `, easiest needs: ${easiest.missingSkills.join(", ")}` : ""})`;
      yield "cycle_complete";
      return;
    }
  }

  // Get recipe info
  const recipe = ctx.crafting.getRecipe(recipeId);
  if (!recipe) {
    yield `unknown recipe: ${recipeId}`;
    yield "cycle_complete";
    return;
  }

  // Build the crafting chain (ordered steps, deepest deps first)
  const chain = ctx.crafting.buildChain(recipeId, count);
  const rawMaterials = ctx.crafting.getRawMaterials(recipeId, count);

  if (chain.length > 1) {
    const rawList = [...rawMaterials.entries()]
      .map(([id, qty]) => `${qty}x ${ctx.crafting.getItemName(id)}`)
      .join(", ");
    yield `chain: ${chain.length} steps. Raw materials needed: ${rawList}`;
  }

  while (!ctx.shouldStop) {
    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // ── Dock at crafting station ──
    if (craftStation && ctx.player.dockedAtBase !== craftStation) {
      yield "traveling to crafting station";
      try {
        await navigateAndDock(ctx, craftStation);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        yield "cycle_complete";
        return;
      }
    } else if (!ctx.player.dockedAtBase) {
      try {
        await findAndDock(ctx);
      } catch {
        yield "no dockable station found";
        yield "cycle_complete";
        return;
      }
    }

    if (ctx.shouldStop) return;

    // ── Source materials ──
    const sourced = await sourceMaterials(ctx, recipe, count, materialSource, skillTraining);
    if (!sourced.ok) {
      yield `${sourced.reason} — waiting for materials`;
      await interruptibleSleep(ctx, 120_000); // Wait 2 min for miners/crafters to produce
      yield "cycle_complete";
      continue; // Retry — materials may appear in faction storage
    }
    for (const msg of sourced.messages) {
      yield msg;
    }

    if (ctx.shouldStop) return;

    // ── Craft chain (intermediates first, then final product) ──
    let chainFailed = false;
    for (const step of chain) {
      if (ctx.shouldStop) return;

      // Check if we have the inputs for this step
      const plan = ctx.crafting.planCraft(step.recipeId, step.batchCount, ctx.ship, ctx.player.skills);
      if (!plan) {
        yield `cannot plan: ${step.recipeName}`;
        continue;
      }

      if (!plan.canCraft) {
        // Try sourcing missing materials for this specific step
        const stepRecipe = ctx.crafting.getRecipe(step.recipeId);
        if (stepRecipe) {
          const stepSourced = await sourceMaterials(ctx, stepRecipe, step.batchCount, materialSource, skillTraining);
          if (!stepSourced.ok) {
            yield `missing materials for ${step.recipeName}: ${stepSourced.reason} — waiting`;
            chainFailed = true;
            break; // Exit chain loop — will wait and retry
          }
          for (const msg of stepSourced.messages) {
            yield msg;
          }
        }
      }

      yield `crafting ${step.batchCount}x ${step.recipeName}`;
      try {
        const batchSize = Math.min(step.batchCount, 10);
        let remaining = step.batchCount;
        while (remaining > 0) {
          const batch = Math.min(remaining, batchSize);
          const result = await ctx.api.craft(step.recipeId, batch);
          await ctx.refreshState();
          remaining -= batch;

          if (remaining > 0) {
            yield `crafted ${batch}x ${result.outputItem} (${remaining} remaining)`;
          } else {
            yield `crafted ${result.outputQuantity} ${ctx.crafting.getItemName(result.outputItem)}`;
            const xpEntries = Object.entries(result.xpGained);
            if (xpEntries.length > 0) {
              yield `XP: ${xpEntries.map(([s, x]) => `${s}:+${x}`).join(", ")}`;
            }
          }
        }
      } catch (err) {
        yield `craft failed: ${err instanceof Error ? err.message : String(err)}`;
        chainFailed = true;
        break; // Exit chain loop — will wait and retry
      }
    }

    if (ctx.shouldStop) return;

    // Chain failed — wait and retry (materials may appear from miners/crafters)
    if (chainFailed) {
      yield "waiting for materials before retrying chain...";
      await interruptibleSleep(ctx, 120_000);
      yield "cycle_complete";
      continue;
    }

    // ── Sell or deposit output ──
    if (sellOutput) {
      yield `selling ${ctx.crafting.getItemName(recipe.outputItem)}`;
      const result = await sellItem(ctx, recipe.outputItem);
      if (result && result.total > 0) {
        yield `sold ${result.quantity} ${recipe.outputItem} @ ${result.priceEach}cr (total: ${result.total}cr)`;
        // Record sell as demand signal for arbitrage
        if (ctx.player.dockedAtBase) {
          recordSellResult(ctx, ctx.player.dockedAtBase, recipe.outputItem,
            ctx.crafting.getItemName(recipe.outputItem), result.priceEach, result.quantity);
        }
      } else {
        yield `no demand for ${ctx.crafting.getItemName(recipe.outputItem)}`;
      }
    } else {
      const qty = ctx.cargo.getItemQuantity(ctx.ship, recipe.outputItem);
      if (qty > 0) {
        const useFaction = ctx.settings.factionStorage
          || ctx.fleetConfig.defaultStorageMode === "faction_deposit";

        if (useFaction) {
          // Deposit to faction storage
          try {
            await ctx.api.factionDepositItems(recipe.outputItem, qty);
            await ctx.refreshState();
            yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)} to faction storage`;
          } catch (err) {
            yield `faction deposit failed: ${err instanceof Error ? err.message : String(err)}`;
            // Fallback: try personal storage
            try {
              await ctx.api.depositItems(recipe.outputItem, qty);
              await ctx.refreshState();
              yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)} to personal storage`;
            } catch (err2) {
              yield `deposit failed: ${err2 instanceof Error ? err2.message : String(err2)}`;
            }
          }
        } else {
          // Personal storage
          try {
            await ctx.api.depositItems(recipe.outputItem, qty);
            await ctx.refreshState();
            yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)}`;
          } catch (err) {
            yield `deposit failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }

    // ── Ensure minimum credits ──
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;

    // ── Service ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    yield "cycle_complete";
  }
}

// ── Material Sourcing ──

interface SourceResult {
  ok: boolean;
  reason: string;
  messages: string[];
}

async function sourceMaterials(
  ctx: BotContext,
  recipe: { id: string; ingredients: Array<{ itemId: string; quantity: number }> },
  batchCount: number,
  preferredSource: string,
  skipSkillCheck = false,
): Promise<SourceResult> {
  const plan = ctx.crafting.planCraft(recipe.id, batchCount, ctx.ship, ctx.player.skills);
  if (!plan) return { ok: false, reason: "could not create crafting plan", messages: [] };
  if (plan.canCraft) return { ok: true, reason: "", messages: [] };

  // Check skill requirements first (skip when in skill training mode — let API decide)
  if (!skipSkillCheck && plan.missingSkills.length > 0) {
    const missing = plan.missingSkills.map((s) => `${s.skillId} (need ${s.required}, have ${s.current})`).join(", ");
    return { ok: false, reason: `missing skills: ${missing}`, messages: [] };
  }

  const missing = plan.ingredients.filter((i) => i.missing > 0);
  const messages: string[] = [];

  // Build source order based on preference
  const sources: Array<"storage" | "market"> =
    preferredSource === "market" ? ["market", "storage"] :
    preferredSource === "storage" ? ["storage", "market"] :
    []; // "cargo" = don't source externally

  for (const ing of missing) {
    let got = 0;

    for (const source of sources) {
      if (got >= ing.missing) break;
      const stillMissing = ing.missing - got;

      if (source === "storage") {
        try {
          // Use faction storage if bot settings say so
          if (ctx.settings.factionStorage || ctx.fleetConfig.defaultStorageMode === "faction_deposit") {
            await ctx.api.factionWithdrawItems(ing.itemId, stillMissing);
          } else {
            await ctx.api.withdrawItems(ing.itemId, stillMissing);
          }
          await ctx.refreshState();
          got += stillMissing;
          const storageType = (ctx.settings.factionStorage || ctx.fleetConfig.defaultStorageMode === "faction_deposit") ? "faction" : "personal";
          messages.push(`withdrew ${stillMissing} ${ctx.crafting.getItemName(ing.itemId)} from ${storageType} storage`);
        } catch (err) {
            // Storage withdrawal failed — try next source
            console.warn(`[${ctx.botId}] storage withdraw failed for ${ing.itemId}: ${err instanceof Error ? err.message : err}`);
          }
      } else if (source === "market") {
        try {
          // Weight-aware buy: cap quantity by available cargo weight
          const itemSize = ctx.cargo.getItemSize(ctx.ship, ing.itemId);
          const freeWeight = ctx.cargo.freeSpace(ctx.ship);
          const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
          const safeBuyQty = Math.min(stillMissing, maxByWeight);
          if (safeBuyQty <= 0) {
            console.warn(`[${ctx.botId}] no cargo space for ${ing.itemId} (size ${itemSize}, free ${freeWeight})`);
          } else {
            const result = await ctx.api.buy(ing.itemId, safeBuyQty);
            await ctx.refreshState();
            got += result.quantity;
            messages.push(`bought ${result.quantity} ${ctx.crafting.getItemName(ing.itemId)} @ ${result.priceEach}cr`);
          }
        } catch (err) {
            // Market purchase failed — try next source
            console.warn(`[${ctx.botId}] market buy failed for ${ing.itemId}: ${err instanceof Error ? err.message : err}`);
          }
      }
    }

    if (got < ing.missing) {
      const shortfall = ing.missing - got;
      return {
        ok: false,
        reason: `need ${shortfall} more ${ctx.crafting.getItemName(ing.itemId)}`,
        messages,
      };
    }
  }

  return { ok: true, reason: "", messages };
}
