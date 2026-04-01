'use strict';
require('events').EventEmitter.defaultMaxListeners = 20;

const { menubar }                                      = require('menubar');
const { app, BrowserWindow, Notification,
        Menu, screen, nativeImage, session: electronSession } = require('electron');
const express                                          = require('express');
const fs                                               = require('fs');
const path                                             = require('path');
const os                                               = require('os');
const AutoLaunch                                       = require('auto-launch');

// ── Debug logging ─────────────────────────────────────────────────────────────
const logFile = path.join(os.homedir(), 'claudeorb-debug.log');
const log = (...args) => {
  try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + args.join(' ') + '\n'); } catch {}
};
log('App starting');

// ── App icon ──────────────────────────────────────────────────────────────────

const iconPath      = path.join(__dirname, 'assets', 'icon.png');
const appIcon       = nativeImage.createFromPath(iconPath);
const trayIcon      = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 });
let icon22DataUrl = '';
try {
  const icon22Base64 = fs.readFileSync(path.join(__dirname, 'assets', 'icon22.png')).toString('base64');
  icon22DataUrl = `data:image/png;base64,${icon22Base64}`;
} catch (e) {
  console.error('Failed to read icon22.png:', e.message);
}

// ── Session persistence ───────────────────────────────────────────────────────

const SESSION_DIR  = path.join(os.homedir(), '.claudeorb');
const SESSION_FILE = path.join(SESSION_DIR, 'session.json');

let session = { cookies: '', usageUrl: '', usageData: null, savedAt: null };

function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      session = Object.assign(session, JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
    }
  } catch { /* ignore */ }
}

function saveSession() {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    // Never persist usageData — always start fresh on next launch
    const { cookies, usageUrl } = session;
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookies, usageUrl }, null, 2));
  } catch { /* ignore */ }
}

loadSession();

// ── Model pricing (per million tokens) ───────────────────────────────────────

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
  if (!modelId) return { input: 3.00, output: 15.00 };
  for (const [key, price] of Object.entries(MODEL_PRICING)) {
    if (modelId.startsWith(key)) return price;
  }
  return { input: 3.00, output: 15.00 };
}

function calcCost(modelId, usage) {
  if (!usage) return 0;
  const p = modelPrice(modelId);
  const inp      = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
  const out      = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return (inp * p.input + out * p.output + cacheRead * p.input * 0.1) / 1_000_000;
}

function simplifyModel(modelId) {
  if (!modelId) return 'unknown';
  if (modelId.includes('opus'))   return 'opus';
  if (modelId.includes('sonnet')) return 'sonnet';
  if (modelId.includes('haiku'))  return 'haiku';
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
  const files     = walkDir(claudeDir);
  const now       = Date.now();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const WEEK = 7 * 24 * 60 * 60 * 1000;

  const today = { tokens: 0, cost: 0, lines: 0, files: new Set(), modelTokens: {} };
  const week  = { tokens: 0, cost: 0 };
  const activeDays = new Set();

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
      if (!ts) continue;
      const age = now - ts;

      const msg     = obj.message || {};
      const usage   = msg.usage  || {};
      const model   = msg.model  || '';
      const inp     = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const out     = usage.output_tokens || 0;
      const tokens  = inp + out + (usage.cache_read_input_tokens || 0);
      const cost    = calcCost(model, usage);

      if (age <= WEEK) {
        week.tokens += tokens;
        week.cost   += cost;
        activeDays.add(new Date(ts).toISOString().slice(0, 10));
      }

      if (ts >= todayStartMs) {
        today.tokens += tokens;
        today.cost   += cost;
        today.modelTokens[model] = (today.modelTokens[model] || 0) + tokens;

        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (block.type !== 'tool_use') continue;
          const toolName = block.name  || '';
          const input    = block.input || {};
          if (toolName === 'Write' || toolName === 'Edit') {
            if (input.file_path) today.files.add(input.file_path);
            if (toolName === 'Write' && typeof input.content === 'string')
              today.lines += input.content.split('\n').length;
            if (toolName === 'Edit' && typeof input.new_string === 'string')
              today.lines += input.new_string.split('\n').length;
          }
        }
      }
    }
  }

  let topModel = 'unknown', topTokens = 0;
  for (const [model, count] of Object.entries(today.modelTokens)) {
    if (count > topTokens) { topTokens = count; topModel = simplifyModel(model); }
  }

  let streak = 0;
  let checkDate = new Date();
  while (true) {
    const dayStr = checkDate.toISOString().slice(0, 10);
    if (activeDays.has(dayStr)) {
      streak++;
      checkDate = new Date(checkDate.getTime() - 24 * 60 * 60 * 1000);
    } else break;
  }

  return {
    today: { tokens: today.tokens, cost: Math.round(today.cost * 10000) / 10000,
             lines: today.lines, files: today.files.size, topModel },
    week:  { tokens: week.tokens, cost: Math.round(week.cost * 10000) / 10000, streak },
    lastUpdated: new Date().toISOString(),
  };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function calcTrends(days = 7) {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const files     = walkDir(claudeDir);
  const now       = Date.now();
  const windowMs  = days * 24 * 60 * 60 * 1000;
  const byDay     = {};

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

      const msg    = obj.message || {};
      const usage  = msg.usage  || {};
      const model  = msg.model  || '';
      const inp    = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
      const out    = usage.output_tokens || 0;
      const tokens = inp + out + (usage.cache_read_input_tokens || 0);
      const cost   = calcCost(model, usage);

      const d       = new Date(ts);
      const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!byDay[dateKey]) byDay[dateKey] = { tokens: 0, cost: 0 };
      byDay[dateKey].tokens += tokens;
      byDay[dateKey].cost   += cost;
    }
  }

  const result = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
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

