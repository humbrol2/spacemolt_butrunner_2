# SpaceMolt Commander v2 - Design Document

> Living document. Updated as design decisions are made.
> Last updated: 2026-02-24

---

## 1. Vision

### Short-term (v2.0)
A goal-driven fleet commander that manages 2-20 coded bots through a professional web dashboard. The Commander evaluates fleet state, market conditions, and skill levels, then assigns and reassigns bots dynamically based on high-level goals rather than manual role selection.

### Long-term (v3+)
- Replace the scoring-based Commander brain with an LLM or custom-trained model
- Use collected training data (decisions, outcomes, market history) to fine-tune a game-specific model
- The system generates its own training data from day one

---

## 2. Architecture Principles

### P1: No Code Duplication
Every game concept has ONE authoritative implementation in `core/`. Routines consume core services, never reimplement them. If two routines need similar logic, it belongs in core.

### P2: Minimal API Calls
- Static data (map, catalogs, skills, recipes) fetched once, cached in SQLite, refreshed only on game version change
- Market data cached with TTL (5-10 min), refreshed only when a bot is actively trading at that station
- Per tick: 1 mutation per bot + shared queries only when needed
- Every query that IS made should serve double duty (gameplay + training data)

### P3: Expandable via Interfaces
- Commander brain is an interface (`CommanderBrain`) - swap scoring for LLM later
- Routines are async generators conforming to a `Routine` type - add new ones without touching existing code
- Core services are injected via `BotContext` - mockable, testable, replaceable

### P4: Data as a First-Class Citizen
- Every decision and outcome is logged for future model training
- Market prices are historized, not just cached
- The system should get smarter over time from its own data

### P5: Single Source of Truth for Types
- Game entity types generated/derived from the OpenAPI spec
- Dashboard ↔ Server protocol is typed and shared
- No string-based command names or untyped payloads

---

## 3. Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Bun | Fast, built-in TS, built-in SQLite, built-in HTTP/WS server |
| Language | TypeScript (strict) | Type safety across the entire stack |
| Frontend | Svelte 5 | Least boilerplate, compiler-based, built-in transitions, reactive |
| Styling | Tailwind CSS 4 | Utility-first, dark theme, consistent spacing/colors |
| Components | shadcn-svelte | Premium pre-built components (tables, cards, dialogs) |
| Charts | Apache ECharts | Professional animated charts, dark themes, rich visualization |
| Database | SQLite (bun:sqlite) | Zero-config, fast, training data + cache + market history |
| Build (frontend) | Vite + svelte plugin | Fast HMR, optimized production builds |
| Config | TOML | Human-readable fleet configuration |
| Validation | Zod | Runtime config/API response validation |

---

## 4. Data Architecture

### 4.1 Cache Strategy

```
┌────────────────────────────────────────────────────────────┐
│                    SQLite Database                          │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  STATIC CACHE (fetch once, version-gated refresh)          │
│  ├── galaxy_map        ~500 systems, connections, POIs     │
│  ├── item_catalog      all items, categories, properties   │
│  ├── ship_catalog      all ship classes, stats, prices     │
│  ├── skill_tree        139 skills, prerequisites, XP       │
│  └── recipe_catalog    all recipes, materials, outputs     │
│                                                            │
│  TIMED CACHE (TTL-based refresh)                           │
│  ├── market_prices     per-station, 5-10 min TTL           │
│  ├── system_details    per-system, refresh on visit        │
│  └── poi_resources     per-POI, refresh when mining there  │
│                                                            │
│  LIVE (never cached, always from API)                      │
│  ├── bot position, fuel, cargo, credits                    │
│  ├── nearby players                                        │
│  ├── combat status                                         │
│  └── notifications                                         │
│                                                            │
│  TRAINING DATA (append-only, never deleted)                │
│  ├── decision_log      every bot action + context          │
│  ├── state_snapshots   full bot state every ~30s           │
│  ├── episode_summaries completed task cycles               │
│  ├── market_history    price time-series                   │
│  └── commander_log     fleet-level decisions + outcomes    │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### 4.2 Cache Invalidation Rules

| Data | Invalidation Trigger | Refresh Method |
|------|---------------------|----------------|
| Galaxy map | Game version change | `get_map()` → full replace |
| Catalogs (items, ships, skills, recipes) | Game version change | `catalog(type)` paginated → full replace |
| Market prices | TTL expired (5 min) AND bot is trading at that station | `view_market()` at station |
| POI resources | Bot arrives at POI to mine | `get_poi()` |
| System details | Bot jumps to system | `get_system()` |

### 4.3 API Call Budget Per Tick (10 seconds)

```
MUTATIONS (1 per bot per tick, rate-limited by game):
  20 bots × 1 action = 20 mutation calls
  These block until tick resolves. This IS the gameplay.

QUERIES (instant, unlimited, no game impact):
  Rotating snapshots: ~3-4 get_status calls per tick (cycle through bots)
  On-demand: market/system/poi queries only when a bot needs them
  Estimated: 5-10 query calls per tick across all bots

TOTAL: ~25-30 calls per tick for 20 bots
  vs. naive approach: 60-80+ calls per tick without caching
```

### 4.4 Training Data Schema

```sql
-- Every action a bot takes
CREATE TABLE decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  action TEXT NOT NULL,           -- "mine", "travel", "sell", etc.
  params TEXT,                    -- JSON: action parameters
  context TEXT NOT NULL,          -- JSON: bot state at decision time
  result TEXT,                    -- JSON: action outcome
  commander_goal TEXT,            -- active fleet goal
  created_at TEXT DEFAULT (datetime('now'))
);

-- Full bot state snapshots (every ~30s)
CREATE TABLE state_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  player_state TEXT NOT NULL,     -- JSON: credits, skills, stats
  ship_state TEXT NOT NULL,       -- JSON: fuel, cargo, hull, modules
  location TEXT NOT NULL,         -- JSON: system, poi, docked status
  created_at TEXT DEFAULT (datetime('now'))
);

-- Completed task cycles (mining run, trade route, exploration arc)
CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  episode_type TEXT NOT NULL,     -- "mining_run", "trade_route", "exploration"
  start_tick INTEGER NOT NULL,
  end_tick INTEGER NOT NULL,
  duration_ticks INTEGER NOT NULL,
  start_credits INTEGER,
  end_credits INTEGER,
  profit INTEGER,
  route TEXT,                     -- JSON: ordered list of locations
  items_involved TEXT,            -- JSON: items mined/traded/crafted
  fuel_consumed INTEGER,
  risks TEXT,                     -- JSON: threats encountered
  commander_goal TEXT,
  success INTEGER NOT NULL,       -- 0 or 1
  created_at TEXT DEFAULT (datetime('now'))
);

-- Market price observations (time-series)
CREATE TABLE market_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  station_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  buy_price REAL,                 -- best ask
  sell_price REAL,                -- best bid
  buy_volume INTEGER,
  sell_volume INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Commander fleet-level decisions
CREATE TABLE commander_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tick INTEGER NOT NULL,
  goal TEXT NOT NULL,
  fleet_state TEXT NOT NULL,      -- JSON: summary of all bots
  assignments TEXT NOT NULL,      -- JSON: what was assigned
  reasoning TEXT NOT NULL,        -- JSON: scoring breakdown
  created_at TEXT DEFAULT (datetime('now'))
);

-- Static data cache
CREATE TABLE cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  game_version TEXT,
  fetched_at INTEGER NOT NULL
);

-- Timed cache (market, system, poi)
CREATE TABLE timed_cache (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  ttl_ms INTEGER NOT NULL
);
```

---

## 5. System Architecture

### 5.1 High-Level Overview

```
┌──────────────────────────────────────────────────────────┐
│                     WEB DASHBOARD                        │
│              Svelte 5 + Tailwind + ECharts               │
│           (served as static build by Bun)                │
└─────────────────────┬────────────────────────────────────┘
                      │ WebSocket (typed protocol)
