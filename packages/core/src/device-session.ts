/**
 * Keeps a wallet open on this device until the user signs out.
 * The wallet's data key is wrapped by a random AES key that the browser stores as non-extractable in IndexedDB,
 * so page code can use it but never read it. Signing out deletes it, after which only the PIN opens the wallet.
 */
const DATABASE = "maxxing-wallet-device-v1", STORE = "sessions";

type Row = { id: string; key: CryptoKey; iv: Uint8Array; cipher: Uint8Array };

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("WALLET_STORAGE_UNAVAILABLE"));
    const request = indexedDB.open(DATABASE, 1);
    const timer = setTimeout(() => reject(new Error("WALLET_STORAGE_TIMEOUT")), 3000);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => { clearTimeout(timer); resolve(request.result); };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onblocked = () => { clearTimeout(timer); reject(new Error("WALLET_STORAGE_BLOCKED")); };
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode), request = action(tx.objectStore(STORE));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("WALLET_STORAGE_FAILED"));
    });
  } finally { db.close(); }
}

const AAD = (id: string) => new TextEncoder().encode(`MAXXING device session v1:${id}`);

/**
 * Where an open wallet's data key is kept between pages. The default (IndexedDB, wrapped by a non-extractable key) keeps the web
 * wallet open until sign-out, as designed. An app with a shorter-lived place swaps it in before the vault is used: the browser
 * extension keeps it in its memory-only session storage, so a browser restart or the auto-lock ends it.
 */
export type DeviceSessionStore = {
  remember(id: string, dataKey: Uint8Array): Promise<void>;
  read(id: string): Promise<Uint8Array | null>;
  forget(id: string): Promise<void>;
  forgetAll(): Promise<void>;
};

const indexedDbStore: DeviceSessionStore = {
  async remember(id, dataKey) {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD(id) }, key, new Uint8Array(dataKey)));
    await run("readwrite", store => store.put({ id, key, iv, cipher } satisfies Row));
  },
  async read(id) {
    const row = await run<Row | undefined>("readonly", store => store.get(id)).catch(() => undefined);
    if (!row) return null;
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(row.iv), additionalData: AAD(id) }, row.key, new Uint8Array(row.cipher))); }
    catch { await this.forget(id); return null; }
  },
  async forget(id) { await run("readwrite", store => store.delete(id)).catch(() => {}); },
  async forgetAll() { await run("readwrite", store => store.clear()).catch(() => {}); },
};

let active: DeviceSessionStore = indexedDbStore;
/** Replaces where open sessions are kept (null restores the default). Call it before the vault is used. */
export function setDeviceSessionStore(store: DeviceSessionStore | null) { active = store ?? indexedDbStore; }

/** Stores the data key for this wallet so it opens without the PIN until sign-out (or until the app's store forgets it). */
export const rememberDeviceSession = (id: string, dataKey: Uint8Array) => active.remember(id, dataKey);
/** The data key for this wallet if it is still open on this device, else null. */
export const readDeviceSession = (id: string): Promise<Uint8Array | null> => active.read(id).catch(() => null);
export const forgetDeviceSession = (id: string) => active.forget(id).catch(() => {});
export const forgetAllDeviceSessions = () => active.forgetAll().catch(() => {});
/** Deletes the default IndexedDB sessions, for an app that moved to its own store and may have old rows left. */
export const forgetIndexedDbDeviceSessions = () => indexedDbStore.forgetAll();
