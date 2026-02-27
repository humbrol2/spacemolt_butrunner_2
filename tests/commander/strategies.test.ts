import { describe, test, expect } from "bun:test";
import { getStrategyWeights, getGoalWeights } from "../../src/commander/strategies";

describe("Strategy Weights", () => {
  test("returns balanced weights with no goals", () => {
    const weights = getStrategyWeights([]);
    expect(weights.miner).toBe(1.0);
    expect(weights.trader).toBe(1.0);
    expect(weights.explorer).toBe(1.0);
  });

  test("maximize_income boosts trader and miner", () => {
    const weights = getGoalWeights("maximize_income");
    expect(weights.trader).toBe(1.5);
    expect(weights.miner).toBe(1.3);
    expect(weights.explorer).toBe(0.4);
  });

  test("prepare_for_war boosts hunter and crafter", () => {
    const weights = getGoalWeights("prepare_for_war");
    expect(weights.hunter).toBe(2.0);
    expect(weights.crafter).toBe(1.5);
    expect(weights.explorer).toBe(0.3);
  });

  test("explore_region boosts explorer heavily", () => {
    const weights = getGoalWeights("explore_region");
    expect(weights.explorer).toBe(2.0);
    expect(weights.miner).toBe(0.5);
  });

  test("blends multiple goals by priority", () => {
    const weights = getStrategyWeights([
      { type: "maximize_income", priority: 2 },
      { type: "prepare_for_war", priority: 1 },
    ]);

    // income has 2/3 influence, war has 1/3
    // trader: default * (1 - 2/3) + 1.5 * 2/3 = 0.333 + 1.0 = 1.333
    // Then war: for trader, no override so stays
    // Actually the loop applies each goal's influence on the running weights
    expect(weights.trader).toBeGreaterThan(1.0);
    expect(weights.hunter).toBeGreaterThan(1.0);
  });

  test("single high-priority goal dominates", () => {
    const weights = getStrategyWeights([
      { type: "maximize_income", priority: 10 },
      { type: "explore_region", priority: 1 },
    ]);

    // Income dominates (10/11 = ~91% influence)
    expect(weights.trader).toBeGreaterThan(1.3);
    expect(weights.miner).toBeGreaterThan(1.1);
  });

  test("custom goal type returns defaults", () => {
    const weights = getGoalWeights("custom");
    expect(weights.miner).toBe(1.0);
    expect(weights.trader).toBe(1.0);
  });

  test("resource_stockpile boosts miner and harvester", () => {
    const weights = getGoalWeights("resource_stockpile");
    expect(weights.miner).toBe(1.8);
    expect(weights.harvester).toBe(1.6);
    expect(weights.hunter).toBe(0.5);
  });

  test("establish_trade_route boosts trader", () => {
    const weights = getGoalWeights("establish_trade_route");
    expect(weights.trader).toBe(2.0);
    expect(weights.explorer).toBe(1.2);
  });
});
