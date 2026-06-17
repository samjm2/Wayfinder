// In-memory, client-only store for uploaded files passed to the custom form
// filler at /form. Uploaded documents are kept IN MEMORY only and are NEVER
// persisted server-side. We hold an object URL keyed by a short id so the
// Form Assistant can navigate to /form?src=<id> without putting the file
// through the network or storage.
//
// This module is a client-side singleton (module-level Map). It survives
// client-side navigation within the same tab but is gone on a full reload —
// exactly the ephemerality we want for sensitive uploads.

export interface StoredFormFile {
  id: string;
  name: string;
  type: string;
  objectUrl: string;
}

const store = new Map<string, StoredFormFile>();

function makeId(): string {
  // crypto.randomUUID is available in modern browsers; fall back if absent.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `f_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function putFormFile(file: File): StoredFormFile {
  const id = makeId();
  const objectUrl = URL.createObjectURL(file);
  const entry: StoredFormFile = { id, name: file.name, type: file.type, objectUrl };
  store.set(id, entry);
  return entry;
}

export function getFormFile(id: string): StoredFormFile | undefined {
  return store.get(id);
}

export function revokeFormFile(id: string): void {
  const entry = store.get(id);
  if (entry) {
    URL.revokeObjectURL(entry.objectUrl);
    store.delete(id);
  }
}