// ── Stats cache ───────────────────────────────────────────────────────────────

let cachedStats    = null;
let cachedTrends   = null;
let cachedTrends30 = null;

function refreshStats() {
  try {
    cachedStats    = parseJsonlFiles();
    cachedTrends   = calcTrends(7);
    cachedTrends30 = calcTrends(30);
  } catch (err) {
    console.error('Failed to refresh stats:', err);
  }
}

refreshStats();
setInterval(refreshStats, 30_000);

// ── Express HTTP server ───────────────────────────────────────────────────────

const httpApp = express();
httpApp.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

httpApp.get('/health',     (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));
httpApp.get('/stats',      (_req, res) => res.json(cachedStats    || { error: 'not yet available' }));
httpApp.get('/trends',     (_req, res) => res.json(cachedTrends   || []));
httpApp.get('/trends/30',  (_req, res) => res.json(cachedTrends30 || []));

httpApp.get('/usage-data', (_req, res) => res.json({
  hasSession: !!(session.usageData || sessionCaptured),
  usageData:  session.usageData,
  savedAt:    session.savedAt,
}));

httpApp.post('/trigger-login', (_req, res) => {
  openLoginWindow();
  res.json({ ok: true });
});

httpApp.post('/hide-window', (_req, res) => {
  mb.hideWindow();
  res.json({ ok: true });
});

httpApp.post('/trigger-poll', (_req, res) => {
  pollUsage();
  res.json({ ok: true });
});

let detachedWin = null;
let detachedWinPos = null; // { x, y } — last saved position

