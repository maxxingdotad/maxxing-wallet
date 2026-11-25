/**
 * A stand-in for the browser and the extension APIs, enough to run the extension's code in Node: localStorage, IndexedDB
 * (fake-indexeddb), cross-tab locks, and chrome.storage / runtime / tabs / windows / alarms kept in memory. Everything that leaves
 * through them (tab messages, windows opened, page messages) is recorded for the tests to inspect.
 */
import "fake-indexeddb/auto";

const data = new Map<string, string>();
export const localStorage = {
  getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k), clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; },
};
export const localData = data;

type Listener = (...args: any[]) => any;
const event = () => { const list: Listener[] = []; return { list, addListener: (f: Listener) => void list.push(f), removeListener: (f: Listener) => void list.splice(list.indexOf(f), 1) }; };

const areas: Record<string, Map<string, unknown>> = { local: new Map(), session: new Map() };
export const storageChanged = event();
const area = (name: string) => ({
  get: async (key: string | string[] | null) => Object.fromEntries((key === null ? [...areas[name]!.keys()] : Array.isArray(key) ? key : [key]).filter(k => areas[name]!.has(k)).map(k => [k, structuredClone(areas[name]!.get(k))])),
  set: async (items: Record<string, unknown>) => {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: areas[name]!.get(k), newValue: structuredClone(v) }; areas[name]!.set(k, structuredClone(v)); }
    for (const f of storageChanged.list) f(changes, name);
  },
  remove: async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) areas[name]!.delete(k); },
  setAccessLevel: async () => {},
});
export const chromeData = areas;

export const tabMessages: unknown[] = [];
export const tabSends: { tabId: number; message: unknown; options: unknown }[] = [];
export const windowsCreated: { url?: string }[] = [];
export const pageMessages: unknown[] = [];
const openWindows = new Set<number>();
let nextWindow = 100;
const alarms = new Map<string, unknown>();
export const alarmsCreated: string[] = [];

export const runtimeMessage = event(), alarmFired = event(), windowRemoved = event(), tabRemoved = event(), startup = event(), installed = event();

const win = Object.assign(new EventTarget(), {
  localStorage,
  location: { origin: "https://app.example", href: "https://app.example/", search: "" },
  postMessage: (message: unknown) => void pageMessages.push(structuredClone(message)),
});

Object.assign(globalThis, {
  window: win,
  localStorage,
  chrome: {
    storage: { local: area("local"), session: area("session"), onChanged: storageChanged },
    runtime: {
      id: "test", sendMessage: async () => undefined, getManifest: () => ({ version: "0.1.0" }), getURL: (p: string) => `chrome-extension://test/${p}`,
      onMessage: runtimeMessage, onStartup: startup, onInstalled: installed,
    },
    tabs: {
      query: async () => [], create: async () => ({}), remove: async () => {}, onRemoved: tabRemoved,
      sendMessage: async (tabId: number, message: unknown, options?: unknown) => { tabMessages.push(structuredClone(message)); tabSends.push({ tabId, message: structuredClone(message), options }); },
    },
    windows: {
      getLastFocused: async () => ({ left: 0, top: 0, width: 1200 }),
      create: async (o: { url?: string }) => { windowsCreated.push({ url: o.url }); const id = nextWindow++; openWindows.add(id); return { id }; },
      get: async (id: number) => { if (!openWindows.has(id)) throw new Error("No window"); return { id }; },
      update: async () => ({}), remove: async (id: number) => { openWindows.delete(id); for (const f of windowRemoved.list) await f(id); },
      onRemoved: windowRemoved,
    },
    alarms: {
      get: async (name: string) => alarms.get(name), create: async (name: string, info: unknown) => { alarms.set(name, info); alarmsCreated.push(name); },
      onAlarm: alarmFired,
    },
  },
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_: string, action: () => unknown) => action() } } });
