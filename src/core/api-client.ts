/**
 * Typed HTTP API client for SpaceMolt.
 * Handles session management, retry logic, and response normalization.
 * All API calls flow through this single class.
 */

import type { CacheHelper } from "../data/database";
import type { SessionStore } from "../data/session-store";
import type { TrainingLogger } from "../data/training-logger";
import type {
  PlayerState,
  ShipState,
  StarSystem,
  PoiDetail,
  MarketPrice,
  MarketOrder,
  MiningYield,
  TravelResult,
  TradeResult,
  CraftResult,
  CatalogItem,
  ShipClass,
  Skill,
  Recipe,
  NearbyPlayer,
  GameNotification,
  BattleStatus,
  Mission,
  SessionInfo,
  LoginResult,
  RegisterResult,
  CargoItem,
  EstimatePurchaseResult,
} from "../types/game";

const BASE_URL = "https://game.spacemolt.com/api/v1";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

interface ApiResponse<T = unknown> {
  result: T;
  notifications: GameNotification[];
  session: SessionInfo;
  error: { code: string; message: string; wait_seconds?: number } | null;
}

export interface ApiClientOptions {
  username: string;
  sessionStore: SessionStore;
  cache: CacheHelper;
  logger: TrainingLogger;
  onNotifications?: (notifications: GameNotification[]) => void;
  onSessionExpired?: () => void;
}

export class ApiClient {
  private sessionId: string | null = null;
  private readonly username: string;
  private readonly sessionStore: SessionStore;
  private readonly cache: CacheHelper;
  private readonly logger: TrainingLogger;
  private readonly onNotifications?: (n: GameNotification[]) => void;
  private readonly onSessionExpired?: () => void;

  // API call counters
  private mutationCount = 0;
  private queryCount = 0;

  constructor(opts: ApiClientOptions) {
    this.username = opts.username;
    this.sessionStore = opts.sessionStore;
    this.cache = opts.cache;
    this.logger = opts.logger;
    this.onNotifications = opts.onNotifications;
    this.onSessionExpired = opts.onSessionExpired;

    // Restore session from store
    const bot = this.sessionStore.getBot(opts.username);
    if (bot?.sessionId) {
      this.sessionId = bot.sessionId;
    }
  }

  get stats() {
    return { mutations: this.mutationCount, queries: this.queryCount };
  }

  // ── Session Management ──

  private async createSession(): Promise<string> {
    const res = await fetch(`${BASE_URL}/session`, { method: "POST" });
    const data = (await res.json()) as ApiResponse;
    if (data.error) throw new ApiError(data.error.code, data.error.message);
    this.sessionId = data.session.id;
    return this.sessionId;
  }

  async login(password?: string): Promise<LoginResult> {
    if (!this.sessionId) {
      await this.createSession();
    }

    const pw = password ?? this.sessionStore.getBot(this.username)?.password;
    if (!pw) throw new Error(`No password found for bot: ${this.username}`);

    const data = await this.call<{
      player: Record<string, unknown>;
      ship: Record<string, unknown>;
      system: Record<string, unknown>;
      poi: Record<string, unknown>;
    }>("login", { username: this.username, password: pw }, false);

    // Store session
    this.sessionStore.updateSession(
      this.username,
      this.sessionId!,
      new Date(Date.now() + 30 * 60 * 1000).toISOString()
    );

    return {
      sessionId: this.sessionId!,
      player: normalizePlayer(data.player),
      ship: normalizeShip(data.ship),
      system: normalizeSystem(data.system),
      poi: normalizePoi(data.poi),
    };
  }

  async register(
    empire: string,
    registrationCode: string
  ): Promise<RegisterResult> {
    if (!this.sessionId) {
      await this.createSession();
    }

    const data = await this.call<{ password: string; player_id: string }>(
      "register",
      { username: this.username, empire, registration_code: registrationCode },
      false
    );

    // Store credentials
    this.sessionStore.upsertBot({
      username: this.username,
      password: data.password,
      empire,
      playerId: data.player_id,
    });

    return { password: data.password, playerId: data.player_id };
  }

  async logout(): Promise<void> {
    await this.call("logout", {}, false);
    this.sessionStore.clearSession(this.username);
    this.sessionId = null;
  }

  // ── Query Commands (instant, unlimited) ──

  async getStatus(): Promise<{ player: PlayerState; ship: ShipState }> {
    const data = await this.query<{ player: Record<string, unknown>; ship: Record<string, unknown> }>("get_status");
    return { player: normalizePlayer(data.player), ship: normalizeShip(data.ship) };
  }

  async getShip(): Promise<ShipState> {
    const data = await this.query<Record<string, unknown>>("get_ship");
    return normalizeShip(data);
  }

  async getCargo(): Promise<CargoItem[]> {
    const data = await this.query<{ cargo: Array<{ item_id: string; quantity: number; size?: number }> }>("get_cargo");
    return (data.cargo ?? []).map((c) => ({ itemId: c.item_id, quantity: c.quantity, size: c.size ?? 1 }));
  }

  async getSystem(): Promise<StarSystem> {
    const data = await this.query<Record<string, unknown>>("get_system");
    // Response wraps system in a `system` field: { system: {...}, poi: {...}, action }
    const systemData = (data.system as Record<string, unknown>) ?? data;
    return normalizeSystem(systemData);
  }

