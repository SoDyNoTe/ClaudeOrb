/**
 * Popup controller — Usage, Code, Trends, Minimal tabs.
 * Compatible with Chrome, Firefox (≥ 128) and Edge.
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// ─── State ───────────────────────────────────────────────────────────────────

let currentData     = null;
let currentTab      = 'usage';
let minimalFocus    = 'session';   // 'session' | 'weekly'
let lastUpdatedAt   = null;
let lastCodeStatsAt = null;
let lastTrendsAt    = null;
let lastTrends30At  = null;
let trendsRange     = '7d';   // '7d' | '30d'

// r=35 → circumference = 2π×35 ≈ 219.91
const CIRC = 219.91;

const TABS = ['usage', 'code', 'trends', 'minimal'];

// ─── Color helpers ────────────────────────────────────────────────────────────

function accentColor(pct) {
  if (pct >= 90) return '#ff3b30';
  if (pct >= 70) return '#ff9500';
  return '#00c48c';
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function countdown(isoString, showSeconds = true) {
  if (!isoString) return '—';
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'resetting…';

  const s   = Math.floor(ms / 1000);
  const d   = Math.floor(s / 86400);
  const h   = Math.floor((s % 86400) / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p   = (n) => String(n).padStart(2, '0');

  if (d > 0) return `${d}d ${h}h ${p(m)}m`;
  if (h > 0) return showSeconds ? `${h}h ${p(m)}m ${p(sec)}s` : `${h}h ${p(m)}m`;
  return showSeconds ? `${p(m)}m ${p(sec)}s` : `${p(m)}m`;
}

function ageLabel(ts) {
  if (!ts) return 'Waiting for data…';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 10)  return 'Updated just now';
  if (sec < 60)  return `Updated ${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)  return `Updated ${min}m ago`;
  return `Updated ${Math.floor(min / 60)}h ago`;
}

function fmtPct(n)  { return `${Math.round(n)}%`; }
function fmtRem(n)  { return `${Math.round(100 - n)}%`; }
function fmtNum(n)  { return Number(n).toLocaleString(); }
function fmtCost(n) { return `$${Number(n).toFixed(2)}`; }

/** claude-sonnet-4-6 → Sonnet,  claude-opus-4-6 → Opus,  etc. */
function fmtModel(raw) {
  if (!raw) return '—';
  const m = String(raw).match(/claude[-_]?(\w+?)[-_\d]/i);
  if (!m) return raw;
  return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
}

function fmtStreak(days) {
  if (days == null) return '—';
  return `${days} day${days === 1 ? '' : 's'}`;
}

// ─── Companion app (reads from storage, populated by background.js) ──────────