┌─────────────────────┴────────────────────────────────────┐
│                     BUN SERVER                           │
│            HTTP static files + WebSocket API             │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────────────────────────────────────────┐     │
│  │              FLEET COMMANDER                    │     │
│  │  ┌──────────────────────────────────────────┐   │     │
│  │  │  CommanderBrain (interface)               │   │     │
│  │  │  ├── ScoringBrain (v2.0)                 │   │     │
│  │  │  ├── LLMBrain (future)                   │   │     │
│  │  │  └── HybridBrain (future)                │   │     │
│  │  └──────────────────────────────────────────┘   │     │
│  │  Evaluates fleet state → assigns bots to roles  │     │
│  │  Runs every 30-60 seconds                       │     │
│  └──────────┬──────────────────────────────────────┘     │
│             │ assigns routines                           │
│  ┌──────────┴──────────────────────────────────────┐     │
│  │              BOT MANAGER                        │     │
│  │  Manages 2-20 Bot instances                     │     │
│  │  Staggered login, lifecycle management          │     │
│  │  ┌──────┐ ┌──────┐ ┌──────┐      ┌──────┐     │     │
│  │  │ Bot1 │ │ Bot2 │ │ Bot3 │ ···  │Bot20 │     │     │
│  │  │ gen* │ │ gen* │ │ gen* │      │ gen* │     │     │
│  │  └──┬───┘ └──┬───┘ └──┬───┘      └──┬───┘     │     │
│  └─────┼────────┼────────┼──────────────┼─────────┘     │
│        └────────┴────────┴──────────────┘                │
│                    │                                     │
│  ┌─────────────────┴───────────────────────────────┐     │
│  │              CORE SERVICES                      │     │
│  │  Injected into every bot via BotContext          │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │     │
│  │  │ApiClient │ │Navigation│ │  Market  │        │     │
│  │  │(typed,   │ │(pathfind,│ │(prices,  │        │     │
│  │  │ cached)  │ │ fuel-est)│ │ arb det) │        │     │
│  │  └──────────┘ └──────────┘ └──────────┘        │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │     │
│  │  │  Cargo   │ │   Fuel   │ │  Combat  │        │     │
│  │  │(inv mgmt,│ │(monitor, │ │(threat,  │        │     │
│  │  │ optimize)│ │ recovery)│ │ tactics) │        │     │
│  │  └──────────┘ └──────────┘ └──────────┘        │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │     │
│  │  │ Crafting │ │ Station  │ │  Galaxy  │        │     │
│  │  │(recipes, │ │(dock,    │ │(map, POI,│        │     │
│  │  │ chains)  │ │ storage) │ │ systems) │        │     │
│  │  └──────────┘ └──────────┘ └──────────┘        │     │
│  └─────────────────┬───────────────────────────────┘     │
│                    │                                     │
│  ┌─────────────────┴───────────────────────────────┐     │
│  │              DATA LAYER                         │     │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐        │     │
│  │  │ GameCache│ │ Training │ │  Session  │        │     │
│  │  │(SQLite,  │ │  Logger  │ │  Store    │        │     │
│  │  │ TTL,     │ │(decisions│ │(creds,    │        │     │
│  │  │ version) │ │ episodes)│ │ tokens)   │        │     │
│  │  └──────────┘ └──────────┘ └──────────┘        │     │
│  └─────────────────────────────────────────────────┘     │
│                                                          │
└──────────────────────────────────────────────────────────┘
              │
              │ HTTP API (cached, minimal calls)
              ▼
   game.spacemolt.com
```

### 5.2 Dependency Flow (strict, no circular imports)

```
types/          ← depends on nothing
  game.ts
  api.ts
  protocol.ts
      ↑
data/           ← depends on types
  database.ts
  game-cache.ts
  training-logger.ts
  session-store.ts
      ↑
core/           ← depends on types, data
  api-client.ts
  navigation.ts
  market.ts
  cargo.ts
  fuel.ts
  combat.ts
  crafting.ts
  station.ts
  galaxy.ts
      ↑
bot/            ← depends on types, core
  context.ts
  bot.ts
      ↑
routines/       ← depends on types, bot (uses core via context)
  miner.ts
  trader.ts
  explorer.ts
  ...
      ↑
commander/      ← depends on types, bot, core
  commander.ts
  strategies.ts
  evaluator.ts
      ↑
server/         ← depends on everything above
  server.ts
  routes.ts
  ws-handler.ts
      ↑
index.ts        ← entry point, wires everything together
```

---

## 6. Core Services Detail

### 6.1 ApiClient

The single interface to the SpaceMolt HTTP API. Every API call goes through here.

**Responsibilities:**
- Typed request/response for all 100+ endpoints
- Session management (create, login, reconnect on expiry)
- Automatic retry with exponential backoff on transient errors
- Response normalization (consistent shape regardless of API quirks)
- Request deduplication (if two bots request the same system data, one call)
- Hooks into GameCache (check cache before hitting API)
- Hooks into TrainingLogger (log every mutation result)

**What it does NOT do:**
- Game logic decisions
- State management beyond session tokens

### 6.2 Navigation

**Responsibilities:**
- BFS/Dijkstra shortest path between systems (using cached galaxy map)
- Fuel-aware routing ("can I reach X with current fuel?")
- Multi-stop route planning ("visit these 3 stations optimally")
- Fuel cost estimation for any route
- "Nearest station" / "nearest belt" / "nearest POI of type X" queries
- All computed locally from cached map data (zero API calls)

### 6.3 Market

**Responsibilities:**
- Price lookup (from cache, refresh if stale)
- Arbitrage detection (find profitable buy→sell pairs across cached stations)
- Trade route scoring (profit per tick including travel time)
- Price trend analysis (from market_history training data)
- "Best station to sell X" / "cheapest station to buy X" queries

**API calls:** Only `view_market()` when cache is stale AND a bot needs it.

### 6.4 Cargo

**Responsibilities:**
- Cargo space calculations (current / max / available)
- Optimal sell ordering (most profitable items first)
- Material availability checking ("do I have enough to craft X?")
- Cargo value estimation (using cached market prices)

**API calls:** None. Works from bot state data.

### 6.5 Fuel

**Responsibilities:**
- Fuel level monitoring and threshold alerts
- "Can I make this trip?" pre-checks
- Emergency recovery chain (refuel → use fuel cells → find station → wait for rescue)
- Fuel cost estimation for routes

**API calls:** `refuel()` mutation only when actually refueling.

### 6.6 Combat

**Responsibilities:**
- Threat assessment ("is this system/POI safe?")
- Police level awareness (from cached system data)
- Battle stance selection logic
- Ammo management and reload decisions
- Flee calculations (can I escape? how many ticks?)
- Target prioritization in multi-ship battles

**API calls:** `get_battle_status()` during active combat, `scan()` when needed.

### 6.7 Crafting

**Responsibilities:**
- Recipe lookup (from cached catalog)
- Prerequisite chain resolution ("to craft X, I first need Y and Z")
- Material shopping list generation
- Skill level checking ("can I craft this?")
- Batch optimization ("craft 10x if I have materials")

**API calls:** `craft()` mutation only when actually crafting.

### 6.8 Station

**Responsibilities:**
- Dock/undock management
- Storage deposit/withdraw optimization
- Repair decision ("is repair worth the credits?")
- Station service availability (from cached POI data)
- Home base management

**API calls:** Mutations only when performing station actions.

### 6.9 Galaxy

**Responsibilities:**
- Star system graph (loaded from cache at startup)
- POI classification and lookup
- Resource location tracking ("where can I mine iron?")
- System security assessment
- Empire territory mapping
- Jump connection graph for Navigation service

**API calls:** None in steady state. `get_map()` on first launch or version change.

---

## 7. Commander Design

### 7.1 Goal System

Goals are high-level directives the user sets:

```typescript
type GoalType =
  | "maximize_income"        // make as much credits/hr as possible
  | "explore_region"         // map and catalog a set of systems
  | "prepare_for_war"        // gear up, train combat, stockpile ammo
  | "level_skills"           // focus on training specific skill categories
  | "establish_trade_route"  // find and run profitable routes
  | "resource_stockpile"     // accumulate specific resources
  | "faction_operations"     // faction missions, storage, territory
  | "custom"                 // user-defined composite goal

interface Goal {
  type: GoalType
  priority: number
  params: Record<string, unknown>  // goal-specific config
  constraints?: {
    maxRiskLevel?: number          // 0-4 system security minimum
    regionLock?: string[]          // limit to these systems/empires
    budgetLimit?: number           // max credits to spend
  }
}
```

### 7.2 Commander Brain Interface

```typescript
interface CommanderBrain {
  evaluate(
    fleetState: FleetState,
    goals: Goal[],
    economyState: EconomyState,
    galaxyData: GalaxySummary
  ): Promise<CommanderDecisions>
}

interface CommanderDecisions {
  assignments: FleetAssignment[]     // bot role changes
  marketOrders: MarketOrderAction[]  // buy/sell orders to place/cancel
  inventoryMoves: InventoryMove[]    // items to move between stations
  craftingQueue: CraftingOrder[]     // recipes to prioritize
  upgradeRecommendations: UpgradeRec[] // ship upgrades to consider
  reasoning: string                  // human-readable summary
}

