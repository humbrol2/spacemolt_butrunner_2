/**
 * Training data logger.
 * Records every decision, snapshot, and episode for future model training.
 */

import type { Database } from "bun:sqlite";
import { version as commanderVersion } from "../../package.json";

export class TrainingLogger {
  private gameVersion: string = "unknown";
  private enabled = {
    decisions: true,
    snapshots: true,
    episodes: true,
    marketHistory: true,
  };

  constructor(private db: Database) {}

  setGameVersion(version: string): void {
    this.gameVersion = version;
  }

  configure(opts: Partial<typeof this.enabled>): void {
    Object.assign(this.enabled, opts);
  }

  /** Log a bot's action decision and outcome */
  logDecision(params: {
    tick: number;
    botId: string;
    action: string;
    actionParams?: Record<string, unknown>;
    context: Record<string, unknown>;
    result?: Record<string, unknown>;
    commanderGoal?: string;
  }): void {
    if (!this.enabled.decisions) return;
    this.db.run(
      `INSERT INTO decision_log (tick, bot_id, action, params, context, result, commander_goal, game_version, commander_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.tick,
        params.botId,
        params.action,
        params.actionParams ? JSON.stringify(params.actionParams) : null,
        JSON.stringify(params.context),
        params.result ? JSON.stringify(params.result) : null,
        params.commanderGoal ?? null,
        this.gameVersion,
        commanderVersion,
      ]
    );
  }

  /** Log a full bot state snapshot */
  logSnapshot(params: {
    tick: number;
    botId: string;
    playerState: Record<string, unknown>;
    shipState: Record<string, unknown>;
    location: Record<string, unknown>;
  }): void {
    if (!this.enabled.snapshots) return;
    this.db.run(
      `INSERT INTO state_snapshots (tick, bot_id, player_state, ship_state, location, game_version, commander_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        params.tick,
        params.botId,
        JSON.stringify(params.playerState),
        JSON.stringify(params.shipState),
        JSON.stringify(params.location),
        this.gameVersion,
        commanderVersion,
      ]
    );
  }

  /** Log a completed episode (mining run, trade route, etc.) */
  logEpisode(params: {
    botId: string;
    episodeType: string;
    startTick: number;
    endTick: number;
    startCredits: number;
    endCredits: number;
    route: string[];
    itemsInvolved: Record<string, number>;
    fuelConsumed: number;
    risks: string[];
    commanderGoal?: string;
    success: boolean;
  }): void {
    if (!this.enabled.episodes) return;
    this.db.run(
      `INSERT INTO episodes (bot_id, episode_type, start_tick, end_tick, duration_ticks,
       start_credits, end_credits, profit, route, items_involved, fuel_consumed, risks,
       commander_goal, success, game_version, commander_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.botId,
        params.episodeType,
        params.startTick,
        params.endTick,
        params.endTick - params.startTick,
        params.startCredits,
        params.endCredits,
        params.endCredits - params.startCredits,
        JSON.stringify(params.route),
        JSON.stringify(params.itemsInvolved),
        params.fuelConsumed,
        JSON.stringify(params.risks),
        params.commanderGoal ?? null,
        params.success ? 1 : 0,
        this.gameVersion,
        commanderVersion,
      ]
    );
  }

  /** Log market prices at a station (for price time-series) */
  logMarketPrices(
    tick: number,
    stationId: string,
    prices: Array<{
      itemId: string;
      buyPrice: number | null;
      sellPrice: number | null;
      buyVolume: number;
      sellVolume: number;
    }>
  ): void {
    if (!this.enabled.marketHistory) return;

    const stmt = this.db.prepare(
      `INSERT INTO market_history (tick, station_id, item_id, buy_price, sell_price, buy_volume, sell_volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      for (const p of prices) {
        stmt.run(tick, stationId, p.itemId, p.buyPrice, p.sellPrice, p.buyVolume, p.sellVolume);
      }
    });

    tx();
  }

