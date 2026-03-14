const { menubar } = require('menubar');
const { app, Menu, nativeImage } = require('electron');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AutoLaunch = require('auto-launch');

const autoLauncher = new AutoLaunch({ name: 'Claude Companion' });
autoLauncher.enable();

// ── Stats cache ──────────────────────────────────────────────────────────────

let cachedStats = null;
let lastUpdated = null;

// ── Model pricing (per million tokens) ───────────────────────────────────────
// Source: Anthropic pricing as of 2025
const MODEL_PRICING = {
  'claude-opus-4':    { input: 15.00, output: 75.00 },
  'claude-opus-4-5':  { input: 15.00, output: 75.00 },
  'claude-opus-4-6':  { input: 15.00, output: 75.00 },
  'claude-sonnet-4':  { input:  3.00, output: 15.00 },
  'claude-sonnet-4-5':{ input:  3.00, output: 15.00 },
  'claude-sonnet-4-6':{ input:  3.00, output: 15.00 },
  'claude-haiku-4-5': { input:  0.80, output:  4.00 },
  'claude-haiku-4':   { input:  0.80, output:  4.00 },
};

function modelPrice(modelId) {
  if (!modelId) return { input: 3.00, output: 15.00 }; // default to sonnet
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key)) return price;
  }
  return { input: 3.00, output: 15.00 };
}

function calcCost(modelId, usage) {
  if (!usage) return 0;
  const p = modelPrice(modelId);
  const inp = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const out = usage.output_tokens || 0;
  // Cache reads are ~10% of base input price
  const cacheRead = (usage.cache_read_input_tokens || 0);
  return (inp * p.input + out * p.output + cacheRead * p.input * 0.1) / 1_000_000;
}

function simplifyModel(modelId) {
  if (!modelId) return 'unknown';
  if (modelId.includes('opus')) return 'opus';
  if (modelId.includes('sonnet')) return 'sonnet';
  if (modelId.includes('haiku')) return 'haiku';
  return modelId.split('-').slice(-1)[0] || modelId;
}

// ── JSONL parsing ─────────────────────────────────────────────────────────────

function walkDir(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(walkDir(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

function parseJsonlFiles() {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const files = walkDir(claudeDir);

  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  // Per-window accumulators
  const today = { tokens: 0, cost: 0, lines: 0, files: new Set(), modelTokens: {} };
  const week  = { tokens: 0, cost: 0 };
  const activeDays = new Set(); // YYYY-MM-DD strings

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }

      // Only process assistant turns — they carry usage data
      if (obj.type !== 'assistant') continue;

      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null;
      if (!ts) continue;
      const age = now - ts;

      const msg    = obj.message || {};
      const usage  = msg.usage || {};
      const model  = msg.model || '';
      const inp    = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const out    = usage.output_tokens || 0;
      const tokens = inp + out + (usage.cache_read_input_tokens || 0);
      const cost   = calcCost(model, usage);

      // Week bucket
      if (age <= WEEK) {
        week.tokens += tokens;
        week.cost   += cost;
        const dayKey = new Date(ts).toISOString().slice(0, 10);
        activeDays.add(dayKey);
      }

      // Today bucket (calendar day: midnight → now)
      if (ts >= todayStartMs) {
        today.tokens += tokens;
        today.cost   += cost;
        today.modelTokens[model] = (today.modelTokens[model] || 0) + tokens;

        // Extract file edits + lines written from tool_use blocks
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          const toolName = block.name || '';
          const input    = block.input || {};

          if (toolName === 'Write' || toolName === 'Edit') {
            if (input.file_path) today.files.add(input.file_path);
            if (toolName === 'Write' && typeof input.content === 'string') {
              today.lines += input.content.split('\n').length;
            }
            if (toolName === 'Edit') {
              if (typeof input.new_string === 'string') {
                today.lines += input.new_string.split('\n').length;
              }
            }
          }
        }
      }
    }
  }

  // Top model
  let topModel = 'unknown';
  let topTokens = 0;
  for (const [model, count] of Object.entries(today.modelTokens)) {
    if (count > topTokens) { topTokens = count; topModel = simplifyModel(model); }
  }

  // Streak: consecutive days (ending today or yesterday) with activity
  let streak = 0;
  let checkDate = new Date();
  while (true) {
    const dayStr = checkDate.toISOString().slice(0, 10);
    if (activeDays.has(dayStr)) {
      streak++;
      checkDate = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);
    } else {
      break;
    }
  }

  return {
    today: {
      tokens: today.tokens,
      cost:   Math.round(today.cost * 10000) / 10000,
      lines:  today.lines,
      files:  today.files.size,
      topModel,
    },
    week: {
      tokens: week.tokens,
      cost:   Math.round(week.cost * 10000) / 10000,
      streak,
    },
    lastUpdated: new Date().toISOString(),
  };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function calcTrends(days = 7) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const files = walkDir(claudeDir);

  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;

  // Build a map of YYYY-MM-DD → { tokens, cost }
  const byDay = {};

  for (const file of files) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try { obj = JSON.parse(trimmed); } catch { continue; }

      if (obj.type !== 'assistant') continue;
      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : null;
      if (!ts || now - ts > windowMs) continue;

      const msg   = obj.message || {};
      const usage = msg.usage || {};
      const model = msg.model || '';
      const inp   = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const out   = usage.output_tokens || 0;
      const tokens = inp + out + (usage.cache_read_input_tokens || 0);
      const cost   = calcCost(model, usage);

      // Use local date string so days match the user's timezone
      const d = new Date(ts);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!byDay[dateKey]) byDay[dateKey] = { tokens: 0, cost: 0 };
      byDay[dateKey].tokens += tokens;
      byDay[dateKey].cost   += cost;
    }
  }

  // Build the last N calendar days (oldest → newest)
  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const data = byDay[dateKey] || { tokens: 0, cost: 0 };
    result.push({
      day:    days <= 7 ? DAY_NAMES[d.getDay()] : String(d.getDate()),
      date:   dateKey,
      tokens: data.tokens,
      cost:   Math.round(data.cost * 10000) / 10000,
    });
  }

  return result;
}

