// Background service worker. Holds the JWT and handles profile-value fetching.
// Responds to messages from popup and content scripts.

// The Wayfinder app origin the extension talks to. Defaults to production but
// can be overridden for local testing by setting chrome.storage.local.wf_origin
// (e.g. "http://localhost:3000"). Must also appear in manifest host_permissions.
const DEFAULT_ORIGIN = "https://wayfinder.app";
async function getOrigin(): Promise<string> {
  const { wf_origin } = await chrome.storage.local.get("wf_origin");
  return (typeof wf_origin === "string" && wf_origin) || DEFAULT_ORIGIN;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "exchange-code") {
    void exchangeCode(msg.code).then(sendResponse);
    return true; // async
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
    void chrome.storage.local.remove(["wf_token", "wf_paired_at"]).then(() =>
      sendResponse({ ok: true })
    );
    return true;
  }

  // ── AI autofill agent — bridge from the app to the external portal tab ──
  if (typeof msg.type === "string" && msg.type.startsWith("agent-")) {
    void handleAgent(msg.type, msg.payload).then(sendResponse);
    return true;
  }
});

// The portal tab the agent is driving. Kept in session storage so it survives a
// service-worker restart within the browsing session.
async function getPortalTab(): Promise<number | undefined> {
  const { wf_portal_tab } = await chrome.storage.session.get("wf_portal_tab");
  return typeof wf_portal_tab === "number" ? wf_portal_tab : undefined;
}
async function setPortalTab(id: number | undefined): Promise<void> {
  if (id === undefined) await chrome.storage.session.remove("wf_portal_tab");
  else await chrome.storage.session.set({ wf_portal_tab: id });
}

// Send a message to the portal tab's content script, retrying briefly so a
// freshly-opened/navigated page has time to inject portalAgent.js.
async function sendToPortal(tabId: number, message: unknown, attempts = 12): Promise<unknown> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, message);
      if (resp) return resp;
    } catch {
      /* content script not ready yet */
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error("The portal page isn't responding. Make sure it finished loading.");
}

