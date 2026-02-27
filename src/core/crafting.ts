/**
 * Crafting service - recipe lookup, material requirements, batch optimization.
 * Loaded once at startup with version-gated cached data.
 */

import type { Recipe, CatalogItem, ShipState, CargoItem } from "../types/game";
import type { Cargo } from "./cargo";

export interface CraftingPlan {
  recipeId: string;
  recipeName: string;
  outputItem: string;
  outputQuantity: number;
  batchCount: number;
  totalOutput: number;
  ingredients: Array<{ itemId: string; totalNeeded: number; inCargo: number; missing: number }>;
  canCraft: boolean;
  missingSkills: Array<{ skillId: string; required: number; current: number }>;
}

export interface ShoppingList {
  items: Array<{ itemId: string; quantity: number }>;
  totalItems: number;
}

/** Describes a single step in a crafting chain */
export interface ChainStep {
  recipeId: string;
  recipeName: string;
  batchCount: number;
  inputs: Array<{ itemId: string; itemName: string; quantity: number; isRaw: boolean }>;
  output: { itemId: string; itemName: string; quantity: number };
}

export class Crafting {
  private recipes: Recipe[] = [];
  private recipeMap = new Map<string, Recipe>();
  private outputIndex = new Map<string, Recipe[]>(); // outputItem → recipes that make it
  private itemCatalog = new Map<string, CatalogItem>();

  constructor(private cargo: Cargo) {}

  /** Load recipes from cache. Call once at startup. */
  load(recipes: Recipe[]): void {
    this.recipes = recipes;
    this.recipeMap.clear();
    this.outputIndex.clear();

    for (const recipe of recipes) {
      this.recipeMap.set(recipe.id, recipe);
      const existing = this.outputIndex.get(recipe.outputItem) ?? [];
      existing.push(recipe);
      this.outputIndex.set(recipe.outputItem, existing);
    }
  }

  /** Load item catalog for name resolution and price info. Call once at startup. */
  loadItems(items: CatalogItem[]): void {
    this.itemCatalog.clear();
    for (const item of items) {
      this.itemCatalog.set(item.id, item);
    }
  }

  get recipeCount(): number {
    return this.recipes.length;
  }

  get itemCount(): number {
    return this.itemCatalog.size;
  }

  // ── Item Catalog Lookups ──

  /** Get human-readable item name */
  getItemName(itemId: string): string {
    return this.itemCatalog.get(itemId)?.name ?? itemId;
  }

  /** Get item base price from catalog */
  getItemBasePrice(itemId: string): number {
    return this.itemCatalog.get(itemId)?.basePrice ?? 0;
  }

  /** Get item category (ore, component, refined, etc.) */
  getItemCategory(itemId: string): string {
    return this.itemCatalog.get(itemId)?.category ?? "unknown";
  }

  /** Check if an item is craftable (is the output of at least one recipe) */
  isCraftable(itemId: string): boolean {
    return (this.outputIndex.get(itemId)?.length ?? 0) > 0;
  }

  /** Check if an item is a raw material (not craftable, must be mined/bought) */
  isRawMaterial(itemId: string): boolean {
    return !this.isCraftable(itemId);
  }

  // ── Recipe Lookups ──

  /** Get a recipe by ID */
  getRecipe(recipeId: string): Recipe | null {
    return this.recipeMap.get(recipeId) ?? null;
  }

  /** Get all known recipes */
  getAllRecipes(): Recipe[] {
    return [...this.recipes];
  }

  /** Find all recipes that produce a given item */
  findRecipesForItem(outputItemId: string): Recipe[] {
    return this.outputIndex.get(outputItemId) ?? [];
  }

  /** Get all recipes the bot can craft with current skills */
  getAvailableRecipes(skills: Record<string, number>): Recipe[] {
    return this.recipes.filter((r) => this.hasRequiredSkills(r, skills));
  }

  /** Check if player has required skills for a recipe */
  hasRequiredSkills(recipe: Recipe, skills: Record<string, number>): boolean {
    for (const [skillId, required] of Object.entries(recipe.requiredSkills)) {
      if ((skills[skillId] ?? 0) < required) return false;
    }
    return true;
  }

