# ClaudeOrb

Real-time Claude.ai usage monitor - for your browser and your desk.

I built ClaudeOrb because I wanted a simple, clean way to see my Claude.ai usage without having to open a browser and dig through settings. If you use Claude heavily, especially with Claude Code, you know how annoying it is to randomly hit a rate limit mid-session with no warning.

> **Currently available on macOS and Chrome. Windows and Firefox coming soon.**

---

## macOS App

ClaudeOrb is a macOS menubar app that quietly monitors your Claude.ai usage in the background.

### How it works

The tricky part about building this was that Claude's usage data isn't stored anywhere on your computer. There's no local file to read, no simple API to call. The only place it lives is on claude.ai/settings/usage when you're logged in.

So instead of making sketchy API calls or asking you to paste tokens, the app opens a small login window when you first launch it. You log into Claude.ai normally, the app detects your session, and closes the window automatically. From that point on it silently loads your usage page in the background every 15 seconds and scrapes the numbers. No API keys, no extra permissions, nothing weird. You only have to log in once. After that it remembers your session.

### Features

- Live 5-hour session and 7-day weekly usage, updates every 15 seconds
- Color-coded rings that go green → orange → red as you approach limits
- Notifications at 50%, 80% and 100% so you're never caught off guard
- Claude Code tab that tracks daily tokens, estimated API cost, lines written, files edited and current streak
- Weekly spend chart so you can see which days you go hard
- Minimal view that cycles through your key stats
- Detachable floating window you can pin next to your work
- Stays open even when you click away

### Installation

Download the `.dmg` from the [Releases page](https://github.com/SoDyNoTe/ClaudeOrb/releases/download/v1.0.0/ClaudeOrb-1.0.0-arm64.dmg), open it, and drag ClaudeOrb to your Applications folder.

When you first open the app, macOS will show a warning saying "ClaudeOrb.app cannot be opened". This is because the app is not yet signed with an Apple Developer certificate. It does not mean the app is unsafe. You can bypass this in one of three ways:

**Option 1 — Terminal (easiest):**
Open Terminal and run:
```
xattr -dr com.apple.quarantine /Applications/ClaudeOrb.app
```
Then open the app normally.

**Option 2 — Privacy & Security settings:**
Go to System Settings → Privacy & Security. Scroll down and you will see a message saying ClaudeOrb was blocked. Click **Open Anyway**.

**Option 3 — Right-click:**
Right-click the app in your Applications folder, select **Open**, then click **Open** in the dialog that appears.

You only need to do this once. On first launch a login window will open. Sign into your Claude.ai account and it will close by itself. That's it.

For full development details see [`desktop/README.md`](desktop/README.md).

---

## Chrome Extension

The ClaudeOrb Chrome Extension adds a browser popup with the same live usage data — no desktop app required for the core features.

### Features

- **Usage tab** — live session and weekly usage rings (works standalone)
- **Minimal tab** — compact cycling view of your key stats (works standalone)
- **Code tab** — Claude Code token and cost tracking (requires desktop app)
- **Trends tab** — 30-day usage history chart (requires desktop app)
- Pop-out button to detach the extension into a floating window

### Installation

Chrome Web Store listing coming soon. In the meantime, load it unpacked:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `chrome-extension/` folder from this repo
4. Visit [claude.ai](https://claude.ai) — the extension activates automatically

For full details see [`chrome-extension/README.md`](chrome-extension/README.md).

---

## What's next

- Chrome Web Store listing
- Firefox support
- Windows version
- Physical desk display — a small screen that sits next to your monitor and shows your usage in real time

---

## Development

Desktop build commands must be run from inside the `/desktop` folder:
```
cd desktop
npm install
npm start       # run in development
npm run build   # build the macOS .dmg
```

---

Built by [@SoDyNoTe](https://github.com/SoDyNoTe)
