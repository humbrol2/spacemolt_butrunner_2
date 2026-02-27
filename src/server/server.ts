/**
 * Bun HTTP + WebSocket server.
 * Serves the Svelte frontend and provides a WebSocket API for real-time dashboard updates.
 */

import type { ServerWebSocket } from "bun";
import type { Database } from "bun:sqlite";
import type { ServerMessage, ClientMessage } from "../types/protocol";
import type { TrainingLogger } from "../data/training-logger";
import { handleTrainingRoute } from "./training-api";

const RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
};

export interface ServerOptions {
  port: number;
  host: string;
  staticDir: string;
  db?: Database;
  trainingLogger?: TrainingLogger;
  onClientMessage?: (ws: ServerWebSocket<WsData>, msg: ClientMessage) => void;
  onClientConnect?: (ws: ServerWebSocket<WsData>) => void;
}

interface WsData {
  id: string;
  connectedAt: number;
}

const clients = new Set<ServerWebSocket<WsData>>();

export function createServer(opts: ServerOptions) {
  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.host,

    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID(), connectedAt: Date.now() },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API routes
      if (url.pathname.startsWith("/api/")) {
        return handleApiRoute(url, req, opts);
      }

      // Static files: try exact file first, then SPA fallback
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`${opts.staticDir}${filePath}`);
      if (await file.exists()) {
        return new Response(file);
      }

      // SPA fallback - serve index.html for all unmatched routes
      const indexFile = Bun.file(`${opts.staticDir}/index.html`);
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html;charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        const msg: ServerMessage = { type: "connected", version: "2.0.0" };
        ws.send(JSON.stringify(msg));
        opts.onClientConnect?.(ws);
        console.log(`[WS] Client connected (${clients.size} total)`);
      },

      message(ws, message) {
        try {
          const msg = JSON.parse(String(message)) as ClientMessage;
          opts.onClientMessage?.(ws, msg);
        } catch {
          console.error("[WS] Invalid message:", String(message).slice(0, 100));
        }
      },

      close(ws) {
        clients.delete(ws);
        console.log(`[WS] Client disconnected (${clients.size} total)`);
      },
    },
  });

  console.log(`[Server] Running at http://${opts.host}:${opts.port}`);
  return server;
}

/** Broadcast a message to all connected dashboard clients */
export function broadcast(msg: ServerMessage): void {
  if (clients.size === 0) return;
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    ws.send(data);
  }
}

/** Send a message to a specific client */
export function sendTo(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

/** Get count of connected clients */
export function getClientCount(): number {
  return clients.size;
}

// REST API routes
async function handleApiRoute(url: URL, req: Request, opts: ServerOptions): Promise<Response> {
  const path = url.pathname.replace("/api/", "");

  // Health check
  if (path === "health") {
    return Response.json({ status: "ok", clients: clients.size });
  }

  // Credit history API
  if (path === "credits" && opts.db) {
    return handleCreditsRoute(url, opts.db);
  }

  // Economy history API
  if (path === "economy/history" && opts.trainingLogger) {
    return handleEconomyHistory(url, opts.trainingLogger);
  }

  // Trade log API
  if (path === "economy/trades" && opts.trainingLogger) {
    return handleTrades(url, opts.trainingLogger);
  }

  // Training data API
  if (path.startsWith("training/") && opts.db && opts.trainingLogger) {
    return handleTrainingRoute(url, req, { db: opts.db, logger: opts.trainingLogger });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

const BUCKET_MS: Record<string, number> = {
  "1h": 60_000,        // 1 min buckets
  "1d": 600_000,       // 10 min buckets
  "1w": 3_600_000,     // 1 hr buckets
  "all": 3_600_000,    // 1 hr buckets
};

/** GET /api/economy/history?range=1h|1d|1w|all */
function handleEconomyHistory(url: URL, logger: TrainingLogger): Response {
  const range = url.searchParams.get("range") ?? "1h";
  const ms = range === "all" ? 365 * 24 * 60 * 60 * 1000 : (RANGE_MS[range] ?? RANGE_MS["1h"]);
  const bucketMs = BUCKET_MS[range] ?? BUCKET_MS["1h"];
  const data = logger.getFinancialHistory(ms, bucketMs);
  return Response.json(data);
}

/** GET /api/economy/trades?range=1h|1d|1w|all&limit=100 */
function handleTrades(url: URL, logger: TrainingLogger): Response {
  const range = url.searchParams.get("range") ?? "1d";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);
  const ms = range === "all" ? 365 * 24 * 60 * 60 * 1000 : (RANGE_MS[range] ?? RANGE_MS["1d"]);
  const data = logger.getRecentTrades(ms, limit);
  return Response.json(data);
}

/** GET /api/credits?range=1h|1d|1w|1m */
function handleCreditsRoute(url: URL, db: Database): Response {
  const range = url.searchParams.get("range") ?? "1h";
  const ms = RANGE_MS[range] ?? RANGE_MS["1h"];
  const since = Date.now() - ms;

  const rows = db
    .query("SELECT timestamp, total_credits, active_bots FROM credit_history WHERE timestamp >= ? ORDER BY timestamp ASC")
    .all(since) as Array<{ timestamp: number; total_credits: number; active_bots: number }>;

  return Response.json(
    rows.map((r) => ({
      time: new Date(r.timestamp).toISOString(),
      credits: r.total_credits,
      activeBots: r.active_bots,
    }))
  );
}