interface FleetAssignment {
  botId: string
  routine: RoutineName
  params: RoutineParams
  reasoning: string
  score: number
  previousRoutine?: RoutineName
}
```

Drop-in replaceable. ScoringBrain for v2.0. LLMBrain or TrainedModelBrain later.

### 7.3 Fleet Economy Engine

The Commander's core intelligence. Manages the full economic pipeline every evaluation cycle.

**Module structure:**
```
commander/
  commander.ts              ← main loop (calls all sub-engines in order)
  scoring-brain.ts          ← role assignment scoring
  evaluator.ts              ← fleet state snapshot
  strategies.ts             ← goal-specific weight profiles

  economy/
    supply-chain.ts         ← demand/supply calculation, deficit detection
    inventory-manager.ts    ← stock targets, reorder points, surplus handling
    order-manager.ts        ← station exchange orders, pricing, staleness
    profit-calculator.ts    ← per-tick profit, ROI, risk adjustment
    skill-planner.ts        ← skill development paths, milestone tracking
    logistics-planner.ts    ← material routing, fuel/ammo delivery scheduling
    upgrade-advisor.ts      ← ship upgrade ROI analysis
    price-strategy.ts       ← batch selling, price impact, order staggering
```

#### 7.3.1 Supply Chain Manager

Tracks what the fleet consumes vs. what it produces:

```typescript
interface MaterialDemand {
  itemId: string
  quantityPerHour: number     // consumption rate
  source: string              // which bot/routine creates demand
  priority: "critical" | "normal" | "low"
    // critical = ammo during combat, fuel when low
    // normal = crafting ingredients, trading stock
    // low = strategic stockpiling
}

interface SupplyChainState {
  demands: MaterialDemand[]
  supplies: MaterialSupply[]
  deficits: MaterialDeficit[]     // demand > supply → action needed
  surpluses: MaterialSurplus[]    // supply > demand → sell or redistribute
}
```

Every evaluation cycle:
1. **Calculate demand** from crafter recipes, hunter ammo burn, fleet fuel consumption
2. **Calculate supply** from miner production rates, current inventory levels
3. **Detect deficits** → dispatch miners to specific ores, place buy orders, route couriers
4. **Detect surpluses** → create sell orders, move excess to trade hubs, adjust miner targets

#### 7.3.2 Inventory Manager

Maintains target stock levels at each station:

```typescript
interface StockTarget {
  stationId: string
  itemId: string
  minStock: number          // below this → reorder
  maxStock: number          // above this → sell/move
  purpose: "crafting" | "trading" | "fuel" | "ammo" | "strategic"
}
```

Deficit actions (in priority order):
1. Withdraw from faction storage (free, instant if available)
2. Dispatch courier from another station that has surplus
3. Place buy order at market (patient, better price)
4. Dispatch miner to produce the resource
5. Craft from components if cheaper than buying

Surplus actions (in priority order):
1. Create sell order at good price (patient, higher margin)
2. Move to station where it's needed (internal logistics)
3. Instant sell if price is acceptable and storage is tight
4. Deposit to faction storage for fleet-wide access

#### 7.3.3 Per-Tick Profit Calculator

THE key metric for trader routing. Raw profit is misleading - a 2000cr trade that takes 20 ticks is worse than a 500cr trade that takes 4 ticks.

```typescript
interface TradeRouteScore {
  buyStation: string
  sellStation: string
  item: string
  buyPrice: number
  sellPrice: number
  quantity: number              // limited by cargo capacity

  // Costs
  fuelCost: number              // fuel consumed for round trip
  ticksRequired: number         // buy(1) + travel(N) + sell(1) + return(N)

  // The metrics that matter
  netProfit: number             // gross - fuel cost
  profitPerTick: number         // netProfit / ticksRequired ← PRIMARY METRIC
  riskFactor: number            // 0-1, based on route security levels
  riskAdjustedPPT: number       // profitPerTick × (1 - riskFactor)
}
```

#### 7.3.4 Station Exchange Order Management

Instead of only instant buy/sell, proactively manage the order book:

- **Sell orders:** Place at market+10-20% for patience premium. Stagger large quantities to avoid price impact (don't dump 500 ore at once).
- **Buy orders:** Place at market price for discount, OR above market to attract sellers when we need materials and the margin justifies it (see 7.3.9).
- **Order lifecycle:** Create → monitor → adjust price if market moved → cancel if stale (>X hours unfilled).
- **Price impact awareness:** If fleet holds 500 of an item at a station, sell in batches of 50-100.
- **Fill rate tracking:** Learn which price points actually fill. Feed into price strategy.

#### 7.3.9 Crafting Margin Arbitrage (Market-Making Strategy)

Core insight: if crafting margins are fat, it's cheaper to PAY ABOVE MARKET for raw materials than to mine them ourselves, because the freed miner can do something more profitable.

**Example:**
```
Ore market price:     10cr each
Recipe:               4 ore → Item Y
Item Y sells for:     100cr
Crafting margin:      60cr (150%)
Breakeven buy price:  25cr per ore (anything below this = profit)

Strategy: Place buy order at 15cr (50% above market)
→ Other players see premium price, sell us their ore
→ Our cost: 4 × 15 = 60cr, sell for 100cr = 40cr profit
→ We freed a miner who now earns 200cr/hr on rare ore
→ Net fleet gain: +200cr/hr rare ore - 20cr/hr premium = +180cr/hr
```

**The Commander calculates for each craftable item:**
1. Full recipe chain cost at market prices (recursive for multi-step recipes)
2. Breakeven buy price per ingredient
3. Optimal premium (attractive to sellers, still profitable for us)
4. "Freed bot value" - what the miner would earn doing something else
5. Net gain: freed bot value - premium cost → if positive, outsource

**Sourcing strategy per ingredient:**
```
SELF_MINE:      No sellers, idle miners, rare ore only we can reach
MARKET_BUY:     Ore is cheap and abundant, just buy at market price
PREMIUM_ORDER:  Fat crafting margins, freeing miners creates more value
FACTION_STORAGE: We already have stockpiled materials
CRAFT:          Intermediate item, cheaper to craft than buy
```

**Advanced: Station Market Making**
The fleet can dominate a station's economy by simultaneously:
- Placing premium buy orders for raw materials (attracting sellers/miners)
- Placing sell orders for finished goods (capturing crafting spread)
- Becoming the supply chain middleman at key stations
- Higher crafter skill levels = lower costs = wider margins than competitors

This data feeds directly into training: the model learns which items have exploitable margins, which stations have active traders to outsource from, and optimal premium pricing.

#### 7.3.5 Skill Development Planner

Strategic long-term assignments that override short-term profit:

```typescript
interface SkillPlan {
  botId: string
  targetSkill: string         // "refinement"
  prerequisite: string        // "mining_basic >= 3"
  currentLevel: number
  targetLevel: number
  estimatedTicks: number      // XP needed / XP per action
  trainedByRoutine: string    // "miner"
  unlocks: string[]           // what becomes available at target level
}
```

Commander checks: "Bot5 is 200 XP from unlocking refinement. Keep mining for ~30 more minutes, then switch to crafting." This is a STRATEGIC assignment that may not score highest on income, but builds fleet capability.

#### 7.3.6 Ship Upgrade Advisor

```typescript
interface UpgradeAnalysis {
  botId: string
  currentShip: string
  candidateShip: string
  cost: number
  currentEarningRate: number     // cr/tick with current ship
  projectedEarningRate: number   // cr/tick with candidate (bigger cargo, faster, etc.)
  paybackTicks: number           // cost / improvement per tick
  paybackMinutes: number
  recommendation: "buy_now" | "save_up" | "not_worth_it" | "need_more_data"
}
```

Rules:
- Payback under 1 hour → "buy_now"
- Payback under 4 hours → "save_up" (don't interrupt current task, buy when docked)
- Payback over 4 hours → "not_worth_it" (unless strategic goal requires it)

#### 7.3.7 Logistics Planner

Routes materials between stations optimally:

- Combines courier trips (pick up iron at A, deliver to B, pick up copper at B, deliver to C)
- Minimizes empty-cargo travel (always carry something both directions)
- Prioritizes critical deliveries (ammo for hunters > surplus ore for traders)
- Coordinates with fuel planner (don't send courier on trip it can't fuel for)

### 7.4 Full Evaluation Loop

Every 60 seconds, Commander runs this pipeline:

```
┌─────────────────────────────────────────────────────────────┐
│  STEP 1: FLEET STATE SNAPSHOT                               │
│  All bot positions, cargo, fuel, credits, skills, routines  │
│  Source: cached bot state (no API calls)                    │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 2: SUPPLY CHAIN ANALYSIS                              │
│  Calculate demand (crafters, hunters, fuel)                  │
│  Calculate supply (miners, current stock)                    │
│  Identify deficits and surpluses                            │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 3: INVENTORY CHECK                                    │
│  Compare stock vs targets at each station                   │
│  Flag items below min or above max threshold                │
│  Check open market orders for fills/staleness               │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 4: MARKET ANALYSIS                                    │
│  Refresh stale prices (only where bots are docked)          │
│  Recalculate trade routes by per-tick profit                │
│  Update arbitrage opportunities                             │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 5: SKILL & UPGRADE ASSESSMENT                         │
│  Check skill development milestones                         │
│  Run ship upgrade ROI analysis                              │
│  Identify bots approaching skill unlocks                    │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 6: SCORING & ASSIGNMENT                               │
│  Score every bot × role combination incorporating:          │
│  - Supply chain needs (deficit items boost mining score)     │
│  - Per-tick profit (not absolute margin)                    │
│  - Skill match (bot skills vs task requirements)            │
│  - Skill development (strategic training assignments)       │
│  - Risk adjustment (route security × profit)                │
│  - Switch cost (ticks to transition roles)                  │
│  - Fleet diversity (avoid all-miners, all-traders)          │
│  Apply cycle-aware reassignment rules                       │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 7: ISSUE ORDERS                                       │
│  - Reassign bots (at cycle boundaries only)                 │
│  - Place/cancel/adjust market orders                        │
│  - Dispatch couriers with material routing plan             │
│  - Queue crafting recipes by priority                       │
│  - Trigger ship upgrades when ROI is positive               │
└──────────────────────┬──────────────────────────────────────┘
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  STEP 8: LOG EVERYTHING                                     │
│  Full reasoning chain → commander_log (training data)       │
│  Supply/demand state → economy snapshots                    │
│  Scoring breakdown per bot → decision_log                   │
└─────────────────────────────────────────────────────────────┘
```

### 7.5 Commander-to-Routine Communication

The Commander doesn't just assign roles - it passes specific parameters:

```typescript
// Commander tells miner WHAT to mine and WHERE
{ routine: "miner", params: {
    targetOre: "ore_iron",           // supply chain says we need iron
    targetBelt: "sol_asteroid_belt",
    sellStation: "sol_earth",        // where crafter needs it
    prioritizeDeposit: true          // deposit to station storage, don't sell on market
}}

