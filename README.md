# Claude Companion

A Mac menubar app that reads your Claude Code usage data and serves it via a local HTTP API.

## Features

- **Menubar icon** with a live dropdown showing today's stats
- **HTTP server** at `localhost:3000` for use by the Chrome extension
- **Auto-refreshes** stats every 30 seconds from `~/.claude/projects/`

## Install

```bash
npm install
npm start
```

The app will appear as `⚡` in your Mac menubar. Click it to see your stats.

## HTTP API

### `GET /health`

```json
{ "status": "ok", "version": "1.0.0" }
```

### `GET /stats`

```json
{
  "today": {
    "tokens": 45230,
    "cost": 1.24,
    "lines": 342,
    "files": 12,
    "topModel": "sonnet"
  },
  "week": {
    "tokens": 284000,
    "cost": 7.80,
    "streak": 5
  },
  "lastUpdated": "2026-03-12T23:00:00Z"
}
```

CORS is enabled for all origins so the Chrome extension can reach it directly.

## Menubar dropdown

```
⚡ Tokens today: 45,230
💰 Cost today: $1.24
📝 Lines written: 342
🔥 Streak: 5 days
──
Last updated: 30s ago
Quit
```

## Requirements

- macOS
- Node.js 18+
- Claude Code with data in `~/.claude/projects/`
