# ClaudeOrb

I built ClaudeOrb because I wanted a simple, clean way to see my Claude.ai
usage without having to open a browser and dig through settings. If you use
Claude heavily, especially with Claude Code, you know how annoying it is to
randomly hit a rate limit mid-session with no warning.

## How it works

The tricky part about building this was that Claude's usage data isn't stored
anywhere on your computer. There's no local file to read, no simple API to call.
The only place it lives is on claude.ai/settings/usage when you're logged in.

So instead of making sketchy API calls or asking you to paste tokens, the app
opens a small login window when you first launch it. You log into Claude.ai
normally, the app detects your session, and closes the window automatically.
From that point on it silently loads your usage page in the background every
15 seconds and scrapes the numbers. No API keys, no extra permissions, nothing weird.

You only have to log in once. After that it remembers your session.

## Features

- Live 5-hour session and 7-day weekly usage, updates every 15 seconds
- Color coded rings that go green, orange, red as you approach limits
- Notifications at 50%, 80% and 100% so you're never caught off guard
- Claude Code tab that tracks your daily tokens, estimated API cost, lines written, files edited and current streak
- Weekly spend chart so you can see which days you go hard
- Minimal view that cycles through your key stats
- Detachable floating window you can pin next to your work
- Stays open even when you click away

## Download

Download the latest .dmg from the releases page, open it, drag ClaudeOrb
to your Applications folder and launch it.

On first launch a login window will open. Sign into your Claude.ai account
and it will close by itself. That's it.

Note: Because the app isn't signed with an Apple Developer certificate yet,
macOS might warn you when opening it for the first time. Right-click the app
and select Open to bypass this.

## What's next
I'm planning a browser extension for Chrome and Edge, and a Windows version. 

I'm also looking at turning this into a physical desk display, a small screen that
sits next to your monitor and shows your usage in real time. If there's enough
interest I'll build it out. Let me know.

Built by @SoDyNoTe
