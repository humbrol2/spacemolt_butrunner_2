/**
 * WebSocket store - manages connection to the Commander backend.
 * Provides reactive state for all dashboard components.
 */

import { writable, derived, get } from "svelte/store";
import type {
  ServerMessage,
  ClientMessage,
  BotSummary,
  FleetStats,
  EconomyState,
  LogEntry,
  CommanderDecision,
  SkillMilestone,
  TrainingStats,
  GalaxySystemSummary,
  MarketStationData,
  FactionState,
  BotStorageData,
} from "../../../../src/types/protocol";
import type { Goal } from "../../../../src/types/config";

// ── Connection State ──

type ConnectionState = "connecting" | "connected" | "disconnected";

export const connectionState = writable<ConnectionState>("disconnected");
export const serverVersion = writable<string | null>(null);

// ── Reactive Stores ──

export const bots = writable<BotSummary[]>([]);
export const fleetStats = writable<FleetStats | null>(null);
export const economy = writable<EconomyState | null>(null);
export const commanderLog = writable<CommanderDecision[]>([]);
export const activityLog = writable<LogEntry[]>([]);
export const notifications = writable<
  Array<{ id: string; level: "critical" | "warning" | "info"; title: string; message: string; timestamp: number }>
>([]);
export const skillMilestones = writable<SkillMilestone[]>([]);
export const trainingStats = writable<TrainingStats | null>(null);
export const galaxySystems = writable<GalaxySystemSummary[]>([]);
export const marketStations = writable<MarketStationData[]>([]);
export const goals = writable<Goal[]>([]);
export const factionState = writable<FactionState | null>(null);
export const botStorage = writable<Map<string, BotStorageData>>(new Map());
export const fleetSettings = writable<{ factionTaxPercent: number; minBotCredits: number }>({ factionTaxPercent: 0, minBotCredits: 0 });

// Derived
export const activeBots = derived(bots, ($bots) => $bots.filter((b) => b.status === "running"));
export const unreadNotifications = derived(notifications, ($n) => $n.length);

// ── WebSocket Management ──

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_LOG_ENTRIES = 500;
const MAX_COMMANDER_LOG = 100;

function getWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function handleMessage(event: MessageEvent) {
  try {
    const msg: ServerMessage = JSON.parse(event.data);

    switch (msg.type) {
      case "connected":
        serverVersion.set(msg.version);
        break;

      case "fleet_update":
        bots.set(msg.bots);
        break;

      case "bot_update":
        bots.update((current) =>
          current.map((b) => (b.id === msg.botId ? { ...b, ...msg.data } : b))
        );
        break;

      case "stats_update":
        fleetStats.set(msg.stats);
        break;

      case "economy_update":
        economy.set(msg.economy);
        break;

      case "commander_decision":
        commanderLog.update((log) => [msg.decision, ...log].slice(0, MAX_COMMANDER_LOG));
        break;

      case "log_entry":
        activityLog.update((log) => [msg.entry, ...log].slice(0, MAX_LOG_ENTRIES));
        break;

      case "supply_chain_update":
        economy.update((e) =>
          e ? { ...e, deficits: msg.deficits, surpluses: msg.surpluses } : e
        );
        break;

      case "order_update":
        economy.update((e) => (e ? { ...e, openOrders: msg.orders } : e));
        break;

      case "skill_milestone":
        skillMilestones.update((m) => [msg.milestone, ...m].slice(0, 50));
        break;

      case "training_stats_update":
        trainingStats.set(msg.stats);
        break;

      case "galaxy_update":
        galaxySystems.set(msg.systems);
        break;

      case "market_update":
        marketStations.set(msg.stations);
        break;

      case "goals_update":
        goals.set(msg.goals);
        break;

      case "faction_update":
        factionState.set(msg.faction);
        break;

      case "fleet_settings_update":
        fleetSettings.set(msg.settings);
        break;

      case "bot_storage":
        botStorage.update((m) => {
          const next = new Map(m);
          next.set(msg.botId, msg.storage);
          return next;
        });
        break;

      case "notification":
        notifications.update((n) => [
          {
            id: crypto.randomUUID(),
            level: msg.level,
            title: msg.title,
            message: msg.message,
            timestamp: Date.now(),
          },
          ...n,
        ]);
        break;
    }
  } catch {
    console.error("[WS] Failed to parse message");
  }
}

export function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  connectionState.set("connecting");
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    connectionState.set("connected");
    reconnectDelay = 1000;
    console.log("[WS] Connected");
  };

  ws.onmessage = handleMessage;

  ws.onclose = () => {
    connectionState.set("disconnected");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log(`[WS] Reconnecting (delay: ${reconnectDelay}ms)...`);
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }, reconnectDelay);
}

export function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  ws?.close();
  ws = null;
  connectionState.set("disconnected");
}

export function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    console.warn("[WS] Cannot send - not connected");
  }
}

export function dismissNotification(id: string) {
  notifications.update((n) => n.filter((item) => item.id !== id));
}

export function clearNotifications() {
  notifications.set([]);
}
