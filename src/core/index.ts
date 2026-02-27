/**
 * Core services barrel export.
 */

export { Galaxy } from "./galaxy";
export { Navigation, type Route, type RouteStep } from "./navigation";
export { Market, type TradeRoute, type StationPrice } from "./market";
export { Cargo, type CargoSummary, type SellPlan } from "./cargo";
export { Fuel, FUEL_THRESHOLDS, type FuelLevel } from "./fuel";
export { Combat, type ThreatLevel, type ThreatAssessment } from "./combat";
export { Crafting, type CraftingPlan, type ShoppingList, type ChainStep } from "./crafting";
export { Station } from "./station";
export { ApiClient, ApiError, type ApiClientOptions, normalizeRecipe, normalizeCatalogItem } from "./api-client";
