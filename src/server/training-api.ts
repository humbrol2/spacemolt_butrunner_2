/**
 * Training data REST API endpoints.
 * Provides export, stats, episode detection, and data management.
 */

import type { Database } from "bun:sqlite";
import type { TrainingLogger } from "../data/training-logger";

export interface TrainingApiDeps {
  db: Database;
  logger: TrainingLogger;
}

/** Parse common query params for training exports */
function parseExportParams(url: URL) {
  return {
    startTick: parseInt(url.searchParams.get("startTick") ?? "0") || 0,
    endTick: parseInt(url.searchParams.get("endTick") ?? "999999999") || 999999999,
    botId: url.searchParams.get("botId") ?? null,
    limit: Math.min(parseInt(url.searchParams.get("limit") ?? "50000") || 50000, 100000),
    format: (url.searchParams.get("format") ?? "json") as "json" | "csv",
  };
}

/** Convert an array of objects to CSV string */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    const values = headers.map((h) => {
      const val = row[h];
      if (val === null || val === undefined) return "";
      const str = typeof val === "object" ? JSON.stringify(val) : String(val);
      // Escape CSV values containing commas, quotes, or newlines
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    lines.push(values.join(","));
  }
  return lines.join("\n");
}

/** Handle all /api/training/* routes */
export async function handleTrainingRoute(
  url: URL,
  req: Request,
  deps: TrainingApiDeps
): Promise<Response> {
  const path = url.pathname.replace("/api/training/", "");

  switch (true) {
    case path === "stats":
      return handleStats(deps);

    case path === "export/decisions":
      return handleExportDecisions(url, deps);

    case path === "export/snapshots":
      return handleExportSnapshots(url, deps);

    case path === "export/episodes":
      return handleExportEpisodes(url, deps);

    case path === "export/market-history":
      return handleExportMarketHistory(url, deps);

    case path === "export/commander-log":
      return handleExportCommanderLog(url, deps);

    case path === "clear" && req.method === "POST":
      return handleClear(req, deps);

    default:
      return Response.json({ error: "Not found" }, { status: 404 });
  }
}

// ── Stats ──

function handleStats(deps: TrainingApiDeps): Response {
  const stats = deps.logger.getStats();

  // Extended stats with breakdowns
  const decisionsByAction = deps.db
    .query("SELECT action, COUNT(*) as count FROM decision_log GROUP BY action ORDER BY count DESC")
    .all() as Array<{ action: string; count: number }>;

  const decisionsByBot = deps.db
    .query("SELECT bot_id, COUNT(*) as count FROM decision_log GROUP BY bot_id ORDER BY count DESC")
    .all() as Array<{ bot_id: string; count: number }>;

  const episodesByType = deps.db
    .query("SELECT episode_type, COUNT(*) as count FROM episodes GROUP BY episode_type ORDER BY count DESC")
    .all() as Array<{ episode_type: string; count: number }>;

  const episodeSuccessRate = deps.db
    .query("SELECT AVG(success) as rate FROM episodes")
    .get() as { rate: number | null };

  const avgEpisodeDuration = deps.db
    .query("SELECT AVG(duration_ticks) as avg_dur FROM episodes")
    .get() as { avg_dur: number | null };

  const totalEpisodeProfit = deps.db
    .query("SELECT SUM(profit) as total FROM episodes")
    .get() as { total: number | null };

  const marketStations = deps.db
    .query("SELECT COUNT(DISTINCT station_id) as count FROM market_history")
    .get() as { count: number };

  const marketItems = deps.db
    .query("SELECT COUNT(DISTINCT item_id) as count FROM market_history")
    .get() as { count: number };

  const commanderGoals = deps.db
    .query("SELECT goal, COUNT(*) as count FROM commander_log GROUP BY goal ORDER BY count DESC")
    .all() as Array<{ goal: string; count: number }>;

  return Response.json({
    decisions: {
      count: stats.decisions,
      byAction: Object.fromEntries(decisionsByAction.map((r) => [r.action, r.count])),
      byBot: Object.fromEntries(decisionsByBot.map((r) => [r.bot_id, r.count])),
    },
    snapshots: {
      count: stats.snapshots,
    },
    episodes: {
      count: stats.episodes,
      byType: Object.fromEntries(episodesByType.map((r) => [r.episode_type, r.count])),
      successRate: episodeSuccessRate.rate ?? 0,
      avgDurationTicks: Math.round(avgEpisodeDuration.avg_dur ?? 0),
      totalProfit: totalEpisodeProfit.total ?? 0,
    },
    marketHistory: {
      count: stats.marketRecords,
      stationsTracked: marketStations.count,
      itemsTracked: marketItems.count,
    },
    commanderLog: {
      count: stats.commanderDecisions,
      goalDistribution: Object.fromEntries(commanderGoals.map((r) => [r.goal, r.count])),
    },
    database: {
      sizeBytes: stats.dbSizeBytes,
      sizeMB: Math.round(stats.dbSizeBytes / 1024 / 1024 * 10) / 10,
    },
  });
}

