// Save / resume in-progress forms, entirely in the browser (localStorage).
// Nothing is sent to a server — the PDF bytes and the values the user typed stay
// on their own device, consistent with the rest of the form filler.
//
// We keep a LIST of in-progress forms (most-recent first), each holding the PDF
// itself (base64, so the page fully restores) plus the values entered so far.

const KEY = "wayfinder:form-progress";
const MAX_BYTES = 3 * 1024 * 1024; // don't persist PDFs larger than ~3MB
const MAX_FORMS = 8; // keep the 8 most recent in-progress forms

export interface SavedForm {
  key: string; // stable id for the form (label + size)
  label: string; // human name, e.g. "IRS Form W-9"
  values: Record<string, string>; // field id -> value
  bytesB64?: string; // the PDF itself, so resume restores the page too
  savedAt: number; // epoch ms
}

export function progressKey(label: string, byteLength: number): string {
  return `${label}::${byteLength}`;
}

function readRaw(): SavedForm[] {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return [];
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v as SavedForm[];
    // Back-compat: a single object from the earlier one-form version.
    if (v && typeof v === "object" && typeof v.key === "string") return [v as SavedForm];
    return [];
  } catch {
    return [];
  }
}

export function readAllProgress(): SavedForm[] {
  return readRaw().sort((a, b) => b.savedAt - a.savedAt);
}

export function getProgress(key: string): SavedForm | null {
  return readRaw().find((f) => f.key === key) ?? null;
}

// Persist a list, shedding weight if we hit the storage quota: first drop the
// stored PDF bytes from the oldest forms (values are tiny and worth keeping),
// then, as a last resort, keep only the newest.
function persist(list: SavedForm[]): boolean {
  const trimmed = list.slice(0, MAX_FORMS);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
    return true;
  } catch {
    const byNewest = [...trimmed].sort((a, b) => b.savedAt - a.savedAt);
    for (let i = byNewest.length - 1; i >= 0; i--) {
      byNewest[i] = { ...byNewest[i], bytesB64: undefined };
      try {
        localStorage.setItem(KEY, JSON.stringify(byNewest));
        return true;
      } catch {
        /* still too big — keep dropping */
      }
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(byNewest.slice(0, 1)));
      return true;
    } catch {
      return false;
    }
  }
}

export function saveForm(p: SavedForm): boolean {
  const list = readRaw().filter((f) => f.key !== p.key);
  list.unshift(p);
  return persist(list);
}

export function deleteForm(key: string): void {
  persist(readRaw().filter((f) => f.key !== key));
}

export function clearAll(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export function bytesToB64(bytes: Uint8Array): string | undefined {
  if (bytes.length > MAX_BYTES) return undefined;
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
