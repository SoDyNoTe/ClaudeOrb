'use strict';
require('events').EventEmitter.defaultMaxListeners = 20;

const { menubar }                                      = require('menubar');
const { app, BrowserWindow, Notification,
        Menu, screen, nativeImage, ipcMain, shell,
        session: electronSession } = require('electron');
const express                                          = require('express');
const fs                                               = require('fs');
const path                                             = require('path');
const os                                               = require('os');
const AutoLaunch                                       = require('auto-launch');
const { autoUpdater }                                  = require('electron-updater');

// ── Debug logging ─────────────────────────────────────────────────────────────
const logFile = path.join(os.homedir(), 'claudeorb-debug.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const LOG_TAIL_LINES = 100;
const log = (...args) => {
  try {
    // Rotate: if file exceeds 5 MB, keep only the last 100 lines
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > LOG_MAX_BYTES) {
        const existing = fs.readFileSync(logFile, 'utf8');
        const lines = existing.split('\n');
        const kept = lines.slice(-LOG_TAIL_LINES).join('\n');
        fs.writeFileSync(logFile, kept + '\n');
      }
    } catch { /* file may not exist yet — ignore */ }
    fs.appendFileSync(logFile, new Date().toISOString() + ' ' + args.join(' ') + '\n');
  } catch {}
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
  'claude-opus-4-7':  { input:  5.00, output: 25.00 },
  'claude-opus-4-6':  { input:  5.00, output: 25.00 },
  'claude-opus-4-5':  { input:  5.00, output: 25.00 },
  'claude-opus-4':    { input:  5.00, output: 25.00 },
  'claude-sonnet-4-6':{ input:  3.00, output: 15.00 },
  'claude-sonnet-4-5':{ input:  3.00, output: 15.00 },
  'claude-sonnet-4':  { input:  3.00, output: 15.00 },
  'claude-haiku-4-5': { input:  1.00, output:  5.00 },
  'claude-haiku-4':   { input:  1.00, output:  5.00 },
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

  // Monday of the current calendar week (Mon–Sun)
  const weekStart = new Date(todayStart);
  const dow = weekStart.getDay(); // 0=Sun
  weekStart.setDate(weekStart.getDate() - (dow === 0 ? 6 : dow - 1));
  const weekStartMs = weekStart.getTime();

  const STREAK_WINDOW = 30 * 24 * 60 * 60 * 1000; // 30-day lookback for streaks

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

      if (ts >= weekStartMs) {
        week.tokens += tokens;
        week.cost   += cost;
      }
      if (age <= STREAK_WINDOW) {
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

httpApp.post('/open-download-page', (_req, res) => {
  log('HTTP open-download-page — opening https://claudeorb.com');
  shell.openExternal('https://claudeorb.com');
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
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'popup-preload.js') },
  });
  detachedWin.loadURL(`file://${path.join(__dirname, 'popup.html')}?detached=true&icon=${encodeURIComponent(icon22DataUrl)}`);
  armUpdateDrain(detachedWin);
  detachedWin.on('moved', () => {
    if (detachedWin && !detachedWin.isDestroyed()) {
      const [wx, wy] = detachedWin.getPosition();
      detachedWinPos = { x: wx, y: wy };
    }
  });
  detachedWin.on('closed', () => { detachedWin = null; });
  res.json({ ok: true });
});

httpApp.listen(45678, '127.0.0.1');


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
    nullScrapeCount    = 0;
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

let pollTimer      = null;
let scrapeWin      = null;
let nullScrapeCount = 0;
let isScraping     = false; // prevent concurrent scrapes

