/**
 * Runs in the ISOLATED world. Listens for the custom event dispatched
 * by inject.js and forwards the usage data to the background service
 * worker via the WebExtensions runtime API.
 *
 * Compatible with Chrome, Firefox (≥ 128) and Edge.
 */

// Unified API surface: Firefox exposes `browser`, Chrome/Edge expose `chrome`.
const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

window.addEventListener('__claude_usage_update__', (event) => {
  try {
    const data = JSON.parse(event.detail);
    browserAPI.runtime.sendMessage({ type: 'USAGE_DATA', data });
  } catch (_) {}
});

// ─── DOM scraper (fallback for all claude.ai pages) ──────────────────────────

function startScrapePolling() {
  let attempts = 0;
  const scrapeInterval = setInterval(() => {
    attempts++;
    const text = document.body.innerText;
    const sessionMatch = text.match(/(\d+)%\s*used[\s\S]*?Resets in/);
    const weeklyMatch  = text.match(/All models[\s\S]*?(\d+)%\s*used/);

    if (sessionMatch && weeklyMatch) {
      browserAPI.runtime.sendMessage({
        type: 'USAGE_DATA',
        data: {
          five_hour: { utilization: parseInt(sessionMatch[1], 10) },
          seven_day:  { utilization: parseInt(weeklyMatch[1],  10) },
        },
      });
      clearInterval(scrapeInterval);
    }

    if (attempts >= 5) clearInterval(scrapeInterval);
  }, 3000);
}

startScrapePolling();

// Ongoing 30s fallback scrape — keeps data fresh without relying solely on fetch intercept
setInterval(() => {
  const text = document.body.innerText;
  const sessionMatch = text.match(/Current session[\s\S]{0,50}?(\d+)%\s*used/);
  const weeklyMatch  = text.match(/All models[\s\S]{0,50}?(\d+)%\s*used/);
  if (sessionMatch && weeklyMatch) {
    browserAPI.runtime.sendMessage({
      type: 'USAGE_DATA',
      data: {
        five_hour: { utilization: parseInt(sessionMatch[1], 10) },
        seven_day:  { utilization: parseInt(weeklyMatch[1],  10) },
      },
    });
  }
}, 30_000);

// Re-scrape on demand when popup opens (via SCRAPE_NOW from background.js)
browserAPI.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCRAPE_NOW') startScrapePolling();
});