  async getPoi(): Promise<PoiDetail> {
    const data = await this.query<Record<string, unknown>>("get_poi");
    return normalizePoi(data);
  }

  async getBase(): Promise<Record<string, unknown>> {
    return this.query("get_base");
  }

  async getNearby(): Promise<NearbyPlayer[]> {
    const data = await this.query<{ nearby?: Array<Record<string, unknown>> }>("get_nearby");
    return (data.nearby ?? (Array.isArray(data) ? data : [])).map(normalizeNearby);
  }

  async getMap(systemId?: string): Promise<StarSystem[]> {
    const data = await this.query<Record<string, unknown>>(
      "get_map",
      systemId ? { system_id: systemId } : {}
    );

    const raw = (data.systems ?? data.map ?? data.galaxy ?? (Array.isArray(data) ? data : [])) as Array<Record<string, unknown>>;
    console.log(`[API] get_map: ${raw.length} systems, sample keys: ${raw.length > 0 ? Object.keys(raw[0]).join(", ") : "none"}`);

    // Log sample raw system for coordinate debugging
    if (raw.length > 0) {
      const sample = raw[0];
      console.log(`[API] get_map sample: id=${sample.id}, x=${sample.x}, y=${sample.y}, position=${JSON.stringify(sample.position)}, coordinates=${JSON.stringify(sample.coordinates)}`);
    }

    const systems = raw.map(normalizeSystem);

    // Log sample normalized coords
    if (systems.length > 0) {
      const s = systems[0];
      const nonZero = systems.filter((sys) => sys.x !== 0 || sys.y !== 0).length;
      console.log(`[API] get_map normalized: first=(${s.x}, ${s.y}), ${nonZero}/${systems.length} have non-zero coords`);
    }

    return systems;
  }

  async getSkills(): Promise<Record<string, { level: number; xp: number; xpNext: number }>> {
    const data = await this.query<Record<string, unknown>>("get_skills");
    // Normalize skill response
    const skills: Record<string, { level: number; xp: number; xpNext: number }> = {};
    if (data.skills && typeof data.skills === "object") {
      for (const [id, info] of Object.entries(data.skills as Record<string, unknown>)) {
        const s = info as Record<string, unknown>;
        skills[id] = {
          level: (s.level as number) ?? 0,
          xp: (s.xp as number) ?? 0,
          xpNext: (s.next_level_xp as number) ?? (s.xp_next as number) ?? (s.xpNext as number) ?? 0,
        };
      }
    }
    return skills;
  }

  async getVersion(): Promise<{ version: string; releaseDate: string }> {
    const data = await this.query<{ version: string; release_date: string }>("get_version");
    return { version: data.version, releaseDate: data.release_date };
  }

  async viewMarket(itemId?: string): Promise<MarketOrder[]> {
    const data = await this.query<Record<string, unknown>>(
      "view_market",
      itemId ? { item_id: itemId } : {}
    );
    // API returns "items" array with aggregated buy_price/sell_price per item
    // plus buy_orders/sell_orders sub-arrays. We expand into individual MarketOrder[]
    const items = (data.items ?? data.orders ?? (Array.isArray(data) ? data : [])) as Array<Record<string, unknown>>;
    const orders: MarketOrder[] = [];
    for (const item of items) {
      const itemId = str(item.item_id ?? item.itemId);
      const itemName = str(item.item_name ?? item.itemName ?? item.name);
      // Expand sell orders
      const sellOrders = (item.sell_orders ?? []) as Array<Record<string, unknown>>;
      for (const so of sellOrders) {
        orders.push({
          id: "",
          type: "sell",
          itemId,
          itemName,
          quantity: num(so.quantity),
          priceEach: num(so.price_each ?? so.price),
          playerId: str(so.player_id),
          playerName: str(so.player_name ?? so.source),
          stationId: str(data.base ?? ""),
        });
      }
      // Expand buy orders
      const buyOrders = (item.buy_orders ?? []) as Array<Record<string, unknown>>;
      for (const bo of buyOrders) {
        orders.push({
          id: "",
          type: "buy",
          itemId,
          itemName,
          quantity: num(bo.quantity),
          priceEach: num(bo.price_each ?? bo.price),
          playerId: str(bo.player_id),
          playerName: str(bo.player_name),
          stationId: str(data.base ?? ""),
        });
      }
      // Fallback: if no sub-orders but we have aggregated prices, create synthetic entries
      if (sellOrders.length === 0 && buyOrders.length === 0) {
        const sp = num(item.sell_price ?? item.sellPrice);
        const bp = num(item.buy_price ?? item.buyPrice);
        if (sp > 0) {
          orders.push({ id: "", type: "sell", itemId, itemName, quantity: num(item.sell_quantity ?? item.sellQuantity), priceEach: sp, playerId: "", playerName: "", stationId: str(data.base ?? "") });
        }
        if (bp > 0) {
          orders.push({ id: "", type: "buy", itemId, itemName, quantity: num(item.buy_quantity ?? item.buyQuantity), priceEach: bp, playerId: "", playerName: "", stationId: str(data.base ?? "") });
        }
      }
    }
    return orders;
  }