function setCodeVal(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setCodePlaceholder(visible) {
  const banner = document.querySelector('#tab-code .placeholder-banner');
  if (banner) banner.style.display = visible ? '' : 'none';
}

function renderCodeStats(s) {
  const t = s.today ?? {};
  const w = s.week  ?? {};
  setCodeVal('code-tokens-today', t.tokens   != null ? fmtNum(t.tokens)   : '—');
  setCodeVal('code-cost-today',   t.cost     != null ? fmtCost(t.cost)    : '—');
  setCodeVal('code-lines-today',  t.lines    != null ? fmtNum(t.lines)    : '—');
  setCodeVal('code-files-today',  t.files    != null ? fmtNum(t.files)    : '—');
  setCodeVal('code-tokens-week',  w.tokens   != null ? fmtNum(w.tokens)   : '—');
  setCodeVal('code-cost-week',    w.cost     != null ? fmtCost(w.cost)    : '—');
  setCodeVal('code-top-model',    fmtModel(t.topModel));
  setCodeVal('code-streak',       fmtStreak(w.streak));
}

/** Apply code stats from storage — shows placeholder when companion is offline (codeStats is null). */
function applyCodeStats(codeStats) {
  if (codeStats) {
    renderCodeStats(codeStats);
    setCodePlaceholder(false);
  } else {
    setCodePlaceholder(true);
  }
}

// ─── Extra Usage collapsible ─────────────────────────────────────────────────

function renderExtraUsage(extra) {
  const card = document.getElementById('extra-usage-card');
  if (!card) return;

  if (!extra || !extra.is_enabled) {
    card.style.display = 'none';
    return;
  }

  card.style.display = '';

  const barTrack = document.getElementById('extra-bar-track');
  const bar      = document.getElementById('extra-bar');
  const spentEl  = document.getElementById('extra-spent');
  const limitEl  = document.getElementById('extra-limit');
  const resetsEl = document.getElementById('extra-resets');

  // API returns values in cents — convert to euros
  const spent = (extra.used_credits ?? 0) / 100;
  const limit = extra.monthly_limit != null ? extra.monthly_limit / 100 : null;

  if (limit != null) {
    // Limited mode — progress bar + spent / limit / resets
    if (barTrack) barTrack.style.display = '';
    const pct = Math.min((spent / limit) * 100, 100);
    if (bar) bar.style.width = `${pct}%`;
    if (spentEl) { spentEl.textContent = `€${spent.toFixed(2)} spent`; spentEl.style.color = '#ff9500'; }
    if (limitEl) { limitEl.style.display = ''; limitEl.textContent = `€${limit.toFixed(2)} limit`; }
    if (resetsEl && extra.resets_at) {
      const d = new Date(extra.resets_at);
      resetsEl.textContent = `Resets ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      resetsEl.style.color = '#555';
    }
  } else {
    // Unlimited mode — no bar, green status, credits used
    if (barTrack) barTrack.style.display = 'none';
    if (spentEl) { spentEl.textContent = `Credits used: €${spent.toFixed(2)}`; spentEl.style.color = '#ffffff'; }
    if (limitEl) limitEl.style.display = 'none';
    if (resetsEl) { resetsEl.textContent = 'Status: Unlimited ✓'; resetsEl.style.color = '#00c48c'; }
  }
}

async function initExtraToggle() {
  const { extraExpanded } = await browserAPI.storage.local.get('extraExpanded');
  const body    = document.getElementById('extra-body');
  const chevron = document.getElementById('extra-chevron');

  if (extraExpanded) {
    body?.classList.add('open');
    chevron?.classList.add('open');
  }

  document.getElementById('extra-toggle')?.addEventListener('click', async () => {
    const isOpen = body?.classList.toggle('open');
    chevron?.classList.toggle('open', isOpen);
    await browserAPI.storage.local.set({ extraExpanded: isOpen });
  });
}

// ─── Trends tab ───────────────────────────────────────────────────────────────

function setTrendsPlaceholder(visible) {
  const banner = document.querySelector('#tab-trends .placeholder-banner');
  if (banner) banner.style.display = visible ? '' : 'none';
  const card = document.getElementById('trends-chart-card');
  if (card) card.style.display = visible ? 'none' : '';
}

function renderTrends(data, compact = false) {
  if (!Array.isArray(data) || data.length === 0) return;

  const barChart  = document.getElementById('trends-bar-chart');
  const barLabels = document.getElementById('trends-bar-labels');
  if (!barChart || !barLabels) return;

  barChart.classList.toggle('compact', compact);
  barLabels.classList.toggle('compact', compact);

  // Update subtitle
  const titleEl = document.querySelector('#trends-chart-card .chart-title');
  if (titleEl) titleEl.textContent = compact ? 'Token usage · last 30 days' : 'Token usage · last 7 days';

  const todayDay  = new Date().toLocaleDateString('en-US', { weekday: 'short' });
  const maxTokens = Math.max(...data.map(d => d.tokens ?? 0), 1);

  barChart.innerHTML  = '';
  barLabels.innerHTML = '';

  // Shared tooltip element for compact (30D) mode
  let tooltip = null;
  if (compact) {
    tooltip = document.createElement('div');
    tooltip.className = 'bar-tooltip';
    barChart.appendChild(tooltip);
  }

  data.forEach((entry, i) => {
    const heightPct = Math.max(((entry.tokens ?? 0) / maxTokens) * 100, 4);
    const isToday   = !compact && entry.day === todayDay;
    const barColor  = isToday ? '#ffffff' : '#ff9500';

    const col = document.createElement('div');
    col.className = 'bar-col';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height     = `${heightPct}%`;
    bar.style.background = barColor;

    if (compact && tooltip && entry.date) {
      const d   = new Date(entry.date);
      const mon = d.toLocaleDateString('en-US', { month: 'short' });
      const tipText = `${mon} ${d.getDate()} · ${fmtCost(entry.cost ?? 0)}`;
      col.addEventListener('mouseenter', () => {
        tooltip.textContent = tipText;
        // Position: centre of this col relative to barChart
        const colRect   = col.getBoundingClientRect();
        const chartRect = barChart.getBoundingClientRect();
        tooltip.style.left = `${colRect.left - chartRect.left + colRect.width / 2}px`;
        tooltip.classList.add('visible');
      });
      col.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
    }

    col.appendChild(bar);
    barChart.appendChild(col);

    const label = document.createElement('div');
    label.className   = 'bar-day';
    label.style.color = '#ffffff';
    label.style.fontSize = '9px';
    if (compact) {
      // Label only on every 7th bar (indices 0, 7, 14, 21, 28); others blank
      if (i % 7 === 0 && entry.date) {
        const d = new Date(entry.date);
        const mon = d.toLocaleDateString('en-US', { month: 'short' });
        label.textContent = `${mon} ${d.getDate()}`;
      }
    } else {
      label.innerHTML = `${entry.day}<span class="bar-cost" style="color:#ff9500">${fmtCost(entry.cost ?? 0)}</span>`;
    }
    barLabels.appendChild(label);
  });
}

function applyTrendsRange(range, trendsData, trendsData30) {
  trendsRange = range;
  document.getElementById('trends-btn-7d')?.classList.toggle('active',  range === '7d');
  document.getElementById('trends-btn-30d')?.classList.toggle('active', range === '30d');

  const loadingEl = document.getElementById('trends-loading');

  // Banner only shows when the companion isn't running (no 7D data at all)
  if (!trendsData) {
    setTrendsPlaceholder(true);
    if (loadingEl) loadingEl.style.display = 'none';
    return;
  }

  setTrendsPlaceholder(false);

  if (range === '30d' && !trendsData30) {
    // 30D not yet fetched — show 7D as fallback with a subtle loading note
    if (loadingEl) loadingEl.style.display = '';
    renderTrends(trendsData, false);
  } else {
    if (loadingEl) loadingEl.style.display = 'none';
    const data = range === '30d' ? trendsData30 : trendsData;
    renderTrends(data, range === '30d');
  }
}

function initTrendsToggle() {
  document.getElementById('trends-btn-7d')?.addEventListener('click', async () => {
    if (trendsRange === '7d') return;
    const { trendsData, trendsData30 } = await browserAPI.storage.local.get(['trendsData', 'trendsData30']);
    applyTrendsRange('7d', trendsData ?? null, trendsData30 ?? null);
  });
  document.getElementById('trends-btn-30d')?.addEventListener('click', async () => {
    if (trendsRange === '30d') return;
    const { trendsData, trendsData30 } = await browserAPI.storage.local.get(['trendsData', 'trendsData30']);
    applyTrendsRange('30d', trendsData ?? null, trendsData30 ?? null);
  });
}

// ─── Animation ────────────────────────────────────────────────────────────────

function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

function countUp(el, target, ms, suffix = '%') {
  if (!el) return;
  const start = Date.now();
  function tick() {
    const p = Math.min((Date.now() - start) / ms, 1);
    el.textContent = `${Math.round(easeOut(p) * target)}${suffix}`;
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function animateRing(ringEl, pct, delay = 0) {
  setTimeout(() => {
    ringEl.style.strokeDashoffset = CIRC * (1 - Math.min(pct, 100) / 100);
  }, delay);
}

// ─── Ring: update without animation (for polling refreshes) ───────────────────

function applyRing(id, pct) {
  const ring  = document.getElementById(`ring-${id}`);
  const pctEl = document.getElementById(`pct-${id}`);
  if (!ring || !pctEl) return;

  const color = accentColor(pct);
  ring.style.stroke        = color;
  ring.style.strokeDashoffset = CIRC * (1 - Math.min(pct, 100) / 100);
  pctEl.textContent        = fmtPct(pct);
  pctEl.style.color        = color;
}

// ─── Render: Usage tab ────────────────────────────────────────────────────────

function renderUsage(data, animate) {
  const session = data.five_hour ?? { utilization: 0, resets_at: null };
  const weekly  = data.seven_day ?? { utilization: 0, resets_at: null };

  renderRingCard('session', session.utilization, animate, 0);
  renderRingCard('weekly',  weekly.utilization,  animate, 140);
}

function renderRingCard(id, utilization, animate, delay) {
  const pct   = Math.round(utilization);
  const color = accentColor(pct);
  const ring  = document.getElementById(`ring-${id}`);
  const pctEl = document.getElementById(`pct-${id}`);
  const barEl = document.getElementById(`bar-${id}`);
  const usedEl      = document.getElementById(`used-${id}`);
  const remainingEl = document.getElementById(`remaining-${id}`);

  if (!ring || !pctEl) return;

  ring.style.stroke = color;
  pctEl.style.color = color === '#00c48c' ? '#e5e5e5' : color; // keep green rings neutral on text

  if (animate) {
    // Ring animates via CSS transition after small delay
    pctEl.textContent = '0%';
    countUp(pctEl, pct, 900);
    animateRing(ring, pct, delay);
  } else {
    applyRing(id, pct);
  }

  // Sidebar stats
  if (barEl) {
    barEl.style.width      = `${Math.min(pct, 100)}%`;
    barEl.style.background = color;
  }
  if (usedEl)      usedEl.textContent      = pct === 0 ? '—' : fmtPct(pct);
  if (remainingEl) remainingEl.textContent = pct === 0 ? '—' : fmtRem(pct);

  // Session-specific inactive state
  if (id === 'session') {
    const countdownEl = document.getElementById('countdown-session');
    if (countdownEl) {
      countdownEl.style.display = pct === 0 ? 'none' : '';
    }
    const usedRowEl      = usedEl?.closest('.ring-stat');
    const remainingRowEl = remainingEl?.closest('.ring-stat');
    const barTrackEl     = barEl?.parentElement;
    [usedRowEl, remainingRowEl, barTrackEl].forEach(el => {
      if (el) el.style.display = pct === 0 ? 'none' : '';
    });

    // "No active session" label injected only for session card
    let inactiveEl = document.getElementById('inactive-session');
    if (pct === 0) {
      if (!inactiveEl) {
        inactiveEl = document.createElement('div');
        inactiveEl.id = 'inactive-session';
        inactiveEl.className = 'ring-inactive';
        inactiveEl.textContent = 'No active session';
        document.getElementById('info-session')?.appendChild(inactiveEl);
      }
      inactiveEl.style.display = '';
    } else if (inactiveEl) {
      inactiveEl.style.display = 'none';
    }
  }
}

// ─── Render: Minimal tab ─────────────────────────────────────────────────────

function renderMinimal() {
  const entry   = minimalFocus === 'session'
    ? (currentData?.five_hour ?? { utilization: 0, resets_at: null })
    : (currentData?.seven_day  ?? { utilization: 0, resets_at: null });
  const pct     = Math.round(entry.utilization);
  const color   = accentColor(pct);

  const labelEl  = document.getElementById('minimal-label');
  const numEl    = document.getElementById('minimal-number');
  const barEl    = document.getElementById('minimal-bar');

  if (labelEl) labelEl.textContent = minimalFocus === 'session' ? 'SESSION · 5-HOUR' : 'WEEKLY · 7-DAY';

  if (numEl) {
    numEl.textContent = pct === 0 ? '—' : `${pct}%`;
    numEl.style.color = pct === 0 ? '#2e2e2e' : '#f0f0f0';
  }

  if (barEl) {
    barEl.style.width      = `${Math.min(pct, 100)}%`;
    barEl.style.background = pct === 0 ? '#2a2a2a' : color;
  }
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function renderEmptyUsage() {
  // Insert empty state before the extra-usage card rather than replacing all children,
  // so the extra-usage card DOM node is preserved for when data arrives.
  const wrap = document.querySelector('#tab-usage .usage-content');
  if (!wrap) return;

  // Remove any existing ring cards but leave #extra-usage-card intact
  Array.from(wrap.children).forEach(child => {
    if (child.id !== 'extra-usage-card') child.remove();
  });

  const empty = document.createElement('div');
  empty.id = 'empty-usage';
  empty.style.cssText = 'padding:32px 0 24px;text-align:center';
  empty.innerHTML = `
    <div style="font-size:30px;color:#3a3a3a;margin-bottom:12px">◌</div>
    <div style="font-size:13px;font-weight:600;color:#aaaaaa;margin-bottom:6px">No data yet</div>
    <div style="font-size:11.5px;color:#666666;line-height:1.65;margin-bottom:14px">
      Keep claude.ai/settings/usage open in a tab to track your usage.
    </div>
    <button id="open-usage-btn"
      style="background:#d97706;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;letter-spacing:0.02em">
      Open Usage Page
    </button>
  `;
  empty.querySelector('#open-usage-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://claude.ai/settings/usage' });
  });
  wrap.insertBefore(empty, document.getElementById('extra-usage-card'));
}

// ─── Countdown tick (every second) ───────────────────────────────────────────

function tickTimers() {
  if (!currentData) return;

  const sResets = currentData.five_hour?.resets_at ?? null;
  const wResets = currentData.seven_day?.resets_at  ?? null;

  const el = (id) => document.getElementById(id);

  const st = el('timer-session');
  if (st && sResets) st.textContent = countdown(sResets);

  const wt = el('timer-weekly');
  if (wt && wResets) wt.textContent = countdown(wResets, false);

  const mt = el('minimal-timer');
  if (mt) {
    const resets = minimalFocus === 'session' ? sResets : wResets;
    mt.textContent = countdown(resets, minimalFocus === 'session');
  }
}

// ─── Footer ───────────────────────────────────────────────────────────────────

function refreshFooter() {
  const ts  = document.getElementById('footer-ts');
  const dot = document.getElementById('dot');
  if (!ts || !dot) return;

  ts.textContent = ageLabel(lastUpdatedAt);

  if (!lastUpdatedAt) {
    dot.className = 'dot empty';
    ts.className  = 'footer-ts';
    return;
  }

  const age = Date.now() - lastUpdatedAt;
  if (age > 3 * 60_000) {   // > 3 min → red
    dot.className = 'dot stale';
    ts.className  = 'footer-ts ts-stale';
  } else if (age > 90_000) { // 90 s – 3 min → amber
    dot.className = 'dot warn';
    ts.className  = 'footer-ts ts-warn';
  } else {                   // < 90 s → green
    dot.className = 'dot';
    ts.className  = 'footer-ts';
  }
}

// ─── Tab switching ────────────────────────────────────────────────────────────

async function switchTab(tabId) {
  if (tabId === currentTab) return;

  const prev = currentTab;
  currentTab = tabId;

  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tabId));

  const prevPanel = document.getElementById(`tab-${prev}`);
  const nextPanel = document.getElementById(`tab-${tabId}`);

  if (prevPanel) prevPanel.classList.remove('visible');

  setTimeout(() => {
    if (prevPanel) prevPanel.classList.remove('active');
    if (nextPanel) nextPanel.classList.add('active');
    // Two rAF passes ensure display:block is painted before opacity transition starts
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (nextPanel) nextPanel.classList.add('visible');
    }));
    if (tabId === 'minimal' && currentData) renderMinimal();
  }, 300);

  await browserAPI.storage.local.set({ lastTab: tabId });
}

// ─── Swipe gesture ────────────────────────────────────────────────────────────

let touchStartX = 0;

document.addEventListener('touchstart', (e) => {
  touchStartX = e.touches[0].clientX;
}, { passive: true });

document.addEventListener('touchend', (e) => {
  const dx  = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) < 48) return;
  const idx = TABS.indexOf(currentTab);
  if (dx < 0 && idx < TABS.length - 1) switchTab(TABS[idx + 1]);
  if (dx > 0 && idx > 0)               switchTab(TABS[idx - 1]);
}, { passive: true });

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Signal background to ask any open claude.ai tab to scrape the page now
  browserAPI.runtime.connect({ name: 'popup' });
  // Trigger immediate poll so Code/Trends data is fresh without waiting for alarm
  browserAPI.runtime.sendMessage({ type: 'POLL_NOW' }).catch(() => {});

  const { usageData, updatedAt, lastTab, codeStats, codeStatsAt, trendsData, trendsAt, trendsData30, trends30At } =
    await browserAPI.storage.local.get(['usageData', 'updatedAt', 'lastTab', 'codeStats', 'codeStatsAt', 'trendsData', 'trendsAt', 'trendsData30', 'trends30At']);

  lastUpdatedAt   = updatedAt   ?? null;
  lastCodeStatsAt = codeStatsAt ?? null;
  lastTrendsAt    = trendsAt    ?? null;
  lastTrends30At  = trends30At  ?? null;

  // Restore last active tab
  const startTab = lastTab && TABS.includes(lastTab) ? lastTab : 'usage';
  if (startTab !== 'usage') {
    currentTab = startTab;
    document.querySelectorAll('.tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === startTab));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(`tab-${startTab}`);
    if (target) target.classList.add('active');
    requestAnimationFrame(() => requestAnimationFrame(() => target?.classList.add('visible')));
  } else {
    // Fade in usage tab
    const usagePanel = document.getElementById('tab-usage');
    requestAnimationFrame(() => requestAnimationFrame(() => usagePanel?.classList.add('visible')));
  }

  if (usageData) {
    currentData = usageData;
    renderUsage(usageData, /* animate */ true);
    if (startTab === 'minimal') renderMinimal();
    tickTimers();
  } else {
    renderEmptyUsage();
  }

  refreshFooter();

  // Extra usage (may be null if claude.ai doesn't send it)
  renderExtraUsage(usageData?.extra_usage ?? null);
  initExtraToggle();

  // Apply companion stats already in storage (background.js keeps this fresh)
  applyCodeStats(codeStats ?? null);

  // Apply trends data if available
  applyTrendsRange(trendsRange, trendsData ?? null, trendsData30 ?? null);
  initTrendsToggle();

  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn =>
    btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  // Minimal: tap to toggle session ↔ weekly
  document.getElementById('minimal-card')?.addEventListener('click', () => {
    minimalFocus = minimalFocus === 'session' ? 'weekly' : 'session';
    renderMinimal();
    tickTimers();
  });
}

// ─── Detached window mode ─────────────────────────────────────────────────────

const isDetached = new URLSearchParams(window.location.search).get('detached') === 'true';

if (isDetached) {
  document.body.classList.add('detached');
  document.getElementById('drag-close-btn')?.addEventListener('click', () => window.close());

  function resizeToContent() {
    requestAnimationFrame(() => {
      chrome.windows.getCurrent(win => {
        chrome.windows.update(win.id, { height: document.body.scrollHeight + 28 });
      });
    });
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', resizeToContent);
  });

  resizeToContent();
} else {
  document.getElementById('popout-btn')?.addEventListener('click', () => {
    const bodyH = document.body.scrollHeight;
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?detached=true'),
      type: 'popup',
      width: 380,
      height: bodyH + 28,
      focused: true,
    });
  });
}

// Download buttons — window.open blocked in MV3 popups, use tabs.create instead
document.querySelectorAll('#dl-btn-code, #dl-btn-trends').forEach(btn => {
  btn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://github.com/SoDyNoTe/claude-companion/releases/download/v1.0.0/ClaudeOrb-1.0.0-arm64.dmg' });
  });
});

(async () => {
  try {
    await init();
  } catch (err) {
    document.body.innerHTML = '<div style="padding:20px;color:#ff3b30;font-size:12px;">Error: ' + err.message + '</div>';
  }
})();

// Countdown — every second
setInterval(tickTimers, 1000);

// Footer age label — every 15 s
setInterval(refreshFooter, 15_000);

// Poll storage every 5 s — picks up both usage updates (from background poller)
// and code stats updates (from the companion app poller in background.js)
setInterval(async () => {
  const { usageData, updatedAt, codeStats, codeStatsAt, trendsData, trendsAt, trendsData30, trends30At } =
    await browserAPI.storage.local.get(['usageData', 'updatedAt', 'codeStats', 'codeStatsAt', 'trendsData', 'trendsAt', 'trendsData30', 'trends30At']);

  if (usageData && updatedAt !== lastUpdatedAt) {
    lastUpdatedAt = updatedAt;
    currentData   = usageData;
    renderUsage(usageData, /* animate */ false);
    renderExtraUsage(usageData.extra_usage ?? null);
    if (currentTab === 'minimal') renderMinimal();
    tickTimers();
    refreshFooter();
  }

  if (codeStatsAt !== lastCodeStatsAt) {
    lastCodeStatsAt = codeStatsAt ?? null;
    applyCodeStats(codeStats ?? null);
  }

  const trendsChanged = trendsAt !== lastTrendsAt || trends30At !== lastTrends30At;
  if (trendsChanged) {
    lastTrendsAt   = trendsAt   ?? null;
    lastTrends30At = trends30At ?? null;
    applyTrendsRange(trendsRange, trendsData ?? null, trendsData30 ?? null);
  }
}, 5_000);
