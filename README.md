# ClaudeOrb

A macOS menubar app that tracks your Claude.ai usage in real time.

## Features
- Live 5-hour session and 7-day weekly usage tracking
- Color coded usage rings (green/orange/red)
- Reset timers for session and weekly limits
- Collapsible extra usage / overage tracking
- Claude Code tab - daily tokens, estimated spend, lines written, files edited, streak
- Weekly spend trends chart
- Minimal view with cycling metrics
- Smart notifications at 50%, 80%, and 100% usage
- Detachable floating window that stays on top
- Auto-polls every 15 seconds
- Remembers your session - only need to log in once

## Requirements
- macOS
- Node.js 18+
- A Claude.ai account (Pro plan recommended)

## Installation
### Option 1 - Download DMG
Download the latest release from the releases page and drag to Applications.

### Option 2 - Run from source
```
git clone https://github.com/SoDyNoTe/claude-companion.git
cd claude-companion
npm install
npm start
```

## First Launch
On first launch a login window will open. Log into your Claude.ai account
and the window will close automatically. The app will start tracking your
usage immediately.

## Building
```
npm run build
```

## Tech Stack
- Electron
- Node.js
- Express
- electron-builder
