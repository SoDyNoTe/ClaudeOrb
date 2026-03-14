# ClaudeOrb Companion

**Local companion app that powers ClaudeOrb's Code and Trends tabs**

The companion app runs silently in your Mac menubar, reads your Claude Code session data from `~/.claude/projects/`, and serves it to the [ClaudeOrb Chrome extension](https://github.com/SoDyNoTe/claude-orb) over a local HTTP API.

---

## Requirements

- macOS
- Node.js 18+

## Installation

```bash
npm install
npm start
```

The app appears as **⚡** in your menubar. It starts automatically on login.

---

## What it unlocks in ClaudeOrb

### Code tab
Real-time stats for the current calendar day:
- Total tokens used
- Estimated cost (calculated from Anthropic's published pricing)
- Lines of code written
- Files edited
- Top model in use

### Trends tab
Historical usage charts pulled from `GET /trends` and `GET /trends/30`:
- Last 7 days — bar chart with daily token and cost breakdown
- Last 30 days — extended view for monthly usage patterns

---

## HTTP API

| Endpoint | Description |
|---|---|
| `GET /health` | `{ "status": "ok", "version": "1.0.0" }` |
| `GET /stats` | Today + this week stats |
| `GET /trends` | Last 7 calendar days |
| `GET /trends/30` | Last 30 calendar days |

All responses include `Access-Control-Allow-Origin: *` so the extension can reach the API directly.

---

## License

MIT
