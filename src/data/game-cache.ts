/**
 * Game data cache with version-gated static data and TTL-based timed data.
 * Wraps CacheHelper with game-specific logic.
 */

import type { CacheHelper } from "./database";
import type { ApiClient } from "../core/api-client";
import { normalizeRecipe, normalizeCatalogItem, normalizeShipClass } from "../core/api-client";
import type { TrainingLogger } from "./training-logger";
import type { StarSystem, CatalogItem, ShipClass, Skill, Recipe, MarketPrice } from "../types/game";

/** Market freshness info for a station */
export interface MarketFreshness {
  stationId: string;
  fetchedAt: number;
  ageMs: number;
  fresh: boolean;
}

export class GameCache {
  private gameVersion: string = "unknown";
  /** Tracks when each station's market was last cached (in-memory, survives cache expiry) */
  private marketFetchedAt = new Map<string, number>();

  constructor(
    private cache: CacheHelper,
    private logger: TrainingLogger
  ) {}

  /** Initialize cache - fetch game version and populate static data if needed */
  async initialize(api: ApiClient): Promise<void> {
    const { version } = await api.getVersion();
    this.gameVersion = version;
    this.logger.setGameVersion(version);
    console.log(`[Cache] Game version: ${version}`);
  }

  get version(): string {
    return this.gameVersion;
  }

  // ── Galaxy Map (static, version-gated) ──

  async getMap(api: ApiClient): Promise<StarSystem[]> {
    // Ensure we have the game version before accessing version-gated cache
    if (this.gameVersion === "unknown") {
      try {
        await this.initialize(api);
      } catch (err) {
        console.warn("[Cache] Failed to initialize game version:", err instanceof Error ? err.message : err);
      }
    }

    // Always check for stale/incomplete cache and purge it
    // Check ANY version's cache — not just "unknown"
    const anyCache = this.cache.getStatic("galaxy_map");
    if (anyCache) {
      const systems = JSON.parse(anyCache) as StarSystem[];
      const hasCoords = systems.some((s) => s.x !== 0 || s.y !== 0);
      if (hasCoords && systems.length >= 50) {
        console.log(`[Cache] Galaxy from cache: ${systems.length} systems (with coordinates)`);
        return systems;
      }
      // Stale or incomplete — nuke it
      console.log(`[Cache] Galaxy cache stale: ${systems.length} systems (need 50+, coords=${hasCoords}) — deleting`);
      this.cache.deleteStatic("galaxy_map");
    }

    console.log("[Cache] Fetching galaxy map from API...");
    const systems = await api.getMap();
    console.log(`[Cache] API returned ${systems.length} systems`);
    // Only cache if we got a substantial map with valid coordinates
    const hasCoords = systems.some((s) => s.x !== 0 || s.y !== 0);
    if (hasCoords && systems.length >= 50) {
      this.cache.setStatic("galaxy_map", JSON.stringify(systems), this.gameVersion);
      console.log(`[Cache] Cached ${systems.length} systems (v${this.gameVersion})`);
    } else {
      console.warn(`[Cache] NOT caching: ${systems.length} systems, coords=${hasCoords} — will retry next load`);
    }
    return systems;
  }

  // ── Catalogs (static, version-gated) ──

  async getItemCatalog(api: ApiClient): Promise<CatalogItem[]> {
    const cacheKey = "item_catalog";
    const cached = this.cache.getStatic(cacheKey, this.gameVersion);
    if (cached) {
      const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
      if (raw.length >= 50) return raw.map(normalizeCatalogItem);
      // Stale/incomplete cache — re-fetch
      console.log(`[Cache] Item catalog only has ${raw.length} items, re-fetching...`);
    }

    // Fetch all categories — game API may only return a subset without category filter
    const categories = ["ore", "refined", "component", "module", "artifact", "fuel", "ammo", "equipment"];
    const allItems: Record<string, unknown>[] = [];
    const seenIds = new Set<string>();

    // First: fetch without category (gets whatever default returns)
    const defaultItems = await this.fetchAllCatalogPages(api, "items");
    for (const item of defaultItems) {
      const id = String(item.id ?? item.item_id ?? "");
      if (id && !seenIds.has(id)) { seenIds.add(id); allItems.push(item); }
    }

    // Then: fetch each category separately to catch anything missed
    for (const category of categories) {
      const catItems = await this.fetchAllCatalogPages(api, "items", category);
      for (const item of catItems) {
        const id = String(item.id ?? item.item_id ?? "");
        if (id && !seenIds.has(id)) { seenIds.add(id); allItems.push(item); }
      }
    }

    const normalized = allItems.map(normalizeCatalogItem);
    this.cache.setStatic(cacheKey, JSON.stringify(normalized), this.gameVersion);
    console.log(`[Cache] Cached ${normalized.length} items (${categories.length} categories searched)`);
    return normalized;
  }

