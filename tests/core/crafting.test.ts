import { describe, test, expect, beforeEach } from "bun:test";
import { Crafting } from "../../src/core/crafting";
import { Cargo } from "../../src/core/cargo";
import type { Recipe, ShipState } from "../../src/types/game";

function makeRecipes(): Recipe[] {
  return [
    {
      id: "recipe_steel",
      name: "Steel Plate",
      description: "Basic steel plate",
      outputItem: "steel_plate",
      outputQuantity: 1,
      ingredients: [
        { itemId: "ore_iron", quantity: 4 },
        { itemId: "ore_carbon", quantity: 1 },
      ],
      requiredSkills: { crafting: 1 },
      xpRewards: { crafting: 10 },
    },
    {
      id: "recipe_advanced_steel",
      name: "Advanced Steel",
      description: "Refined steel",
      outputItem: "advanced_steel",
      outputQuantity: 1,
      ingredients: [
        { itemId: "steel_plate", quantity: 2 },
        { itemId: "rare_mineral", quantity: 1 },
      ],
      requiredSkills: { crafting: 3 },
      xpRewards: { crafting: 25 },
    },
    {
      id: "recipe_copper_wire",
      name: "Copper Wire",
      description: "Electrical wire",
      outputItem: "copper_wire",
      outputQuantity: 5,
      ingredients: [{ itemId: "ore_copper", quantity: 2 }],
      requiredSkills: { crafting: 1 },
      xpRewards: { crafting: 5 },
    },
  ];
}

function makeShip(overrides: Partial<ShipState> = {}): ShipState {
  return {
    id: "ship1",
    ownerId: "player1",
    classId: "hauler",
    name: null,
    hull: 100,
    maxHull: 100,
    shield: 50,
    maxShield: 50,
    shieldRecharge: 1,
    armor: 10,
    speed: 3,
    fuel: 80,
    maxFuel: 100,
    cargoUsed: 30,
    cargoCapacity: 100,
    cpuUsed: 0,
    cpuCapacity: 10,
    powerUsed: 0,
    powerCapacity: 10,
    modules: [],
    cargo: [
      { itemId: "ore_iron", quantity: 20 },
      { itemId: "ore_carbon", quantity: 5 },
      { itemId: "ore_copper", quantity: 10 },
    ],
    ...overrides,
  };
}