// Commander tells trader WHICH route to run
{ routine: "trader", params: {
    route: { buy: "nebula_station", sell: "sol_earth", item: "ore_silicon" },
    maxBuyPrice: 18,                 // don't overpay
    minSellPrice: 28,                // don't undersell
    useOrders: true                  // place orders instead of instant trade
}}

// Commander tells crafter WHAT to craft and in what order
{ routine: "crafter", params: {
    craftingQueue: [
      { recipeId: "refine_steel", count: 20, priority: 1 },
      { recipeId: "craft_hull_plating", count: 5, priority: 2 }
    ],
    materialSource: "station_storage",  // don't buy, use what miners deposited
    sellFinishedGoods: true
}}

// Commander tells courier WHERE to move WHAT
{ routine: "courier", params: {
    deliveries: [
      { from: "sol_earth", to: "nebula_station", item: "ammo_kinetic_small", qty: 50 },
      { from: "nebula_station", to: "sol_earth", item: "ore_silicon", qty: 100 }
    ]
}}
```

---

## 8. Bot & Routine Design

### 8.1 Bot Lifecycle

```
IDLE → LOGGING_IN → READY → RUNNING → STOPPING → IDLE
                      ↑                    │
                      └────────────────────┘
                         (reassignment)
```

### 8.2 Routine Interface

Kept from v1 (this was a good pattern):

```typescript
type Routine = (ctx: BotContext) => AsyncGenerator<string, void, void>

// The yielded string is the current state label shown on dashboard
// e.g., "mining", "traveling to Sol Belt", "selling 45 iron ore"
```

### 8.3 BotContext (Dependency Injection)

```typescript
interface BotContext {
  // Identity
  botId: string
  session: SessionInfo

  // Core services (shared instances, not singletons)
  api: ApiClient
  nav: Navigation
  market: Market
  cargo: CargoManager
  fuel: FuelManager
  combat: CombatManager
  crafting: CraftingManager
  station: StationManager
  galaxy: Galaxy

  // Data
  cache: GameCache
  logger: TrainingLogger

  // Fleet awareness (read-only view of other bots)
  getFleetStatus: () => FleetStatus

  // Routine params (set by Commander)
  params: RoutineParams