  async getShipCatalog(api: ApiClient): Promise<ShipClass[]> {
    return this.getCatalogNormalized(api, "ships", "ship_catalog", normalizeShipClass);
  }

  async getSkillTree(api: ApiClient): Promise<Skill[]> {
    return this.getCatalog<Skill>(api, "skills", "skill_tree");
  }

  async getRecipes(api: ApiClient): Promise<Recipe[]> {
    return this.getCatalogNormalized(api, "recipes", "recipe_catalog", normalizeRecipe);
  }

  /** Generic catalog fetch without normalization (ships, skills) */
  private async getCatalog<T>(api: ApiClient, type: string, cacheKey: string): Promise<T[]> {
    const cached = this.cache.getStatic(cacheKey, this.gameVersion);
    if (cached) return JSON.parse(cached);

    const items = await this.fetchAllCatalogPages(api, type);
    this.cache.setStatic(cacheKey, JSON.stringify(items), this.gameVersion);
    console.log(`[Cache] Cached ${items.length} ${type}`);
    return items as T[];
  }

  /** Catalog fetch with normalizer (recipes, items) */
  private async getCatalogNormalized<T>(
    api: ApiClient,
    type: string,
    cacheKey: string,
    normalize: (raw: Record<string, unknown>) => T,
  ): Promise<T[]> {
    const cached = this.cache.getStatic(cacheKey, this.gameVersion);
    if (cached) {
      // Re-normalize on read to handle both raw and pre-normalized cached data
      const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
      return raw.map(normalize);
    }

    const raw = await this.fetchAllCatalogPages(api, type);
    const normalized = raw.map(normalize);
    this.cache.setStatic(cacheKey, JSON.stringify(normalized), this.gameVersion);
    console.log(`[Cache] Cached ${normalized.length} ${type}`);
    return normalized;
  }

  private async fetchAllCatalogPages(api: ApiClient, type: string, category?: string): Promise<Record<string, unknown>[]> {
    console.log(`[Cache] Fetching ${type} catalog${category ? ` (category: ${category})` : ""}...`);
    const items: Record<string, unknown>[] = [];
    let page = 1;
    while (true) {
      const batch = await api.catalog(type, { page, pageSize: 50, category });
      if (batch.length === 0) break;
      items.push(...batch);
      if (batch.length < 50) break;
      page++;
    }
    return items;
  }

  // ── Market Prices (timed cache, 5 min TTL) ──

  getMarketPrices(stationId: string): MarketPrice[] | null {
    const cached = this.cache.getTimed(`market:${stationId}`);
    if (!cached) return null;
    return JSON.parse(cached);
  }

  setMarketPrices(stationId: string, prices: MarketPrice[], tick: number, ttlMs = 1_800_000): void {
    this.cache.setTimed(`market:${stationId}`, JSON.stringify(prices), ttlMs);
    this.marketFetchedAt.set(stationId, Date.now());

    // Also log to market history for training data
    this.logger.logMarketPrices(
      tick,
      stationId,
      prices.map((p) => ({
        itemId: p.itemId,
        buyPrice: p.buyPrice,
        sellPrice: p.sellPrice,
        buyVolume: p.buyVolume,
        sellVolume: p.sellVolume,
      }))
    );
  }

  // ── System Details (timed cache, 1 hr TTL) ──

  getSystemDetail(systemId: string): StarSystem | null {
    const cached = this.cache.getTimed(`system:${systemId}`);
    if (!cached) return null;
    return JSON.parse(cached);
  }

  setSystemDetail(systemId: string, system: StarSystem, ttlMs = 3_600_000): void {
    this.cache.setTimed(`system:${systemId}`, JSON.stringify(system), ttlMs);
    // Also persist permanently so system POI data survives restarts
    this.cache.setStatic(`system_detail:${systemId}`, JSON.stringify(system), "persistent");
  }

  /** Load all permanently cached system details (populated as bots visit systems) */
  loadPersistedSystemDetails(): StarSystem[] {
    const entries = this.cache.getAllByPrefix("system_detail:");
    return entries.map((e) => JSON.parse(e.data) as StarSystem);
  }

  // ── Market Freshness ──

  /** Get freshness info for a station's market data */
  getMarketFreshness(stationId: string, ttlMs = 300_000): MarketFreshness {
    const fetchedAt = this.marketFetchedAt.get(stationId) ?? 0;
    const ageMs = fetchedAt > 0 ? Date.now() - fetchedAt : Infinity;
    return {
      stationId,
      fetchedAt,
      ageMs,
      fresh: ageMs < ttlMs,
    };
  }

