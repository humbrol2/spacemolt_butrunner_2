/**
 * Commander barrel export.
 */

export { Commander, type CommanderConfig, type CommanderDeps } from "./commander";
export { ScoringBrain, type ScoringConfig } from "./scoring-brain";
export { EconomyEngine } from "./economy-engine";
export { getStrategyWeights, getGoalWeights } from "./strategies";
export type {
  CommanderBrain,
  EvaluationInput,
  EvaluationOutput,
  Assignment,
  BotScore,
  StrategyWeights,
  MaterialDemand,
  MaterialSupply,
  SupplyDeficit,
  SupplySurplus,
  InventoryAlert,
  EconomySnapshot,
  ReassignmentState,
} from "./types";