  // State
  state: BotState        // "running" | "stopping" | etc.
  player: PlayerState    // latest known player state
  ship: ShipState        // latest known ship state
}
```

### 8.4 Routine List

| Routine | Purpose | Key Core Services Used |
|---------|---------|----------------------|
| `miner` | Mine ore at belts, sell at stations | navigation, cargo, fuel, market, station |
| `harvester` | Unified gas/ice/asteroid mining (parameterized) | navigation, cargo, fuel, market, station |
| `trader` | Buy low, sell high across stations | navigation, cargo, fuel, market, station |
| `explorer` | Map systems, catalog POIs, scan resources | navigation, fuel, galaxy |
| `crafter` | Craft items from recipes, manage materials | crafting, cargo, station, market |
| `hunter` | Combat NPCs/players, loot wrecks | combat, navigation, fuel, cargo |
| `salvager` | Scavenge wrecks, recover materials | navigation, cargo, station |
| `rescue` | Monitor fleet for stranded bots, deliver fuel | navigation, fuel, cargo (fleet awareness) |
| `courier` | Move items between stations for fleet needs | navigation, cargo, station |
| `mission_runner` | Accept and complete NPC missions | navigation, combat, cargo, station |

### 8.5 Avoiding Code Duplication: Common Patterns

These patterns appear in EVERY routine and belong in core:

| Pattern | Where in v1 | Where in v2 |
|---------|------------|-------------|
| "Navigate to X, handling fuel" | Duplicated in every routine | `nav.travelTo(ctx, destination)` |
| "Dock, sell cargo, refuel" | Duplicated in every routine | `station.dockAndService(ctx, { sell: true, refuel: true })` |
| "Check if cargo is full" | Inline checks everywhere | `cargo.isFull(ctx)` / `cargo.freeSpace(ctx)` |
| "Find nearest station" | Reimplemented 4 different ways | `nav.findNearest(ctx, 'station')` |
| "Am I safe here?" | Scattered police checks | `combat.isSafe(ctx)` |
| "Handle emergency (low fuel, damaged)" | Duplicated recovery chains | `fuel.ensureSafe(ctx)` / `station.emergencyDock(ctx)` |
| "Parse API response safely" | Defensive parsing everywhere | Typed in ApiClient, validated with Zod |

---

## 9. Dashboard Design

### 9.1 Site Map & Pages

**Navigation:** `Fleet | Economy | Galaxy | Activity | Market | Bots | Training | Settings`

| # | Page | Route | Purpose |
|---|------|-------|---------|
| 1 | **Fleet** | `/` | Mission control home. Commander status, key metrics, credits chart, bot status table, commander log, alerts. |
| 2 | **Economy** | `/economy` | Supply chain, P&L, inventory levels, open orders, deficit/surplus alerts. |
| 3 | **Galaxy** | `/galaxy` | Canvas 2D fleet operations map with 9 filter overlays (see 9.4). |
| 4 | **Activity** | `/activity` | Market ticker, live trade/crafting feed, stat cards, top items. |
| 5 | **Market** | `/market` | Price analysis, heatmaps, arbitrage by per-tick profit, order fill rates. |
| 6 | **Bots** | `/bots` | Bot management hub: roster cards, add/remove/import bots, fleet summary. |
| 6b| **Bot Detail** | `/bots/:id` | Per-bot deep dive with 6 tabs: Overview, Skills, History, Settings, Logs, Credentials. |
| 7 | **Training** | `/training` | Training data viewer, dataset stats, export controls, decision distributions. |
| 8 | **Settings** | `/settings` | App-level config with 6 tabs: Goals, Commander, Fleet, Economy, Cache, About. |

### 9.1.1 Global Elements (always visible)

**Navigation Bar (top, fixed):**
```
┌─────────────────────────────────────────────────────────────────────┐
│  ⚡ COMMANDER   Fleet│Economy│Galaxy│Activity│Market│Bots│Training│⚙│
│  Right: [🔔 3]  Fleet: 12/20 ●  +2,340 cr/hr  Brain: Scoring     │
└─────────────────────────────────────────────────────────────────────┘
```
- Notification bell with unread count
- Fleet status (active/total bots)
- Income rate (always visible)
- Commander brain indicator

**Notification Drawer (slide from right on bell click):**
- Grouped by severity: Critical (red), Warning (amber), Info (blue)
- Types: bot errors, session expiry, supply deficits, skill milestones, commander decisions
- [Clear All] button, individual dismiss

**Connection Status Banner (top, conditional):**
- Shows only when connection lost: "Connection lost. Retrying in 5s..." with countdown
- Auto-reconnect with exponential backoff

**Keyboard Shortcuts:**
- `1-8`: Navigate to pages
- `Space`: Pause/resume all bots
- `R`: Force Commander re-evaluation
- `?`: Show shortcut overlay

### 9.1.2 Fleet Page (`/`) - Mission Control

Commander status card (goal, brain, income, alerts, next evaluation countdown).
4 metric cards (total credits, income/hr, active bots, uptime) with trend indicators.
Credits over time chart (24h line) + Revenue by bot (horizontal bar).
Bot status table (click row → `/bots/:id`): status dot, name, role, state, location, cr/hr, fuel%.
Commander log (timestamped decisions with expandable "why?" scoring explanation).
Active alerts (deficits, milestones, upgrade recommendations, errors).

### 9.1.3 Bots Page (`/bots`) - Management Hub

**Bot Roster** - card per bot showing:
- Status indicator (green/yellow/red/grey)
- Name, empire, ship class, credits
- Current role, state, uptime
- Top skills summary
- Fuel + cargo gauges
- Action buttons: [⚙ Settings] [▶ Start / ■ Stop] [🗑 Remove]
- Error state: shows error message + [Retry Login] [Edit Credentials] [View Error Log]
- Click card → `/bots/:id`

**Add Bot Dialog (modal, two modes):**
- Register New: username, empire dropdown, registration code → creates account and adds
- Import Existing: username, password → test login, then add
- Security note: "Passwords stored locally in data/sessions/. Never transmitted except to game.spacemolt.com"

**Fleet Summary Bar:** total bots, active/stopped/error counts, empire distribution, faction name.

### 9.1.4 Bot Detail Page (`/bots/:id`) - 6 Tabs

**Overview Tab:**
- Status card (credits, income, role, state, location, docked)
- Ship card (class, hull/shield/fuel/cargo gauges, modules list)
- Cargo breakdown (pie chart + table)
- Earnings chart (24h line)
- Commander notes (current assignment reason, next evaluation plan, skill plan)

**Skills Tab:**
- Skill radar chart (spider chart across categories: mining, trading, combat, crafting, nav, exploration)
- Full skill table (skill name, level, XP%, progress bar)
- Active skill plan (target skill, progress, ETA, what it unlocks)

**History Tab:**
- Action timeline (scrollable, filterable by action type)
- Episode history (completed task cycles with profit, duration, route)
- Click episode → expands full details

**Settings Tab (per-bot overrides):**
- Assignment mode: [Commander decides] or [Manual override]
- Per-routine settings (shown based on current/selected role):
  - Miner: target ore, home station, cargo threshold, min fuel, max risk, deposit to storage
  - Trader: max route jumps, min profit/tick, use orders, max buy premium
  - Explorer: max jump distance, use cloak, submit intel
  - Hunter: engagement rules (NPCs only/all/faction enemies), flee threshold, auto-insurance
  - Crafter: recipe priority, material source, sell finished goods
- [Reset to Commander Defaults] [Save Overrides]

**Logs Tab:**
- Filterable bot log (All / Errors / Commander decisions)
- Search bar
- Log levels: INFO, WARN, ERROR, CMD (commander decisions)

**Credentials Tab:**
- Username (read-only)
- Password (masked with show/copy buttons)
- Empire, Player ID (read-only)
- Session status (active/expired, expiry countdown)
- [Force Re-login] [Reset Password via spacemolt.com/dashboard]
- File path: `data/sessions/{name}/credentials.json`

### 9.1.5 Settings Page (`/settings`) - 6 Tabs

**Goals Tab:** Active goals table (priority, type, params) with add/edit/remove. Goal type picker with param forms.

**Commander Tab:** Brain selector (scoring/LLM/hybrid). Evaluation interval, reassignment cooldown, score threshold, switch cost weight, urgency override toggle. LLM provider/model/key config (disabled until LLM brain selected).

**Fleet Tab:** Fleet defaults (max bots, login stagger, snapshot interval). Default routine settings (fuel threshold, cargo threshold, risk level, auto-refuel, auto-repair, submit intel). Faction settings (name, auto-deposit surplus, share intel, share trade intel).

**Economy Tab:** Inventory targets table (station, item, min, max, purpose) with add/edit. Market making settings (enable premium orders, max premium %, min crafting margin, batch sell size, order stale timeout).

**Cache Tab:** Cache status per data type (version, age, item count). Database size and training record count. Buttons: [Force Refresh All] [Clear Market Cache] [Export Training Data] [Vacuum Database].

**About Tab:** Version info (commander, game server, Bun), uptime, API call stats for the day (mutations vs queries).

### 9.1.6 Confirmation Dialogs

Destructive actions require explicit confirmation:
- Remove bot → "Remove {name}? This stops the bot and deletes saved credentials."
- Force reassign → "Override Commander? Bot will be manually assigned until you release."
- Clear training data → "Delete all training data? This cannot be undone."
- Reset all settings → "Reset all settings to defaults?"

### 9.2 Design Language

Aligned with SpaceMolt's own design system for cohesive feel:

**Color Tokens (matching SpaceMolt CSS variables):**
```
Backgrounds:  space-black #0a0e17, deep-void #0d1321, nebula-blue #1a2744
Accents:      plasma-cyan #00d4ff, laser-blue #4dabf7, shell-orange #ff6b35
              claw-red #e63946, bio-green #2dd4bf, warning-yellow #ffd93d
              void-purple #9b59b6
Text:         star-white #e8f4f8, chrome-silver #a8c5d6, hull-grey #3d5a6c

Empires:      solarian #ffd700, voidborn #9b59b6, crimson #e63946
              nebula #00d4ff, outerrim #2dd4bf, neutral #5a6a7a

Routines:     miner #ff6b35, trader #2dd4bf, explorer #00d4ff
              crafter #9b59b6, hunter #e63946, salvager #ffd93d
              rescue #4dabf7, courier #a8c5d6, mission #ffd700
```

**Typography (matching SpaceMolt fonts):**
- Orbitron: headings, stat values, uppercase labels
- JetBrains Mono: data, numbers, tables, monospace content
- Space Grotesk: body text, system labels, descriptions

**Visual Style:**
- Cards: glass-morphism (`background: linear-gradient(135deg, nebula-blue, deep-void)`, `border: 1px solid hull-grey`, `backdrop-filter: blur(10px)`)
- Hover: `border-color: #00d4ff66` transition
- Animations: smooth number ticking, chart morphing, card hover lifts
- Status indicators: pulsing dots (green=active, amber=idle, red=error, gray=offline)
- Charts: ECharts with dark theme, gradient fills, animated transitions
- Shadows: `box-shadow: 0 4px 20px #00000080`

### 9.4 Galaxy Map (Fleet Operations Map)

Canvas 2D map matching SpaceMolt's rendering approach. 500 systems with fixed x/y coordinates from cached `get_map()` data. Zero API calls in steady state.

**Rendering stack (draw order):**
1. Starfield background (procedural, animated twinkle)
2. Coordinate grid (multi-scale, fades with zoom)
3. Jump connections (lines between connected systems)
4. Active overlay layers (based on filter toggles)
5. System nodes (empire-colored circles with glow effects)
6. Bot icons (routine-colored diamonds on current position)
7. Labels (system names, bot names)
8. DOM tooltip overlay (follows cursor on hover)

**9 Toggleable Filter Overlays:**

