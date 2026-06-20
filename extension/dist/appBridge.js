"use strict";
(() => {
  // src/appBridge.ts
  var APP_TYPES = /* @__PURE__ */ new Set(["ping", "open", "snapshot", "execute", "focus", "highlight", "close"]);
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "wayfinder-app" || typeof data.id !== "string") return;
    if (!APP_TYPES.has(data.type)) return;
    const reply = (resp) => window.postMessage({ source: "wayfinder-ext", id: data.id, ...resp }, window.location.origin);
    try {
      chrome.runtime.sendMessage({ type: `agent-${data.type}`, payload: data.payload }, (resp) => {
        if (chrome.runtime.lastError) {
          reply({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        reply(resp ?? { ok: false, error: "no response" });
      });
    } catch (e) {
      reply({ ok: false, error: String(e).slice(0, 120) });
    }
  });
  window.postMessage({ source: "wayfinder-ext", type: "ready" }, window.location.origin);
})();