// ── Export: Decisions ──

function handleExportDecisions(url: URL, deps: TrainingApiDeps): Response {
  const params = parseExportParams(url);
  const action = url.searchParams.get("action") ?? null;

  let sql = `SELECT id, tick, bot_id, action, params, context, result, commander_goal,
             game_version, commander_version, created_at
             FROM decision_log WHERE tick >= ? AND tick <= ?`;
  const binds: (string | number | null)[] = [params.startTick, params.endTick];

  if (params.botId) {
    sql += " AND bot_id = ?";
    binds.push(params.botId);
  }
  if (action) {
    sql += " AND action = ?";
    binds.push(action);
  }
  sql += " ORDER BY tick ASC LIMIT ?";
  binds.push(params.limit);

  const rows = deps.db.query(sql).all(...binds) as Record<string, unknown>[];

  // Parse JSON fields for JSON format
  const records = rows.map((r) => ({
    ...r,
    params: r.params ? JSON.parse(r.params as string) : null,
    context: JSON.parse(r.context as string),
    result: r.result ? JSON.parse(r.result as string) : null,
  }));

  if (params.format === "csv") {
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=decisions.csv",
      },
    });
  }

  return Response.json({
    table: "decision_log",
    recordCount: records.length,
    records,
  });
}

// ── Export: Snapshots ──

function handleExportSnapshots(url: URL, deps: TrainingApiDeps): Response {
  const params = parseExportParams(url);

  let sql = `SELECT id, tick, bot_id, player_state, ship_state, location,
             game_version, commander_version, created_at
             FROM state_snapshots WHERE tick >= ? AND tick <= ?`;
  const binds: (string | number | null)[] = [params.startTick, params.endTick];

  if (params.botId) {
    sql += " AND bot_id = ?";
    binds.push(params.botId);
  }
  sql += " ORDER BY tick ASC LIMIT ?";
  binds.push(params.limit);

  const rows = deps.db.query(sql).all(...binds) as Record<string, unknown>[];

  const records = rows.map((r) => ({
    ...r,
    player_state: JSON.parse(r.player_state as string),
    ship_state: JSON.parse(r.ship_state as string),
    location: JSON.parse(r.location as string),
  }));

  if (params.format === "csv") {
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=snapshots.csv",
      },
    });
  }

  return Response.json({
    table: "state_snapshots",
    recordCount: records.length,
    records,
  });
}

// ── Export: Episodes ──

function handleExportEpisodes(url: URL, deps: TrainingApiDeps): Response {
  const params = parseExportParams(url);
  const episodeType = url.searchParams.get("episodeType") ?? null;
  const successOnly = url.searchParams.get("successOnly") === "true";

  let sql = `SELECT id, bot_id, episode_type, start_tick, end_tick, duration_ticks,
             start_credits, end_credits, profit, route, items_involved, fuel_consumed,
             risks, commander_goal, success, game_version, commander_version, created_at
             FROM episodes WHERE start_tick >= ? AND end_tick <= ?`;
  const binds: (string | number | null)[] = [params.startTick, params.endTick];

  if (params.botId) {
    sql += " AND bot_id = ?";
    binds.push(params.botId);
  }
  if (episodeType) {
    sql += " AND episode_type = ?";
    binds.push(episodeType);
  }
  if (successOnly) {
    sql += " AND success = 1";
  }
  sql += " ORDER BY start_tick ASC LIMIT ?";
  binds.push(params.limit);

  const rows = deps.db.query(sql).all(...binds) as Record<string, unknown>[];

  const records = rows.map((r) => ({
    ...r,
    route: r.route ? JSON.parse(r.route as string) : [],
    items_involved: r.items_involved ? JSON.parse(r.items_involved as string) : {},
    risks: r.risks ? JSON.parse(r.risks as string) : [],
  }));

  if (params.format === "csv") {
    return new Response(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": "attachment; filename=episodes.csv",
      },
    });
  }

  return Response.json({
    table: "episodes",
    recordCount: records.length,
    records,
  });
}

