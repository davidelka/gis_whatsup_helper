# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-platform GIS bot that listens to WhatsApp groups and Telegram groups/DMs, captures location data and messages (with Hebrew report commands), and exports them to GIS formats. Three-tier architecture: a shared TypeScript library, platform-specific listeners (WhatsApp + Telegram), and a Python/Flask management server that stores data in SQLite, controls listener lifecycle, and serves dashboards.

## Commands

### Setup
```bash
# Install all workspace dependencies (shared + listeners)
npm install

# Python GIS processor
cd gis-processor && pip install -r requirements.txt
```

### Running (Management Server)
```bash
# Start the management server (controls everything)
./start.sh
# Or directly:
cd gis-processor && python app.py

# Then start/stop WhatsApp and Telegram listeners from:
# http://localhost:5000/management
```

### NPM Workspace Scripts
```bash
# Build all TypeScript packages
npm run build --workspaces

# Build individual packages
cd shared && npm run build
cd whatsapp-listener && npm run build
cd telegram-listener && npm run build
```

## Architecture

```
                    ┌──────────────────────┐
                    │  Management Server   │
                    │  (Flask, port 5000)  │
                    │  - Dashboard         │
                    │  - Group CRUD API    │
                    │  - Service control   │
                    └──────┬───────┬───────┘
                           │       │
              ┌────────────┘       └────────────┐
              │ subprocess                       │ subprocess
    ┌─────────▼──────────┐           ┌──────────▼──────────┐
    │  WhatsApp Listener │           │  Telegram Listener  │
    │  (whatsapp-web.js) │           │  (grammy bot)       │
    └─────────┬──────────┘           └──────────┬──────────┘
              │ HTTP POST                       │ HTTP POST
              └────────────┐       ┌────────────┘
                    ┌──────▼───────▼───────┐
                    │  Flask API           │
                    │  SQLite → GIS Export  │
                    └──────────────────────┘
```

**shared/** (npm workspace `@gis-bot/shared`):
- `src/types.ts` — ParsedMessage, LocationData, MessagingAdapter interfaces
- `src/reportTracker.ts` — Per-user report state machine (platform-agnostic)
- `src/commandHandler.ts` — Slash commands with Hebrew aliases (platform-agnostic)
- `src/pythonServiceClient.ts` — HTTP client for Flask API
- `src/config.ts` — YAML config loader
- `src/logger.ts` — Pino structured logging

**whatsapp-listener/** (TypeScript, depends on @gis-bot/shared):
- `src/index.ts` — WhatsApp client init, QR auth, startup watchdog
- `src/messageHandler.ts` — WhatsApp message parsing, report/command flow
- `src/whatsappAdapter.ts` — MessagingAdapter implementation for WhatsApp

**telegram-listener/** (TypeScript, depends on @gis-bot/shared):
- `src/index.ts` — grammy bot init, long polling, message routing
- `src/messageHandler.ts` — Telegram message parsing, report/command flow
- `src/telegramAdapter.ts` — MessagingAdapter implementation for Telegram

**gis-processor/** (Python/Flask):
- `app.py` — REST API, management routes, service control, dashboard
- `models.py` — SQLAlchemy models: Message, Location, Report, Track, ListenerGroup
- `service_manager.py` — Process manager for listener services
- `gis_export.py` — GeoPandas export to GeoJSON, Shapefile, KML, GeoPackage
- `static/index.html` — GIS Dashboard (Leaflet.js, dark theme)
- `static/management.html` — Management UI (start/stop listeners, configure groups)

**config.yaml** — Static config: bot tokens, timeouts, service host/port, storage paths. Group configuration is stored in SQLite (managed via /management UI).

## Key Domain Concepts

- **Report flow**: Users start a report with `תד` (תחילת דיווח) and end with `סד` (סוף דיווח). Messages between are aggregated. Reports require a location to be marked "complete" vs "invalid". One active report per sender, with 120s inactivity timeout + 60s grace period.
- **Deduplication**: Messages are deduplicated by `message_id` before storage.
- **Visibility**: Locations and reports have `is_visible` flags controlling dashboard display and GIS export inclusion.
- **Tags**: JSON arrays stored on locations/reports, used for filtering.
- **Telegram ID prefix**: Telegram sender/group IDs are prefixed with `tg:` to avoid collisions with WhatsApp IDs.
- **Telegram bot privacy**: Bot must have privacy mode disabled via BotFather (`/setprivacy` -> Disable) to see all group messages.

## REST API

Data receipt: `POST /message`, `POST /report`
CRUD: `GET /messages`, `GET /locations`, `GET /reports`, `PATCH/DELETE /api/reports/<id>`, `PATCH/DELETE /api/locations/<id>`
Exports: `GET /export/{geojson,shapefile,kml,gpkg}`, `GET /export/reports/geojson`
Live data: `GET /api/geojson`, `GET /api/tags`
Dashboard: `GET /dashboard`
Management: `GET /management`
Service control: `GET /api/services`, `POST /api/services/<name>/start`, `POST /api/services/<name>/stop`, `GET /api/services/<name>/logs`
Group config: `GET/POST /api/groups`, `PATCH/DELETE /api/groups/<id>`