let cachedTrends = null;
let cachedTrends30 = null;

function refreshStats() {
  try {
    cachedStats    = parseJsonlFiles();
    cachedTrends   = calcTrends(7);
    cachedTrends30 = calcTrends(30);
    lastUpdated    = Date.now();
  } catch (err) {
    console.error('Failed to refresh stats:', err);
  }
}

// Initial load + recurring refresh
refreshStats();
setInterval(refreshStats, 30_000);

// ── Express HTTP server ───────────────────────────────────────────────────────

const server = express();

server.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

server.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

server.get('/stats', (_req, res) => {
  res.json(cachedStats || { error: 'stats not yet available' });
});

server.get('/trends', (_req, res) => {
  res.json(cachedTrends || []);
});

server.get('/trends/30', (_req, res) => {
  res.json(cachedTrends30 || []);
});

server.listen(3000, '127.0.0.1', () => {
  console.log('Claude Companion HTTP server listening on http://localhost:3000');
});

// ── Menubar ───────────────────────────────────────────────────────────────────

// Create a tiny 1×1 transparent icon so menubar still renders the title text
const emptyIcon = nativeImage.createEmpty();

const mb = menubar({
  icon: emptyIcon,
  tooltip: 'Claude Companion',
  browserWindow: {
    width: 300,
    height: 200,
    webPreferences: { nodeIntegration: false },
  },
  // We don't need the popup window — just the tray icon + context menu
  showOnRightClick: false,
  preloadWindow: false,
});

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

function timeSince(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

function buildMenu() {
  const s = cachedStats;
  const items = [];

  if (!s) {
    items.push({ label: 'Loading…', enabled: false });
  } else {
    items.push(
      { label: `⚡ Tokens today: ${fmtNum(s.today.tokens)}`, enabled: false },
      { label: `💰 Cost today: $${s.today.cost.toFixed(2)}`, enabled: false },
      { label: `📝 Lines written: ${fmtNum(s.today.lines)}`, enabled: false },
      { label: `🔥 Streak: ${s.week.streak} day${s.week.streak !== 1 ? 's' : ''}`, enabled: false },
      { type: 'separator' },
      { label: `Last updated: ${lastUpdated ? timeSince(lastUpdated) : '—'}`, enabled: false },
    );
  }

  items.push(
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );

  return Menu.buildFromTemplate(items);
}

mb.on('ready', () => {
  mb.tray.setTitle('⚡');
  mb.tray.setContextMenu(buildMenu());

  // Rebuild menu on each click so "last updated" stays fresh
  mb.tray.on('click', () => {
    mb.tray.setContextMenu(buildMenu());
    mb.tray.popUpContextMenu();
  });
  mb.tray.on('right-click', () => {
    mb.tray.setContextMenu(buildMenu());
    mb.tray.popUpContextMenu();
  });

  // Rebuild every 5 seconds so the "last updated" label ticks
  setInterval(() => {
    mb.tray.setContextMenu(buildMenu());
  }, 5_000);

  console.log('Claude Companion menubar app is running.');
});
