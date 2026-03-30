# ClaudeOrb

Real-time Claude.ai usage monitor — for your browser and your desk.

---

## Desktop App (macOS)

ClaudeOrb is a macOS menubar app that quietly monitors your Claude.ai usage in the background. It shows your live session and weekly usage, color-coded rings that go green, orange, and red as you approach limits, and a Claude Code tab that tracks daily tokens, estimated API cost, lines written, files edited, and your current streak.

**Download:** [ClaudeOrb-1.0.0-arm64.dmg](https://github.com/SoDyNoTe/claude-companion/releases/download/v1.0.0/ClaudeOrb-1.0.0-arm64.dmg)

For full installation instructions and macOS security bypass steps, see [desktop/README.md](desktop/README.md).

---

## Chrome Extension

The ClaudeOrb Chrome Extension adds a browser popup with four tabs:

- **Usage** — live session and weekly usage rings (works standalone)
- **Minimal** — a compact cycling view of your key stats (works standalone)
- **Code** — Claude Code token and cost tracking (requires the desktop app)
- **Trends** — 30-day usage history chart (requires the desktop app)

Chrome Web Store listing coming soon. In the meantime, load it unpacked — see [extension/README.md](extension/README.md) for steps.

---

## Development

Desktop build commands must be run from inside the `/desktop` folder:

```bash
cd desktop
npm install
npm start        # run in development
npm run build    # build the macOS .dmg
```

---

## License

MIT