// ── Export: Market History ──

function handleExportMarketHistory(url: URL, deps: TrainingApiDeps): Response {
  const params = parseExportParams(url);
  const stationId = url.searchParams.get("stationId") ?? null;
  const itemId = url.searchParams.get("itemId") ?? null;

  let sql = `SELECT tick, station_id, item_id, buy_price, sell_price,
             buy_volume, sell_volume, created_at
             FROM market_history WHERE tick >= ? AND tick <= ?`;
  const binds: (string | number | null)[] = [params.startTick, params.endTick];

  if (stationId) {
    sql += " AND station_id = ?";
    binds.push(stationId);
  }
  if (itemId) {
    sql += " AND item_id = ?";
    binds.push(itemId);
  }
  sql += " ORDER BY tick ASC LIMIT ?";
  binds.push(params.limit);

  const rows = deps.db.query(sql).all(...binds) as Record<string, unknown>[];

  // Market history always exports as CSV
  return new Response(toCsv(rows), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": "attachment; filename=market_history.csv",
    },
  });
}

// ── Export: Commander Log ──

function handleExportCommanderLog(url: URL, deps: TrainingApiDeps): Response {
  const params = parseExportParams(url);
  const goal = url.searchParams.get("goal") ?? null;

  let sql = `SELECT id, tick, goal, fleet_state, assignments, reasoning, economy_state,
             game_version, commander_version, created_at
             FROM commander_log WHERE tick >= ? AND tick <= ?`;
  const binds: (string | number | null)[] = [params.startTick, params.endTick];

  if (goal) {
    sql += " AND goal = ?";
    binds.push(goal);
  }
  sql += " ORDER BY tick ASC LIMIT ?";
  binds.push(params.limit);

  const rows = deps.db.query(sql).all(...binds) as Record<string, unknown>[];

  const records = rows.map((r) => ({
    ...r,
    fleet_state: JSON.parse(r.fleet_state as string),
    assignments: JSON.parse(r.assignments as string),
    economy_state: r.economy_state ? JSON.parse(r.economy_state as string) : null,
  }));

  return Response.json({
    table: "commander_log",
    recordCount: records.length,
    records,
  });
}

// ── Clear Training Data ──

async function handleClear(req: Request, deps: TrainingApiDeps): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body?.confirm) {
    return Response.json({ error: "Must include { confirm: true }" }, { status: 400 });
  }

  const olderThanTick = (body.olderThanTick as number) ?? null;
  const tables = (body.tables as string[]) ?? ["decision_log", "state_snapshots", "episodes", "market_history", "commander_log"];
  const validTables = new Set(["decision_log", "state_snapshots", "episodes", "market_history", "commander_log"]);

  const results: Record<string, number> = {};

  const tx = deps.db.transaction(() => {
    for (const table of tables) {
      if (!validTables.has(table)) continue;

      if (olderThanTick) {
        const tickCol = table === "episodes" ? "end_tick" : "tick";
        const sql = `DELETE FROM ${table} WHERE ${tickCol} < ?`;
        const result = deps.db.run(sql, [olderThanTick]);
        results[table] = result.changes;
      } else {
        const sql = `DELETE FROM ${table}`;
        const result = deps.db.run(sql);
        results[table] = result.changes;
      }
    }
  });

  tx();

  return Response.json({
    success: true,
    recordsDeleted: results,
  });
}