  async viewOrders(stationId?: string): Promise<MarketOrder[]> {
    const data = await this.query<{ orders?: Array<Record<string, unknown>> }>(
      "view_orders",
      stationId ? { station_id: stationId } : {}
    );
    const orders = data.orders ?? (Array.isArray(data) ? data : []);
    return orders.map(normalizeMarketOrder);
  }

  async analyzeMarket(): Promise<Record<string, unknown>> {
    return this.query("analyze_market");
  }

  async getNotifications(
    opts?: { limit?: number; types?: string[]; clear?: boolean }
  ): Promise<GameNotification[]> {
    const data = await this.query<{ notifications?: Array<Record<string, unknown>> }>(
      "get_notifications",
      opts ?? {}
    );
    return (data.notifications ?? (Array.isArray(data) ? data : [])).map((n) => ({
      type: (n.type as string) ?? "system",
      data: n,
      timestamp: (n.timestamp as string) ?? new Date().toISOString(),
    })) as GameNotification[];
  }

  async catalog(
    type: string,
    opts?: { category?: string; id?: string; page?: number; pageSize?: number; search?: string }
  ): Promise<Record<string, unknown>[]> {
    const data = await this.query<{ items?: Array<Record<string, unknown>> }>("catalog", {
      type,
      ...opts,
    });
    return data.items ?? (Array.isArray(data) ? data : []);
  }

  async findRoute(targetSystem: string): Promise<{ found: boolean; route: Array<{ systemId: string; name: string; jumps: number }>; totalJumps: number }> {
    const data = await this.query<Record<string, unknown>>("find_route", { target_system: targetSystem });
    const rawRoute = (data.route as Array<Record<string, unknown>>) ?? [];
    return {
      found: Boolean(data.found),
      route: rawRoute.map((r) => ({
        systemId: str(r.system_id) || str(r.id),
        name: str(r.name),
        jumps: num(r.jumps),
      })),
      totalJumps: num(data.total_jumps),
    };
  }

  async getMissions(): Promise<Mission[]> {
    const data = await this.query<{ missions?: Array<Record<string, unknown>> }>("get_missions");
    return (data.missions ?? (Array.isArray(data) ? data : [])).map(normalizeMission);
  }

  async getActiveMissions(): Promise<Mission[]> {
    const data = await this.query<{ missions?: Array<Record<string, unknown>> }>("get_active_missions");
    return (data.missions ?? (Array.isArray(data) ? data : [])).map(normalizeMission);
  }

  async getBattleStatus(): Promise<BattleStatus | null> {
    const data = await this.query<Record<string, unknown>>("get_battle_status");
    return data.id ? (data as unknown as BattleStatus) : null;
  }

  async getWrecks(): Promise<Array<Record<string, unknown>>> {
    const data = await this.query<{ wrecks?: Array<Record<string, unknown>> }>("get_wrecks");
    return data.wrecks ?? (Array.isArray(data) ? data : []);
  }

  async viewStorage(stationId?: string): Promise<Record<string, unknown>> {
    return this.query("view_storage", stationId ? { station_id: stationId } : {});
  }

  /** Get storage at a specific station with typed items */
  async viewStorageTyped(stationId?: string): Promise<{
    baseId: string;
    credits: number;
    hint: string;
    items: Array<{ itemId: string; itemName: string; quantity: number }>;
  }> {
    const data = await this.query<Record<string, unknown>>("view_storage", stationId ? { station_id: stationId } : {});
    const rawItems = (data.items ?? []) as Array<Record<string, unknown>>;
    return {
      baseId: str(data.base_id ?? ""),
      credits: num(data.credits ?? 0),
      hint: str(data.hint ?? ""),
      items: rawItems.map((i) => ({
        itemId: str(i.item_id ?? i.itemId),
        itemName: str(i.name ?? ""),
        quantity: num(i.quantity),
      })),
    };
  }

  /** Parse storage hint to extract station IDs with storage */
  parseStorageHint(hint: string): string[] {
    // Format: "200 credits and 13,122 items in storage at alpha_centauri_base, sol_base, ..."
    const match = hint.match(/in storage at ([a-z0-9_,\s]+)/i);
    if (!match) return [];
    return match[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0 && /^[a-z0-9_]+$/i.test(s));
  }

  async viewFactionStorage(): Promise<CargoItem[]> {
    const data = await this.viewFactionStorageFull();
    return data.items;
  }

  /** Full faction storage including credits, item names, and recent activity */
  async viewFactionStorageFull(): Promise<{ credits: number; items: CargoItem[]; itemNames: Map<string, string> }> {
    const data = await this.query<Record<string, unknown>>("view_faction_storage");
    const rawItems = (data.items ?? data.storage ?? (Array.isArray(data) ? data : [])) as Array<Record<string, unknown>>;
    const itemNames = new Map<string, string>();
    const items = rawItems.map((i) => {
      const itemId = str(i.item_id ?? i.itemId ?? i.id);
      const name = str(i.name ?? "");
      if (name) itemNames.set(itemId, name);
      return { itemId, quantity: num(i.quantity ?? i.amount) };
    });
    return { credits: num(data.credits ?? 0), items, itemNames };
  }

  async listShips(): Promise<Array<Record<string, unknown>>> {
    const data = await this.query<{ ships?: Array<Record<string, unknown>> }>("list_ships");
    return data.ships ?? (Array.isArray(data) ? data : []);
  }

