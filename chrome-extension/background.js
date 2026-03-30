/**
 * Service worker.
 *
 * Responsibilities:
 *  1. Receive USAGE_DATA from the content bridge → persist to storage
 *  2. Actively poll https://claude.ai/api/usage every 60 s (via alarms)
 *  3. Update the toolbar badge with the 5-hour session %
 *  4. Fire Chrome/Firefox notifications at the 80 %, 90 %, and reset thresholds
 *
 * Compatible with Chrome, Firefox (≥ 128) and Edge via the WebExtensions API.
 */

// Unified API surface: Firefox exposes `browser`, Chrome/Edge expose `chrome`.
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// ─── Badge ───────────────────────────────────────────────────────────────────

const BADGE_COLOR = {
  ok:      '#22c55e',  // green   < 70 %
  warning: '#f97316',  // orange  ≥ 70 %
  danger:  '#ef4444',  // red     ≥ 90 %
  empty:   '#4a4a4a',  // grey    0 % / no data
};

function updateBadge(utilization) {
  const pct = Math.round(utilization ?? 0);

  // Show nothing when session is at 0% — no badge clutter before any usage.
  if (pct === 0) {
    browserAPI.action.setBadgeText({ text: '' });
    return;
  }

  browserAPI.action.setBadgeText({ text: `${pct}%` });
  browserAPI.action.setBadgeBackgroundColor({
    color: pct >= 90 ? BADGE_COLOR.danger
         : pct >= 70 ? BADGE_COLOR.warning
         :             BADGE_COLOR.ok,
  });
}

// ─── Notification icon (generated at startup) ────────────────────────────────

let iconDataUrl = null;

async function buildIconDataUrl() {
  try {
    const size = 128;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Amber filled circle background
    ctx.fillStyle = '#d97706';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();

    // White clock ring
    const r = size * 0.28;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = size * 0.07;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    ctx.stroke();

    // Minute hand (12 o'clock)
    ctx.lineWidth = size * 0.065;
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2);
    ctx.lineTo(size / 2, size / 2 - r * 0.68);
    ctx.stroke();

    // Hour hand (3 o'clock-ish)
    ctx.lineWidth = size * 0.055;
    ctx.beginPath();
    ctx.moveTo(size / 2, size / 2);
    ctx.lineTo(size / 2 + r * 0.52, size / 2 + r * 0.3);
    ctx.stroke();

    // Center dot
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size * 0.055, 0, Math.PI * 2);
    ctx.fill();

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return 'data:image/png;base64,' + btoa(binary);
  } catch {
    return null;
  }
}

buildIconDataUrl().then((url) => { iconDataUrl = url; });

// ─── Notifications ───────────────────────────────────────────────────────────

function sendNotification(id, title, message, priority = 1) {
  const options = { type: 'basic', title, message, priority };
  if (iconDataUrl) options.iconUrl = iconDataUrl;
  browserAPI.notifications.create(`claude-usage-${id}`, options);
}

