/**
 * Development only (dev.html, never in the extension build): the few browser-extension calls the wallet's pages make, done in a
 * normal localhost tab so the real app runs with vite's live reload instead of reloading the unpacked extension.
 *
 * - storage.session lives in this tab's sessionStorage, so an unlocked wallet stays unlocked across reloads (cleared when the
 *   tab closes, like the real one when the browser closes). storage.local lives in localStorage.
 * - There is no background here: messages to it resolve with nothing, and site connections and approvals don't run.
 * - Links open in new tabs; the side panel is not available.
 */
type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type Listener = (changes: Changes, area: string) => void;
const listeners = new Set<Listener>();

function area(name: "session" | "local", backing: Storage) {
  const prefix = `maxxing-dev:${name}:`;
  const all = () => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < backing.length; i++) {
      const k = backing.key(i)!;
      if (k.startsWith(prefix)) out[k.slice(prefix.length)] = JSON.parse(backing.getItem(k)!);
    }
    return out;
  };
  const emit = (changes: Changes) => { if (Object.keys(changes).length) for (const l of listeners) l(changes, name); };
  return {
    async get(keys?: string | string[] | Record<string, unknown> | null) {
      const items = all();
      if (keys == null) return items;
      const wanted = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const defaults = keys && typeof keys === "object" && !Array.isArray(keys) ? keys : {};
      const out: Record<string, unknown> = {};
      for (const k of wanted) { if (k in items) out[k] = items[k]; else if (k in defaults) out[k] = (defaults as Record<string, unknown>)[k]; }
      return out;
    },
    async set(values: Record<string, unknown>) {
      const items = all(), changes: Changes = {};
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) continue;
        backing.setItem(prefix + k, JSON.stringify(v));
        changes[k] = { oldValue: items[k], newValue: v };
      }
      emit(changes);
    },
    async remove(keys: string | string[]) {
      const items = all(), changes: Changes = {};
      for (const k of typeof keys === "string" ? [keys] : keys) {
        if (!(k in items)) continue;
        backing.removeItem(prefix + k);
        changes[k] = { oldValue: items[k] };
      }
      emit(changes);
    },
    async clear() { await this.remove(Object.keys(all())); },
    setAccessLevel: async () => {},
  };
}

const manifest = { version: "dev", name: "MAXXING Wallet (dev)" };
const openTab = async ({ url }: { url?: string }) => { if (url) window.open(url, "_blank", "noopener"); return {}; };

const shim = {
  runtime: {
    id: "maxxing-dev",
    getURL: (path: string) => new URL(path.replace(/^\//, ""), location.origin + "/").toString(),
    getManifest: () => manifest,
    sendMessage: async () => undefined,
    onMessage: { addListener: () => {}, removeListener: () => {} },
  },
  storage: {
    session: area("session", sessionStorage),
    local: area("local", localStorage),
    onChanged: { addListener: (l: Listener) => listeners.add(l), removeListener: (l: Listener) => listeners.delete(l) },
  },
  tabs: {
    create: openTab,
    query: async () => [],
    sendMessage: async () => undefined,
    remove: async () => {},
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  sidePanel: { open: async () => { throw new Error("The side panel needs the installed extension."); } },
  permissions: { contains: async () => true, request: async () => true },
};

// Chrome gives every normal page a bare `window.chrome` without these APIs, so replace it unless this is a real extension page.
const existing = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome;
if (!existing?.runtime?.id) Object.defineProperty(globalThis, "chrome", { value: shim, configurable: true, writable: true });

export {};