  /**
   * Find the easiest recipe for skill progression.
   * Returns the recipe with the lowest total skill gap — even if the bot can't craft it yet,
   * the API may allow attempts on low-level recipes. Sorted by total skill deficit ascending.
   */
  findEasiestRecipe(skills: Record<string, number>): { recipe: Recipe; skillGap: number; missingSkills: string[] } | null {
    if (this.recipes.length === 0) return null;

    const scored = this.recipes.map((r) => {
      let totalGap = 0;
      const missing: string[] = [];
      for (const [skillId, required] of Object.entries(r.requiredSkills)) {
        const current = skills[skillId] ?? 0;
        if (current < required) {
          totalGap += required - current;
          missing.push(`${skillId}:${current}/${required}`);
        }
      }
      return { recipe: r, skillGap: totalGap, missingSkills: missing };
    });

    // Prefer recipes with 0 gap (should be caught by getAvailableRecipes, but just in case)
    // then smallest gap, then fewest ingredients (simpler to source)
    scored.sort((a, b) => {
      if (a.skillGap !== b.skillGap) return a.skillGap - b.skillGap;
      return a.recipe.ingredients.length - b.recipe.ingredients.length;
    });

    return scored[0] ?? null;
  }

  // ── Material Chain Resolution ──

  /**
   * Resolve the full raw material requirements for a recipe.
   * Recursively resolves crafted intermediates down to base materials.
   * Returns a flat map of itemId → total quantity needed (raw materials only).
   */
  getRawMaterials(recipeId: string, batchCount = 1): Map<string, number> {
    const rawMaterials = new Map<string, number>();
    const visited = new Set<string>();

    const resolve = (id: string, multiplier: number) => {
      if (visited.has(id)) return; // Prevent circular dependencies
      visited.add(id);

      const recipe = this.recipeMap.get(id);
      if (!recipe) return;

      for (const ing of recipe.ingredients) {
        const subRecipes = this.outputIndex.get(ing.itemId);
        if (subRecipes && subRecipes.length > 0) {
          // Craftable intermediate — resolve deeper
          const sub = subRecipes[0];
          const subBatches = Math.ceil((ing.quantity * multiplier) / sub.outputQuantity);
          resolve(sub.id, subBatches);
        } else {
          // Raw material — accumulate
          const needed = ing.quantity * multiplier;
          rawMaterials.set(ing.itemId, (rawMaterials.get(ing.itemId) ?? 0) + needed);
        }
      }

      visited.delete(id); // Allow re-entry from different branches
    };

    resolve(recipeId, batchCount);
    return rawMaterials;
  }

  /**
   * Build the full crafting chain with ordered steps.
   * Returns an ordered list of crafting steps (deepest dependencies first).
   * Each step includes input/output items with names and whether inputs are raw.
   */
  buildChain(recipeId: string, batchCount = 1): ChainStep[] {
    const steps: ChainStep[] = [];
    const visited = new Set<string>();

    const resolve = (id: string, multiplier: number) => {
      if (visited.has(id)) return;
      visited.add(id);

      const recipe = this.recipeMap.get(id);
      if (!recipe) return;

      // Resolve sub-recipes first (depth-first)
      for (const ing of recipe.ingredients) {
        const subRecipes = this.outputIndex.get(ing.itemId);
        if (subRecipes && subRecipes.length > 0) {
          const sub = subRecipes[0];
          const subBatches = Math.ceil((ing.quantity * multiplier) / sub.outputQuantity);
          resolve(sub.id, subBatches);
        }
      }

      steps.push({
        recipeId: recipe.id,
        recipeName: recipe.name,
        batchCount: multiplier,
        inputs: recipe.ingredients.map((ing) => ({
          itemId: ing.itemId,
          itemName: this.getItemName(ing.itemId),
          quantity: ing.quantity * multiplier,
          isRaw: this.isRawMaterial(ing.itemId),
        })),
        output: {
          itemId: recipe.outputItem,
          itemName: this.getItemName(recipe.outputItem),
          quantity: recipe.outputQuantity * multiplier,
        },
      });

      visited.delete(id);
    };

    resolve(recipeId, batchCount);
    return steps;
  }

  /**
   * Estimate profit for crafting one batch of a recipe.
   * Uses base catalog prices: outputValue - inputCost.
   */
  estimateProfit(recipeId: string): number {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe) return 0;

    const outputPrice = this.getItemBasePrice(recipe.outputItem) * recipe.outputQuantity;
    const inputCost = recipe.ingredients.reduce(
      (sum, ing) => sum + this.getItemBasePrice(ing.itemId) * ing.quantity,
      0,
    );