  /** Get freshness for all tracked stations */
  getAllMarketFreshness(ttlMs = 300_000): MarketFreshness[] {
    const result: MarketFreshness[] = [];
    for (const stationId of this.marketFetchedAt.keys()) {
      result.push(this.getMarketFreshness(stationId, ttlMs));
    }
    return result;
  }

  /** Get station IDs with fresh market data */
  getFreshStationIds(ttlMs = 300_000): string[] {
    return this.getAllMarketFreshness(ttlMs)
      .filter((f) => f.fresh)
      .map((f) => f.stationId);
  }

  /** Get all cached market prices (for dashboard broadcasting) */
  getAllCachedMarketPrices(): Array<{ stationId: string; prices: MarketPrice[]; fetchedAt: number }> {
    const results: Array<{ stationId: string; prices: MarketPrice[]; fetchedAt: number }> = [];
    for (const [stationId, fetchedAt] of this.marketFetchedAt.entries()) {
      const prices = this.getMarketPrices(stationId);
      if (prices) {
        results.push({ stationId, prices, fetchedAt });
      }
    }
    return results;
  }

  /** Check if ANY market data exists (has ever been scanned) */
  hasAnyMarketData(): boolean {
    return this.marketFetchedAt.size > 0;
  }

  // ── Market Data Recovery ──

  /**
   * Load most recent market data from SQLite market_history on startup.
   * Populates the timed cache so market page has data immediately.
   */
  loadRecentMarketData(db: import("bun:sqlite").Database): void {
    try {
      // Get the most recent tick for each station/item pair (within last 24h)
      const cutoff = Math.floor(Date.now() / 1000) - 86_400;
      const rows = db.query(`
        SELECT station_id, item_id, buy_price, sell_price, buy_volume, sell_volume, MAX(tick) as latest_tick
        FROM market_history
        WHERE tick > ?
        GROUP BY station_id, item_id
        ORDER BY station_id, item_id
      `).all(cutoff) as Array<{
        station_id: string;
        item_id: string;
        buy_price: number | null;
        sell_price: number | null;
        buy_volume: number;
        sell_volume: number;
        latest_tick: number;
      }>;

      if (rows.length === 0) return;

      // Group by station + track most recent tick per station
      const byStation = new Map<string, { prices: MarketPrice[]; latestTick: number }>();
      for (const row of rows) {
        let entry = byStation.get(row.station_id);
        if (!entry) {
          entry = { prices: [], latestTick: 0 };
          byStation.set(row.station_id, entry);
        }
        entry.prices.push({
          itemId: row.item_id,
          itemName: row.item_id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          buyPrice: row.buy_price,
          sellPrice: row.sell_price,
          buyVolume: row.buy_volume,
          sellVolume: row.sell_volume,
        });
        if (row.latest_tick > entry.latestTick) entry.latestTick = row.latest_tick;
      }

      // Cache each station's data (don't re-log to training data)
      // Use longer TTL (4h) for startup recovery — fresh scans will overwrite with normal 30min TTL
      // Use the ACTUAL fetch time from DB, not Date.now(), so staleness displays correctly
      for (const [stationId, entry] of byStation) {
        this.cache.setTimed(`market:${stationId}`, JSON.stringify(entry.prices), 14_400_000);
        this.marketFetchedAt.set(stationId, entry.latestTick * 1000); // Convert Unix seconds to ms
      }

      console.log(`[Cache] Loaded market data from DB: ${byStation.size} station(s), ${rows.length} price(s)`);
    } catch (err) {
      console.warn(`[Cache] Failed to load market history from DB:`, err);
    }
  }

  // ── Cache Management ──

  /** Overwrite galaxy map cache with layout-generated coordinates */
  setMapCache(systems: StarSystem[]): void {
    this.cache.setStatic("galaxy_map", JSON.stringify(systems), this.gameVersion);
  }

  /** Force re-fetch galaxy map next time loadGalaxy runs */
  clearGalaxyCache(): void {
    this.cache.deleteStatic("galaxy_map");
  }

  clearMarketCache(): void {
    this.cache.clearTimed("market:%");
  }

  clearAllCache(): void {
    this.cache.clearAll();
  }

  /** Check if static caches are populated for current game version */
  getCacheStatus(): Record<string, { cached: boolean; version: string | null }> {
    const keys = ["galaxy_map", "item_catalog", "ship_catalog", "skill_tree", "recipe_catalog"];
    const status: Record<string, { cached: boolean; version: string | null }> = {};
    for (const key of keys) {
      const cached = this.cache.getStatic(key, this.gameVersion);
      status[key] = { cached: cached !== null, version: cached ? this.gameVersion : null };
    }
    return status;
  }
}
