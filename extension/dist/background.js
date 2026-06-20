// src/background.ts
var DEFAULT_ORIGIN = "https://wayfinder.app";
async function getOrigin() {
  const { wf_origin } = await chrome.storage.local.get("wf_origin");
  return typeof wf_origin === "string" && wf_origin || DEFAULT_ORIGIN;
}
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "exchange-code") {
    void exchangeCode(msg.code).then(sendResponse);
    return true;
  }
  if (msg.type === "get-profile-values") {
    void getProfileValues().then(sendResponse);
    return true;
  }
  if (msg.type === "fill-fields") {
    void fillCurrentTab(msg.values).then(sendResponse);
    return true;
  }
  if (msg.type === "get-pairing-status") {
    void getPairingStatus().then(sendResponse);
    return true;
  }
  if (msg.type === "disconnect") {
    void chrome.storage.local.remove(["wf_token", "wf_paired_at"]).then(
      () => sendResponse({ ok: true })
    );
    return true;
  }
  if (typeof msg.type === "string" && msg.type.startsWith("agent-")) {
    void handleAgent(msg.type, msg.payload).then(sendResponse);
    return true;
  }
});
async function getPortalTab() {
  const { wf_portal_tab } = await chrome.storage.session.get("wf_portal_tab");
  return typeof wf_portal_tab === "number" ? wf_portal_tab : void 0;
}
async function setPortalTab(id) {
  if (id === void 0) await chrome.storage.session.remove("wf_portal_tab");
  else await chrome.storage.session.set({ wf_portal_tab: id });
}
async function sendToPortal(tabId, message, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, message);
      if (resp) return resp;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error("The portal page isn't responding. Make sure it finished loading.");
}
async function handleAgent(type, payload) {
  try {
    if (type === "agent-ping") return { ok: true };
    if (type === "agent-open") {
      const url = payload?.url;
      if (!url || !/^https?:\/\//.test(url)) return { ok: false, error: "Invalid portal URL." };
      const tab = await chrome.tabs.create({ url, active: true });
      await setPortalTab(tab.id);
      if (tab.id !== void 0) {
        try {
          await sendToPortal(tab.id, { type: "wf-ping" });
        } catch {
        }
      }
      return { ok: true, result: { tabId: tab.id } };
    }
    const tabId = await getPortalTab();
    if (tabId === void 0) return { ok: false, error: "No portal is open yet." };
    if (type === "agent-snapshot") {
      const resp = await sendToPortal(tabId, { type: "wf-snapshot" });
      return { ok: true, result: resp.snapshot };
    }
    if (type === "agent-execute") {
      const actions = payload?.actions ?? [];
      const resp = await sendToPortal(tabId, { type: "wf-execute", actions });
      return { ok: true, result: resp.results };
    }
    if (type === "agent-focus") {
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    if (type === "agent-highlight") {
      const ref = payload?.ref;
      await sendToPortal(tabId, { type: "wf-highlight", ref });
      return { ok: true };
    }
    if (type === "agent-close") {
      await setPortalTab(void 0);
      return { ok: true };
    }
    return { ok: false, error: `Unknown agent action: ${type}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
chrome.tabs.onRemoved.addListener((tabId) => {
  void getPortalTab().then((p) => {
    if (p === tabId) void setPortalTab(void 0);
  });
});
async function exchangeCode(code) {
  try {
    const res = await fetch(`${await getOrigin()}/api/extension/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (!res.ok || !data.token) {
      return { ok: false, error: data.error ?? "Exchange failed" };
    }
    await chrome.storage.local.set({ wf_token: data.token, wf_paired_at: Date.now() });
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}
async function getPairingStatus() {
  const stored = await chrome.storage.local.get(["wf_token", "wf_paired_at"]);
  return { paired: !!stored.wf_token, pairedAt: stored.wf_paired_at };
}
async function getProfileValues() {
  const stored = await chrome.storage.local.get("wf_token");
  const token = stored.wf_token;
  if (!token) return { ok: false, error: "Not paired. Please connect in the extension popup." };
  try {
    const res = await fetch(`${await getOrigin()}/api/extension/profile-values`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 401) await chrome.storage.local.remove("wf_token");
      return { ok: false, error: data.error ?? "Failed to load profile" };
    }
    return { ok: true, values: data.values };
  } catch {
    return { ok: false, error: "Network error" };
  }
}
async function fillCurrentTab(values) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab" };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillFields,
      args: [values]
    });
    const filled = results[0]?.result ?? 0;
    return { ok: true, filled };
  } catch {
    return { ok: false, error: "Could not access this page. Check extension permissions." };
  }
}
function fillFields(values) {
  const SENSITIVE_RE = /ssn|social.?security|alien|a-?number|a\s*#|a#|uscis|account|routing|\bcard\b|passport|i-?94\s*number|receipt.?number|bank/i;
  let filled = 0;
  const inputs = document.querySelectorAll(
    "input[type=text], input[type=email], input[type=tel], input[type=date], input:not([type]), textarea"
  );
  for (const input of inputs) {
    const label = [
      input.getAttribute("aria-label"),
      input.getAttribute("placeholder"),
      input.id ? document.querySelector(`label[for="${input.id}"]`)?.textContent : null,
      input.getAttribute("name")
    ].filter(Boolean).join(" ").toLowerCase();
    if (!label || SENSITIVE_RE.test(label)) continue;
    if (input.value) continue;
    for (const [, value] of Object.entries(values)) {
      if (!value) continue;
      const firstName = /first.?name|given.?name|forename/i.test(label);
      const lastName = /last.?name|family.?name|surname/i.test(label);
      const dob = /birth|dob|date.?of.?birth/i.test(label);
      const city = /city|municipality/i.test(label);
      const state = /\bstate\b/i.test(label);
      const zip = /zip|postal/i.test(label);
      const phone = /phone|telephone|mobile/i.test(label);
      const country = /country.?of.?birth|birthplace/i.test(label);
      const profileValues = values;
      let match;
      if (firstName) match = profileValues.firstName;
      else if (lastName) match = profileValues.lastName;
      else if (dob) match = profileValues.dateOfBirth;
      else if (city) match = profileValues.city;
      else if (state) match = profileValues.state;
      else if (zip) match = profileValues.zip;
      else if (phone) match = profileValues.phone;
      else if (country) match = profileValues.countryOfBirth;
      if (match) {
        input.value = match;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        filled++;
        break;
      }
    }
  }
  if (filled > 0 && !document.getElementById("wf-review-banner")) {
    const shadow = document.createElement("div");
    shadow.id = "wf-review-banner";
    const root = shadow.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { position: fixed; top: 16px; right: 16px; z-index: 2147483647; max-width: 320px; }
        .banner { background: #fff; border: 2px solid #2563eb; border-radius: 12px; padding: 14px 16px; box-shadow: 0 8px 24px rgba(0,0,0,0.12); font-family: system-ui, sans-serif; font-size: 13px; color: #1a1a1a; }
        .title { font-weight: 700; color: #1a3a5c; margin-bottom: 6px; }
        .list { margin: 6px 0; padding-left: 16px; }
        .warning { color: #92400e; background: #fffbeb; border-radius: 6px; padding: 6px 10px; margin-top: 8px; font-weight: 600; font-size: 12px; }
        .close { position: absolute; top: 8px; right: 10px; background: none; border: none; cursor: pointer; font-size: 18px; color: #9ca3af; }
      </style>
      <div class="banner">
        <button class="close" onclick="this.closest('#wf-review-banner').remove()">\xD7</button>
        <div class="title">Wayfinder filled ${filled} field${filled !== 1 ? "s" : ""}</div>
        <p>Review every field before submitting. We never fill SSN, A-number, or bank details.</p>
        <div class="warning">\u26A0\uFE0F Do not submit until you have reviewed all fields.</div>
      </div>
    `;
    document.body.appendChild(shadow);
  }
  return filled;
}
