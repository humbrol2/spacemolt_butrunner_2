/**
 * Explorer routine - charts systems, catalogs POIs, discovers resources.
 *
 * Prioritizes:
 * 1. Systems with stations that have stale market data (>15 min)
 * 2. Systems not yet explored (no POI data in galaxy graph)
 * 3. Connected systems in round-robin order
 *
 * Loop: jump to system -> scan POIs -> dock at bases (refreshes market) -> submit intel -> next
 *
 * Params:
 *   targetSystems: string[]   - System IDs to explore (auto-discovered if empty)
 *   submitIntel?: boolean     - Submit findings to faction
 *   useCloaking?: boolean     - Enable stealth mode
 *   explorerIndex?: number    - For deconfliction when multiple explorers
 */

import type { BotContext } from "../bot/types";
import {
  navigateTo,
  dockAtCurrent,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
} from "./helpers";

/** Threshold in ms: stations with data older than this get priority */
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

export async function* explorer(ctx: BotContext): AsyncGenerator<string, void, void> {
  const submitIntel = getParam(ctx, "submitIntel", false);
  const useCloaking = getParam(ctx, "useCloaking", false);
  const explorerIndex = getParam(ctx, "explorerIndex", 0);
  const initialTargets = getParam<string[]>(ctx, "targetSystems", []);

  // Enable cloaking if requested
  if (useCloaking) {
    try {
      await ctx.api.cloak(true);
      yield "cloaking enabled";
    } catch (err) {
      yield `cloaking failed (${err instanceof Error ? err.message : String(err)}), continuing uncloaked`;
    }
  }

  // ── Continuous exploration loop ──
  // Keep discovering and exploring systems until Commander reassigns
  while (!ctx.shouldStop) {
    let targetSystems = [...initialTargets];

    // Auto-discover target systems if none specified (or re-discover each cycle)
    if (targetSystems.length === 0) {
      yield "planning exploration route...";
      try {
        const currentSystem = await ctx.api.getSystem();

        // Gather all connected system IDs
        const connectedIds = currentSystem.connections?.length
          ? [...currentSystem.connections]
          : [currentSystem.id];

        // Score each system: stale market = highest priority, unexplored = medium
        const scored: Array<{ systemId: string; score: number; reason: string }> = [];

        for (const sysId of connectedIds) {
          let score = 0;
          let reason = "";

          // Check if this system has stations with stale market data
          const sys = ctx.galaxy.getSystem(sysId);
          if (sys) {
            for (const poi of sys.pois) {
              if (poi.hasBase && poi.baseId) {
                const freshness = ctx.cache.getMarketFreshness(poi.baseId);
                if (freshness.fetchedAt === 0) {
                  // Never scanned — high priority
                  score += 30;
                  reason = "unscanned station";
                } else if (!freshness.fresh || freshness.ageMs > STALE_THRESHOLD_MS) {
                  // Stale data — priority refresh
                  const ageMin = Math.round(freshness.ageMs / 60_000);
                  score += 20;
                  reason = `stale market (${ageMin}m)`;
                }
              }
            }

            // No POI data = unexplored system
            if (sys.pois.length === 0) {
              score += 15;
              reason = reason || "unexplored";
            }
          } else {
            // System not even in galaxy graph
            score += 25;
            reason = "unknown system";
          }

          // Small base score so everything gets visited eventually
          score += 1;
          scored.push({ systemId: sysId, score, reason });
        }

        // Sort by score descending (highest priority first)
        scored.sort((a, b) => b.score - a.score);

        // Split among explorers (in case of multiple, though now capped at 1)
        const totalExplorers = Math.max(1, explorerIndex + 1);
        const chunkSize = Math.max(1, Math.ceil(scored.length / totalExplorers));
        const start = explorerIndex * chunkSize;
        const chunk = scored.slice(start, start + chunkSize);
        if (chunk.length === 0 && scored.length > 0) {
          // Wrap around
          targetSystems = scored.slice(0, chunkSize).map((s) => s.systemId);
        } else {
          targetSystems = chunk.map((s) => s.systemId);
        }

        // Log what we're prioritizing
        const staleCount = scored.filter((s) => s.score >= 20).length;
        const unexploredCount = scored.filter((s) => s.reason.includes("unexplored") || s.reason.includes("unknown")).length;
        if (staleCount > 0) {
          yield `${staleCount} station(s) need market refresh`;
        }
        if (unexploredCount > 0) {
          yield `${unexploredCount} unexplored system(s)`;
        }
        yield `exploring ${targetSystems.length} systems (group ${explorerIndex + 1}/${totalExplorers})`;
      } catch (err) {
        yield `discovery error: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }

    if (targetSystems.length === 0) {
      yield "no systems to explore, waiting";
      yield "cycle_complete";
      return;
    }

  for (const systemId of targetSystems) {
    if (ctx.shouldStop) break;

    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) {
        yield "emergency unresolved, stopping";
        return;
      }
    }

    // ── Navigate to system ──
    yield `jumping to ${systemId}`;
    try {
      await navigateTo(ctx, systemId);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (ctx.shouldStop) break;

    // ── Survey system ──
    yield `surveying ${systemId}`;
    try {
      const systemInfo = await ctx.api.getSystem();

      // Save system detail to galaxy graph + cache
      if (systemInfo.id) {
        ctx.galaxy.updateSystem(systemInfo);
        ctx.cache.setSystemDetail(systemInfo.id, systemInfo);
      }

      yield `found ${systemInfo.pois.length} POIs in ${systemInfo.name}`;

      // Visit each POI — prioritize bases with stale market data
      const pois = [...systemInfo.pois].sort((a, b) => {
        // Bases with stale/no market data come first
        if (a.hasBase && !b.hasBase) return -1;
        if (!a.hasBase && b.hasBase) return 1;
        if (a.hasBase && b.hasBase && a.baseId && b.baseId) {
          const freshA = ctx.cache.getMarketFreshness(a.baseId);
          const freshB = ctx.cache.getMarketFreshness(b.baseId);
          return freshA.fetchedAt - freshB.fetchedAt; // Oldest first
        }
        return 0;
      });

      let poiDataUpdated = false;
      for (const poi of pois) {
        if (ctx.shouldStop) break;

        yield `scanning ${poi.name}`;
        try {
          await ctx.api.travel(poi.id);
          await ctx.refreshState();

          // Get detailed POI info and save resources to galaxy graph
          const detail = await ctx.api.getPoi();
          if (detail.resources.length > 0) {
            ctx.galaxy.updatePoiResources(poi.id, detail.resources);
            poiDataUpdated = true;

            // Report belt content in detail for mining/harvesting intelligence
            const isBelt = poi.type === "asteroid_belt" || poi.type === "gas_cloud"
              || poi.type === "ice_field" || poi.type === "asteroid" || poi.type === "nebula";
            if (isBelt) {
              const resourceList = detail.resources
                .filter((r) => r.remaining > 0)
                .sort((a, b) => b.remaining - a.remaining)
                .map((r) => `${r.resourceId}:${r.remaining}(${r.richness > 0 ? `rich:${r.richness}` : "depleted"})`)
                .join(", ");
              if (resourceList) {
                yield `${poi.name} resources: ${resourceList}`;
              } else {
                yield `${poi.name}: depleted`;
              }
            } else {
              yield `${poi.name}: ${poi.type}, ${detail.resources.length} resources`;
            }
          } else {
            yield `${poi.name}: ${poi.type}, no resources`;
          }

          // Dock at bases to catalog them (dockAtCurrent auto-refuels + scans market)
          if (poi.hasBase) {
            try {
              await dockAtCurrent(ctx);
              yield `${poi.baseName}: docked and scanned`;

              await ctx.api.undock();
              await ctx.refreshState();
            } catch (err) {
              yield `could not dock at ${poi.baseName}: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        } catch (err) {
          yield `scan error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Persist updated system (with POI resources) to cache
      if (poiDataUpdated && systemInfo.id) {
        const updatedSystem = ctx.galaxy.getSystem(systemInfo.id);
        if (updatedSystem) {
          ctx.cache.setSystemDetail(systemInfo.id, updatedSystem);
        }
      }

      // Deep survey
      try {
        await ctx.api.surveySystem();
        yield `deep survey of ${systemInfo.name} complete`;
      } catch (err) {
        yield `survey unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }

      // Submit intel to faction (requires faction_intel facility at a base)
      if (submitIntel && ctx.player.factionId) {
        try {
          await ctx.api.factionSubmitIntel([{
            system_id: systemInfo.id,
            name: systemInfo.name,
            empire: systemInfo.empire,
            police_level: systemInfo.policeLevel,
            pois: systemInfo.pois.map((p) => ({
              id: p.id,
              name: p.name,
              type: p.type,
              has_base: p.hasBase,
              base_id: p.baseId,
              base_name: p.baseName,
            })),
            connections: systemInfo.connections,
          }]);
          yield "intel submitted to faction";
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("facility") || msg.includes("intel")) {
            yield `intel not available (needs faction_intel facility)`;
          } else {
            yield `intel submission failed: ${msg}`;
          }
        }
      }
    } catch (err) {
      yield `survey error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Refuel if we can dock somewhere
    if (ctx.player.dockedAtBase) {
      await refuelIfNeeded(ctx);
      await repairIfNeeded(ctx);
    }
  }

    yield "cycle_complete";

    // If initial targets were specified (not auto-discovered), don't loop
    if (initialTargets.length > 0) break;
  } // end outer while loop

  // Disable cloaking
  if (useCloaking) {
    try {
      await ctx.api.cloak(false);
    } catch { /* ok */ }
  }

  yield "exploration complete";
}