const SCRAPE_JS = `
(() => {
  try {
    const body = document.body ? document.body.innerText : '';
    if (!body || document.location.pathname.startsWith('/login') || document.location.pathname.startsWith('/auth')) {
      return JSON.stringify({ auth_expired: true });
    }

    const sessionIdx = body.indexOf('Current session');
    const weekIdx    = body.indexOf('Weekly limits');
    const extraIdx   = body.indexOf('Extra usage');

    function extractPct(from, to) {
      const slice = body.slice(from, to !== -1 ? to : from + 500);
      const m = slice.match(/(\\d{1,3})%\\s*used/i);
      return m ? parseInt(m[1], 10) : null;
    }

    function extractResets(from, to) {
      const slice = body.slice(from, to !== -1 ? to : from + 500);
      const m = slice.match(/Resets in ([^\\n]+)|Resets ((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[^\\n]+)/i);
      if (!m) return null;
      return (m[1] || m[2]).trim();
    }

    const five_hour      = sessionIdx !== -1 ? extractPct(sessionIdx, weekIdx)    : null;
    const five_hour_resets = sessionIdx !== -1 ? extractResets(sessionIdx, weekIdx) : null;
    const seven_day      = weekIdx    !== -1 ? extractPct(weekIdx, extraIdx)      : null;
    const seven_day_resets = weekIdx  !== -1 ? extractResets(weekIdx, extraIdx)   : null;

    let extra_usage = null;
    if (extraIdx !== -1) {
      const extraSlice = body.slice(extraIdx, extraIdx + 600);
      const spentM  = extraSlice.match(/([€$£][\\d.,]+)\\s*spent/i);
      const eResetM = extraSlice.match(/Resets\\s+((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^\\n]{0,20})/i);
      const ePctM   = extraSlice.match(/(\\d+)%\\s*used/i);
      const limitM  = extraSlice.match(/([€$£][\\d.,]+)\\s*[\\n\\r]+[^\\n]*[Mm]onthly/);
      if (spentM || ePctM) {
        extra_usage = {
          spent:       spentM  ? spentM[1]              : null,
          utilization: ePctM   ? parseInt(ePctM[1], 10) : null,
          resets_at:   eResetM ? eResetM[1].trim()      : null,
          limit:       limitM  ? limitM[1]              : null,
        };
      }
    }

    return JSON.stringify({ five_hour, seven_day, five_hour_resets, seven_day_resets, extra_usage });
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
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:claudeai',
        webSecurity: false,
        allowRunningInsecureContent: true,
      },
    });


    let settled    = false;
    let scrapeTimer = null;
    let timeout    = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(scrapeTimer);
      if (scrapeWin && !scrapeWin.isDestroyed()) scrapeWin.destroy();
      scrapeWin = null;
      resolve(result);
    };

    timeout = setTimeout(() => { log('Scraper timed out'); finish(null); }, 25_000);

    const runScrape = async (attempt = 1) => {
      if (settled) return;
      try {
        // Guard: still navigating — wait and retry
        if (scrapeWin.webContents.isLoading()) {
          log('Page still loading, waiting...');
          scrapeTimer = setTimeout(() => runScrape(attempt), 1500);
          return;
        }
        const url = scrapeWin.webContents.getURL();
        log(`Scraping attempt ${attempt} at URL:`, url);

        // If SPA navigated away from settings page, re-navigate
        if (!url.includes('/settings/usage')) {
          log('Not at settings/usage, got:', url, '— re-navigating');
          scrapeWin.loadURL('https://claude.ai/settings/usage');
          return; // did-finish-load will re-arm the timer
        }

        // Quick sanity check before running the full script
        try {
          const readyState = await scrapeWin.webContents.executeJavaScript('document.readyState');
          log('document.readyState:', readyState);
          if (readyState !== 'complete') {
            scrapeTimer = setTimeout(() => runScrape(attempt), 1500);
            return;
          }
        } catch (e) {
          log('readyState check failed:', e.message, '— retrying in 2s');
          if (attempt < 5) {
            scrapeTimer = setTimeout(() => runScrape(attempt + 1), 2000);
          } else {
            finish(null);
          }
          return;
        }

        // Log raw HTML snapshot so we can see what the page actually contains
        try {
          const html = await scrapeWin.webContents.executeJavaScript(
            'document.documentElement.outerHTML.slice(0, 4000)', true);
          log(`HTML snapshot (attempt ${attempt}):`, html);
        } catch (e) {
          log('HTML snapshot failed:', e.message);
        }

        const raw = await scrapeWin.webContents.executeJavaScript(SCRAPE_JS, true);
        log(`Scrape raw return (attempt ${attempt}):`, String(raw).slice(0, 500));
        const parsed = JSON.parse(raw);
        log('Scrape parsed:', JSON.stringify(parsed));
        if (parsed.auth_expired) { finish('auth_expired'); return; }
        if (parsed.error) { log('Scrape JS error:', parsed.error); finish(null); return; }
        const out = {};
        if (parsed.five_hour !== null && parsed.five_hour !== undefined)
          out.five_hour = { utilization: parsed.five_hour, resets_at: parsed.five_hour_resets || null };
        if (parsed.seven_day !== null && parsed.seven_day !== undefined)
          out.seven_day = { utilization: parsed.seven_day, resets_at: parsed.seven_day_resets || null };
        if (parsed.extra_usage)
          out.extra_usage = parsed.extra_usage;
        log('Scraper result:', JSON.stringify(out));
        if (Object.keys(out).length) {
          finish(out);
        } else if (attempt < 3) {
          log(`Empty scrape result (attempt ${attempt}), retrying in 2s…`);
          scrapeTimer = setTimeout(() => runScrape(attempt + 1), 2000);
        } else {
          log('Empty scrape result after 3 attempts — giving up');
          finish(null);
        }
      } catch (e) {
        log(`executeJavaScript error (attempt ${attempt}):`, e.message);
        if (attempt < 5) {
          scrapeTimer = setTimeout(() => runScrape(attempt + 1), 2000);
        } else {
          finish(null);
        }
      }
    };

    // Each time the page (re-)loads, cancel the previous timer and restart.
    // This ensures we only scrape after the LAST navigation has settled.
    scrapeWin.webContents.on('console-message', (_e, level, msg) => {
      // Skip renderer noise — only log actual errors or ClaudeOrb-relevant messages
      if (msg.startsWith('[')) return;
      if (level >= 2) log('Renderer error:', msg); // 2=warning, 3=error
    });

    // dom-ready fires as soon as the DOM is parseable (before subresources finish).
    // Paired with did-finish-load below so whichever fires last wins the timer.
    scrapeWin.webContents.on('dom-ready', () => {
      clearTimeout(scrapeTimer);
      scrapeTimer = setTimeout(() => runScrape(1), 1500);
    });

    scrapeWin.webContents.on('did-finish-load', () => {
      clearTimeout(scrapeTimer);
      scrapeTimer = setTimeout(() => runScrape(1), 4000);
    });

    scrapeWin.on('closed', () => { scrapeWin = null; });
    scrapeWin.loadURL('https://claude.ai/settings/usage');
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

// ── IPC: push usage to popup ──────────────────────────────────────────────────

// ipcMain.handle so the popup can request current data synchronously on load
ipcMain.handle('get-usage', () => ({
  usageData:  session.usageData,
  hasSession: !!(session.usageData || sessionCaptured),
  savedAt:    session.savedAt,
}));

ipcMain.handle('open-download-page', () => {
  log('IPC open-download-page — opening https://claudeorb.com');
  return shell.openExternal('https://claudeorb.com');
});

ipcMain.handle('preload-loaded', () => {
  log('popup-preload.js confirmed loaded by renderer');
});

// Queued payload for when the popup loads after data is already available
let pendingPopupPush = null;

// Cached update info — replayed to any window that loads after the download event fires
let downloadedUpdateInfo = null;

function pushUsageToPopup(data) {
  const payload = {
    usageData:  data,
    hasSession: true,
    savedAt:    session.savedAt,
  };
  const win = mb?.window;
  if (win && !win.isDestroyed() && win.webContents.isLoading() === false) {
    log('IPC send to popup:', JSON.stringify(payload).slice(0, 200));
    win.webContents.send('usage-push', payload);
    pendingPopupPush = null;
  } else {
    // Popup not ready yet — queue it; the popup's did-finish-load will drain it
    log('IPC popup not ready, queuing push');
    pendingPopupPush = payload;
  }
}

// Drain the queue the moment the menubar popup finishes loading
function armPopupLoadDrain() {
  const win = mb?.window;
  if (!win || win.isDestroyed()) return;
  win.webContents.on('did-finish-load', () => {
    if (pendingPopupPush) {
      log('IPC draining queued push to popup');
      win.webContents.send('usage-push', pendingPopupPush);
      pendingPopupPush = null;
    }
    if (downloadedUpdateInfo) {
      win.webContents.send('update-downloaded', downloadedUpdateInfo);
    }
  });
}

// Send cached update info to a window once it finishes loading
function armUpdateDrain(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on('did-finish-load', () => {
    if (downloadedUpdateInfo) {
      win.webContents.send('update-downloaded', downloadedUpdateInfo);
    }
  });
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

function initAutoUpdater() {
  autoUpdater.autoDownload    = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger          = null; // we handle logging ourselves

  autoUpdater.on('checking-for-update', () => {
    log('Updater: checking for update');
  });

  autoUpdater.on('update-available', (info) => {
    log('Updater: update available', info.version);
    try {
      new Notification({
        title: 'ClaudeOrb update downloading…',
        body:  `Version ${info.version} is downloading in the background.`,
        icon:  path.join(__dirname, 'assets', 'icon.icns'),
      }).show();
    } catch { /* notifications may be unsupported */ }
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('Updater: update downloaded', info.version);
    downloadedUpdateInfo = { version: info.version };
    for (const win of [mb?.window, detachedWin]) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('update-downloaded', downloadedUpdateInfo);
      }
    }
  });

  autoUpdater.on('update-not-available', () => {
    log('Updater: up to date');
  });

  autoUpdater.on('error', (err) => {
    log('Updater error:', err.message);
    // Silent — never crash or alert the user for update failures
  });

  // Check on startup, then every 4 hours
  autoUpdater.checkForUpdates().catch(err => log('Updater check failed:', err.message));
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(err => log('Updater check failed:', err.message));
  }, 4 * 60 * 60 * 1000);
}

async function pollUsage() {
  if (isScraping) return; // prevent concurrent scrapes
  isScraping = true;
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
      openLoginWindow();
      return;
    }
    if (data && (data.five_hour !== undefined || data.seven_day !== undefined)) {
      nullScrapeCount = 0;
      session.usageData = data;
      session.savedAt   = new Date().toISOString();
      saveSession();
      checkUsageThresholds(data);
      updateTrayTitle(data);
      pushUsageToPopup(data);
    } else {
      // Don't increment if polling already stopped (login window open)
      if (!pollTimer) return;
      nullScrapeCount++;
      log('Null scrape count:', nullScrapeCount);
      // Only force login if we have never confirmed a valid session this run.
      // If sessionCaptured is true the page was just slow — keep retrying silently.
      // Real auth expiry is handled by the auth_expired signal above.
      if (nullScrapeCount >= 3 && !sessionCaptured) {
        log('3 consecutive nulls and no session — opening login window');
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        nullScrapeCount = 0;
        session.cookies = '';
        saveSession();
        openLoginWindow();
      }
    }
  } catch { /* ignore */ }
  finally { isScraping = false; }
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
      preload: path.join(__dirname, 'popup-preload.js'),
    },
  },
  showOnRightClick: false,
  hideOnClickOutside: false,
  hideOnClick: false,
  preloadWindow:    true,
});

mb.on('ready', () => {
  app.setAppUserModelId('com.claudeorb.app');
  log('Preload path:', path.join(__dirname, 'popup-preload.js'));
  armPopupLoadDrain();
  initAutoUpdater();



  // Strip CSP headers on the scraper/login session so executeJavaScript works on claude.ai.
  // Must run after app is ready — session API is unavailable before that.
  electronSession.fromPartition('persist:claudeai').webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    callback({ responseHeaders: headers });
  });
  log('CSP interceptor active');

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
    { label: 'Reconnect / Log in again', click: () => {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      sessionCaptured = false;
      nullScrapeCount = 0;
      session.cookies = '';
      saveSession();
      openLoginWindow();
    }},
    { type: 'separator' },
    { label: 'Quit ClaudeOrb', click: () => app.quit() },
  ]);
  mb.tray.on('right-click', () => mb.tray.popUpContextMenu(contextMenu));

  // Keep popup open when it loses focus — use once so the listener doesn't stack on repeat shows
  mb.on('after-show', () => {
    if (mb.window) {
      mb.window.removeAllListeners('blur');
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