  async searchSystems(queryStr: string): Promise<Array<Record<string, unknown>>> {
    const data = await this.query<{ systems?: Array<Record<string, unknown>> }>("search_systems", { query: queryStr });
    return data.systems ?? (Array.isArray(data) ? data : []);
  }

  async getGuide(guide?: string): Promise<string> {
    const data = await this.query<{ content?: string }>("get_guide", guide ? { guide } : {});
    return data.content ?? JSON.stringify(data);
  }

  // ── Mutation Commands (1 per tick, ~10s) ──

  async mine(): Promise<MiningYield> {
    const data = await this.mutation<Record<string, unknown>>("mine");
    return {
      resourceId: (data.resource_id as string) ?? "",
      quantity: (data.quantity as number) ?? 0,
      remaining: (data.remaining as number) ?? 0,
      xpGained: (data.xp_gained as Record<string, number>) ?? {},
    };
  }

  async travel(targetPoi: string): Promise<TravelResult> {
    const data = await this.mutation<Record<string, unknown>>("travel", { target_poi: targetPoi });
    return {
      destination: (data.destination as string) ?? targetPoi,
      arrivalTick: (data.arrival_tick as number) ?? 0,
      fuelConsumed: (data.fuel_consumed as number) ?? 0,
    };
  }

  async jump(targetSystem: string): Promise<TravelResult> {
    const data = await this.mutation<Record<string, unknown>>("jump", { target_system: targetSystem });
    return {
      destination: (data.destination as string) ?? targetSystem,
      arrivalTick: (data.arrival_tick as number) ?? 0,
      fuelConsumed: (data.fuel_consumed as number) ?? 0,
    };
  }

  async dock(): Promise<Record<string, unknown>> {
    return this.mutation("dock");
  }

  async undock(): Promise<Record<string, unknown>> {
    return this.mutation("undock");
  }

  async sell(itemId: string, quantity: number): Promise<TradeResult> {
    const data = await this.mutation<Record<string, unknown>>("sell", { item_id: itemId, quantity });
    return normalizeTradeResult(data);
  }

  async jettison(itemId: string, quantity: number): Promise<Record<string, unknown>> {
    return this.mutation("jettison", { item_id: itemId, quantity });
  }

  async buy(itemId: string, quantity: number): Promise<TradeResult> {
    const data = await this.mutation<Record<string, unknown>>("buy", { item_id: itemId, quantity });
    return normalizeTradeResult(data);
  }

  /** Preview a purchase without executing — free query, no rate limit */
  async estimatePurchase(itemId: string, quantity: number): Promise<EstimatePurchaseResult> {
    const data = await this.query<Record<string, unknown>>("estimate_purchase", { item_id: itemId, quantity });
    return {
      item: (data.item as string) ?? itemId,
      available: (data.available as number) ?? 0,
      quantityRequested: (data.quantity_requested as number) ?? quantity,
      totalCost: (data.total_cost as number) ?? 0,
      unfilled: (data.unfilled as number) ?? quantity,
      fills: ((data.fills as Array<Record<string, unknown>>) ?? []).map((f) => ({
        priceEach: (f.price_each as number) ?? 0,
        quantity: (f.quantity as number) ?? 0,
        subtotal: (f.subtotal as number) ?? 0,
      })),
    };
  }

  async refuel(itemId?: string, quantity?: number): Promise<Record<string, unknown>> {
    return this.mutation("refuel", { item_id: itemId, quantity });
  }

  async repair(): Promise<Record<string, unknown>> {
    return this.mutation("repair");
  }

  async craft(recipeId: string, count?: number): Promise<CraftResult> {
    const data = await this.mutation<Record<string, unknown>>("craft", { recipe_id: recipeId, count });
    return {
      recipeId: (data.recipe_id as string) ?? recipeId,
      outputItem: (data.output_item as string) ?? "",
      outputQuantity: (data.output_quantity as number) ?? 1,
      xpGained: (data.xp_gained as Record<string, number>) ?? {},
    };
  }

  async createSellOrder(itemId: string, quantity: number, priceEach: number): Promise<Record<string, unknown>> {
    return this.mutation("create_sell_order", { item_id: itemId, quantity, price_each: priceEach });
  }

  async createBuyOrder(itemId: string, quantity: number, priceEach: number): Promise<Record<string, unknown>> {
    return this.mutation("create_buy_order", { item_id: itemId, quantity, price_each: priceEach });
  }

  async cancelOrder(orderId: string): Promise<Record<string, unknown>> {
    return this.mutation("cancel_order", { order_id: orderId });
  }

  async modifyOrder(orderId: string, newPrice: number): Promise<Record<string, unknown>> {
    return this.mutation("modify_order", { order_id: orderId, new_price: newPrice });
  }

  async depositItems(itemId: string, quantity: number): Promise<Record<string, unknown>> {
    return this.mutation("deposit_items", { item_id: itemId, quantity });
  }

  async withdrawItems(itemId: string, quantity: number): Promise<Record<string, unknown>> {
    return this.mutation("withdraw_items", { item_id: itemId, quantity });
  }

  async depositCredits(amount: number): Promise<Record<string, unknown>> {
    return this.mutation("deposit_credits", { amount });
  }

  async withdrawCredits(amount: number): Promise<Record<string, unknown>> {
    return this.mutation("withdraw_credits", { amount });
  }

