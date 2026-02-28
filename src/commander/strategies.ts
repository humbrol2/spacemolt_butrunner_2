/**
 * Goal-specific strategy weight profiles.
 * Each goal type adjusts the scoring multipliers for routine selection.
 */

import type { GoalType } from "../types/config";
import type { StrategyWeights } from "./types";

/** Default balanced weights (no goal active) */
const DEFAULT_WEIGHTS: StrategyWeights = {
  miner: 1.0,
  harvester: 1.0,
  trader: 1.0,
  explorer: 1.0,
  crafter: 1.0,
  hunter: 1.0,
  salvager: 1.0,
  mission_runner: 1.0,
  return_home: 0.1,
  scout: 0.1,
  quartermaster: 0.8,
  ship_upgrade: 1.0,
};

/** Goal-specific weight overrides */
const STRATEGY_PROFILES: Record<GoalType, Partial<StrategyWeights>> = {
  maximize_income: {
    trader: 1.5,
    miner: 1.3,
    crafter: 1.2,
    harvester: 1.1,
    hunter: 0.6,
    explorer: 0.4,
    salvager: 0.8,
    mission_runner: 0.9,
  },
  explore_region: {
    explorer: 2.0,
    miner: 0.5,
    trader: 0.5,
    hunter: 0.7,
    salvager: 0.6,
  },
  prepare_for_war: {
    hunter: 2.0,
    crafter: 1.5,
    salvager: 1.3,
    miner: 1.2,
    trader: 0.8,
    explorer: 0.3,
  },
  level_skills: {
    mission_runner: 1.5,
    crafter: 1.3,
    miner: 1.2,
    hunter: 1.1,
    explorer: 1.1,
    trader: 0.8,
  },
  establish_trade_route: {
    trader: 2.0,
    explorer: 1.2,
    miner: 0.7,
    crafter: 0.8,
    hunter: 0.4,
  },
  resource_stockpile: {
    miner: 1.8,
    harvester: 1.6,
    crafter: 1.0,
    trader: 0.7,
    hunter: 0.5,
    explorer: 0.4,
  },
  faction_operations: {
    hunter: 1.3,
    explorer: 1.2,
    miner: 1.0,
    trader: 1.0,
    crafter: 1.0,
    quartermaster: 1.5,
  },
  custom: {},
};

/**
 * Get the combined strategy weights for active goals.
 * Higher-priority goals have more influence.
 */
export function getStrategyWeights(goals: Array<{ type: GoalType; priority: number }>): StrategyWeights {
  if (goals.length === 0) return { ...DEFAULT_WEIGHTS };

  // Start from defaults
  const weights: StrategyWeights = { ...DEFAULT_WEIGHTS };

  // Total priority for normalization
  const totalPriority = goals.reduce((sum, g) => sum + g.priority, 0);
  if (totalPriority === 0) return weights;

  // Blend goal profiles weighted by priority
  // Routines NOT mentioned in a goal profile get suppressed (treated as 0.3 multiplier)
  const DEFAULT_UNMENTIONED = 0.3;

  for (const goal of goals) {
    const profile = STRATEGY_PROFILES[goal.type];
    const influence = goal.priority / totalPriority;

    for (const key of Object.keys(weights) as Array<keyof StrategyWeights>) {
      const multiplier = (profile[key] as number | undefined) ?? DEFAULT_UNMENTIONED;
      weights[key] = weights[key] * (1 - influence) + multiplier * influence;
    }
  }

  return weights;
}

/**
 * Get strategy weights for a single goal type.
 */
export function getGoalWeights(goalType: GoalType): StrategyWeights {
  return { ...DEFAULT_WEIGHTS, ...STRATEGY_PROFILES[goalType] };
}
