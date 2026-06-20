// Extension popup script.

const content = document.getElementById("content")!;

function html(s: string) {
  content.innerHTML = s;
}

async function init() {
  // Never hang on "Loading…": if the background worker is slow to wake or
  // doesn't answer, fall back to the connect screen after a short timeout.
  let res: { paired: boolean; pairedAt?: number } | null = null;
  try {
    res = (await Promise.race([
      chrome.runtime.sendMessage({ type: "get-pairing-status" }),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ])) as { paired: boolean; pairedAt?: number } | null;
  } catch {
    res = null;
  }

  if (res?.paired) {
    renderPaired(res.pairedAt);
  } else {
    renderUnpaired();
  }
}

function renderUnpaired() {
  html(`
    <p class="status">Connect to your Wayfinder account to fill forms automatically.</p>
    <button class="btn btn-primary" id="btn-pair">Connect Wayfinder Account</button>
  `);
  document.getElementById("btn-pair")!.addEventListener("click", startPairing);
}

function renderPaired(pairedAt?: number) {
  const date = pairedAt ? new Date(pairedAt).toLocaleDateString() : "Unknown";
  html(`
    <div class="success">✓ Connected to Wayfinder</div>
    <p class="paired-info">Paired on ${date}</p>
    <button class="btn btn-primary" id="btn-fill" style="margin-top:12px">Fill Detected Fields</button>
    <button class="btn btn-secondary" id="btn-disconnect">Disconnect</button>
  `);
  document.getElementById("btn-fill")!.addEventListener("click", fillCurrentPage);
  document.getElementById("btn-disconnect")!.addEventListener("click", disconnect);
}

// Guess which Wayfinder server to pair against by looking at open tabs, falling
// back to a previously-saved origin, then production.
async function detectOrigin(): Promise<string> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t.url) continue;
      try {
        const u = new URL(t.url);
        const h = u.hostname.toLowerCase().replace(/\.$/, "");
        if (h === "localhost" || h === "127.0.0.1") return u.origin;
        // Anchored suffix match so "evilwayfinder.app" can't impersonate us.
        if (h === "wayfinder.app" || h.endsWith(".wayfinder.app")) return u.origin;
      } catch { /* ignore */ }
    }
  } catch { /* tabs permission missing */ }
  const { wf_origin } = await chrome.storage.local.get("wf_origin");
  return (typeof wf_origin === "string" && wf_origin) || "https://wayfinder.app";
}

async function startPairing() {
  const origin = await detectOrigin();

  html(`
    <p class="status">In Wayfinder, open <strong>Settings → Auto-fill</strong> and click <strong>"Set up auto-fill"</strong> to get a code, then enter it here:</p>
    <div style="margin: 10px 0;">
      <input id="code-input" type="text" maxlength="8" placeholder="e.g. AB1C2D" style="width:100%;padding:10px;border:2px solid #e5e7eb;border-radius:8px;font-family:monospace;font-size:18px;letter-spacing:3px;text-align:center;text-transform:uppercase" />
    </div>
    <label style="display:block;font-size:11px;color:#6b7280;margin:8px 0 4px">Wayfinder server</label>
    <input id="origin-input" type="text" value="${origin}" style="width:100%;padding:8px;border:2px solid #e5e7eb;border-radius:8px;font-size:12px;font-family:monospace" />
    <button class="btn btn-primary" id="btn-exchange" style="margin-top:12px">Confirm Code</button>
    <button class="btn btn-secondary" id="btn-cancel-pair">Cancel</button>
  `);

  const submit = async () => {
    const code = (document.getElementById("code-input") as HTMLInputElement).value.trim().toUpperCase();
    const originVal = (document.getElementById("origin-input") as HTMLInputElement).value.trim().replace(/\/$/, "");
    if (originVal) await chrome.storage.local.set({ wf_origin: originVal });
    void exchangeCode(code);
  };
  document.getElementById("btn-exchange")!.addEventListener("click", () => void submit());
  document.getElementById("btn-cancel-pair")!.addEventListener("click", renderUnpaired);
  document.getElementById("code-input")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void submit();
  });
}

async function exchangeCode(code: string) {
  if (!code) return;
  const btn = document.getElementById("btn-exchange") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "Connecting..."; }

  const res = (await Promise.race([
    chrome.runtime.sendMessage({ type: "exchange-code", code }),
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, error: "Timed out. Is the Wayfinder server running, and is this the code currently shown in the app?" }), 8000),
    ),
  ])) as { ok: boolean; error?: string } | null;

  if (!res?.ok) {
    html(`<div class="error">Could not connect: ${res?.error ?? "Unknown error"}</div>`);
    setTimeout(renderUnpaired, 2500);
  } else {
    renderPaired(Date.now());
  }
}

async function fillCurrentPage() {
  const btn = document.getElementById("btn-fill") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Loading your profile...";

  const profileRes = await chrome.runtime.sendMessage({ type: "get-profile-values" }) as {
    ok: boolean; values?: Record<string, string>; error?: string;
  };

  if (!profileRes.ok || !profileRes.values) {
    html(`<div class="error">${profileRes.error ?? "Failed to load profile"}</div>`);
    setTimeout(() => renderPaired(), 2500);
    return;
  }

  btn.textContent = "Filling fields...";
  const fillRes = await chrome.runtime.sendMessage({ type: "fill-fields", values: profileRes.values }) as {
    ok: boolean; filled?: number; error?: string;
  };

  if (!fillRes.ok) {
    html(`<div class="error">${fillRes.error ?? "Fill failed"}</div>`);
    setTimeout(() => renderPaired(), 2500);
  } else {
    html(`
      <div class="success">✓ Filled ${fillRes.filled ?? 0} field${(fillRes.filled ?? 0) !== 1 ? "s" : ""}</div>
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Review every field before submitting. Sensitive fields (SSN, A-number) were skipped.</p>
      <button class="btn btn-secondary" id="btn-back" style="margin-top:12px">Back</button>
    `);
    document.getElementById("btn-back")!.addEventListener("click", () => renderPaired(Date.now()));
  }
}

async function disconnect() {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  renderUnpaired();
}

void init();