httpApp.post('/open-detached', (_req, res) => {
  if (detachedWin && !detachedWin.isDestroyed()) {
    detachedWin.focus();
    return res.json({ ok: true });
  }
  const winW = 360, winH = 480;
  let x, y;
  if (detachedWinPos) {
    ({ x, y } = detachedWinPos);
  } else {
    const cursor   = screen.getCursorScreenPoint();
    const display  = screen.getDisplayNearestPoint(cursor);
    const { workArea } = display;
    x = (workArea.x + workArea.width)  - winW - 10;
    y =  workArea.y + 10;
  }
  detachedWin = new BrowserWindow({
    width: winW, height: winH,
    x, y,
    useContentSize:  true,
    alwaysOnTop:     true,
    resizable:       false,
    frame:           false,
    transparent:     false,
    skipTaskbar:     true,
    icon:            appIcon,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  detachedWin.loadURL(`file://${path.join(__dirname, 'popup.html')}?detached=true&icon=${encodeURIComponent(icon22DataUrl)}`);
  detachedWin.on('moved', () => {
    if (detachedWin && !detachedWin.isDestroyed()) {
      const [wx, wy] = detachedWin.getPosition();
      detachedWinPos = { x: wx, y: wy };
    }
  });
  detachedWin.on('closed', () => { detachedWin = null; });
  res.json({ ok: true });
});

httpApp.listen(3000, '127.0.0.1');

// ── Login window ──────────────────────────────────────────────────────────────

let loginWin        = null;
let sessionCaptured = false;

async function checkLoginState() {
  if (sessionCaptured) return;
  if (!loginWin || loginWin.isDestroyed()) return;

  try {
    const rawCookies = await loginWin.webContents.session.cookies.get({ url: 'https://claude.ai' });
    const hasCookies = rawCookies.some(c => c.name === 'sessionKey');
    if (!hasCookies) return;

    sessionCaptured    = true;
    session.cookies    = 'captured';
    session.savedAt    = new Date().toISOString();
    saveSession();
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
    startPolling();
    pollUsage().then(() => {
      setTimeout(() => {
        if (mb.window && !mb.window.isDestroyed()) {
          mb.window.webContents.reload();
        }
      }, 500);
    });
  } catch { /* ignore */ }
}

function openLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return; }

  sessionCaptured = false;

  loginWin = new BrowserWindow({
    width:  980,
    height: 720,
    title:  'Sign in to Claude',
    icon:   appIcon,
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:claudeai' },
  });

  loginWin.webContents.on('did-finish-load', () => {
    setTimeout(checkLoginState, 500);
  });
  // Also check on SPA navigations (claude.ai uses React Router)
  loginWin.webContents.on('did-navigate-in-page', () => {
    setTimeout(checkLoginState, 500);
  });

  loginWin.loadURL('https://claude.ai');
  loginWin.on('closed', () => { loginWin = null; });
}

// ── Usage polling ─────────────────────────────────────────────────────────────

let pollTimer  = null;
let scrapeWin  = null;

// Fetch usage API using the hidden window's session cookies.
// Uses absolute URL to avoid 404s from relative path on redirect pages.
const FETCH_JS = `
(async () => {
  try {
    if (location.pathname.startsWith('/login') || location.pathname.startsWith('/auth')) {
      return JSON.stringify({ auth_expired: true });
    }
    const res = await fetch('https://claude.ai/api/usage', {
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    if (res.status === 401 || res.status === 403) return JSON.stringify({ auth_expired: true });
    if (!res.ok) return JSON.stringify({ error: res.status });
    const data = await res.json();
    return JSON.stringify(data);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
})()
`;

function scrapeUsage() {
  return new Promise((resolve) => {
    if (scrapeWin && !scrapeWin.isDestroyed()) scrapeWin.destroy();

    scrapeWin = new BrowserWindow({
      show: false,
      icon: appIcon,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:claudeai' },
    });

    let settled = false;
    let timeout = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (scrapeWin && !scrapeWin.isDestroyed()) scrapeWin.destroy();
      scrapeWin = null;
      resolve(result);
    };

    timeout = setTimeout(() => finish(null), 20_000);

    scrapeWin.webContents.on('did-finish-load', async () => {
      try {
        // Wait for page and cookies to be fully ready before fetching
        await new Promise(r => setTimeout(r, 2000));
        if (settled) return;
        const raw = await scrapeWin.webContents.executeJavaScript(FETCH_JS);
        const parsed = JSON.parse(raw);
        log('API fetch result:', JSON.stringify(parsed));
        if (parsed.auth_expired) { finish('auth_expired'); return; }
        if (parsed.error) { log('API error:', parsed.error); finish(null); return; }
        // API returns { five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at }, ... }
        finish((parsed.five_hour !== undefined || parsed.seven_day !== undefined) ? parsed : null);
      } catch (e) {
        log('executeJavaScript error:', e.message);
        finish(null);
      }
    });

    scrapeWin.on('closed', () => { scrapeWin = null; });
    scrapeWin.loadURL('https://claude.ai/');
  });
}