  async sendGift(recipient: string, opts: { credits?: number; itemId?: string; quantity?: number; message?: string }): Promise<Record<string, unknown>> {
    return this.mutation("send_gift", { recipient, ...opts });
  }

  async attack(targetId: string): Promise<Record<string, unknown>> {
    return this.mutation("attack", { target_id: targetId });
  }

  async battle(action: string, opts?: { stance?: string; targetId?: string; sideId?: string }): Promise<Record<string, unknown>> {
    return this.mutation("battle", { action, ...opts });
  }

  async scan(targetId: string): Promise<Record<string, unknown>> {
    return this.mutation("scan", { target_id: targetId });
  }

  async cloak(enable?: boolean): Promise<Record<string, unknown>> {
    return this.mutation("cloak", enable !== undefined ? { enable } : {});
  }

  async reload(weaponInstanceId: string, ammoItemId: string): Promise<Record<string, unknown>> {
    return this.mutation("reload", { weapon_instance_id: weaponInstanceId, ammo_item_id: ammoItemId });
  }

  async acceptMission(missionId: string): Promise<Record<string, unknown>> {
    return this.mutation("accept_mission", { mission_id: missionId });
  }

  async completeMission(missionId: string): Promise<Record<string, unknown>> {
    return this.mutation("complete_mission", { mission_id: missionId });
  }

  async abandonMission(missionId: string): Promise<Record<string, unknown>> {
    return this.mutation("abandon_mission", { mission_id: missionId });
  }

  async buyShip(shipClass: string): Promise<Record<string, unknown>> {
    return this.mutation("buy_ship", { ship_class: shipClass });
  }

  async switchShip(shipId: string): Promise<Record<string, unknown>> {
    return this.mutation("switch_ship", { ship_id: shipId });
  }

  async installMod(moduleId: string): Promise<Record<string, unknown>> {
    return this.mutation("install_mod", { module_id: moduleId });
  }

  async uninstallMod(moduleId: string): Promise<Record<string, unknown>> {
    return this.mutation("uninstall_mod", { module_id: moduleId });
  }

  async surveySystem(): Promise<Record<string, unknown>> {
    return this.mutation("survey_system");
  }

  async lootWreck(wreckId: string, itemId: string, quantity: number): Promise<Record<string, unknown>> {
    return this.mutation("loot_wreck", { wreck_id: wreckId, item_id: itemId, quantity });
  }

  async salvageWreck(wreckId: string): Promise<Record<string, unknown>> {
    return this.mutation("salvage_wreck", { wreck_id: wreckId });
  }

  async towWreck(wreckId: string): Promise<Record<string, unknown>> {
    return this.mutation("tow_wreck", { wreck_id: wreckId });
  }

  async sellWreck(): Promise<Record<string, unknown>> {
    return this.mutation("sell_wreck");
  }

  async scrapWreck(): Promise<Record<string, unknown>> {
    return this.mutation("scrap_wreck");
  }

  async releaseTow(): Promise<Record<string, unknown>> {
    return this.mutation("release_tow");
  }

  async setHomeBase(baseId: string): Promise<Record<string, unknown>> {
    return this.mutation("set_home_base", { base_id: baseId });
  }

  async buyInsurance(ticks: number): Promise<Record<string, unknown>> {
    return this.mutation("buy_insurance", { ticks });
  }

  async chat(channel: string, content: string, targetId?: string): Promise<Record<string, unknown>> {
    return this.mutation("chat", { channel, content, target_id: targetId });
  }

  async captainsLogAdd(entry: string): Promise<Record<string, unknown>> {
    return this.query("captains_log_add", { entry });
  }

  async factionInfo(): Promise<Record<string, unknown>> {
    return this.query("faction_info");
  }

  async viewFactionStorageCredits(): Promise<number> {
    const info = await this.factionInfo();
    return num(
      (info as any).credits ??
      (info as any).treasury ??
      (info as any).faction_credits ?? 0
    );
  }

  async factionSubmitIntel(systems: unknown[]): Promise<Record<string, unknown>> {
    return this.mutation("faction_submit_intel", { systems });
  }

  async factionSubmitTradeIntel(stations: unknown[]): Promise<Record<string, unknown>> {
    return this.mutation("faction_submit_trade_intel", { stations });
  }

  async factionListFacilities(): Promise<Array<Record<string, unknown>>> {
    const data = await this.query<Record<string, unknown>>("facility", { action: "faction_list" });
    return (data.facilities ?? data.items ?? (Array.isArray(data) ? data : [])) as Array<Record<string, unknown>>;
  }

  async factionInvite(playerIdOrUsername: string): Promise<Record<string, unknown>> {
    return this.mutation("faction_invite", { player_id: playerIdOrUsername });
  }

  async factionGetInvites(): Promise<Array<{ factionId: string; factionName: string; factionTag: string; invitedBy: string }>> {
    const data = await this.query<any>("faction_get_invites");
    const invites = data.invites ?? data.pending ?? (Array.isArray(data) ? data : []);
    return invites.map((inv: any) => ({
      factionId: inv.faction_id ?? inv.factionId ?? "",
      factionName: inv.faction_name ?? inv.factionName ?? inv.name ?? "",
      factionTag: inv.faction_tag ?? inv.factionTag ?? inv.tag ?? "",
      invitedBy: inv.invited_by ?? inv.invitedBy ?? "",
    }));
  }

