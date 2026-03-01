/**
 * Galaxy service - star system graph, pathfinding, POI lookups.
 * Loads the map from cache once and provides fast in-memory queries.
 */

import type { StarSystem, PoiSummary, PoiType, Empire } from "../types/game";

interface SystemNode {
  system: StarSystem;
  neighbors: string[]; // system IDs
}

export class Galaxy {
  private graph = new Map<string, SystemNode>();
  private poiIndex = new Map<string, { systemId: string; poi: PoiSummary }>();
  private baseToSystem = new Map<string, string>(); // baseId → systemId
  /** Dirty flag: set when galaxy data changes, cleared after broadcast */
  dirty = true;

  /** Load systems into the graph. Preserves existing non-zero coordinates (layout-generated). */
  load(systems: StarSystem[]): void {
    // Preserve existing layout coordinates before clearing
    const oldCoords = new Map<string, { x: number; y: number }>();
    for (const node of this.graph.values()) {
      if (node.system.x !== 0 || node.system.y !== 0) {
        oldCoords.set(node.system.id, { x: node.system.x, y: node.system.y });
      }
    }

    this.graph.clear();
    this.poiIndex.clear();
    this.baseToSystem.clear();

    for (let sys of systems) {
      // Preserve generated layout coordinates when API returns (0,0)
      const old = oldCoords.get(sys.id);
      if (sys.x === 0 && sys.y === 0 && old) {
        sys = { ...sys, x: old.x, y: old.y };
      }
      this.addSystemToGraph(sys);
    }
    this.dirty = true;
  }

  /** Update or add a single system with full detail (POIs, connections). */
  updateSystem(sys: StarSystem): void {
    // Remove old POI/base entries for this system
    const existing = this.graph.get(sys.id);
    if (existing) {
      // Preserve generated layout coordinates when API returns (0,0)
      if (sys.x === 0 && sys.y === 0 && (existing.system.x !== 0 || existing.system.y !== 0)) {
        sys = { ...sys, x: existing.system.x, y: existing.system.y };
      }
      for (const poi of existing.system.pois) {
        this.poiIndex.delete(poi.id);
        if (poi.baseId) this.baseToSystem.delete(poi.baseId);
      }
    }
    this.addSystemToGraph(sys);
    this.dirty = true;
  }

  private addSystemToGraph(sys: StarSystem): void {
    if (!sys.id) return; // skip empty IDs from minimal map data
    this.graph.set(sys.id, { system: sys, neighbors: sys.connections });
    for (const poi of sys.pois) {
      this.poiIndex.set(poi.id, { systemId: sys.id, poi });
      if (poi.baseId) {
        this.baseToSystem.set(poi.baseId, sys.id);
      }
    }
  }

  get systemCount(): number {
    return this.graph.size;
  }

  get poiCount(): number {
    return this.poiIndex.size;
  }