| Filter | Default | Renders |
|--------|---------|---------|
| **Bot Positions** | ON | Routine-colored diamonds at each bot's current system. Pulsing when active, dim when idle. Click → bot detail. |
| **Trade Routes** | OFF | Animated dashed lines between active trader buy/sell stations. Thickness = profit/tick. Color = profitability (green/yellow/red). |
| **Supply Flows** | ON | Animated particle lines showing material movement. Miner→Station (orange), Station→Crafter (purple), Crafter→Market (green). Deficits pulse red. |
| **Faction Territory** | ON | Translucent colored regions around systems with faction presence. Storage locations flagged. Enemy territory red-tinted. |
| **Threat Map** | OFF | Systems colored by police level: green (3-4), yellow (1-2), red (0). Active battles show explosion animation. Recent deaths show skulls. |
| **Resource Map** | OFF | Systems colored by resource availability. Ore type icons at belts. Brightness = richness. Depleted belts dimmed. Sub-filter: by resource type. |
| **Market Activity** | ON | Trade icons at stations sized by volume. Our trades in gold, others in grey. Click station → price ticker. |
| **Skill Training** | OFF | Progress rings around bot icons showing XP to next level. Glowing highlight when milestone approaching. |
| **Travel Paths** | OFF | Breadcrumb trails of where bots have been in last hour. Useful for seeing exploration coverage. |

**Interactivity:**
- Zoom: scroll wheel (exponential), pinch gesture, +/- buttons
- Pan: click-and-drag with grab cursor
- Hover: nearest system/bot within 15px, shows tooltip
- Click system: slides open System Detail Panel (right side, 360px)
- Click bot: slides open Bot Detail Panel
- URL sync: `?x=&y=&z=&system=` for shareable views

**System Detail Panel (right slide-in, 360px):**
- System name, empire, police level
- Our bots currently here (with routine + status)
- Market summary (key prices with trend arrows ▲▼─)
- POI list with resource details
- Supply chain at this station (receiving/shipping volumes)
- Faction intel (last scouted, known threats)

### 9.5 Market Activity Panel

Integrated into Economy page and available as overlay on Galaxy Map.

**Stat Cards (4-column grid, matching SpaceMolt ticker layout):**
- 24h Volume (total market), Total Trades, Our Fleet Volume, Fleet Profit
- Each with trend indicator (▲ green / ▼ red / ─ grey) vs previous period

**Top Items (our fleet):**
- Ranked by our trading volume
- Horizontal gradient bars (plasma-cyan → bio-green)
- Shows volume + trade count per item

**Live Trade Feed:**
- Scrolling list of recent trades
- Filterable: [All] [Our Fleet] [Our Faction] + search box
- Each row: timestamp (relative), bot/player name, action (bought/sold/crafted), item, qty, price, station
- Our bot trades highlighted in gold, others in grey
- Commander actions (placed order, cancelled order) shown in cyan

**Open Orders Table:**
- All active buy/sell orders placed by Commander
- Columns: Type (BUY/SELL), Item, Qty, Price, Station, Fill %, Age
- Fill progress bar (gradient)
- Actions: cancel, modify price
- Stale orders (>2h unfilled) highlighted in warning-yellow

### 9.3 Real-Time Updates

Dashboard connects via WebSocket to Bun server. Protocol:

```typescript
// Server → Dashboard
type ServerMessage =
  | { type: "fleet_update"; bots: BotSummary[] }
  | { type: "bot_update"; botId: string; state: BotState }
  | { type: "commander_decision"; decision: CommanderDecisions }
  | { type: "economy_update"; economy: EconomyState }
  | { type: "market_update"; stationId: string; prices: MarketPrice[] }
  | { type: "supply_chain_update"; deficits: MaterialDeficit[]; surpluses: MaterialSurplus[] }
  | { type: "order_update"; orders: OpenOrder[] }
  | { type: "log_entry"; entry: LogEntry }
  | { type: "stats_update"; stats: FleetStats }
  | { type: "skill_milestone"; botId: string; skill: string; level: number; unlocks: string[] }

// Dashboard → Server
type ClientMessage =
  | { type: "set_goal"; goal: Goal }
  | { type: "override_assignment"; botId: string; routine: RoutineName; params?: RoutineParams }
  | { type: "set_inventory_target"; target: StockTarget }
  | { type: "start_bot"; botId: string }
  | { type: "stop_bot"; botId: string }
  | { type: "update_settings"; settings: Partial<Settings> }
  | { type: "cancel_order"; orderId: string }
  | { type: "force_reassign"; botId: string; routine: RoutineName }
```

Push interval: fleet_update every 2-3 seconds, stats_update every 10 seconds, others on-event.

---

## 10. Configuration

### 10.1 Fleet Config (config.toml)

```toml
[commander]
brain = "scoring"           # "scoring" | "llm" | "hybrid"
evaluation_interval = 30    # seconds between fleet evaluations
reassignment_threshold = 0.3 # score improvement needed to reassign (prevents thrashing)

[[goals]]
type = "maximize_income"
priority = 1

[[goals]]
type = "explore_region"
priority = 2
params = { region = "voidborn" }

[fleet]
max_bots = 20
login_stagger_ms = 5000
snapshot_interval = 30      # seconds between state snapshots

[cache]
market_ttl_ms = 300000      # 5 minutes
system_ttl_ms = 3600000     # 1 hour
catalog_refresh = "on_version_change"

[server]
port = 3000
host = "localhost"

[training]
log_decisions = true
log_snapshots = true
log_episodes = true
log_market_history = true
snapshot_interval = 30      # seconds

# Bot credentials stored separately in data/sessions/
# Not in config file for security
```

### 10.2 Settings Hierarchy (kept from v1, improved)

```
Commander goal params
  └── Routine-level defaults (from scoring brain)
       └── Per-bot overrides (from config or dashboard)
            └── Emergency overrides (fuel/combat critical)
```

---

## 11. Gameplay Feature Coverage

### Full API command usage by routine:

| Command | Miner | Trader | Explorer | Crafter | Hunter | Salvager | Rescue | Mission |
|---------|:-----:|:------:|:--------:|:-------:|:------:|:--------:|:------:|:-------:|
| mine | x | | | | | | | |
| travel | x | x | x | x | x | x | x | x |
| jump | x | x | x | | x | x | x | x |
| dock / undock | x | x | x | x | x | x | x | x |
| sell | x | x | | x | x | x | | |
| buy | | x | | x | | | x | |
| refuel | x | x | x | x | x | x | x | x |
| repair | x | x | | | x | x | | x |
| view_market | | x | x | x | | | | |
| create_sell_order | | x | | x | | x | | |
| create_buy_order | | x | | x | | | | |
| craft | | | | x | | | | |
| survey_system | | | x | | | | | |
| attack | | | | | x | | | x |
| battle | | | | | x | | | x |
| scan | | | x | | x | | | |
| reload | | | | | x | | | |
| get_wrecks | | | | | x | x | | |
| loot_wreck | | | | | x | x | | |
| salvage_wreck | | | | | | x | | |
| tow_wreck | | | | | | x | | |
| sell_wreck | | | | | | x | | |
| accept_mission | | | | | | | | x |
| complete_mission | | | | | | | | x |
| deposit_items | x | x | | x | | x | | |
| withdraw_items | | x | | x | | | x | |
| send_gift | | | | | | | x | |
| chat | all | all | all | all | all | all | all | all |
| get_notifications | all | all | all | all | all | all | all | all |
| captains_log_add | all | all | all | all | all | all | all | all |
| install_mod | planned | planned | planned | planned | planned | | | |
| cloak | | | x | | x | | | |
| buy_ship | upgrade path | upgrade path | upgrade path | upgrade path | upgrade path | | | |
| switch_ship | multi-ship mgmt | | | | | | | |
| buy_insurance | | | | | x | | | |
| set_home_base | all | all | all | all | all | all | all | all |
| faction_* | future | future | future | future | future | future | future | future |
| facility | future | future | future | future | future | future | future | future |

### Features NOT in v1 that v2 should support:
- [ ] Mission system (accept_mission, complete_mission) - new routine
- [ ] Insurance management (buy_insurance, claim_insurance)
- [ ] Ship upgrades (buy_ship, install_mod, uninstall_mod)
- [ ] Cloaking (cloak for stealth operations)
- [ ] Multi-ship management (list_ships, switch_ship)
- [ ] Faction operations (intel, storage, missions, rooms)
- [ ] Station facilities
- [ ] Player market orders (create_buy_order, create_sell_order, modify_order)
- [ ] Notes system for persistent bot memory

---

## 12. Project File Structure

