/**
 * Station service - dock/undock logic, storage, repair decisions, home base.
 */

import type { PlayerState, ShipState, PoiSummary } from "../types/game";
import type { Galaxy } from "./galaxy";

export class Station {
  constructor(private galaxy: Galaxy) {}

  /** Check if the player is currently docked */
  isDocked(player: PlayerState): boolean {
    return player.dockedAtBase !== null;
  }

  /** Check if the player is at a POI that has a base (can dock) */
  canDock(player: PlayerState): boolean {
    const poi = this.galaxy.getPoi(player.currentPoi);
    return poi?.hasBase === true;
  }

  /** Check if we need repairs (hull below threshold) */
  needsRepair(ship: ShipState, thresholdPct = 50): boolean {
    return ship.maxHull > 0 && (ship.hull / ship.maxHull) * 100 < thresholdPct;
  }

  /** Get hull health as percentage */
  hullPercentage(ship: ShipState): number {
    return ship.maxHull > 0 ? (ship.hull / ship.maxHull) * 100 : 0;
  }

  /** Check if we should repair before undocking */
  shouldRepairBeforeUndock(ship: ShipState, threshold = 80): boolean {
    return this.hullPercentage(ship) < threshold;
  }

  /** Find the station POI at the player's current POI location */
  getStationAtPoi(poiId: string): PoiSummary | null {
    const poi = this.galaxy.getPoi(poiId);
    return poi?.hasBase ? poi : null;
  }

  /** Get all stations the player has set as home base or visited */
  getHomeSystem(player: PlayerState): string | null {
    if (!player.homeBase) return null;
    return this.galaxy.getSystemForBase(player.homeBase);
  }

  /** Check if we're at our home base */
  isAtHomeBase(player: PlayerState): boolean {
    return player.homeBase !== null && player.dockedAtBase === player.homeBase;
  }

  /** Find all dockable stations in a system */
  getStationsInSystem(systemId: string): PoiSummary[] {
    const system = this.galaxy.getSystem(systemId);
    if (!system) return [];
    return system.pois.filter((p) => p.hasBase);
  }

  /**
   * Decide where to dock: prefer home base if close enough,
   * otherwise pick nearest station.
   */
  chooseDockTarget(
    player: PlayerState,
    ship: ShipState,
    maxDetourJumps = 3
  ): { poiId: string; systemId: string } | null {
    // 1. Check current system for stations
    const localStations = this.getStationsInSystem(player.currentSystem);
    if (localStations.length > 0) {
      // Prefer home base if it's here
      const home = localStations.find((s) => s.baseId === player.homeBase);
      if (home) return { poiId: home.id, systemId: player.currentSystem };
      return { poiId: localStations[0].id, systemId: player.currentSystem };
    }

    // 2. Check if home base is within detour range
    if (player.homeBase) {
      const homeSystemId = this.galaxy.getSystemForBase(player.homeBase);
      if (homeSystemId) {
        const dist = this.galaxy.getDistance(player.currentSystem, homeSystemId);
        if (dist >= 0 && dist <= maxDetourJumps) {
          const homeSystem = this.galaxy.getSystem(homeSystemId);
          const homePoi = homeSystem?.pois.find((p) => p.baseId === player.homeBase);
          if (homePoi) return { poiId: homePoi.id, systemId: homeSystemId };
        }
      }
    }

    // 3. Find nearest station anywhere
    const nearest = this.galaxy.findNearestStation(player.currentSystem);
    if (nearest) return { poiId: nearest.poi.id, systemId: nearest.systemId };

    return null;
  }
}
