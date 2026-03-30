# Privacy Policy for ClaudeOrb

_Last updated: March 30, 2026_

## Overview

ClaudeOrb is a browser extension that monitors your Claude.ai usage limits in real-time. This privacy policy explains what data the extension accesses and how it is handled.

## Data We Collect

ClaudeOrb does not collect, store, or transmit any personal data to external servers.

The extension accesses the following data locally on your device only:

- **Claude.ai usage data** — session and weekly usage percentages, fetched directly from the Claude.ai API while you are logged in. This data is stored locally in your browser using Chrome's `storage.local` API and is never sent anywhere.
- **Claude Code logs** — if you use the optional desktop companion app, it reads local JSONL log files from `~/.claude/projects/` on your machine to calculate token usage and cost estimates. This data is served locally over `localhost:3000` and never leaves your device.

## Data Sharing

We do not share, sell, or transmit any data to third parties. All data remains on your local device.

## Permissions

The extension requires the following permissions:

- **storage** — to save your usage data locally between sessions
- **notifications** — to alert you at usage thresholds (80%, 90%)
- **alarms** — to poll your usage data periodically
- **tabs** — to detect when you are on claude.ai and trigger data updates
- **windows** — to support the pop-out floating window feature

## Contact

If you have any questions about this privacy policy, please open an issue at [github.com/SoDyNoTe/ClaudeOrb](https://github.com/SoDyNoTe/ClaudeOrb).