function updateTrayTitle(data) {
  if (!mb.tray) return;
  if (!data) { mb.tray.setTitle('—'); return; }
  const fhP = typeof data.five_hour === 'object' ? data.five_hour?.utilization : data.five_hour;
  const sdP = typeof data.seven_day === 'object' ? data.seven_day?.utilization : data.seven_day;
  const parts = [];
  if (fhP != null) parts.push(`${fhP}%`);
  if (sdP != null) parts.push(`${sdP}%`);
  mb.tray.setTitle(parts.length ? parts.join(' · ') : '—');
}

async function pollUsage() {
  log('pollUsage called');
  try {
    const data = await scrapeUsage();
    log('Scraper result:', JSON.stringify(data));
    if (data === 'auth_expired') {
      log('auth_expired fired');
      session.cookies  = '';
      session.usageUrl = '';
      sessionCaptured  = false;
      saveSession();
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      // Open login window immediately — never leave user stuck on loading screen
      openLoginWindow();
      return;
    }
    if (data && (data.five_hour !== undefined || data.seven_day !== undefined)) {
      session.usageData = data;
      session.savedAt   = new Date().toISOString();
      saveSession();
      checkUsageThresholds(data);
      updateTrayTitle(data);
    }
  } catch { /* ignore */ }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollUsage(); // immediate poll on start
  pollTimer = setInterval(pollUsage, 15_000);
}

// ── Usage threshold notifications ─────────────────────────────────────────────

const notifiedThresholds = {
  five_hour_50:  false,
  five_hour_80:  false,
  five_hour_100: false,
  seven_day_50:  false,
  seven_day_80:  false,
  seven_day_100: false,
};

function checkUsageThresholds(data) {
  function notify(title, body) {
    try {
      new Notification({ title, body, icon: path.join(__dirname, 'assets', 'icon.icns') }).show();
    } catch { /* ignore if notifications unsupported */ }
  }

  function fmtResetsSession(val) {
    if (!val) return '';
    return ` — resets in ${val}`;
  }

  function fmtResetsWeekly(val) {
    if (!val) return '';
    return ` — resets ${val}`;
  }

  const fhP     = typeof data.five_hour === 'object' ? data.five_hour?.utilization ?? -1 : data.five_hour ?? -1;
  const sdP     = typeof data.seven_day === 'object' ? data.seven_day?.utilization ?? -1 : data.seven_day ?? -1;
  const fhResets = data.five_hour_resets || data.five_hour?.resets_at || null;
  const sdResets = data.seven_day_resets || data.seven_day?.resets_at || null;
  // ── 5-hour session ────────────────────────────────────────────────────────
  if (fhP >= 100) {
    if (!notifiedThresholds.five_hour_100) {
      notifiedThresholds.five_hour_100 = true;
      notify('Session Limit Reached', `Your 5-hour session is full${fmtResetsSession(fhResets)}`);
    }
  } else {
    notifiedThresholds.five_hour_100 = false;
  }

  if (fhP >= 80 && fhP < 100) {
    if (!notifiedThresholds.five_hour_80) {
      notifiedThresholds.five_hour_80 = true;
      notify('Session Warning', `You've used 80% of your 5-hour session${fmtResetsSession(fhResets)}`);
    }
  } else if (fhP < 80) {
    notifiedThresholds.five_hour_80 = false;
  }

  if (fhP >= 50 && fhP < 80) {
    if (!notifiedThresholds.five_hour_50) {
      notifiedThresholds.five_hour_50 = true;
      notify('Session at 50%', `You've used half your 5-hour session${fmtResetsSession(fhResets)}`);
    }
  } else if (fhP < 50) {
    notifiedThresholds.five_hour_50 = false;
  }

  // ── 7-day weekly ──────────────────────────────────────────────────────────
  if (sdP >= 100) {
    if (!notifiedThresholds.seven_day_100) {
      notifiedThresholds.seven_day_100 = true;
      notify('Weekly Limit Reached', `Your weekly Claude limit is full${fmtResetsWeekly(sdResets)}`);
    }
  } else {
    notifiedThresholds.seven_day_100 = false;
  }

  if (sdP >= 80 && sdP < 100) {
    if (!notifiedThresholds.seven_day_80) {
      notifiedThresholds.seven_day_80 = true;
      notify('Weekly Warning', `You've used 80% of your weekly limit${fmtResetsWeekly(sdResets)}`);
    }
  } else if (sdP < 80) {
    notifiedThresholds.seven_day_80 = false;
  }

  if (sdP >= 50 && sdP < 80) {
    if (!notifiedThresholds.seven_day_50) {
      notifiedThresholds.seven_day_50 = true;
      notify('Weekly Usage at 50%', `You've used half your weekly Claude limit${fmtResetsWeekly(sdResets)}`);
    }
  } else if (sdP < 50) {
    notifiedThresholds.seven_day_50 = false;
  }
}


