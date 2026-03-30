/**
 * Runs in the page's MAIN world so it can override window.fetch and XHR.
 * Intercepts responses from URLs containing "/usage" and dispatches
 * a custom event so the ISOLATED-world content.js can forward the
 * data to the extension via the WebExtensions runtime API.
 */
(function () {
  function dispatch(data) {
    window.dispatchEvent(
      new CustomEvent('__claude_usage_update__', {
        detail: JSON.stringify(data),
      })
    );
  }

  // ─── fetch intercept ───────────────────────────────────────────────────────

  const _fetch = window.fetch;

  window.fetch = async function (...args) {
    const input = args[0];
    const url = input instanceof Request ? input.url : String(input);
    const response = await _fetch.apply(this, args);

    if (url.includes('/usage')) {
      response
        .clone()
        .json()
        .then((data) => {
          if (data && (data.five_hour !== undefined || data.seven_day !== undefined)) {
            dispatch(data);
          }
        })
        .catch(() => {});
    }

    return response;
  };

  // ─── XHR intercept ────────────────────────────────────────────────────────

  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      if (this._url && this._url.includes('/usage')) {
        try {
          const data = JSON.parse(this.responseText);
          if (data && (data.five_hour !== undefined || data.seven_day !== undefined)) {
            dispatch(data);
          }
        } catch {}
      }
    });
    return _send.apply(this, arguments);
  };
})();
