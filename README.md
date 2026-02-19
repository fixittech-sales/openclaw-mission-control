# Mission Control

A real-time monitoring dashboard for [OpenClaw](https://github.com/open-claw/openclaw) AI agent gateways.

![Node.js](https://img.shields.io/badge/node-18%2B-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Dashboard** - System health (CPU/memory/disk), gateway status, model usage, cron job monitoring
- **Agent Hub** - Live agent roster, active workflow runs, real-time event feed via WebSocket
- **Session Explorer** - Token usage breakdown per agent and model
- **Agent Chat** - Send messages to agents directly from the dashboard
- **Memory Search** - Search across agent memory stores
- **Documents** - Upload, view, rename, and delete documents with PDF conversion
- **Kanban Board** - Task management (proxied from external service, optional)
- **Notifications** - Aggregated alerts for cron errors and agent failures
- **Quick Actions** - Restart gateway, reindex memory, trigger cron jobs
- **PIN Protection** - Server-side PIN authentication

## Quick Start

```bash
git clone https://github.com/fixittech-sales/openclaw-mission-control.git
cd openclaw-mission-control
npm install
npm run setup     # interactive config generator
npm start         # http://localhost:3100
```

## Configuration

All settings are controlled via environment variables. Copy `.env.example` to `.env` and edit, or run `npm run setup` for an interactive walkthrough.

### Core Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_PORT` | `3100` | HTTP server port |
| `MC_PIN` | `0000` | Dashboard access PIN |
| `MC_TITLE` | `Mission Control` | Page title |

### OpenClaw

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_BASE` | `~/.openclaw` | OpenClaw installation root (all paths derive from this) |
| `MC_CORE_AGENTS` | `main,ops,comms,architect` | Comma-separated agent IDs to monitor |
| `MC_A2A_POLL_MS` | `5000` | Agent-to-agent communication polling interval (ms) |

### Optional Integrations

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_KANBAN_ENABLED` | `true` | Enable Kanban task board proxy |
| `MC_KANBAN_URL` | `http://localhost:3000` | Kanban service address |
| `MC_ACTIONS_LOG` | `{OPENCLAW_BASE}/workspace/kanban-board/actions.log` | Activity log path |
| `MC_VPS_ENABLED` | `false` | Enable VPS remote activity log |
| `MC_VPS_SSH_KEY` | | Path to SSH private key |
| `MC_VPS_USER` | | VPS SSH username |
| `MC_VPS_HOST` | | VPS hostname or IP |
| `MC_VPS_REMOTE_PATH` | | Remote log file path |
| `MC_GATEWAY_LAUNCHD_LABEL` | `ai.openclaw.gateway` | macOS launchd service label for gateway restart |

## Prerequisites

- **Node.js 18+**
- **OpenClaw** installed and running
- **Optional:** `pandoc` + `weasyprint` (for Markdown/text to PDF conversion)
- **Optional:** `sqlite3` CLI (for Antfarm workflow data)

## Architecture

Single-process Express server with WebSocket support:

```
server.js          Express API + WebSocket event streaming
config.js          Centralized configuration (env vars + defaults)
public/index.html  Single-page application (vanilla JS)
minimax-proxy.js   MiniMax LLM API proxy
minimax-tracker.js API usage tracker
setup.js           Interactive .env generator
```

## License

MIT