  async joinFaction(factionId: string): Promise<Record<string, unknown>> {
    return this.mutation("join_faction", { faction_id: factionId });
  }

  async factionPromote(playerIdOrUsername: string, role: "recruit" | "member" | "officer" | "leader"): Promise<Record<string, unknown>> {
    return this.mutation("faction_promote", { player_id: playerIdOrUsername, role_id: role });
  }

  async factionDepositItems(itemId: string, quantity: number): Promise<Record<string, unknown>> {
    return this.mutation("faction_deposit_items", { item_id: itemId, quantity });
  }

  async factionDepositCredits(amount: number): Promise<Record<string, unknown>> {
    return this.mutation("faction_deposit_credits", { amount });
  }

  async factionWithdrawItems(itemId: string, quantity: number): Promise<Record<string, unknown>> {
    return this.mutation("faction_withdraw_items", { item_id: itemId, quantity });
  }

  async factionWithdrawCredits(amount: number): Promise<Record<string, unknown>> {
    return this.mutation("faction_withdraw_credits", { amount });
  }

  // ── Generic command for anything not wrapped above ──

  async command<T = Record<string, unknown>>(cmd: string, params?: Record<string, unknown>): Promise<T> {
    return this.call<T>(cmd, params ?? {});
  }

  // ── Internal ──