  /** Log a commander evaluation decision */
  logCommanderDecision(params: {
    tick: number;
    goal: string;
    fleetState: Record<string, unknown>;
    assignments: Record<string, unknown>[];
    reasoning: string;
    economyState?: Record<string, unknown>;
  }): void {
    this.db.run(
      `INSERT INTO commander_log (tick, goal, fleet_state, assignments, reasoning, economy_state, game_version, commander_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        params.tick,
        params.goal,
        JSON.stringify(params.fleetState),
        JSON.stringify(params.assignments),
        params.reasoning,
        params.economyState ? JSON.stringify(params.economyState) : null,
        this.gameVersion,
        commanderVersion,
      ]
    );
  }

  /** Log a financial event (revenue or cost) for the profit chart */
  logFinancialEvent(type: "revenue" | "cost", amount: number, botId?: string): void {
    if (amount <= 0) return;
    this.db.run(
      "INSERT INTO financial_events (timestamp, event_type, amount, bot_id) VALUES (?, ?, ?, ?)",
      [Date.now(), type, amount, botId ?? null]
    );
  }

  /** Get aggregated financial history for charting */
  getFinancialHistory(sinceMs: number, bucketMs: number): Array<{
    timestamp: number;
    revenue: number;
    cost: number;
    profit: number;
  }> {
    const since = Date.now() - sinceMs;
    const rows = this.db.query(`
      SELECT
        (timestamp / ? * ?) as bucket,
        SUM(CASE WHEN event_type = 'revenue' THEN amount ELSE 0 END) as revenue,
        SUM(CASE WHEN event_type = 'cost' THEN amount ELSE 0 END) as cost
      FROM financial_events
      WHERE timestamp >= ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all(bucketMs, bucketMs, since) as Array<{ bucket: number; revenue: number; cost: number }>;

    return rows.map((r) => ({
      timestamp: r.bucket,
      revenue: r.revenue,
      cost: r.cost,
      profit: r.revenue - r.cost,
    }));
  }

  /** Log a trade transaction (buy/sell) */
  logTrade(params: {
    botId: string;
    action: "buy" | "sell";
    itemId: string;
    quantity: number;
    priceEach: number;
    total: number;
    stationId?: string;
  }): void {
    this.db.run(
      "INSERT INTO trade_log (timestamp, bot_id, action, item_id, quantity, price_each, total, station_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [Date.now(), params.botId, params.action, params.itemId, params.quantity, params.priceEach, params.total, params.stationId ?? null]
    );
  }

  /** Get recent trades for the economy dashboard */
  getRecentTrades(sinceMs: number, limit = 100): Array<{
    timestamp: number;
    botId: string;
    action: string;
    itemId: string;
    quantity: number;
    priceEach: number;
    total: number;
    stationId: string | null;
  }> {
    const since = Date.now() - sinceMs;
    const rows = this.db.query(`
      SELECT timestamp, bot_id, action, item_id, quantity, price_each, total, station_id
      FROM trade_log
      WHERE timestamp >= ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(since, limit) as Array<{
      timestamp: number;
      bot_id: string;
      action: string;
      item_id: string;
      quantity: number;
      price_each: number;
      total: number;
      station_id: string | null;
    }>;
    return rows.map((r) => ({
      timestamp: r.timestamp,
      botId: r.bot_id,
      action: r.action,
      itemId: r.item_id,
      quantity: r.quantity,
      priceEach: r.price_each,
      total: r.total,
      stationId: r.station_id,
    }));
  }

  /** Get training data stats */
  getStats(): {
    decisions: number;
    snapshots: number;
    episodes: number;
    marketRecords: number;
    commanderDecisions: number;
    dbSizeBytes: number;
  } {
    const decisions = (
      this.db.query("SELECT COUNT(*) as count FROM decision_log").get() as { count: number }
    ).count;
    const snapshots = (
      this.db.query("SELECT COUNT(*) as count FROM state_snapshots").get() as { count: number }
    ).count;
    const episodes = (
      this.db.query("SELECT COUNT(*) as count FROM episodes").get() as { count: number }
    ).count;
    const marketRecords = (
      this.db.query("SELECT COUNT(*) as count FROM market_history").get() as { count: number }
    ).count;
    const commanderDecisions = (
      this.db.query("SELECT COUNT(*) as count FROM commander_log").get() as { count: number }
    ).count;

    // Get file size
    const file = Bun.file("data/commander.db");
    const dbSizeBytes = file.size;

    return { decisions, snapshots, episodes, marketRecords, commanderDecisions, dbSizeBytes };
  }
}
