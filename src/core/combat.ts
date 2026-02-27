/**
 * Combat service - threat assessment, stance selection, battle logic.
 */

import type {
  ShipState,
  BattleStatus,
  BattleParticipant,
  BattleStance,
  NearbyPlayer,
} from "../types/game";
import type { Galaxy } from "./galaxy";

export type ThreatLevel = "safe" | "caution" | "dangerous" | "hostile";

export interface ThreatAssessment {
  level: ThreatLevel;
  policeLevel: number;
  nearbyHostiles: number;
  shouldFlee: boolean;
  reason: string;
}

export class Combat {
  constructor(private galaxy: Galaxy) {}

  /**
   * Assess threat level at current location.
   */
  assessThreat(
    systemId: string,
    ship: ShipState,
    nearby: NearbyPlayer[]
  ): ThreatAssessment {
    const policeLevel = this.galaxy.getSecurityLevel(systemId);
    const hostiles = nearby.filter((p) => p.inCombat || (!p.factionId && policeLevel === 0));
    const nearbyHostiles = hostiles.length;

    // Low hull = dangerous regardless of security
    const hullPct = ship.maxHull > 0 ? (ship.hull / ship.maxHull) * 100 : 0;
    if (hullPct < 30) {
      return { level: "dangerous", policeLevel, nearbyHostiles, shouldFlee: true, reason: "Hull critically low" };
    }

    // High security = safe
    if (policeLevel >= 3 && nearbyHostiles === 0) {
      return { level: "safe", policeLevel, nearbyHostiles, shouldFlee: false, reason: "High security system" };
    }
    if (nearbyHostiles > 0 && policeLevel < 2) {
      return { level: "hostile", policeLevel, nearbyHostiles, shouldFlee: hullPct < 60, reason: `${nearbyHostiles} hostile(s) in lawless space` };
    }

    if (policeLevel === 0) {
      return { level: "caution", policeLevel, nearbyHostiles, shouldFlee: false, reason: "Lawless system" };
    }

    return { level: "safe", policeLevel, nearbyHostiles, shouldFlee: false, reason: "Patrolled system" };
  }

  /**
   * Choose optimal battle stance given current state.
   */
  chooseStance(ship: ShipState, battle: BattleStatus): BattleStance {
    const hullPct = ship.maxHull > 0 ? (ship.hull / ship.maxHull) * 100 : 0;
    const shieldPct = ship.maxShield > 0 ? (ship.shield / ship.maxShield) * 100 : 0;

    // Critical hull - flee
    if (hullPct < 20) return "flee";

    // Low hull - brace for shields
    if (hullPct < 40) return "brace";

    // Good shields - fire
    if (shieldPct > 50) return "fire";

    // Mid-range - evade to recover shields
    if (shieldPct < 20) return "evade";

    return "fire";
  }

  /**
   * Evaluate if we should engage a target.
   */
  shouldEngage(
    ourShip: ShipState,
    target: NearbyPlayer,
    systemId: string
  ): { engage: boolean; reason: string } {
    const policeLevel = this.galaxy.getSecurityLevel(systemId);

    // Don't attack in high-security (police will punish)
    if (policeLevel >= 3) {
      return { engage: false, reason: "High security - police will intervene" };
    }

    // Don't attack faction allies
    if (target.factionId && target.factionId === ourShip.ownerId) {
      return { engage: false, reason: "Faction ally" };
    }

    // Don't engage if hull is low
    const hullPct = ourShip.maxHull > 0 ? (ourShip.hull / ourShip.maxHull) * 100 : 0;
    if (hullPct < 50) {
      return { engage: false, reason: "Hull too low for combat" };
    }

    // Target already in combat - opportunity
    if (target.inCombat) {
      return { engage: true, reason: "Target already in combat - weakened" };
    }

    return { engage: true, reason: "Clear to engage" };
  }

  /**
   * Find the weakest enemy in a battle (best target to focus).
   */
  findWeakestEnemy(battle: BattleStatus, ourPlayerId: string): BattleParticipant | null {
    // Find which side we're on
    let enemySide: BattleParticipant[] = [];
    for (const side of battle.sides) {
      const isOurSide = side.participants.some((p) => p.playerId === ourPlayerId);
      if (!isOurSide) {
        enemySide = [...enemySide, ...side.participants];
      }
    }

    if (enemySide.length === 0) return null;

    // Sort by remaining hull (ascending) - attack weakest first
    enemySide.sort((a, b) => {
      const aHpPct = a.maxHull > 0 ? a.hull / a.maxHull : 0;
      const bHpPct = b.maxHull > 0 ? b.hull / b.maxHull : 0;
      return aHpPct - bHpPct;
    });

    return enemySide[0];
  }

  /** Check if we should flee from battle */
  shouldFlee(ship: ShipState, battle: BattleStatus): boolean {
    const hullPct = ship.maxHull > 0 ? (ship.hull / ship.maxHull) * 100 : 0;
    // Flee if hull critically low
    if (hullPct < 20) return true;
    // Flee if outnumbered significantly
    const ourSide = battle.sides.find((s) => s.participants.some((p) => p.playerId === ship.ownerId));
    const totalEnemies = battle.sides
      .filter((s) => s !== ourSide)
      .reduce((sum, s) => sum + s.participants.length, 0);
    const ourCount = ourSide?.participants.length ?? 0;
    if (totalEnemies > ourCount * 2) return true;
    return false;
  }
}