  /** Export all systems as dashboard-friendly summaries */
  toSummaries(): Array<{
    id: string;
    name: string;
    x: number;
    y: number;
    empire: string;
    policeLevel: number;
    connections: string[];
    poiCount: number;
    visited: boolean;
    pois: Array<{ id: string; name: string; type: string; hasBase: boolean; baseName: string | null; resources: Array<{ resourceId: string; richness: number; remaining: number }> }>;
  }> {
    const results = [];
    for (const node of this.graph.values()) {
      const sys = node.system;
      results.push({
        id: sys.id,
        name: sys.name,
        x: sys.x ?? 0,
        y: sys.y ?? 0,
        empire: sys.empire ?? "neutral",
        policeLevel: sys.policeLevel ?? 0,
        connections: sys.connections,
        poiCount: sys.poiCount || sys.pois.length,
        visited: sys.visited || sys.pois.length > 0,
        pois: sys.pois.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          hasBase: p.hasBase,
          baseName: p.baseName ?? null,
          resources: (p.resources ?? []).map((r) => ({
            resourceId: r.resourceId,
            richness: r.richness,
            remaining: r.remaining,
          })),
        })),
      });
    }
    return results;
  }

  /** Check if all systems lack meaningful coordinates (all at origin) */
  get allCoordsZero(): boolean {
    if (this.graph.size <= 1) return false;
    for (const node of this.graph.values()) {
      if (node.system.x !== 0 || node.system.y !== 0) return false;
    }
    return true;
  }

  /**
   * Generate force-directed layout positions when the API doesn't provide coordinates.
   * Updates x/y on each system in-place.
   */
  generateLayout(): void {
    const nodes = Array.from(this.graph.values());
    if (nodes.length === 0) return;

    // Initialize positions: first node at center, rest in a circle
    const positions = new Map<string, { x: number; y: number }>();
    const radius = nodes.length * 30;
    for (let i = 0; i < nodes.length; i++) {
      const angle = (2 * Math.PI * i) / nodes.length;
      positions.set(nodes[i].system.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }

    // Force-directed iterations
    const repulsion = 50000;
    const attraction = 0.01;
    const damping = 0.85;
    const iterations = 300;

    for (let iter = 0; iter < iterations; iter++) {
      const forces = new Map<string, { fx: number; fy: number }>();
      for (const n of nodes) forces.set(n.system.id, { fx: 0, fy: 0 });

      // Repulsive forces (all pairs)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = positions.get(nodes[i].system.id)!;
          const b = positions.get(nodes[j].system.id)!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulsion / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          forces.get(nodes[i].system.id)!.fx += fx;
          forces.get(nodes[i].system.id)!.fy += fy;
          forces.get(nodes[j].system.id)!.fx -= fx;
          forces.get(nodes[j].system.id)!.fy -= fy;
        }
      }

      // Attractive forces (connected pairs)
      for (const node of nodes) {
        const pos = positions.get(node.system.id)!;
        for (const neighbor of node.neighbors) {
          const nPos = positions.get(neighbor);
          if (!nPos) continue;
          const dx = nPos.x - pos.x;
          const dy = nPos.y - pos.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = dist * attraction;
          forces.get(node.system.id)!.fx += (dx / dist) * force;
          forces.get(node.system.id)!.fy += (dy / dist) * force;
        }
      }

      // Apply forces with damping
      const temp = 1 - iter / iterations; // cooling
      for (const node of nodes) {
        const pos = positions.get(node.system.id)!;
        const f = forces.get(node.system.id)!;
        pos.x += f.fx * damping * temp;
        pos.y += f.fy * damping * temp;
      }
    }

    // Apply positions to systems
    for (const node of nodes) {
      const pos = positions.get(node.system.id)!;
      node.system.x = Math.round(pos.x);
      node.system.y = Math.round(pos.y);
    }

    console.log(`[Galaxy] Generated force-directed layout for ${nodes.length} systems`);
  }

  // ── Lookups ──

  getSystem(id: string): StarSystem | null {
    return this.graph.get(id)?.system ?? null;
  }

  getSystemByName(name: string): StarSystem | null {
    for (const node of this.graph.values()) {
      if (node.system.name.toLowerCase() === name.toLowerCase()) return node.system;
    }
    return null;
  }

  getAllSystems(): StarSystem[] {
    return Array.from(this.graph.values()).map((n) => n.system);
  }

  getNeighbors(systemId: string): StarSystem[] {
    const node = this.graph.get(systemId);
    if (!node) return [];
    return node.neighbors
      .map((id) => this.graph.get(id)?.system)
      .filter((s): s is StarSystem => s !== undefined);
  }

  /** Find which system a POI belongs to */
  getSystemForPoi(poiId: string): string | null {
    return this.poiIndex.get(poiId)?.systemId ?? null;
  }

  /** Find which system a base belongs to */
  getSystemForBase(baseId: string): string | null {
    return this.baseToSystem.get(baseId) ?? null;
  }

  getPoi(poiId: string): PoiSummary | null {
    return this.poiIndex.get(poiId)?.poi ?? null;
  }

  /** Update a POI's resource data from a detailed getPoi() response */
  updatePoiResources(poiId: string, resources: Array<{ resourceId: string; richness: number; remaining: number }>): void {
    const entry = this.poiIndex.get(poiId);
    if (entry) {
      entry.poi.resources = resources;
    }
  }

  // ── Queries ──

  /** Find all POIs of a given type across the galaxy */
  findPoisByType(type: PoiType): Array<{ systemId: string; poi: PoiSummary }> {
    const results: Array<{ systemId: string; poi: PoiSummary }> = [];
    for (const [, entry] of this.poiIndex) {
      if (entry.poi.type === type) results.push(entry);
    }
    return results;
  }

  /** Find all stations (POIs with bases) */
  findStations(): Array<{ systemId: string; poi: PoiSummary }> {
    const results: Array<{ systemId: string; poi: PoiSummary }> = [];
    for (const [, entry] of this.poiIndex) {
      if (entry.poi.hasBase) results.push(entry);
    }
    return results;
  }

  /** Find systems belonging to an empire */
  findEmpireSystems(empire: Empire): StarSystem[] {
    return this.getAllSystems().filter((s) => s.empire === empire);
  }

  /** Get police level for a system (0 = lawless, higher = safer) */
  getSecurityLevel(systemId: string): number {
    return this.graph.get(systemId)?.system.policeLevel ?? 0;
  }

  // ── Pathfinding (BFS - unweighted shortest path) ──

  /**
   * Find shortest path between two systems (by jump count).
   * Returns array of system IDs from start to end (inclusive), or null if unreachable.
   */
  findPath(fromSystemId: string, toSystemId: string): string[] | null {
    if (fromSystemId === toSystemId) return [fromSystemId];
    if (!this.graph.has(fromSystemId) || !this.graph.has(toSystemId)) return null;

    const visited = new Set<string>([fromSystemId]);
    const parent = new Map<string, string>();
    const queue: string[] = [fromSystemId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.graph.get(current);
      if (!node) continue;

      for (const neighbor of node.neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parent.set(neighbor, current);

        if (neighbor === toSystemId) {
          // Reconstruct path
          const path: string[] = [neighbor];
          let step = neighbor;
          while (parent.has(step)) {
            step = parent.get(step)!;
            path.unshift(step);
          }
          return path;
        }

        queue.push(neighbor);
      }
    }

    return null; // Unreachable
  }

  /** Get hop count between two systems, or -1 if unreachable */
  getDistance(fromSystemId: string, toSystemId: string): number {
    const path = this.findPath(fromSystemId, toSystemId);
    return path ? path.length - 1 : -1;
  }

  /**
   * Find nearest system/POI matching a predicate.
   * BFS from startSystem, returns first match.
   */
  findNearest(
    startSystemId: string,
    predicate: (system: StarSystem) => boolean
  ): { system: StarSystem; path: string[] } | null {
    if (!this.graph.has(startSystemId)) return null;

    const startSystem = this.graph.get(startSystemId)!.system;
    if (predicate(startSystem)) return { system: startSystem, path: [startSystemId] };

    const visited = new Set<string>([startSystemId]);
    const parent = new Map<string, string>();
    const queue: string[] = [startSystemId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = this.graph.get(current);
      if (!node) continue;

      for (const neighbor of node.neighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        parent.set(neighbor, current);

        const neighborSystem = this.graph.get(neighbor)!.system;
        if (predicate(neighborSystem)) {
          const path: string[] = [neighbor];
          let step = neighbor;
          while (parent.has(step)) {
            step = parent.get(step)!;
            path.unshift(step);
          }
          return { system: neighborSystem, path };
        }

        queue.push(neighbor);
      }
    }

    return null;
  }

  /** Find nearest station from a system */
  findNearestStation(fromSystemId: string): { systemId: string; poi: PoiSummary; distance: number } | null {
    const result = this.findNearest(fromSystemId, (sys) =>
      sys.pois.some((p) => p.hasBase)
    );
    if (!result) return null;

    const stationPoi = result.system.pois.find((p) => p.hasBase)!;
    return {
      systemId: result.system.id,
      poi: stationPoi,
      distance: result.path.length - 1,
    };
  }

  /** Find nearest asteroid belt (or ice field, gas cloud, etc.) */
  findNearestResource(fromSystemId: string, poiType: PoiType): { systemId: string; poi: PoiSummary; distance: number } | null {
    const result = this.findNearest(fromSystemId, (sys) =>
      sys.pois.some((p) => p.type === poiType)
    );
    if (!result) return null;

    const resourcePoi = result.system.pois.find((p) => p.type === poiType)!;
    return {
      systemId: result.system.id,
      poi: resourcePoi,
      distance: result.path.length - 1,
    };
  }
}
