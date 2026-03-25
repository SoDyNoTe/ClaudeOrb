'use strict';
const { ipcRenderer } = require('electron');

// Patch fetch to intercept /usage API responses
const origFetch = window.fetch.bind(window);
window.fetch = async function (...args) {
  let url = '';
  if (typeof args[0] === 'string') url = args[0];
  else if (args[0] && typeof args[0].url === 'string') url = args[0].url;

  const response = await origFetch(...args);

  if (url.includes('/usage')) {
    try {
      const data = await response.clone().json();
      if (data && (data.five_hour !== undefined || data.seven_day !== undefined)) {
        ipcRenderer.send('usage-intercepted', { url, data });
      }
    } catch { /* ignore parse errors */ }
  }

  return response;
};

// Patch XHR too
const origOpen = XMLHttpRequest.prototype.open;
const origSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this._claudeUrl = url;
  return origOpen.call(this, method, url, ...rest);
};

XMLHttpRequest.prototype.send = function (...args) {
  this.addEventListener('load', function () {
    if (this._claudeUrl && String(this._claudeUrl).includes('/usage')) {
      try {
        const data = JSON.parse(this.responseText);
        if (data && (data.five_hour !== undefined || data.seven_day !== undefined)) {
          ipcRenderer.send('usage-intercepted', { url: this._claudeUrl, data });
        }
      } catch { /* ignore */ }
    }
  });
  return origSend.apply(this, args);
};
