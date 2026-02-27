/**
 * Mission runner routine - accepts and completes NPC missions.
 *
 * Loop: browse missions -> accept -> execute objectives -> complete -> repeat
 *
 * Params:
 *   missionTypes?: string[]    - Filter by type ("delivery", "explore", etc.)
 *   minReward?: number         - Minimum credit reward to accept
 *   autoAccept?: boolean       - Auto-accept matching missions (default: true)
 *   hubStation?: string        - Base ID to return to for mission browsing (auto-discovered)
 */

import type { BotContext } from "../bot/types";
import type { Mission } from "../types/game";
import {
  navigateAndDock,
  navigateTo,
  dockAtCurrent,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
} from "./helpers";

export async function* mission_runner(ctx: BotContext): AsyncGenerator<string, void, void> {
  const missionTypes = getParam<string[]>(ctx, "missionTypes", []);
  const minReward = getParam(ctx, "minReward", 0);
  const autoAccept = getParam(ctx, "autoAccept", true);
  let hubStation = getParam(ctx, "hubStation", "");

  // Auto-discover hub station if not set
  if (!hubStation) {
    if (ctx.player.dockedAtBase) {
      hubStation = ctx.player.dockedAtBase;
    } else {
      try {
        const system = await ctx.api.getSystem();
        const station = system.pois.find((p) => p.hasBase);
        if (station?.baseId) hubStation = station.baseId;
      } catch { /* ok */ }
    }
  }

  while (!ctx.shouldStop) {
    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // ── Go to hub station ──
    if (hubStation && ctx.player.dockedAtBase !== hubStation) {
      yield "traveling to mission hub";
      try {
        await navigateAndDock(ctx, hubStation);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    } else if (!ctx.player.dockedAtBase) {
      await dockAtCurrent(ctx);
    }

    if (ctx.shouldStop) return;

    // ── Browse missions ──
    yield "browsing missions";
    let missions: Mission[];
    try {
      missions = await ctx.api.getMissions();
    } catch (err) {
      yield `mission query failed: ${err instanceof Error ? err.message : String(err)}`;
      yield "cycle_complete";
      continue;
    }

    // Filter missions
    let candidates = missions;
    if (missionTypes.length > 0) {
      candidates = candidates.filter((m) => missionTypes.includes(m.type));
    }
    if (minReward > 0) {
      candidates = candidates.filter((m) =>
        m.rewards.some((r) => r.type === "credits" && r.amount >= minReward)
      );
    }

    if (candidates.length === 0) {
      yield "no suitable missions available";
      yield "cycle_complete";
      continue;
    }

    // Sort by reward value
    candidates.sort((a, b) => {
      const rewardA = a.rewards.find((r) => r.type === "credits")?.amount ?? 0;
      const rewardB = b.rewards.find((r) => r.type === "credits")?.amount ?? 0;
      return rewardB - rewardA;
    });

    yield `found ${candidates.length} missions`;

    // ── Accept best mission ──
    const mission = candidates[0];
    if (!autoAccept) {
      yield `best mission: ${mission.title} (${mission.type})`;
      yield "cycle_complete";
      continue;
    }

    yield `accepting: ${mission.title}`;
    try {
      await ctx.api.acceptMission(mission.id);
      await ctx.refreshState();
    } catch (err) {
      yield `accept failed: ${err instanceof Error ? err.message : String(err)}`;
      yield "cycle_complete";
      continue;
    }

    if (ctx.shouldStop) return;

    // ── Execute mission objectives ──
    yield `executing mission: ${mission.title}`;
    try {
      const activeMissions = await ctx.api.getActiveMissions();
      const active = activeMissions.find((m) => m.id === mission.id);

      if (active) {
        for (const obj of active.objectives) {
          if (ctx.shouldStop) break;
          if (obj.complete) continue;
          yield `objective: ${obj.description} (${obj.progress}/${obj.target})`;
        }
      }
    } catch (err) {
      yield `mission execution error: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (ctx.shouldStop) return;

    // ── Complete mission ──
    if (hubStation && ctx.player.dockedAtBase !== hubStation) {
      yield "returning to mission hub";
      try {
        await navigateAndDock(ctx, hubStation);
      } catch {
        yield "return to hub failed";
      }
    }

    yield "completing mission";
    try {
      await ctx.api.completeMission(mission.id);
      await ctx.refreshState();

      const reward = mission.rewards.find((r) => r.type === "credits");
      yield `mission complete! ${reward ? `+${reward.amount}cr` : ""}`;
    } catch (err) {
      yield `completion failed: ${err instanceof Error ? err.message : String(err)}`;
      try {
        await ctx.api.abandonMission(mission.id);
        yield "mission abandoned";
      } catch { /* ok */ }
    }

    // ── Service ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    yield "cycle_complete";
  }
}