async function handleAgent(type: string, payload: unknown): Promise<unknown> {
  try {
    if (type === "agent-ping") return { ok: true };

    if (type === "agent-open") {
      const url = (payload as { url?: string })?.url;
      if (!url || !/^https?:\/\//.test(url)) return { ok: false, error: "Invalid portal URL." };
      const tab = await chrome.tabs.create({ url, active: true });
      await setPortalTab(tab.id);
      // Wait for the content script to be reachable before returning.
      if (tab.id !== undefined) {
        try { await sendToPortal(tab.id, { type: "wf-ping" }); } catch { /* return anyway; snapshot will retry */ }
      }
      return { ok: true, result: { tabId: tab.id } };
    }

    const tabId = await getPortalTab();
    if (tabId === undefined) return { ok: false, error: "No portal is open yet." };

    if (type === "agent-snapshot") {
      const resp = (await sendToPortal(tabId, { type: "wf-snapshot" })) as { snapshot?: unknown };
      return { ok: true, result: resp.snapshot };
    }
    if (type === "agent-execute") {
      const actions = (payload as { actions?: unknown[] })?.actions ?? [];
      const resp = (await sendToPortal(tabId, { type: "wf-execute", actions })) as { results?: unknown };
      return { ok: true, result: resp.results };
    }
    if (type === "agent-focus") {
      await chrome.tabs.update(tabId, { active: true });
      return { ok: true };
    }
    if (type === "agent-highlight") {
      const ref = (payload as { ref?: string })?.ref;
      await sendToPortal(tabId, { type: "wf-highlight", ref });
      return { ok: true };
    }
    if (type === "agent-close") {
      await setPortalTab(undefined);
      return { ok: true };
    }
    return { ok: false, error: `Unknown agent action: ${type}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Forget the portal tab if it closes.
chrome.tabs.onRemoved.addListener((tabId) => {
  void getPortalTab().then((p) => { if (p === tabId) void setPortalTab(undefined); });
});

async function exchangeCode(code: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${await getOrigin()}/api/extension/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json() as { token?: string; error?: string };
    if (!res.ok || !data.token) {
      return { ok: false, error: data.error ?? "Exchange failed" };
    }
    await chrome.storage.local.set({ wf_token: data.token, wf_paired_at: Date.now() });
    return { ok: true };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

async function getPairingStatus(): Promise<{ paired: boolean; pairedAt?: number }> {
  const stored = await chrome.storage.local.get(["wf_token", "wf_paired_at"]);
  return { paired: !!stored.wf_token, pairedAt: stored.wf_paired_at };
}

async function getProfileValues(): Promise<{ ok: boolean; values?: Record<string, string>; error?: string }> {
  const stored = await chrome.storage.local.get("wf_token");
  const token = stored.wf_token as string | undefined;
  if (!token) return { ok: false, error: "Not paired. Please connect in the extension popup." };
  try {
    const res = await fetch(`${await getOrigin()}/api/extension/profile-values`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json() as { values?: Record<string, string>; error?: string };
    if (!res.ok) {
      if (res.status === 401) await chrome.storage.local.remove("wf_token");
      return { ok: false, error: data.error ?? "Failed to load profile" };
    }
    return { ok: true, values: data.values };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

async function fillCurrentTab(values: Record<string, string>): Promise<{ ok: boolean; filled?: number; error?: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: "No active tab" };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillFields,
      args: [values],
    });
    const filled = (results[0]?.result as number) ?? 0;
    return { ok: true, filled };
  } catch {
    return { ok: false, error: "Could not access this page. Check extension permissions." };
  }
}

// Injected into the page — must be self-contained (no imports, no closures over outer scope).
function fillFields(values: Record<string, string>): number {
  const SENSITIVE_RE = /ssn|social.?security|alien|a-?number|a\s*#|a#|uscis|account|routing|\bcard\b|passport|i-?94\s*number|receipt.?number|bank/i;
  let filled = 0;
  const inputs = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "input[type=text], input[type=email], input[type=tel], input[type=date], input:not([type]), textarea"
  );
  for (const input of inputs) {
    // Derive label from aria-label, placeholder, associated <label>, name, id.
    const label = [
      input.getAttribute("aria-label"),
      input.getAttribute("placeholder"),
      input.id ? document.querySelector(`label[for="${input.id}"]`)?.textContent : null,
      input.getAttribute("name"),
    ].filter(Boolean).join(" ").toLowerCase();

    if (!label || SENSITIVE_RE.test(label)) continue;
    if (input.value) continue; // never overwrite existing user input

    // Try each profile value key against the label.
    for (const [, value] of Object.entries(values)) {
      if (!value) continue;
      // Simple heuristic match — the content script does not import formFill.ts
      // to keep the bundle self-contained; this matches the most common fields.
      const firstName = /first.?name|given.?name|forename/i.test(label);
      const lastName = /last.?name|family.?name|surname/i.test(label);
      const dob = /birth|dob|date.?of.?birth/i.test(label);
      const city = /city|municipality/i.test(label);
      const state = /\bstate\b/i.test(label);
      const zip = /zip|postal/i.test(label);
      const phone = /phone|telephone|mobile/i.test(label);
      const country = /country.?of.?birth|birthplace/i.test(label);

      const profileValues = values as {
        firstName?: string; lastName?: string; dateOfBirth?: string;
        city?: string; state?: string; zip?: string; phone?: string; countryOfBirth?: string;
      };
      let match: string | undefined;
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

  // Inject a review banner.
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
        <button class="close" onclick="this.closest('#wf-review-banner').remove()">×</button>
        <div class="title">Wayfinder filled ${filled} field${filled !== 1 ? "s" : ""}</div>
        <p>Review every field before submitting. We never fill SSN, A-number, or bank details.</p>
        <div class="warning">⚠️ Do not submit until you have reviewed all fields.</div>
      </div>
    `;
    document.body.appendChild(shadow);
  }
  return filled;
}
