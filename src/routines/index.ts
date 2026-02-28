/**
 * Routines barrel export and registry builder.
 */

import type { RoutineRegistry } from "../bot/types";

import { miner } from "./miner";
import { harvester } from "./harvester";
import { trader } from "./trader";
import { explorer } from "./explorer";
import { crafter } from "./crafter";
import { hunter } from "./hunter";
import { salvager } from "./salvager";
import { mission_runner } from "./mission_runner";
import { returnHome } from "./return_home";
import { scout } from "./scout";
import { quartermaster } from "./quartermaster";
import { ship_upgrade } from "./ship_upgrade";

export { miner } from "./miner";
export { harvester } from "./harvester";
export { trader } from "./trader";
export { explorer } from "./explorer";
export { crafter } from "./crafter";
export { hunter } from "./hunter";
export { salvager } from "./salvager";
export { mission_runner } from "./mission_runner";
export { returnHome } from "./return_home";
export { scout } from "./scout";
export { quartermaster } from "./quartermaster";
export { ship_upgrade } from "./ship_upgrade";

/** Build the complete routine registry with all 12 routines. */
export function buildRoutineRegistry(): RoutineRegistry {
  return {
    miner,
    harvester,
    trader,
    explorer,
    crafter,
    hunter,
    salvager,
    mission_runner,
    return_home: returnHome,
    scout,
    quartermaster,
    ship_upgrade,
  };
}
