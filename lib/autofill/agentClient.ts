// Browser-only client for talking to the Wayfinder extension from the app's
// React side panel. It speaks the window.postMessage protocol that the
// extension's appBridge content script relays to the background worker and on to
// the portal tab. No direct DOM access to the portal — the extension bridges it.

import type { PageSnapshot } from "@/lib/autofill/plan";

export type ExecAction =
  | { action: "fill"; ref: string; value: string }
  | { action: "select"; ref: string; value: string }
  | { action: "check"; ref: string; value: boolean }
  | { action: "click"; ref: string };

export interface ExecResult { ref: string; ok: boolean; note?: string }

interface ExtReply { source: "wayfinder-ext"; id?: string; type?: string; ok?: boolean; result?: unknown; error?: string }

let counter = 0;

function request<T>(type: string, payload?: unknown, timeoutMs = 20000): Promise<T> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  const id = `wf-${Date.now()}-${++counter}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("The extension didn't respond. Is it installed and enabled?"));
    }, timeoutMs);
    function onMsg(e: MessageEvent) {
      const d = e.data as ExtReply;
      if (!d || d.source !== "wayfinder-ext" || d.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      if (d.ok) resolve(d.result as T);
      else reject(new Error(d.error || "Extension error"));
    }
    window.addEventListener("message", onMsg);
    window.postMessage({ source: "wayfinder-app", id, type, payload }, window.location.origin);
  });
}

// Is the extension installed? Pings the bridge with a short timeout.
export async function detectExtension(timeoutMs = 1500): Promise<boolean> {
  try {
    await request<unknown>("ping", undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export const agent = {
  ping: () => request<unknown>("ping", undefined, 1500),
  openPortal: (url: string) => request<{ tabId?: number }>("open", { url }, 30000),
  snapshot: () => request<PageSnapshot>("snapshot", undefined, 25000),
  execute: (actions: ExecAction[]) => request<ExecResult[]>("execute", { actions }, 25000),
  focusPortal: () => request<unknown>("focus"),
  highlight: (ref: string) => request<unknown>("highlight", { ref }),
  close: () => request<unknown>("close"),
};
