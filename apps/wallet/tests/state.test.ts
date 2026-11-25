import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

// A browser-like window for the wallet: storage, events and cross-tab locks.
const data = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k), clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; },
};
const win = Object.assign(new EventTarget(), { localStorage });
Object.assign(globalThis, { window: win, localStorage });
Object.defineProperty(globalThis, "navigator", { value: { locks: { request: async (_: string, action: () => unknown) => action() } }, configurable: true });

const vault = await import("@maxxing/wallet-core/vault");
const { walletState } = await import("../src/state");
const PIN = "246810";

test("the app's wallet state carries addresses and flags, never the phrase", async () => {
  const created = await vault.createPlatformWallet(PIN);
  const state = walletState();
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0]!.backedUp, false);
  assert.equal(state.unlocked, true);
  assert.equal(state.published.wallet, created.evm.toLowerCase());
  const phrase = await vault.revealPlatformMnemonic(PIN);
  assert.ok(!JSON.stringify(state).includes(phrase.split(" ")[0] + " "), "the app state never carries the phrase");
});

test("damaged storage is reported to the app instead of silently replaced", () => {
  const saved = localStorage.getItem("maxxing.wallet.v3")!;
  localStorage.setItem("maxxing.wallet.v3", "{not json");
  assert.equal(walletState().storageError, "WALLET_STORAGE_DAMAGED_RESTORE_BACKUP");
  localStorage.setItem("maxxing.wallet.v3", saved);
});
