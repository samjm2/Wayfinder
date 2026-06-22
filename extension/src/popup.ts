// Extension popup script.

// Exact Vercel hostname(s) we deploy Wayfinder under. NEVER use a wildcard like
// "*.vercel.app" — that namespace is shared, so any attacker could deploy there
// and be auto-trusted. Add your real production host here, e.g.
// "wayfinder.vercel.app". Must also be listed in manifest.json (host_permissions
// and the appBridge content-script "matches").
const TRUSTED_VERCEL_HOSTS = new Set<string>([
  "wayfinder-sigma-gold.vercel.app",
]);

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
    <div class="success">Connected ✓</div>
    <p class="paired-info">Paired on ${date}</p>
    <p class="status" style="margin-top:8px">Open Wayfinder in your browser and use <strong>Fill out with AI</strong> on a benefit to fill forms.</p>
    <button class="btn btn-secondary" id="btn-disconnect" style="margin-top:12px">Disconnect</button>
  `);
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
        // Our exact Vercel deployment ONLY. Never trust the whole *.vercel.app
        // namespace — anyone can deploy there and impersonate us.
        if (TRUSTED_VERCEL_HOSTS.has(h)) return u.origin;
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
    <button class="btn btn-primary" id="btn-exchange" style="margin-top:12px">Confirm Code</button>
    <button class="btn btn-secondary" id="btn-cancel-pair">Cancel</button>
  `);

  const submit = async () => {
    const code = (document.getElementById("code-input") as HTMLInputElement).value.trim().toUpperCase();
    // Origin is auto-detected (see detectOrigin); persist it so the background
    // worker can reach the right Wayfinder server when exchanging the code.
    const originVal = origin.trim().replace(/\/$/, "");
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

async function disconnect() {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  renderUnpaired();
}

void init();
