/**
 * The extension's own records, public data only (keys, the recovery phrase and the PIN live in the wallet core's vault).
 * - Kept across restarts (settings, connected sites, activity, past recipients): the extension origin's IndexedDB, which only the
 *   extension's own pages and background can open. Content scripts, which run inside websites' pages, can't.
 * - Kept until the browser closes (the open account's addresses, the lock state, when the user last did something, pending site
 *   requests): chrome.storage.session, memory only, which the background limits to the extension's own pages (TRUSTED_CONTEXTS).
 */
import { NO_PREFS, type AssetPrefs } from "./assets";

export type Connection = { evm: string; solana: string };
/** `chainId`: the EVM network this site is on (each site keeps its own); unset until the site or the user picks one. */
export type SitePermission = { origin: string; evm: string; solana: string; connectedAt: number; lastUsedAt: number; chainId?: number };
/** `network`: "all", or one registry networkId; every screen follows it. */
export type Settings = { autoLockMinutes: number; showTestnets: boolean; network: string; /** Totals and amounts show as dots. */ hideBalances: boolean };
export type TxStatus = "pending" | "confirmed" | "failed" | "not-sent";
/**
 * One line of Activity. Transactions also carry the account that sent them, the network, the hash (for the explorer link) and a
 * status; wallet-wide events (lock, unlock, reveal) carry none and show under every account. Older entries have only text.
 */
export type Activity = {
  at: number; kind: "connect" | "sign" | "send" | "export" | "lock" | "unlock" | "revoke" | "blocked"; text: string; site?: string;
  account?: string; networkId?: string; hash?: string; status?: TxStatus;
};

const DEFAULTS: Settings = { autoLockMinutes: 15, showTestnets: false, network: "all", hideBalances: false };
export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60, 240] as const;

// ── Kept across restarts: IndexedDB of the extension origin ────────────────────────────────────────────────────────────────
const DATABASE = "maxxing-extension-v1", STORE = "records";
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = d.transaction(STORE, mode), request = action(t.objectStore(STORE));
      let result: T;
      if (request) request.onsuccess = () => { result = request.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(t.error ?? new Error("EXTENSION_STORAGE_FAILED"));
    });
  } finally { d.close(); }
}
export const kept = {
  get: async <T>(key: string, fallback: T): Promise<T> => ((await tx<T | undefined>("readonly", s => s.get(key))) ?? fallback),
  set: (key: string, value: unknown) => tx<void>("readwrite", s => { s.put(structuredClone(value), key); }),
  /** Read, change and write one record in one transaction, so two pages changing it at once don't lose either change. */
  update: async <T>(key: string, fallback: T, change: (value: T) => T): Promise<void> => {
    const d = await db();
    try {
      await new Promise<void>((resolve, reject) => {
        const t = d.transaction(STORE, "readwrite"), s = t.objectStore(STORE), read = s.get(key);
        read.onsuccess = () => { s.put(change((read.result as T | undefined) ?? fallback), key); };
        t.oncomplete = () => resolve();
        t.onerror = t.onabort = () => reject(t.error ?? new Error("EXTENSION_STORAGE_FAILED"));
      });
    } finally { d.close(); }
  },
};

/** Records the first version kept in chrome.storage.local, moved once (content scripts could read that area). */
export async function moveOldRecords() {
  const old = await chrome.storage.local.get(["settings", "sites", "activity", "recipients"]).catch(() => ({} as Record<string, unknown>));
  for (const [key, value] of Object.entries(old)) if (value !== undefined && (await kept.get(key, undefined)) === undefined) await kept.set(key, value);
  await chrome.storage.local.remove(["settings", "sites", "activity", "recipients", "account", "lastActive", "lockedAt"]).catch(() => {});
}

export const settings = {
  read: async (): Promise<Settings> => ({ ...DEFAULTS, ...(await kept.get<Partial<Settings>>("settings", {})) }),
  write: (patch: Partial<Settings>) => kept.update<Partial<Settings>>("settings", {}, s => ({ ...DEFAULTS, ...s, ...patch })),
};

