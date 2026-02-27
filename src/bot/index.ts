/**
 * Bot engine barrel export.
 */

export { Bot, type BotDeps } from "./bot";
export { BotManager, type SharedServices, type BotManagerConfig, type ApiClientFactory } from "./bot-manager";
export type { BotContext, Routine, RoutineParams, RoutineRegistry, FleetStatus, FleetBotInfo } from "./types";
