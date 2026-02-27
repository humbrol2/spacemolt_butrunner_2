/**
 * Configuration types with Zod validation.
 */

import { z } from "zod";

// ── Goal Types ──

export const GoalTypeSchema = z.enum([
  "maximize_income",
  "explore_region",
  "prepare_for_war",
  "level_skills",
  "establish_trade_route",
  "resource_stockpile",
  "faction_operations",
  "custom",
]);

export type GoalType = z.infer<typeof GoalTypeSchema>;

export const GoalSchema = z.object({
  type: GoalTypeSchema,
  priority: z.number().int().min(1),
  params: z.record(z.unknown()).default({}),
  constraints: z
    .object({
      maxRiskLevel: z.number().int().min(0).max(4).optional(),
      regionLock: z.array(z.string()).optional(),
      budgetLimit: z.number().optional(),
    })
    .optional(),
});

export type Goal = z.infer<typeof GoalSchema>;

// ── Commander Config ──

export const CommanderConfigSchema = z.object({
  brain: z.enum(["scoring", "llm", "hybrid"]).default("scoring"),
  evaluation_interval: z.number().default(60),
  reassignment_cooldown: z.number().default(300),
  reassignment_threshold: z.number().default(0.3),
  switch_cost_weight: z.number().default(1.0),
  urgency_override: z.boolean().default(true),
});

// ── Fleet Config ──

export const FleetConfigSchema = z.object({
  max_bots: z.number().int().default(20),
  login_stagger_ms: z.number().default(5000),
  snapshot_interval: z.number().default(30),
  /** Fleet home system ID (bots return here for deposits) */
  home_system: z.string().default(""),
  /** Fleet home base/station ID (shared storage hub) */
  home_base: z.string().default(""),
  /** Default cargo disposal mode for all bots */
  default_storage_mode: z.enum(["sell", "deposit", "faction_deposit"]).default("sell"),
  /** Specific station for faction storage deposits (if different from home_base) */
  faction_storage_station: z.string().default(""),
  /** Percent of profit to deposit into faction treasury (0-100, default 0) */
  faction_tax_percent: z.number().min(0).max(100).default(0),
  /** Minimum credits a bot should maintain — withdraws from faction if below (0 = disabled) */
  min_bot_credits: z.number().min(0).default(0),
});

// ── Cache Config ──

export const CacheConfigSchema = z.object({
  market_ttl_ms: z.number().default(300_000),
  system_ttl_ms: z.number().default(3_600_000),
  catalog_refresh: z.enum(["on_version_change", "daily"]).default("on_version_change"),
});

// ── Server Config ──

export const ServerConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default("localhost"),
});

// ── Training Config ──

export const TrainingConfigSchema = z.object({
  log_decisions: z.boolean().default(true),
  log_snapshots: z.boolean().default(true),
  log_episodes: z.boolean().default(true),
  log_market_history: z.boolean().default(true),
  snapshot_interval: z.number().default(30),
});

// ── Economy Config ──

export const EconomyConfigSchema = z.object({
  enable_premium_orders: z.boolean().default(true),
  max_premium_pct: z.number().default(50),
  min_crafting_margin_pct: z.number().default(30),
  batch_sell_size: z.number().default(100),
  order_stale_timeout_min: z.number().default(120),
});

// ── Inventory Target ──

export const StockTargetSchema = z.object({
  station_id: z.string(),
  item_id: z.string(),
  min_stock: z.number().int().min(0),
  max_stock: z.number().int().min(0),
  purpose: z.enum(["crafting", "trading", "fuel", "ammo", "strategic"]),
});

export type StockTarget = z.infer<typeof StockTargetSchema>;

// ── Full Config ──

export const AppConfigSchema = z.object({
  commander: CommanderConfigSchema.default({}),
  goals: z.array(GoalSchema).default([]),
  fleet: FleetConfigSchema.default({}),
  cache: CacheConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  training: TrainingConfigSchema.default({}),
  economy: EconomyConfigSchema.default({}),
  inventory_targets: z.array(StockTargetSchema).default([]),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