// ── Menubar ───────────────────────────────────────────────────────────────────

const mb = menubar({
  index:  `file://${path.join(__dirname, 'popup.html')}?icon=${encodeURIComponent(icon22DataUrl)}`,
  tooltip: 'ClaudeOrb',
  icon:   trayIcon,
  browserWindow: {
    width:           320,
    height:          460,
    resizable:       false,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
  },
  showOnRightClick: false,
  hideOnClickOutside: false,
  hideOnClick: false,
  preloadWindow:    true,
});

mb.on('ready', () => {
  app.setAppUserModelId('com.claudeorb.app');

  // Set tray icon explicitly after tray exists
  trayIcon.setTemplateImage(false);
  mb.tray.setImage(trayIcon);

  // Always set tray title on startup — "—" until first scrape arrives
  updateTrayTitle(session.usageData || null);

  // Dock icon
  if (app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.icns')));
    app.dock.hide();
  }

  // Right-click shows a minimal context menu with Quit
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => mb.showWindow() },
    { type: 'separator' },
    { label: 'Quit ClaudeOrb', click: () => app.quit() },
  ]);
  mb.tray.on('right-click', () => mb.tray.popUpContextMenu(contextMenu));

  // Keep popup open when it loses focus (blur refocus)
  mb.on('after-show', () => {
    if (mb.window) {
      mb.window.on('blur', () => {
        if (mb.window && !mb.window.isDestroyed()) {
          mb.window.focus();
        }
      });
    }
  });

  // 5s fallback — if polling hasn't started by then, open login window
  const loginFallback = setTimeout(() => {
    if (!sessionCaptured) openLoginWindow();
  }, 5000);

  // Always verify partition cookies — never trust session.json alone
  log('Checking partition cookies');
  electronSession.fromPartition('persist:claudeai').cookies
    .get({ url: 'https://claude.ai' })
    .then((cookies) => {
      const names = cookies.map(c => c.name).join(', ');
      log('Partition cookies found:', names || '(none)');
      const found = cookies.some(c => c.name === 'sessionKey');
      log('sessionKey found:', found);
      if (found) {
        sessionCaptured = true;
        session.cookies = 'captured';
        saveSession();
        clearTimeout(loginFallback);
        log('startPolling called');
        startPolling();
      } else {
        // Partition has no valid session — clear stale file and force login
        session.cookies = '';
        saveSession();
        clearTimeout(loginFallback);
        log('No sessionKey — opening login window');
        openLoginWindow();
      }
    })
    .catch((err) => {
      log('Cookie check error:', err?.message);
      clearTimeout(loginFallback);
      openLoginWindow();
    });

});

// ── Quit cleanup ──────────────────────────────────────────────────────────────

app.on('before-quit', () => {
  if (pollTimer)  { clearInterval(pollTimer); pollTimer = null; }
  if (scrapeWin && !scrapeWin.isDestroyed()) { scrapeWin.destroy(); scrapeWin = null; }
});

// ── Auto-launch ───────────────────────────────────────────────────────────────

const autoLauncher = new AutoLaunch({ name: 'ClaudeOrb' });
autoLauncher.enable().catch(() => {});