describe("Crafting", () => {
  let crafting: Crafting;

  beforeEach(() => {
    crafting = new Crafting(new Cargo());
    crafting.load(makeRecipes());
  });

  test("load populates recipe map", () => {
    expect(crafting.recipeCount).toBe(3);
  });

  test("getRecipe returns recipe by ID", () => {
    const recipe = crafting.getRecipe("recipe_steel");
    expect(recipe).not.toBeNull();
    expect(recipe!.name).toBe("Steel Plate");
  });

  test("getRecipe returns null for unknown", () => {
    expect(crafting.getRecipe("nonexistent")).toBeNull();
  });

  test("findRecipesForItem finds by output", () => {
    const recipes = crafting.findRecipesForItem("steel_plate");
    expect(recipes.length).toBe(1);
    expect(recipes[0].id).toBe("recipe_steel");
  });

  test("findRecipesForItem returns empty for unknown", () => {
    expect(crafting.findRecipesForItem("nonexistent").length).toBe(0);
  });

  test("hasRequiredSkills checks skill levels", () => {
    const recipe = crafting.getRecipe("recipe_steel")!;
    expect(crafting.hasRequiredSkills(recipe, { crafting: 5 })).toBe(true);
    expect(crafting.hasRequiredSkills(recipe, { crafting: 1 })).toBe(true);
    expect(crafting.hasRequiredSkills(recipe, { crafting: 0 })).toBe(false);
    expect(crafting.hasRequiredSkills(recipe, {})).toBe(false);
  });

  test("getAvailableRecipes filters by skills", () => {
    expect(crafting.getAvailableRecipes({ crafting: 1 }).length).toBe(2); // steel + copper_wire
    expect(crafting.getAvailableRecipes({ crafting: 3 }).length).toBe(3); // all
    expect(crafting.getAvailableRecipes({}).length).toBe(0); // none
  });

  test("planCraft with sufficient materials", () => {
    const ship = makeShip();
    const plan = crafting.planCraft("recipe_steel", 2, ship, { crafting: 1 });
    expect(plan).not.toBeNull();
    expect(plan!.canCraft).toBe(true);
    expect(plan!.batchCount).toBe(2);
    expect(plan!.totalOutput).toBe(2);
    expect(plan!.ingredients[0].totalNeeded).toBe(8); // 4 iron * 2 batches
    expect(plan!.ingredients[0].inCargo).toBe(20);
    expect(plan!.ingredients[0].missing).toBe(0);
  });

  test("planCraft with insufficient materials", () => {
    const ship = makeShip({ cargo: [{ itemId: "ore_iron", quantity: 2 }] });
    const plan = crafting.planCraft("recipe_steel", 1, ship, { crafting: 1 });
    expect(plan).not.toBeNull();
    expect(plan!.canCraft).toBe(false);
    expect(plan!.ingredients[0].missing).toBe(2); // Need 4, have 2
    expect(plan!.ingredients[1].missing).toBe(1); // Need 1 carbon, have 0
  });

  test("planCraft with missing skills", () => {
    const ship = makeShip();
    const plan = crafting.planCraft("recipe_advanced_steel", 1, ship, { crafting: 1 });
    expect(plan).not.toBeNull();
    expect(plan!.canCraft).toBe(false);
    expect(plan!.missingSkills.length).toBe(1);
    expect(plan!.missingSkills[0].skillId).toBe("crafting");
    expect(plan!.missingSkills[0].required).toBe(3);
    expect(plan!.missingSkills[0].current).toBe(1);
  });

  test("planCraft returns null for unknown recipe", () => {
    expect(crafting.planCraft("nonexistent", 1, makeShip(), {})).toBeNull();
  });

  test("getShoppingList returns only missing items", () => {
    const ship = makeShip();
    const list = crafting.getShoppingList("recipe_steel", 5, ship);
    expect(list).not.toBeNull();
    // Need 20 iron (have 20) and 5 carbon (have 5) → nothing missing
    expect(list!.items.length).toBe(0);
    expect(list!.totalItems).toBe(0);
  });

  test("getShoppingList with shortage", () => {
    const ship = makeShip({ cargo: [{ itemId: "ore_iron", quantity: 5 }] });
    const list = crafting.getShoppingList("recipe_steel", 5, ship);
    expect(list).not.toBeNull();
    // Need 20 iron (have 5 → missing 15), need 5 carbon (have 0 → missing 5)
    expect(list!.items.length).toBe(2);
    expect(list!.items.find((i) => i.itemId === "ore_iron")?.quantity).toBe(15);
    expect(list!.items.find((i) => i.itemId === "ore_carbon")?.quantity).toBe(5);
    expect(list!.totalItems).toBe(20);
  });

  test("maxBatches calculates limited by scarcest ingredient", () => {
    const ship = makeShip(); // 20 iron, 5 carbon
    // Steel needs 4 iron + 1 carbon per batch
    // Iron: 20/4 = 5, Carbon: 5/1 = 5 → max 5
    expect(crafting.maxBatches("recipe_steel", ship)).toBe(5);
  });

  test("maxBatches with zero of an ingredient", () => {
    const ship = makeShip({ cargo: [{ itemId: "ore_iron", quantity: 20 }] });
    // No carbon → 0 batches
    expect(crafting.maxBatches("recipe_steel", ship)).toBe(0);
  });

  test("maxBatches returns 0 for unknown recipe", () => {
    expect(crafting.maxBatches("nonexistent", makeShip())).toBe(0);
  });

  test("resolveChain returns dependency order", () => {
    const chain = crafting.resolveChain("recipe_advanced_steel");
    expect(chain.length).toBe(2);
    // Steel plate (dependency) should come before advanced steel
    expect(chain[0].id).toBe("recipe_steel");
    expect(chain[1].id).toBe("recipe_advanced_steel");
  });

  test("resolveChain for simple recipe returns just itself", () => {
    const chain = crafting.resolveChain("recipe_copper_wire");
    expect(chain.length).toBe(1);
    expect(chain[0].id).toBe("recipe_copper_wire");
  });

  // ── Item Catalog ──

  test("loadItems populates item catalog", () => {
    crafting.loadItems([
      { id: "ore_iron", name: "Iron Ore", category: "ore", description: "", basePrice: 5, stackSize: 100 },
      { id: "steel_plate", name: "Steel Plate", category: "component", description: "", basePrice: 50, stackSize: 50 },
    ]);
    expect(crafting.itemCount).toBe(2);
    expect(crafting.getItemName("ore_iron")).toBe("Iron Ore");
    expect(crafting.getItemName("unknown_item")).toBe("unknown_item"); // fallback to ID
  });

  test("getItemBasePrice returns catalog price", () => {
    crafting.loadItems([
      { id: "ore_iron", name: "Iron Ore", category: "ore", description: "", basePrice: 5, stackSize: 100 },
    ]);
    expect(crafting.getItemBasePrice("ore_iron")).toBe(5);
    expect(crafting.getItemBasePrice("nonexistent")).toBe(0);
  });

  test("getItemCategory returns catalog category", () => {
    crafting.loadItems([
      { id: "ore_iron", name: "Iron Ore", category: "ore", description: "", basePrice: 5, stackSize: 100 },
    ]);
    expect(crafting.getItemCategory("ore_iron")).toBe("ore");
    expect(crafting.getItemCategory("nonexistent")).toBe("unknown");
  });

  test("isCraftable and isRawMaterial", () => {
    expect(crafting.isCraftable("steel_plate")).toBe(true);  // output of recipe_steel
    expect(crafting.isCraftable("ore_iron")).toBe(false);     // raw material
    expect(crafting.isRawMaterial("ore_iron")).toBe(true);
    expect(crafting.isRawMaterial("steel_plate")).toBe(false);
  });

  // ── Material Chain Resolution ──

  test("getRawMaterials for simple recipe returns direct ingredients", () => {
    const raw = crafting.getRawMaterials("recipe_steel", 1);
    expect(raw.get("ore_iron")).toBe(4);
    expect(raw.get("ore_carbon")).toBe(1);
    expect(raw.size).toBe(2);
  });

  test("getRawMaterials resolves intermediates to base materials", () => {
    // advanced_steel needs 2 steel_plate + 1 rare_mineral
    // steel_plate is craftable: 4 ore_iron + 1 ore_carbon
    // So advanced_steel raw materials: 8 ore_iron + 2 ore_carbon + 1 rare_mineral
    const raw = crafting.getRawMaterials("recipe_advanced_steel", 1);
    expect(raw.get("ore_iron")).toBe(8);    // 2 plates × 4 iron each
    expect(raw.get("ore_carbon")).toBe(2);  // 2 plates × 1 carbon each
    expect(raw.get("rare_mineral")).toBe(1);
    expect(raw.has("steel_plate")).toBe(false); // Resolved away
  });

  test("getRawMaterials scales with batch count", () => {
    const raw = crafting.getRawMaterials("recipe_copper_wire", 3);
    expect(raw.get("ore_copper")).toBe(6); // 2 per batch × 3 batches
  });

  // ── Chain Steps ──

  test("buildChain returns ordered steps for complex recipe", () => {
    crafting.loadItems([
      { id: "ore_iron", name: "Iron Ore", category: "ore", description: "", basePrice: 5, stackSize: 100 },
      { id: "ore_carbon", name: "Carbon Ore", category: "ore", description: "", basePrice: 3, stackSize: 100 },
      { id: "steel_plate", name: "Steel Plate", category: "component", description: "", basePrice: 50, stackSize: 50 },
      { id: "rare_mineral", name: "Rare Mineral", category: "ore", description: "", basePrice: 100, stackSize: 20 },
      { id: "advanced_steel", name: "Advanced Steel", category: "refined", description: "", basePrice: 200, stackSize: 20 },
    ]);

    const chain = crafting.buildChain("recipe_advanced_steel", 1);
    expect(chain.length).toBe(2);

    // Step 1: craft steel plate (intermediate)
    expect(chain[0].recipeId).toBe("recipe_steel");
    expect(chain[0].inputs.some((i) => i.itemId === "ore_iron" && i.isRaw)).toBe(true);
    expect(chain[0].output.itemId).toBe("steel_plate");

    // Step 2: craft advanced steel (final)
    expect(chain[1].recipeId).toBe("recipe_advanced_steel");
    expect(chain[1].inputs.some((i) => i.itemId === "steel_plate" && !i.isRaw)).toBe(true);
    expect(chain[1].output.itemId).toBe("advanced_steel");
  });

  test("buildChain for simple recipe returns single step", () => {
    const chain = crafting.buildChain("recipe_copper_wire", 2);
    expect(chain.length).toBe(1);
    expect(chain[0].batchCount).toBe(2);
    expect(chain[0].inputs[0].isRaw).toBe(true);
  });

  // ── Profit Estimation ──

  test("estimateProfit calculates output - input cost", () => {
    crafting.loadItems([
      { id: "ore_iron", name: "Iron Ore", category: "ore", description: "", basePrice: 5, stackSize: 100 },
      { id: "ore_carbon", name: "Carbon Ore", category: "ore", description: "", basePrice: 3, stackSize: 100 },
      { id: "steel_plate", name: "Steel Plate", category: "component", description: "", basePrice: 50, stackSize: 50 },
    ]);

    // Steel: output 50cr, input 4×5 + 1×3 = 23cr → profit 27cr
    expect(crafting.estimateProfit("recipe_steel")).toBe(27);
  });

  test("estimateProfit returns 0 for unknown recipe", () => {
    expect(crafting.estimateProfit("nonexistent")).toBe(0);
  });

  // ── Recipe Finder ──

  test("findBestRecipe picks most profitable recipe for skill level", () => {
    crafting.loadItems([
      { id: "ore_iron", name: "Iron Ore", category: "ore", description: "", basePrice: 5, stackSize: 100 },
      { id: "ore_carbon", name: "Carbon Ore", category: "ore", description: "", basePrice: 3, stackSize: 100 },
      { id: "ore_copper", name: "Copper Ore", category: "ore", description: "", basePrice: 4, stackSize: 100 },
      { id: "steel_plate", name: "Steel Plate", category: "component", description: "", basePrice: 50, stackSize: 50 },
      { id: "copper_wire", name: "Copper Wire", category: "component", description: "", basePrice: 8, stackSize: 100 },
      { id: "rare_mineral", name: "Rare Mineral", category: "ore", description: "", basePrice: 100, stackSize: 20 },
      { id: "advanced_steel", name: "Advanced Steel", category: "refined", description: "", basePrice: 200, stackSize: 20 },
    ]);

    // With crafting:1 → steel_plate(27) vs copper_wire(5×8 - 2×4 = 32) → copper_wire wins
    const best1 = crafting.findBestRecipe({ crafting: 1 });
    expect(best1).not.toBeNull();
    expect(best1!.id).toBe("recipe_copper_wire"); // 32cr profit vs 27cr

    // With crafting:3 → all available, advanced_steel(200 - 100 - 0) = depends on prices
    const best3 = crafting.findBestRecipe({ crafting: 3 });
    expect(best3).not.toBeNull();
  });

  test("findBestRecipe returns null when no skills match", () => {
    expect(crafting.findBestRecipe({})).toBeNull();
  });

  test("findCraftableNow returns recipe with materials in cargo", () => {
    crafting.loadItems([
      { id: "ore_iron", name: "Iron Ore", category: "ore", description: "", basePrice: 5, stackSize: 100 },
      { id: "ore_carbon", name: "Carbon Ore", category: "ore", description: "", basePrice: 3, stackSize: 100 },
      { id: "ore_copper", name: "Copper Ore", category: "ore", description: "", basePrice: 4, stackSize: 100 },
      { id: "steel_plate", name: "Steel Plate", category: "component", description: "", basePrice: 50, stackSize: 50 },
      { id: "copper_wire", name: "Copper Wire", category: "component", description: "", basePrice: 8, stackSize: 100 },
    ]);

    const ship = makeShip(); // has ore_iron, ore_carbon, ore_copper
    const best = crafting.findCraftableNow(ship, { crafting: 1 });
    expect(best).not.toBeNull();
    // Both steel_plate and copper_wire are craftable; copper_wire is more profitable
    expect(best!.id).toBe("recipe_copper_wire");
  });

  test("findCraftableNow returns null when no materials available", () => {
    const ship = makeShip({ cargo: [] });
    expect(crafting.findCraftableNow(ship, { crafting: 5 })).toBeNull();
  });
});
