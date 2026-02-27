# SpaceMolt Commander v2

Autonomous bot fleet commander for [SpaceMolt](https://spacemolt.com), a browser-based space MMO. Manages 2-20 bots through a goal-driven scoring engine that dynamically assigns roles based on fleet state, market conditions, and resource availability.

## Features

- **Goal-driven commander** — set high-level objectives (maximize income, explore, dominate) and the scoring brain handles role assignment across the fleet
- **10 autonomous routines** — miner, harvester, trader, explorer, crafter, hunter, salvager, mission runner, scout, return home
- **Full supply chain** — miners deposit ore to faction storage, crafters source materials and output goods, traders sell finished products
- **Real-time dashboard** — Svelte 5 SPA with fleet overview, per-bot detail, galaxy map, market data, economy tracking, and training data visualization
- **Training data pipeline** — every decision, state snapshot, episode, and market price is logged to SQLite for future model training
- **Heavy caching** — static game data cached in SQLite with version-gated refresh; market data with configurable TTL

## Architecture

```
Commander (scoring brain)
  ├── evaluates fleet state + economy + world context
  ├── scores all bot×routine combinations (13 factors)
  └── assigns/reassigns bots at configurable intervals

Bot Engine
  ├── async generator routines (yield state labels for dashboard)
  ├── graceful reassignment via shouldStop flag
  └── BotContext injects all core services

Core Services
  ├── Galaxy, Navigation, Market, Cargo
  ├── Fuel, Combat, Crafting, Station
  └── shared typed services, no singletons

Data Layer
  ├── SQLite cache (game data, market prices)
  ├── Training logger (decisions, snapshots, episodes)
  └── Session store (bot credentials)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) |
| Language | TypeScript (strict) |
| Frontend | Svelte 5 + Tailwind CSS 4 + ECharts |
| Database | SQLite (bun:sqlite) |
| Config | TOML + Zod validation |
| Build | Vite |

## Prerequisites

- [Bun](https://bun.sh) v1.2+
- A [SpaceMolt](https://spacemolt.com) account with bot credentials

## Setup

```bash
# Install dependencies
bun install
cd web && bun install && cd ..

# Create config from template
cp config.example.toml config.toml
# Edit config.toml with your fleet settings (home system, goals, etc.)

# Bot credentials are stored in the SQLite database at runtime
# No credentials go in config files
```

## Usage

```bash
# Start the commander + dashboard server
bun run start

# Development mode (auto-reload)
bun run dev

# Frontend dev server (HMR)
bun run dev:web

# Build frontend for production
bun run build:web

# Run tests
bun test
```

The dashboard is served at `http://localhost:3000` by default.

## Configuration

See `config.example.toml` for all options. Key sections:

- **`[commander]`** — brain type, evaluation interval, reassignment thresholds
- **`[[goals]]`** — fleet objectives with priority weighting
- **`[fleet]`** — max bots, home system/base, storage mode, minimum credits
- **`[cache]`** — market/system data TTL
- **`[training]`** — what data to log (decisions, snapshots, episodes, market history)
- **`[economy]`** — crafting margins, order settings, batch sizes

## Dashboard Pages

1. **Fleet** — overview of all bots, credits/hr, aggregate stats
2. **Bots** — per-bot detail with skills radar, credits chart, cargo, reassignment
3. **Galaxy** — canvas map with system nodes, bot positions, POI indicators
4. **Market** — item prices across stations, spread analysis, price history
5. **Economy** — profit charts, trade activity log, supply/demand tracking
6. **Commander** — goal management, assignment history, decision log
7. **Faction** — treasury, storage inventory, members, diplomacy
8. **Training** — data pipeline stats, export (JSON/CSV), retention management
9. **Settings** — fleet config, bot credentials, server settings

## Project Structure

```
src/
  bot/          Bot engine, manager, context types
  commander/    Scoring brain, economy engine, strategies
  core/         Shared services (galaxy, market, fuel, etc.)
  data/         SQLite database, cache, training logger
  routines/     10 async generator routines
  server/       HTTP/WS server, training API
  types/        Game types, protocol, config schema
web/
  src/
    lib/        Svelte components, stores
    routes/     9 dashboard pages
tests/          374 tests
```

## License

Private.