  private async query<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    this.queryCount++;
    return this.call<T>(cmd, params);
  }

  private async mutation<T>(cmd: string, params: Record<string, unknown> = {}): Promise<T> {
    this.mutationCount++;
    return this.call<T>(cmd, params);
  }

  private async call<T>(
    cmd: string,
    params: Record<string, unknown>,
    requireSession = true
  ): Promise<T> {
    if (requireSession && !this.sessionId) {
      await this.createSession();
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.sessionId) headers["X-Session-Id"] = this.sessionId;

        const body = Object.keys(params).length > 0 ? JSON.stringify(params) : undefined;

        const res = await fetch(`${BASE_URL}/${cmd}`, {
          method: "POST",
          headers,
          body,
        });

        // Handle rate limiting
        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get("Retry-After") ?? "10") * 1000;
          await sleep(retryAfter);
          continue;
        }

        // Retry on server errors (502, 503, 504 - typically Cloudflare/proxy timeouts)
        if (res.status >= 500 && attempt < MAX_RETRIES) {
          console.warn(`[API] ${cmd} returned ${res.status}, retrying (${attempt + 1}/${MAX_RETRIES})...`);
          await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
          continue;
        }

        // Parse response as text first, then JSON for better error messages
        const text = await res.text();
        let data: ApiResponse<T>;
        try {
          data = JSON.parse(text) as ApiResponse<T>;
        } catch {
          throw new ApiError(
            "json_parse_error",
            `Invalid JSON from ${cmd} (status ${res.status}): ${text.slice(0, 200)}`
          );
        }

        // Process notifications
        if (data.notifications?.length && this.onNotifications) {
          this.onNotifications(
            data.notifications.map((n: unknown) => {
              const notif = n as Record<string, unknown>;
              return {
                type: ((notif.type as string) ?? "system") as GameNotification["type"],
                data: notif,
                timestamp: (notif.timestamp as string) ?? new Date().toISOString(),
              };
            })
          );
        }

        // Update session expiry
        if (data.session?.expiresAt) {
          this.sessionStore.updateSession(
            this.username,
            data.session.id,
            data.session.expiresAt
          );
        }

        if (data.error) {
          // Session expired - try to re-login
          if (data.error.code === "session_invalid" || data.error.code === "not_authenticated") {
            if (attempt < MAX_RETRIES) {
              this.sessionId = null;
              await this.createSession();
              await this.login();
              continue;
            }
            this.onSessionExpired?.();
          }

          // Action still resolving from previous tick — wait and retry
          if (data.error.code === "action_in_progress" && attempt < MAX_RETRIES) {
            const waitMs = (data.error.wait_seconds ?? 12) * 1000;
            console.log(`[API] ${cmd} action_in_progress, waiting ${waitMs / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await sleep(waitMs);
            continue;
          }

          throw new ApiError(data.error.code, data.error.message, data.error.wait_seconds);
        }

        return data.result;
      } catch (err) {
        if (err instanceof ApiError) throw err;

        // Network error - retry with backoff
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }
    }

    throw new Error(`Failed after ${MAX_RETRIES} retries: ${cmd}`);
  }
}

// ── Error Class ──

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public waitSeconds?: number
  ) {
    super(`[${code}] ${message}`);
    this.name = "ApiError";
  }
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizePlayer(raw: Record<string, unknown>): PlayerState {
  return {
    id: str(raw.id),
    username: str(raw.username),
    empire: str(raw.empire) as PlayerState["empire"],
    credits: num(raw.credits),
    currentSystem: str(raw.current_system),
    currentPoi: str(raw.current_poi),
    currentShipId: str(raw.current_ship_id),
    homeBase: (raw.home_base as string) ?? null,
    dockedAtBase: (raw.docked_at_base as string) ?? null,
    factionId: (raw.faction_id as string) ?? null,
    factionRank: (raw.faction_rank as string) ?? null,
    statusMessage: (raw.status_message as string) ?? null,
    clanTag: (raw.clan_tag as string) ?? null,
    anonymous: Boolean(raw.anonymous),
    isCloaked: Boolean(raw.is_cloaked),
    skills: (raw.skills as Record<string, number>) ?? {},
    skillXp: (raw.skill_xp as Record<string, number>) ?? {},
    stats: normalizeStats(raw.stats as Record<string, unknown>),
  };
}

function normalizeStats(raw?: Record<string, unknown>): PlayerState["stats"] {
  if (!raw) return { shipsDestroyed: 0, timesDestroyed: 0, oreMined: 0, creditsEarned: 0, creditsSpent: 0, tradesCompleted: 0, systemsVisited: 0, itemsCrafted: 0, missionsCompleted: 0 };
  return {
    shipsDestroyed: num(raw.ships_destroyed),
    timesDestroyed: num(raw.times_destroyed),
    oreMined: num(raw.ore_mined),
    creditsEarned: num(raw.credits_earned),
    creditsSpent: num(raw.credits_spent),
    tradesCompleted: num(raw.trades_completed),
    systemsVisited: num(raw.systems_visited),
    itemsCrafted: num(raw.items_crafted),
    missionsCompleted: num(raw.missions_completed),
  };
}

function normalizeShip(raw: Record<string, unknown>): ShipState {
  return {
    id: str(raw.id),
    ownerId: str(raw.owner_id),
    classId: str(raw.class_id),
    name: raw.name as string | null,
    hull: num(raw.hull),
    maxHull: num(raw.max_hull),
    shield: num(raw.shield),
    maxShield: num(raw.max_shield),
    shieldRecharge: num(raw.shield_recharge),
    armor: num(raw.armor),
    speed: num(raw.speed),
    fuel: num(raw.fuel),
    maxFuel: num(raw.max_fuel),
    cargoUsed: num(raw.cargo_used),
    cargoCapacity: num(raw.cargo_capacity),
    cpuUsed: num(raw.cpu_used),
    cpuCapacity: num(raw.cpu_capacity),
    powerUsed: num(raw.power_used),
    powerCapacity: num(raw.power_capacity),
    modules: ((raw.modules as Array<Record<string, unknown>>) ?? []).map((m) => ({
      id: str(m.id),
      moduleId: str(m.module_id),
      name: str(m.name),
    })),
    cargo: ((raw.cargo as Array<Record<string, unknown>>) ?? []).map((c) => ({
      itemId: str(c.item_id),
      quantity: num(c.quantity),
      size: num(c.size ?? 1) || 1,
    })),
  };
}

function normalizeSystem(raw: Record<string, unknown>): StarSystem {
  const id = str(raw.id) || str(raw.system_id);

  // Coordinates: try every conceivable format
  const pos = (raw.position ?? raw.coordinates ?? raw.coords ?? raw.pos ?? raw.location ?? raw.loc) as Record<string, unknown> | undefined;
  const x = num(pos?.x ?? raw.x ?? raw.coord_x ?? raw.posX ?? raw.px);
  const y = num(pos?.y ?? raw.y ?? raw.coord_y ?? raw.posY ?? raw.py);

  // get_system returns full system detail inside raw.system
  const system = (raw.system as Record<string, unknown>) ?? raw;

  return {
    id: id || str(system.id) || str(system.system_id),
    name: str(raw.name) || str(system.name),
    x,
    y,
    empire: (system.empire as StarSystem["empire"]) ?? (raw.empire as StarSystem["empire"]) ?? null,
    policeLevel: num(system.police_level ?? raw.police_level ?? raw.policeLevel),
    connections: ((system.connections ?? raw.connections) as Array<unknown> ?? []).map((c) => {
      if (typeof c === "string") return c;
      const obj = c as Record<string, unknown>;
      return str(obj.system_id) || str(obj.id) || str(obj.target);
    }).filter((c) => c !== ""),
    pois: ((system.pois ?? raw.pois) as Array<Record<string, unknown>> ?? []).map((p) => ({
      id: str(p.id) || str(p.poi_id),
      name: str(p.name),
      type: str(p.type) as PoiDetail["type"],
      hasBase: Boolean(p.has_base ?? p.hasBase),
      baseId: (p.base_id ?? p.baseId ?? null) as string | null,
      baseName: (p.base_name ?? p.baseName ?? null) as string | null,
      resources: ((p.resources as Array<Record<string, unknown>>) ?? []).map((r) => ({
        resourceId: str(r.resource_id ?? r.resourceId ?? r.id),
        richness: num(r.richness),
        remaining: num(r.remaining),
      })),
    })),
    poiCount: num(raw.poi_count ?? system.poi_count ?? raw.poiCount),
    visited: Boolean(raw.visited ?? system.visited),
  };
}

function normalizePoi(raw: Record<string, unknown>): PoiDetail {
  return {
    id: str(raw.id),
    systemId: str(raw.system_id),
    type: str(raw.type) as PoiDetail["type"],
    name: str(raw.name),
    description: str(raw.description),
    position: {
      x: num((raw.position as Record<string, unknown>)?.x),
      y: num((raw.position as Record<string, unknown>)?.y),
    },
    resources: ((raw.resources as Array<Record<string, unknown>>) ?? []).map((r) => ({
      resourceId: str(r.resource_id),
      richness: num(r.richness),
      remaining: num(r.remaining),
    })),
    baseId: (raw.base_id as string) ?? null,
  };
}

function normalizeMarketOrder(raw: Record<string, unknown>): MarketOrder {
  return {
    id: str(raw.id),
    type: str(raw.type) as "buy" | "sell",
    itemId: str(raw.item_id),
    itemName: str(raw.item_name),
    quantity: num(raw.quantity),
    priceEach: num(raw.price_each),
    playerId: str(raw.player_id),
    playerName: str(raw.player_name),
    stationId: str(raw.station_id),
  };
}

function normalizeNearby(raw: Record<string, unknown>): NearbyPlayer {
  return {
    playerId: str(raw.player_id),
    username: str(raw.username),
    shipClass: str(raw.ship_class),
    factionId: (raw.faction_id as string) ?? null,
    factionTag: (raw.faction_tag as string) ?? null,
    anonymous: Boolean(raw.anonymous),
    inCombat: Boolean(raw.in_combat),
  };
}

function normalizeTradeResult(raw: Record<string, unknown>): TradeResult {
  return {
    itemId: str(raw.item_id),
    quantity: num(raw.quantity),
    priceEach: num(raw.price_each),
    total: num(raw.total),
  };
}

function normalizeMission(raw: Record<string, unknown>): Mission {
  // API returns rewards as object { credits?: number, items?: {...} }
  // We normalize to MissionReward[]
  const rawRewards = raw.rewards;
  const rewards: Array<{ type: "credits" | "item" | "xp"; amount: number; itemId?: string }> = [];

  if (rawRewards && typeof rawRewards === "object" && !Array.isArray(rawRewards)) {
    const r = rawRewards as Record<string, unknown>;
    if (r.credits) rewards.push({ type: "credits", amount: num(r.credits) });
    if (r.xp) rewards.push({ type: "xp", amount: num(r.xp) });
    if (r.items && typeof r.items === "object") {
      for (const [itemId, qty] of Object.entries(r.items as Record<string, unknown>)) {
        rewards.push({ type: "item", amount: num(qty), itemId });
      }
    }
  } else if (Array.isArray(rawRewards)) {
    // Already in array format
    for (const r of rawRewards) {
      const item = r as Record<string, unknown>;
      rewards.push({ type: str(item.type) as "credits" | "item" | "xp", amount: num(item.amount), itemId: item.itemId as string | undefined });
    }
  }

  // Normalize objectives
  const rawObjectives = (raw.objectives as Array<Record<string, unknown>>) ?? [];
  const objectives = rawObjectives.map((o) => ({
    description: str(o.description),
    progress: num(o.progress),
    target: num(o.target ?? o.quantity ?? 1),
    complete: Boolean(o.complete ?? o.completed),
  }));

  return {
    id: str(raw.id ?? raw.mission_id),
    title: str(raw.title),
    description: str(raw.description),
    type: str(raw.type),
    objectives,
    rewards,
  };
}

// ── Exported Normalizers (used by GameCache for catalog data) ──

export function normalizeRecipe(raw: Record<string, unknown>): Recipe {
  // Ingredients: API may use ingredients, materials, or inputs
  const rawIngs = (raw.ingredients ?? raw.materials ?? raw.inputs) as Array<Record<string, unknown>> | undefined;
  const ingredients = (rawIngs ?? []).map((i) => ({
    itemId: str(i.item_id ?? i.itemId),
    quantity: num(i.quantity ?? i.amount) || 1,
  }));

  // Required skills: object mapping skill_id → level
  const requiredSkills: Record<string, number> = {};
  const rawSkills = raw.required_skills ?? raw.requiredSkills ?? raw.skills;
  if (rawSkills && typeof rawSkills === "object" && !Array.isArray(rawSkills)) {
    for (const [k, v] of Object.entries(rawSkills as Record<string, unknown>)) {
      requiredSkills[k] = num(v);
    }
  }

  // XP rewards
  const xpRewards: Record<string, number> = {};
  const rawXp = raw.xp_rewards ?? raw.xpRewards ?? raw.xp;
  if (rawXp && typeof rawXp === "object" && !Array.isArray(rawXp)) {
    for (const [k, v] of Object.entries(rawXp as Record<string, unknown>)) {
      xpRewards[k] = num(v);
    }
  }

  return {
    id: str(raw.id ?? raw.recipe_id),
    name: str(raw.name),
    description: str(raw.description),
    outputItem: str(raw.output_item ?? raw.outputItem ?? raw.output),
    outputQuantity: num(raw.output_quantity ?? raw.outputQuantity ?? 1) || 1,
    ingredients,
    requiredSkills,
    xpRewards,
  };
}

export function normalizeCatalogItem(raw: Record<string, unknown>): CatalogItem {
  return {
    id: str(raw.id ?? raw.item_id),
    name: str(raw.name),
    category: str(raw.category ?? raw.type),
    description: str(raw.description),
    basePrice: num(raw.base_price ?? raw.basePrice ?? raw.price),
    stackSize: num(raw.stack_size ?? raw.stackSize ?? 100) || 100,
  };
}

function str(v: unknown): string {
  return String(v ?? "");
}

function num(v: unknown): number {
  return Number(v ?? 0) || 0;
}