export const sites = {
  all: async () => Object.values(await kept.get<Record<string, SitePermission>>("sites", {})).sort((a, b) => b.lastUsedAt - a.lastUsedAt),
  get: async (origin: string) => (await kept.get<Record<string, SitePermission>>("sites", {}))[origin] ?? null,
  grant: (origin: string, connection: Connection) => kept.update<Record<string, SitePermission>>("sites", {}, all => {
    const now = Date.now();
    const chainId = all[origin]?.chainId;
    return { ...all, [origin]: { origin, evm: connection.evm, solana: connection.solana, connectedAt: all[origin]?.connectedAt ?? now, lastUsedAt: now, ...(chainId ? { chainId } : {}) } };
  }),
  touch: (origin: string) => kept.update<Record<string, SitePermission>>("sites", {}, all => all[origin] ? { ...all, [origin]: { ...all[origin]!, lastUsedAt: Date.now() } } : all),
  setChain: (origin: string, chainId: number) => kept.update<Record<string, SitePermission>>("sites", {}, all => all[origin] ? { ...all, [origin]: { ...all[origin]!, chainId } } : all),
  revoke: async (origin: string) => {
    await kept.update<Record<string, SitePermission>>("sites", {}, all => { const next = { ...all }; delete next[origin]; return next; });
    await kept.update<string[]>("trusted-lookalikes", [], all => all.filter(o => o !== origin));
  },
  clear: async () => { await kept.set("sites", {}); await kept.set("trusted-lookalikes", []); },
};
/** A site may act for the open account only if that is the account it was connected with. */
export const grantedTo = (permission: SitePermission | null, open: Connection | null): open is Connection =>
  !!permission && !!open && permission.evm.toLowerCase() === open.evm.toLowerCase() && permission.solana === open.solana;

const MAX_ACTIVITY = 200;
export const activity = {
  all: () => kept.get<Activity[]>("activity", []),
  add: (entry: Omit<Activity, "at">) => kept.update<Activity[]>("activity", [], all => [{ ...entry, at: Date.now() }, ...all].slice(0, MAX_ACTIVITY)),
  /** Rewrites the newest entry that mentions `ref` (a transaction's hash), when what happened to it becomes known. */
  settle: (ref: string, rewrite: (text: string) => string, status?: TxStatus) => kept.update<Activity[]>("activity", [], all => {
    const i = all.findIndex(a => a.hash === ref || a.text.includes(ref));
    if (i < 0) return all;
    const next = [...all];
    next[i] = { ...next[i]!, text: rewrite(next[i]!.text), ...(status ? { status } : {}) };
    return next;
  }),
  /** Adds the entry unless the same kind of entry for the same site was added within `ms` (so a site can't flood the list). */
  addUnlessRecent: (entry: Omit<Activity, "at">, ms: number) => kept.update<Activity[]>("activity", [], all =>
    all.some(a => a.kind === entry.kind && a.site === entry.site && Date.now() - a.at < ms) ? all : [{ ...entry, at: Date.now() }, ...all].slice(0, MAX_ACTIVITY)),
};

/** Home's asset choices: hidden assets, spam shown or not, tokens added by address (lib/assets.ts). */
export const assetPrefs = {
  read: async (): Promise<AssetPrefs> => ({ ...NO_PREFS, ...(await kept.get<Partial<AssetPrefs>>("asset-prefs", {})) }),
  update: (change: (p: AssetPrefs) => AssetPrefs) => kept.update<AssetPrefs>("asset-prefs", NO_PREFS, p => change({ ...NO_PREFS, ...p })),
};

/** Sites whose name reads as MAXXING that the user said they know, after the warning. Disconnecting a site forgets it too. */
export const trustedLookalikes = {
  has: async (origin: string) => (await kept.get<string[]>("trusted-lookalikes", [])).includes(origin),
  add: (origin: string) => kept.update<string[]>("trusted-lookalikes", [], all => all.includes(origin) ? all : [...all, origin]),
  remove: (origin: string) => kept.update<string[]>("trusted-lookalikes", [], all => all.filter(o => o !== origin)),
};

// ── Until the browser closes: chrome.storage.session ───────────────────────────────────────────────────────────────────────
const session = {
  get: async <T>(key: string, fallback: T): Promise<T> => ((await chrome.storage.session.get(key))[key] as T | undefined) ?? fallback,
  set: (key: string, value: unknown) => chrome.storage.session.set({ [key]: value }),
};

/** The open account's public addresses, so the background can answer a connected site. Null while the wallet is locked. */
export const account = {
  read: () => session.get<Connection | null>("account", null),
  write: (value: Connection | null) => session.set("account", value),
};

/** When the user last did something in the wallet (a click or a key in one of its windows); the auto-lock counts from here. */
export const lastActive = {
  touch: () => session.set("lastActive", Date.now()),
  read: () => session.get<number>("lastActive", 0),
};

/** When the user turned a site's requests down in the last minute; the background pauses a site turned down too often. */
export const declines = {
  recent: async (origin: string, now = Date.now()) => (await session.get<number[]>(`declined:${origin}`, [])).filter(t => now - t < 60_000),
  note: async (origin: string, now = Date.now()) => session.set(`declined:${origin}`, [...await declines.recent(origin, now), now]),
};

/** When the wallet was last locked; open pages drop their keys when it changes. */
export const lockedAt = {
  read: () => session.get<number>("lockedAt", 0),
  write: (at: number) => session.set("lockedAt", at),
};