```
commander-v2/
├── package.json
├── bunfig.toml
├── config.toml                  ← fleet configuration
├── tsconfig.json
├── src/
│   ├── index.ts                 ← entry point, dependency wiring
│   │
│   ├── types/                   ← shared type definitions
│   │   ├── game.ts              ← game entities (from OpenAPI)
│   │   ├── api.ts               ← API request/response types
│   │   ├── protocol.ts          ← dashboard ↔ server WS messages
│   │   ├── commander.ts         ← goals, strategies, assignments
│   │   └── config.ts            ← config file schema
│   │
│   ├── data/                    ← persistence layer
│   │   ├── database.ts          ← SQLite setup, migrations, helpers
│   │   ├── game-cache.ts        ← version-gated + TTL caching
│   │   ├── training-logger.ts   ← decision/episode/market logging
│   │   └── session-store.ts     ← credential management
│   │
│   ├── core/                    ← shared game services
│   │   ├── api-client.ts        ← typed HTTP client
│   │   ├── navigation.ts        ← pathfinding, routing
│   │   ├── market.ts            ← prices, arbitrage, trade routes
│   │   ├── cargo.ts             ← inventory management
│   │   ├── fuel.ts              ← fuel monitoring, recovery
│   │   ├── combat.ts            ← threat assessment, tactics
│   │   ├── crafting.ts          ← recipe resolution, materials
│   │   ├── station.ts           ← docking, storage, services
│   │   └── galaxy.ts            ← map graph, POI lookup
│   │
│   ├── bot/                     ← bot engine
│   │   ├── bot.ts               ← Bot class, state machine
│   │   ├── bot-manager.ts       ← fleet lifecycle management
│   │   └── context.ts           ← BotContext factory
│   │
│   ├── routines/                ← async generator routines
│   │   ├── miner.ts
│   │   ├── harvester.ts         ← unified gas/ice/asteroid
│   │   ├── trader.ts
│   │   ├── explorer.ts
│   │   ├── crafter.ts
│   │   ├── hunter.ts
│   │   ├── salvager.ts
│   │   ├── rescue.ts
│   │   ├── courier.ts
│   │   └── mission-runner.ts
│   │
│   ├── commander/               ← fleet brain
│   │   ├── commander.ts         ← orchestration loop
│   │   ├── scoring-brain.ts     ← deterministic scoring engine
│   │   ├── evaluator.ts         ← fleet state analysis
│   │   ├── strategies.ts        ← goal-specific scoring weights
│   │   └── economy/             ← fleet economy engine
│   │       ├── supply-chain.ts      ← demand/supply, deficit detection
│   │       ├── inventory-manager.ts ← stock targets, reorder, surplus
│   │       ├── order-manager.ts     ← exchange orders, pricing
│   │       ├── profit-calculator.ts ← per-tick profit, ROI
│   │       ├── skill-planner.ts     ← skill paths, milestones
│   │       ├── logistics-planner.ts ← material routing, delivery scheduling
│   │       ├── upgrade-advisor.ts   ← ship upgrade ROI
│   │       └── price-strategy.ts    ← batch selling, price impact
│   │
│   └── server/                  ← dashboard backend
│       ├── server.ts            ← Bun HTTP + WS server
│       ├── routes.ts            ← REST endpoints
│       └── ws-handler.ts        ← typed WS protocol
│
├── web/                         ← Svelte 5 frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── svelte.config.js
│   ├── src/
│   │   ├── app.html
│   │   ├── app.css              ← Tailwind + dark theme
│   │   ├── App.svelte
│   │   ├── lib/
│   │   │   ├── components/
│   │   │   │   ├── ui/              ← shadcn-svelte base components
│   │   │   │   ├── layout/
│   │   │   │   │   ├── NavBar.svelte
│   │   │   │   │   ├── NotificationDrawer.svelte
│   │   │   │   │   ├── ConnectionBanner.svelte
│   │   │   │   │   ├── ConfirmDialog.svelte
│   │   │   │   │   └── KeyboardShortcuts.svelte
│   │   │   │   ├── fleet/
│   │   │   │   │   ├── FleetOverview.svelte
│   │   │   │   │   ├── MetricCards.svelte
│   │   │   │   │   ├── BotStatusTable.svelte
│   │   │   │   │   ├── CommanderLog.svelte
│   │   │   │   │   └── AlertsList.svelte
│   │   │   │   ├── bots/
│   │   │   │   │   ├── BotRosterCard.svelte
│   │   │   │   │   ├── AddBotDialog.svelte
│   │   │   │   │   ├── BotOverviewTab.svelte
│   │   │   │   │   ├── BotSkillsTab.svelte
│   │   │   │   │   ├── BotHistoryTab.svelte
│   │   │   │   │   ├── BotSettingsTab.svelte
│   │   │   │   │   ├── BotLogsTab.svelte
│   │   │   │   │   └── BotCredentialsTab.svelte
│   │   │   │   ├── charts/
│   │   │   │   │   ├── CreditChart.svelte
│   │   │   │   │   ├── RevenueChart.svelte
│   │   │   │   │   ├── PnLWaterfall.svelte
│   │   │   │   │   ├── SkillRadar.svelte
│   │   │   │   │   └── MarketHeatmap.svelte
│   │   │   │   ├── economy/
│   │   │   │   │   ├── SupplyChainView.svelte
│   │   │   │   │   ├── InventoryTable.svelte
│   │   │   │   │   ├── OpenOrdersTable.svelte
│   │   │   │   │   └── TradeFeed.svelte
│   │   │   │   ├── map/
│   │   │   │   │   ├── GalaxyCanvas.svelte      ← main canvas component
│   │   │   │   │   ├── MapFilterBar.svelte       ← toggle overlay buttons
│   │   │   │   │   ├── SystemDetailPanel.svelte  ← right slide-in on click
│   │   │   │   │   ├── MapTooltip.svelte         ← hover tooltip
│   │   │   │   │   └── map-renderer.ts           ← canvas draw functions
│   │   │   │   │       (starfield, grid, connections, nodes,
│   │   │   │   │        overlays, bots, labels, hit-detection)
│   │   │   │   ├── activity/
│   │   │   │   │   ├── StatCards.svelte
│   │   │   │   │   ├── TopItems.svelte
│   │   │   │   │   ├── LiveFeed.svelte
│   │   │   │   │   └── OrdersTable.svelte
│   │   │   │   ├── settings/
│   │   │   │   │   ├── GoalsTab.svelte
│   │   │   │   │   ├── CommanderTab.svelte
│   │   │   │   │   ├── FleetTab.svelte
│   │   │   │   │   ├── EconomyTab.svelte
│   │   │   │   │   ├── CacheTab.svelte
│   │   │   │   │   └── AboutTab.svelte
│   │   │   │   └── shared/
│   │   │   │       ├── StatusIndicator.svelte
│   │   │   │       ├── FuelGauge.svelte
│   │   │   │       ├── CargoBreakdown.svelte
│   │   │   │       ├── SkillProgressBar.svelte
│   │   │   │       ├── EmpireBadge.svelte
│   │   │   │       └── TrendIndicator.svelte
│   │   │   ├── stores/
│   │   │   │   ├── websocket.ts ← WS connection + reconnect
│   │   │   │   ├── fleet.ts     ← reactive fleet state
│   │   │   │   ├── economy.ts   ← supply chain, inventory, orders
│   │   │   │   ├── market.ts    ← market data store
│   │   │   │   └── settings.ts  ← user preferences
│   │   │   └── utils/
│   │   │       ├── formatters.ts
│   │   │       └── theme.ts
│   │   └── pages/
│   │       ├── Fleet.svelte       ← / mission control home
│   │       ├── Economy.svelte     ← /economy supply chain, P&L, orders
│   │       ├── Galaxy.svelte      ← /galaxy canvas map with overlays
│   │       ├── Activity.svelte    ← /activity market ticker, feed
│   │       ├── Market.svelte      ← /market price analysis, arbitrage
│   │       ├── Bots.svelte        ← /bots management hub, roster
│   │       ├── BotDetail.svelte   ← /bots/:id per-bot deep dive (6 tabs)
│   │       ├── Training.svelte    ← /training data viewer, export
│   │       └── Settings.svelte    ← /settings app config (6 tabs)
│   └── static/
│       └── fonts/
│
├── data/                        ← runtime data (gitignored)
│   ├── commander.db             ← SQLite database
│   └── sessions/                ← bot credentials
│
└── tests/
    ├── core/
    │   ├── navigation.test.ts
    │   ├── market.test.ts
    │   └── cargo.test.ts
    ├── commander/
    │   └── scoring-brain.test.ts
    └── routines/
        └── miner.test.ts
```

---

## 13. Implementation Phases

