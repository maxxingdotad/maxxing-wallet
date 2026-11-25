/**
 * When the wallet stays open, and when it locks.
 * - An open wallet's data key lives in chrome.storage.session: memory only, gone when the browser closes, and readable only by the
 *   extension's own pages (the background sets TRUSTED_CONTEXTS). Never in IndexedDB or on disk.
 * - The auto-lock counts from the user's last click or key in a wallet window. A site opening an approval window doesn't count.
 * - Locking forgets the data key, records `lockedAt` (open pages drop their keys), and stops telling sites the addresses.
 * Every page that opens the vault imports this file first, so the core uses this store from the start.
 */
import { forgetAllDeviceSessions, setDeviceSessionStore } from "@maxxing/wallet-core/device-session";
import { account, lastActive, lockedAt, settings, activity } from "./store";

const PREFIX = "device-session:";
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

setDeviceSessionStore({
  remember: async (id, dataKey) => { await chrome.storage.session.set({ [PREFIX + id]: b64(dataKey) }); },
  read: async id => { const v = (await chrome.storage.session.get(PREFIX + id))[PREFIX + id]; return typeof v === "string" ? unb64(v) : null; },
  forget: async id => { await chrome.storage.session.remove(PREFIX + id); },
  forgetAll: async () => {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith(PREFIX));
    if (keys.length) await chrome.storage.session.remove(keys);
  },
});

/** True when the user has been away longer than the auto-lock time (or never did anything since the browser started). */
export async function stale(now = Date.now()) {
  const [{ autoLockMinutes }, last] = await Promise.all([settings.read(), lastActive.read()]);
  return !last || now - last >= autoLockMinutes * 60_000;
}

/** Locks the wallet everywhere: forgets the open session, tells open pages, and stops answering sites with the addresses. */
export async function lockNow(reason?: string) {
  await forgetAllDeviceSessions();
  await account.write(null);
  await lockedAt.write(Date.now());
  if (reason) await activity.add({ kind: "lock", text: reason });
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: "site-connection-check" }).catch(() => {});
}

/** Locks if the user has been away too long. Returns true when it locked (or there was nothing open). */
export async function lockIfStale(now = Date.now()) {
  if (!(await stale(now))) return false;
  const [locked, last] = await Promise.all([lockedAt.read(), lastActive.read()]);
  const minutes = (await settings.read()).autoLockMinutes;
  // Once per idle stretch: a lock already recorded after the last activity needs nothing more.
  if (locked && locked >= last && !(await account.read())) { await forgetAllDeviceSessions(); return true; }
  await lockNow(last ? `Locked after ${minutes} minute${minutes === 1 ? "" : "s"} without use` : undefined);
  return true;
}