/** Formats a resets_at ISO string as "Xh Ym" for notification copy. */
function formatResetCountdown(isoString) {
  if (!isoString) return null;
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Fires notifications when crossing thresholds.
 * Tracks state keyed to `resets_at` so thresholds re-arm after each reset.
 */
async function maybeNotify(newData, prevData) {
  const newPct  = newData.five_hour?.utilization ?? 0;
  const prevPct = prevData?.five_hour?.utilization ?? 0;
  const newResets  = newData.five_hour?.resets_at  ?? null;
  const prevResets = prevData?.five_hour?.resets_at ?? null;

  const { notifState } = await browserAPI.storage.local.get('notifState');

  // Re-arm state whenever the window resets_at timestamp changes
  let state = notifState;
  if (!state || state.resets_at !== newResets) {
    state = { resets_at: newResets, warned80: false, warned90: false };
  }

  // Session reset: was meaningfully used, now back near zero in the same window
  if (prevPct > 5 && newPct < 5 && prevResets === newResets) {
    sendNotification('reset', '✅ Claude session reset', 'Full usage available — you\'re good to go!', 1);
    state = { resets_at: newResets, warned80: false, warned90: false };
  } else if (newPct >= 90 && !state.warned90) {
    state.warned90 = true;
    sendNotification('danger', '🔴 Claude session at 90%', 'Running low — use remaining messages wisely.', 2);
  } else if (newPct >= 80 && !state.warned80) {
    state.warned80 = true;
    const countdown = formatResetCountdown(newResets);
    const body = countdown
      ? `Resets in ${countdown}.`
      : 'Approaching the limit.';
    sendNotification('warning', '⚠️ Claude session at 80%', body, 1);
  }

  await browserAPI.storage.local.set({ notifState: state });
}

// ─── Shared data handler (used by both intercept and poller) ─────────────────

/**
 * @param {object} newData
 * @param {'intercept'|'poller'} source
 *   intercept — data came directly from the page's fetch; always trusted.
 *   poller    — data came from background service worker fetch; only applied
 *               when there is no existing data or resets_at changed (new window).
 *               This prevents the poller overwriting fresher intercept data with
 *               a stale cached response.
 */
async function applyUsageData(newData, source = 'poller') {
  const { usageData: prevData } = await browserAPI.storage.local.get('usageData');

  if (source === 'poller' && prevData) {
    const prevResets = prevData.five_hour?.resets_at ?? null;
    const newResets  = newData.five_hour?.resets_at  ?? null;
    // Only let the poller win when the session window has changed (or resets_at is absent on both)
    if (prevResets === newResets && prevResets !== null) return;
  }

  await browserAPI.storage.local.set({ usageData: newData, updatedAt: Date.now() });
  updateBadge(newData.five_hour?.utilization ?? 0);
  await maybeNotify(newData, prevData);
}

/** Reads stored utilization and refreshes the badge — keeps badge in sync even when no new data arrives. */
async function refreshBadgeFromStorage() {
  const { usageData } = await browserAPI.storage.local.get('usageData');
  updateBadge(usageData?.five_hour?.utilization ?? 0);
}

// ─── Companion app poller (localhost:3000) ────────────────────────────────────

const COMPANION_URL = 'http://localhost:3000';

/** fetch() with a manual AbortController timeout — avoids AbortSignal.timeout() edge cases. */
function timedFetch(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function pollCodeStats() {
  console.log('[ClaudeOrb extension] polling code stats...');
  try {
    const health = await timedFetch(`${COMPANION_URL}/health`, 2000);
    if (!health.ok) throw new Error('unhealthy');

    const res = await timedFetch(`${COMPANION_URL}/stats`, 4000);
    if (!res.ok) throw new Error(`stats ${res.status}`);

    const data = await res.json();
    if (data) {
      await browserAPI.storage.local.set({ codeStats: data, codeStatsAt: Date.now() });
    }

    // Also fetch trends data while companion is reachable
    try {
      const trendsRes = await timedFetch(`${COMPANION_URL}/trends`, 4000);
      if (trendsRes.ok) {
        const trendsData = await trendsRes.json();
        if (Array.isArray(trendsData)) {
          await browserAPI.storage.local.set({ trendsData, trendsAt: Date.now() });
        }
      }
    } catch { /* trends failure is non-fatal */ }

    try {
      const trends30Res = await timedFetch(`${COMPANION_URL}/trends/30`, 4000);
      if (trends30Res.ok) {
        const trendsData30 = await trends30Res.json();
        if (Array.isArray(trendsData30)) {
          await browserAPI.storage.local.set({ trendsData30, trends30At: Date.now() });
        }
      }
    } catch { /* trends/30 failure is non-fatal */ }
  } catch {
    // Companion not reachable — write null so popup shows the placeholder
    await browserAPI.storage.local.set({ codeStats: null, codeStatsAt: Date.now() });
  }
}

// ─── Active poller ────────────────────────────────────────────────────────────

const USAGE_URL    = 'https://claude.ai/api/usage';
const ALARM_NAME   = 'claude-usage-poll';
const POLL_MINUTES = 0.25; // every 15 seconds

async function pollUsage() {
  try {
    const response = await fetch(USAGE_URL, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!data || (data.five_hour === undefined && data.seven_day === undefined)) return;
    await applyUsageData(data, 'poller');
  } catch { /* service worker fetch failed — will retry on next alarm */ }
}

// Register periodic alarms (idempotent — won't duplicate if already registered)
browserAPI.alarms.create(ALARM_NAME,         { periodInMinutes: POLL_MINUTES });
browserAPI.alarms.create('code-stats-poll',  { periodInMinutes: 0.5 });
browserAPI.alarms.create('keepalive',        { periodInMinutes: 0.4 });
browserAPI.alarms.create('badge-refresh',    { periodInMinutes: 0.25 });

browserAPI.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME)        pollUsage();
  if (alarm.name === 'code-stats-poll') pollCodeStats();
  if (alarm.name === 'keepalive')       browserAPI.storage.local.get('usageData', () => {});
  if (alarm.name === 'badge-refresh')   refreshBadgeFromStorage();
});

// ─── Message listener (fetch intercept path + scrape results) ────────────────

browserAPI.runtime.onMessage.addListener((message) => {
  if (message.type === 'POLL_NOW') { pollCodeStats(); pollUsage(); return; }
  if (message.type !== 'USAGE_DATA' || !message.data) return;
  applyUsageData(message.data, 'intercept');
});

// ─── On popup connect: ask content script on any claude.ai tab to scrape ─────

browserAPI.runtime.onConnect.addListener((port) => {
  if (port.name !== 'popup') return;
  browserAPI.tabs.query({ url: 'https://claude.ai/*' }, (tabs) => {
    tabs.forEach((tab) => {
      browserAPI.tabs.sendMessage(tab.id, { type: 'SCRAPE_NOW' }).catch(() => {});
    });
  });
});

// ─── Startup: restore badge + immediate poll ──────────────────────────────────

browserAPI.storage.local.get('usageData', ({ usageData }) => {
  updateBadge(usageData?.five_hour?.utilization ?? 0);
});

browserAPI.runtime.onStartup.addListener(() => {
  pollUsage();
  pollCodeStats();
});

// Poll immediately so the first read is fresh rather than waiting up to 60 s
pollUsage();
pollCodeStats();

// Companion stats also polled via alarm above ('code-stats-poll', every 1 min)