### Phase 1: Foundation
- [ ] Project scaffolding (Bun + Svelte + Tailwind)
- [ ] Type definitions from OpenAPI spec
- [ ] SQLite database setup with schema + migrations
- [ ] GameCache (static data caching with version-gate)
- [ ] ApiClient (typed, cached, with session management)
- [ ] SessionStore (credential management)

### Phase 2: Core Services
- [ ] Galaxy service (map graph, pathfinding)
- [ ] Navigation service (fuel-aware routing)
- [ ] Cargo service
- [ ] Fuel service
- [ ] Station service
- [ ] Market service (price tracking, arbitrage)
- [ ] Crafting service (recipe resolution)
- [ ] Combat service (threat assessment)

### Phase 3: Bot Engine
- [ ] Bot class (state machine, routine runner)
- [ ] BotContext factory (dependency injection)
- [ ] BotManager (fleet lifecycle)
- [ ] TrainingLogger (decision/episode recording)

### Phase 4: Routines
- [ ] Miner routine
- [ ] Trader routine
- [ ] Explorer routine
- [ ] Harvester routine (unified)
- [ ] Crafter routine
- [ ] Hunter routine
- [ ] Salvager routine
- [ ] Rescue routine
- [ ] Mission runner routine

### Phase 5: Commander
- [ ] Fleet evaluator (state analysis)
- [ ] Scoring brain (deterministic)
- [ ] Strategy implementations (per goal type)
- [ ] Commander loop (evaluation cycle)

### Phase 6: Dashboard
- [ ] Bun server + WebSocket
- [ ] Svelte project setup
- [ ] Fleet overview page
- [ ] Bot detail page
- [ ] Market page
- [ ] Galaxy map
- [ ] Settings page

### Phase 7: Training Pipeline
- [ ] Training data viewer page
- [ ] Data export (JSON/CSV/Parquet)
- [ ] Episode detection and summarization
- [ ] Commander brain interface for LLM drop-in

### Phase 8: Polish & Advanced
- [ ] Insurance management
- [ ] Ship upgrade paths
- [ ] Faction operations
- [ ] Multi-ship management
- [ ] Cloaking/stealth support
- [ ] Station facilities

---

## 14. Resolved Design Decisions

### 14.1 Faction: All Bots Share One Faction
All bots operate under a single faction. This enables:
- `faction_submit_intel` / `faction_query_intel` - shared galaxy knowledge across fleet
- `faction_submit_trade_intel` / `faction_query_trade_intel` - shared market price data
- `faction_deposit/withdraw_items/credits` - shared storage pool
- `faction_create_buy/sell_order` - faction-level market operations
- `faction_post_mission` - Commander can post internal missions for bots
- Coordinated territory control and war readiness

### 14.2 API Connection: HTTP API
HTTP API chosen over MCP and WebSocket because:
- **vs MCP:** MCP is designed for AI tool discovery. We already know all commands. MCP would mean spawning 20 `npx mcp-remote` Node.js child processes just to wrap HTTP calls. Unnecessary overhead.
- **vs WebSocket:** WS only advantage is real-time push notifications. But we call `get_notifications()` (free instant query) after every action anyway. With 10s tick rate, we're never more than one tick behind on events. HTTP is simpler - no connection state, no reconnection logic, just fetch().
- **Direct control:** We manage caching, retry, dedup, and logging at the HTTP layer. No abstraction we can't see through.

### 14.3 Commander Reassignment Strategy
**Cycle-aware reassignment** - Commander never interrupts a bot mid-task:

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Evaluation interval | 60 seconds | Frequent enough to catch changes, not spammy |
| Reassignment cooldown | 5 minutes per bot | Prevents thrashing between roles |
| Score threshold | 30% improvement | Small improvements aren't worth the switch cost |
| Switch cost penalty | Estimated ticks to transition | Subtracted from new role's score |
| Urgency override | Yes | Combat/stranded/goal-change bypass cooldown |

Routines signal cycle boundaries via `yield "cycle_complete"`. Commander can only reassign at these safe points. Mid-cycle yields like `"mining"` or `"traveling"` are protected.

### 14.4 Dashboard: Desktop-First
Desktop layout for now. Mobile can be added later via Tailwind responsive utilities (`md:` / `lg:` breakpoints) since the component architecture supports it. Not a priority for v2.0.

### 14.5 Training Data Retention: Keep Everything, Downsample Old
Storage is cheap (~50MB/day for 20 bots, ~18GB/year). Strategy:
- **Last 7 days:** Full resolution (every record)
- **Last 30 days:** 33% sample (every 3rd record)
- **Last 90 days:** 10% sample (every 10th record)
- **Older:** Hourly summaries + episode summaries only

Every record versioned with `game_version`, `commander_version`, `schema_version` for:
- Filtering by version when training ("only game v0.142+ data")
- Weighting recent data higher
- Detecting and migrating schema changes

Our code changes do NOT invalidate data - bad decisions with real outcomes are still valuable training signals. Game patches may invalidate outcome-specific data but decision patterns survive.

### 14.6 TypeScript Types: Hybrid (Auto-Generated + Hand-Written)
- Auto-generate raw API types from OpenAPI spec into `src/types/generated/api.ts`
- Hand-write clean domain types in `src/types/game.ts` that reference generated ones
- ApiClient maps API responses → domain types (camelCase, validated)
- Update workflow: `bunx openapi-typescript` → compiler shows type errors → fix mappings

### 14.7 Full Gameplay Coverage
All game systems are accounted for across 10 routines + core services:
- Mining/harvesting (unified parameterized routine)
- Trading (arbitrage, exchange orders, multi-stop routes)
- Exploration (surveying, cloaking, intel submission)
- Crafting (recipe chains, prerequisite skills, batch crafting)
- Combat (tactical battles, stances, ammo, insurance)
- Salvaging (wrecks, towing, scrapping)
- Missions (NPC mission board, objectives, rewards)
- Faction ops (intel, storage, orders, territory)
- Fleet logistics (rescue, courier, storage consolidation)
- Ship management (upgrades, modules, multi-ship)

---

## 15. Additional Feature Ideas

### 15.1 Fleet Notifications & Alerts
Dashboard should surface important events prominently:
- **Critical:** Bot under attack, bot stranded (no fuel), session expired
- **Warning:** Deficit detected, order unfilled >2h, belt depleted, bot idle
- **Info:** Trade completed, skill leveled up, mission completed, ship upgrade available
- Desktop notification support (Notification API) for critical alerts when tab is backgrounded.

### 15.2 Replay / Time Travel
Since we log everything, the dashboard could replay historical fleet state:
- Scrub a timeline to see fleet positions, market state, commander decisions at any past time
- Useful for debugging "why did the Commander do X?" and for training data review
- Phase 8+ feature, but the data schema supports it from day one.

### 15.3 Fleet P&L Dashboard (Economy page)
Detailed financial tracking:
- Revenue by source (mining, trading, crafting, salvaging, missions)
- Costs by category (fuel, repairs, ammo, market purchases, ship upgrades)
- Per-bot P&L with sortable table
- Hourly/daily/weekly trends
- ROI per bot (profit vs ship cost)

### 15.4 Commander Decision Explainer
When Commander makes a reassignment, show the full reasoning:
- "Reassigned Bot3: miner → trader because:
  - Iron ore price dropped 30% (mining score: 45 → 28)
  - Sol→Kepler copper route opened (trader score: 72)
  - Bot3 has trading skill level 4 (bonus: +15)
  - Switch cost: 8 ticks (already near Sol station)
  - Net score improvement: +44 (+62%)"
- Viewable in Commander Log and Bot Detail page
- This is the most valuable training data signal

---

## 16. Open Questions (Remaining)

- [ ] Exact scoring weights for Commander brain (needs gameplay data to tune)
- [ ] Chat behavior - should bots chat in-character? How often?
- [ ] Forum participation - should bots post on forums?
- [ ] Captain's log strategy - what to record per bot?
- [ ] War strategy - how should Commander handle faction wars?
- [ ] SSE integration - should we also connect to game.spacemolt.com/events for global events?

---

## 17. Lessons from v1 (Reference)

### Keep
- Async generator routines (elegant, readable)
- Debounced persistence
- Settings hierarchy (per-bot > routine > global)
- Session auto-discovery from filesystem
- Emergency recovery chains
- Fleet status callback for cross-bot awareness
- Staggered initialization

### Avoid
- Global mutable singletons
- 64KB utility grab-bag files
- Copy-paste routine variants
- Monolithic HTML (361KB)
- Silent error swallowing
- Untyped message protocols
- Cross-routine settings mutation via shared files
- Magic numbers scattered in code
