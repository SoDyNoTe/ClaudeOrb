# ClaudeOrb Chrome Extension

A Chrome extension that gives you a real-time popup showing your Claude.ai usage stats — session progress, weekly usage, Claude Code metrics, and 30-day trend charts.

---

## Install (unpacked)

1. Go to `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `chrome-extension/` folder from this repository.

The ClaudeOrb icon will appear in your Chrome toolbar.

---

## Tabs

| Tab | Description | Requires desktop app? |
|-----|-------------|----------------------|
| **Usage** | Live session and weekly usage rings with percentages | No |
| **Minimal** | Compact view that cycles through your key stats | No |
| **Code** | Daily token usage, estimated API cost, lines written, files edited, and streak | Yes |
| **Trends** | 30-day usage history chart with tooltips | Yes |

The **Code** and **Trends** tabs pull data from the ClaudeOrb desktop app via a local HTTP connection on `localhost:3000`. Make sure the desktop app is running for those tabs to work.

---

## Chrome Web Store

Coming soon.

---

[Back to main README](../README.md)