    return outputPrice - inputCost;
  }

  /**
   * Find the best recipe for a bot based on available skills and estimated profit.
   * Returns null if no recipes are available.
   */
  findBestRecipe(skills: Record<string, number>): Recipe | null {
    const available = this.getAvailableRecipes(skills);
    if (available.length === 0) return null;

    // Sort by estimated profit descending, pick the best
    let best: Recipe | null = null;
    let bestProfit = -Infinity;
    for (const recipe of available) {
      const profit = this.estimateProfit(recipe.id);
      if (profit > bestProfit) {
        bestProfit = profit;
        best = recipe;
      }
    }

    return best;
  }

  /**
   * Find the best recipe that a bot can craft RIGHT NOW with materials in cargo.
   * Falls back to findBestRecipe if nothing is immediately craftable.
   */
  findCraftableNow(ship: ShipState, skills: Record<string, number>): Recipe | null {
    const available = this.getAvailableRecipes(skills);
    if (available.length === 0) return null;

    // First pass: find recipes we can craft with current cargo, pick most profitable
    let best: Recipe | null = null;
    let bestProfit = -Infinity;
    for (const recipe of available) {
      const plan = this.planCraft(recipe.id, 1, ship, skills);
      if (plan && plan.canCraft) {
        const profit = this.estimateProfit(recipe.id);
        if (profit > bestProfit) {
          bestProfit = profit;
          best = recipe;
        }
      }
    }

    return best;
  }

  /**
   * Plan crafting: check materials, skills, and determine what's missing.
   */
  planCraft(
    recipeId: string,
    batchCount: number,
    ship: ShipState,
    skills: Record<string, number>
  ): CraftingPlan | null {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe) return null;

    // Check skills
    const missingSkills: CraftingPlan["missingSkills"] = [];
    for (const [skillId, required] of Object.entries(recipe.requiredSkills)) {
      const current = skills[skillId] ?? 0;
      if (current < required) {
        missingSkills.push({ skillId, required, current });
      }
    }

    // Check ingredients
    const ingredients: CraftingPlan["ingredients"] = recipe.ingredients.map((ing) => {
      const totalNeeded = ing.quantity * batchCount;
      const inCargo = this.cargo.getItemQuantity(ship, ing.itemId);
      return {
        itemId: ing.itemId,
        totalNeeded,
        inCargo,
        missing: Math.max(0, totalNeeded - inCargo),
      };
    });

    const canCraft = missingSkills.length === 0 && ingredients.every((i) => i.missing === 0);

    return {
      recipeId,
      recipeName: recipe.name,
      outputItem: recipe.outputItem,
      outputQuantity: recipe.outputQuantity,
      batchCount,
      totalOutput: recipe.outputQuantity * batchCount,
      ingredients,
      canCraft,
      missingSkills,
    };
  }

  /**
   * Generate a shopping list for crafting N batches of a recipe.
   * Only includes items we don't already have enough of.
   */
  getShoppingList(recipeId: string, batchCount: number, ship: ShipState): ShoppingList | null {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe) return null;

    const items: ShoppingList["items"] = [];
    let totalItems = 0;

    for (const ing of recipe.ingredients) {
      const needed = ing.quantity * batchCount;
      const have = this.cargo.getItemQuantity(ship, ing.itemId);
      const missing = Math.max(0, needed - have);
      if (missing > 0) {
        items.push({ itemId: ing.itemId, quantity: missing });
        totalItems += missing;
      }
    }

    return { items, totalItems };
  }

  /**
   * Calculate max batches we can craft with current cargo.
   */
  maxBatches(recipeId: string, ship: ShipState): number {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe || recipe.ingredients.length === 0) return 0;

    let maxBatches = Infinity;
    for (const ing of recipe.ingredients) {
      const have = this.cargo.getItemQuantity(ship, ing.itemId);
      const batchesFromThis = ing.quantity > 0 ? Math.floor(have / ing.quantity) : Infinity;
      maxBatches = Math.min(maxBatches, batchesFromThis);
    }

    return maxBatches === Infinity ? 0 : maxBatches;
  }

  /**
   * Resolve full prerequisite chain for a recipe.
   * Returns ordered list of recipes to craft (deepest dependencies first).
   */
  resolveChain(recipeId: string): Recipe[] {
    const chain: Recipe[] = [];
    const visited = new Set<string>();

    const resolve = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const recipe = this.recipeMap.get(id);
      if (!recipe) return;

      // Check if any ingredients are themselves craftable
      for (const ing of recipe.ingredients) {
        const subRecipes = this.outputIndex.get(ing.itemId);
        if (subRecipes && subRecipes.length > 0) {
          resolve(subRecipes[0].id);
        }
      }

      chain.push(recipe);
    };

    resolve(recipeId);
    return chain;
  }
}
