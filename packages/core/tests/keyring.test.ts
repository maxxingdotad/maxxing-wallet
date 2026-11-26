import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

// A browser-like window: storage, events and cross-tab locks.
const data = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k), clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; },
};
Object.assign(globalThis, { window: Object.assign(new EventTarget(), { localStorage }), localStorage });
Object.defineProperty(globalThis, "navigator", { value: { locks: { request: async (_: string, action: () => unknown) => action() } }, configurable: true });

const vault = await import("../src/vault");
const COLLECTION = "maxxing.wallet.v3";
const collection = () => JSON.parse(data.get(COLLECTION) ?? "null");
const reset = async () => { await vault.signOutPlatformWallet(); data.clear(); vault.useKeyring(false); };
const phraseOf = async (id: string, pin: string) => { await vault.selectPlatformWallet(id); return vault.revealPlatformMnemonic(pin); };

test("keyring: one password for every wallet on a fresh device", async () => {
  await reset();
  vault.useKeyring(true);
  const first = await vault.createPlatformWallet("246810", "First");
  assert.equal(vault.keyringExists(), true);
  // While the keyring is open, more wallets need no PIN at all.
  const second = await vault.createPlatformWallet(undefined, "Second");
  const phrase = "test test test test test test test test test test test junk";
  const third = await vault.importPlatformWallet(phrase, undefined, "Third");
  const saved = vault.savedPlatformWallets();
  assert.equal(saved.length, 3);
  assert.ok(collection().accounts.every((a: { pin?: unknown; ring?: unknown }) => a.ring && !a.pin), "every wallet is in the keyring, none has its own PIN");
  // Locked: the one password opens the extension, and every wallet behind it.
  await vault.signOutPlatformWallet();
  assert.equal(vault.platformWalletUnlocked(), false);
  await assert.rejects(vault.createPlatformWallet(undefined, "Fourth"), /Enter your password/);
  await vault.unlockPlatformWallet("246810");
  for (const w of saved) { await vault.selectPlatformWallet(w.id); assert.equal(vault.platformWalletUnlocked(), true, `${w.label} opens without a PIN of its own`); }
  assert.equal(await phraseOf(saved.find(w => w.label === "Third")!.id, "246810"), phrase);
  assert.deepEqual([first.evm, second.evm, third.evm].map(e => e.toLowerCase()).sort(), saved.map(w => w.evm.toLowerCase()).sort());
});

test("keyring: wrong passwords count for the whole keyring, and changing the password keeps every wallet", async () => {
  await reset();
  vault.useKeyring(true);
  await vault.createPlatformWallet("246810", "A");
  await vault.createPlatformWallet(undefined, "B");
  await vault.signOutPlatformWallet();
  for (let i = 0; i < 4; i++) await assert.rejects(vault.unlockPlatformWallet("111111"), /^Error: Wrong PIN\.$/);
  await assert.rejects(vault.unlockPlatformWallet("111111"), /Try again in 30 seconds/);
  assert.ok(vault.pinWaitUntil() > Date.now(), "the wait applies to the keyring");
  await assert.rejects(vault.unlockPlatformWallet("246810"), /Too many wrong PINs/);
  data.delete("maxxing.wallet.attempts.keyring"); // the wait is over
  await vault.unlockPlatformWallet("246810");
  await vault.changePlatformPin("246810", "135791");
  await vault.signOutPlatformWallet();
  await assert.rejects(vault.unlockPlatformWallet("246810"), /Wrong PIN/);
  await vault.unlockPlatformWallet("135791");
  for (const w of vault.savedPlatformWallets()) { await vault.selectPlatformWallet(w.id); assert.equal(vault.platformWalletUnlocked(), true); }
});

test("migration: wallets made before the keyring join it; none loses its key", async () => {
  await reset();
  // Before the update: three wallets, each with its own PIN (the old extension, or the web wallet's format).
  const a = await vault.createPlatformWallet("111111", "Same PIN 1");
  const b = await vault.createPlatformWallet("111111", "Same PIN 2");
  const c = await vault.createPlatformWallet("222222", "Other PIN");
  const ids = Object.fromEntries(vault.savedPlatformWallets().map(w => [w.label, w.id]));
  const phrases: Record<string, string> = {};
  for (const [label, pin] of [["Same PIN 1", "111111"], ["Same PIN 2", "111111"], ["Other PIN", "222222"]] as const) phrases[label] = await phraseOf(ids[label]!, pin);
  void a; void b; void c;
  await vault.selectPlatformWallet(ids["Same PIN 1"]!);
  await vault.signOutPlatformWallet();
  const before = JSON.stringify(collection().accounts.find((x: { id: string }) => x.id === ids["Other PIN"]));

  // After the update: the first unlock with the active wallet's PIN makes it the one password.
  vault.useKeyring(true);
  assert.equal(vault.keyringExists(), false);
  await assert.rejects(vault.unlockPlatformWallet("333333"), /Wrong PIN/, "a wrong PIN creates nothing");
  assert.equal(vault.keyringExists(), false);
  await vault.unlockPlatformWallet("111111");
  assert.equal(vault.keyringExists(), true);
  // Wallets with the same PIN joined at once; the one with another PIN waits for its old PIN, untouched.
  assert.deepEqual(vault.walletsNeedingOldPin().map(w => w.label), ["Other PIN"]);
  assert.equal(JSON.stringify(collection().accounts.find((x: { id: string }) => x.id === ids["Other PIN"])), before, "its record is exactly as before");
  // A wrong old PIN changes nothing.
  await assert.rejects(vault.adoptPlatformWallet(ids["Other PIN"]!, "999999"), /Wrong PIN/);
  assert.equal(JSON.stringify(collection().accounts.find((x: { id: string }) => x.id === ids["Other PIN"])), before);
  // Opening it before it joins says so plainly.
  await vault.selectPlatformWallet(ids["Other PIN"]!);
  assert.equal(vault.platformWalletUnlocked(), false);
  await vault.adoptPlatformWallet(ids["Other PIN"]!, "222222");
  assert.deepEqual(vault.walletsNeedingOldPin(), []);
  assert.ok(collection().accounts.every((x: { pin?: unknown; ring?: unknown }) => x.ring && !x.pin));
  // Every wallet opens with the one password, and holds exactly the phrase it had.
  for (const [label, phrase] of Object.entries(phrases)) assert.equal(await phraseOf(ids[label]!, "111111"), phrase, label);
  await assert.rejects(phraseOf(ids["Other PIN"]!, "222222"), /Wrong PIN/, "its old PIN no longer opens it");
});

test("keyring passwords may have letters (6–128 characters, Unicode-normalized); the web wallet's PIN stays 6 digits", async () => {
  await reset();
  vault.useKeyring(true);
  const word = "Café-Hat 2026";
  await vault.createPlatformWallet(word, "Letters");
  await vault.signOutPlatformWallet();
  await assert.rejects(vault.unlockPlatformWallet("cafe-hat 2026"), /Wrong PIN/, "case and accents count");
  await vault.unlockPlatformWallet("Café-Hat 2026"); // the same text typed as e + combining accent
  assert.equal(vault.platformWalletUnlocked(), true);
  await assert.rejects(vault.changePlatformPin(word, "short"), /Enter your password/);
  await assert.rejects(vault.changePlatformPin(word, "x".repeat(129)), /Enter your password/);
  await vault.changePlatformPin(word, "246810"); // six digits are still a valid password
  await vault.signOutPlatformWallet();
  await vault.unlockPlatformWallet("246810");
  await reset(); // the web wallet (keyring off): letters are refused
  await assert.rejects(vault.createPlatformWallet("abcdefgh", "Web"), /Enter 6 digits/);
});

test("keyring iterations: a stored count at or above the floor is accepted and used; below it, or absurdly high, is refused", async () => {
  await reset();
  vault.useKeyring(true);
  await vault.createPlatformWallet("246810", "A");
  await vault.signOutPlatformWallet();
  const KEY = "maxxing.wallet.keyring.v1";
  const original = data.get(KEY)!;
  // A later version raises the count: the master key, wrapped again with 700,000 iterations, still opens with the stored count.
  const ring = JSON.parse(original);
  const master = await (async () => {
    const salt = Uint8Array.from(atob(ring.salt), c => c.charCodeAt(0)), iv = Uint8Array.from(atob(ring.iv), c => c.charCodeAt(0));
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode("246810"), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ring.iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("MAXXING keyring v1") }, key, Uint8Array.from(atob(ring.cipher), c => c.charCodeAt(0))));
  })();
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode("246810"), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 700_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("MAXXING keyring v1") }, key, master));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
  data.set(KEY, JSON.stringify({ version: 1, salt: b64(salt), iv: b64(iv), cipher: b64(cipher), iterations: 700_000 }));
  await vault.unlockPlatformWallet("246810");
  assert.equal(vault.platformWalletUnlocked(), true, "opened with the stored 700,000");
  await vault.signOutPlatformWallet();
  for (const iterations of [100_000, 50_000_000, 600_000.5]) {
    data.set(KEY, JSON.stringify({ ...JSON.parse(original), iterations }));
    await assert.rejects(vault.unlockPlatformWallet("246810"), /WALLET_STORAGE_DAMAGED/, String(iterations));
  }
  data.set(KEY, original);
});

test("an older wallet whose PIN is skipped stays locked on its own, through every session and password change, and is never deleted", async () => {
  await reset();
  await vault.createPlatformWallet("111111", "Main");
  const skipped = await vault.createPlatformWallet("222222", "Skipped");
  const id = vault.savedPlatformWallets().find(w => w.label === "Skipped")!.id;
  const phrase = await phraseOf(id, "222222");
  await vault.selectPlatformWallet(vault.savedPlatformWallets().find(w => w.label === "Main")!.id);
  await vault.signOutPlatformWallet();
  const before = JSON.stringify(collection().accounts.find((x: { id: string }) => x.id === id));
  vault.useKeyring(true);
  await vault.unlockPlatformWallet("111111");
  // The user skips it: several sessions, a new wallet, a password change. It is left exactly as it was.
  for (let i = 0; i < 3; i++) { await vault.signOutPlatformWallet(); await vault.unlockPlatformWallet("111111"); }
  await vault.createPlatformWallet(undefined, "New");
  await vault.changePlatformPin("111111", "135791");
  await vault.signOutPlatformWallet();
  await vault.unlockPlatformWallet("135791");
  assert.deepEqual(vault.walletsNeedingOldPin().map(w => w.label), ["Skipped"]);
  assert.equal(JSON.stringify(collection().accounts.find((x: { id: string }) => x.id === id)), before, "its record is untouched");
  assert.equal(vault.savedPlatformWallets().length, 3, "never deleted");
  // Opening it needs its own old PIN: the password doesn't open it, and nothing else does either.
  await vault.selectPlatformWallet(id);
  assert.equal(vault.platformWalletUnlocked(), false, "locked on its own");
  await assert.rejects(vault.adoptPlatformWallet(id, "135791"), /Wrong PIN/, "the password isn't its PIN");
  // Whenever the user does enter it, it joins with its key intact.
  await vault.adoptPlatformWallet(id, "222222");
  assert.equal(await phraseOf(id, "135791"), phrase);
  assert.equal(skipped.evm.toLowerCase(), vault.savedPlatformWallets().find(w => w.id === id)!.evm.toLowerCase());
});

test("migration interrupted, or a wallet that fails its check: nothing is lost, it can join later", async () => {
  await reset();
  await vault.createPlatformWallet("111111", "One");
  await vault.createPlatformWallet("111111", "Two");
  const ids = Object.fromEntries(vault.savedPlatformWallets().map(w => [w.label, w.id]));
  const phraseTwo = await phraseOf(ids.Two!, "111111");
  await vault.signOutPlatformWallet();
  const oldRecords = collection().accounts;

  vault.useKeyring(true);
  await vault.unlockPlatformWallet("111111");
  // A crash after the keyring was written but before a wallet's record changed: that wallet still has only its own PIN wrap.
  const c = collection();
  c.accounts = c.accounts.map((x: { id: string }) => x.id === ids.Two ? oldRecords.find((y: { id: string }) => y.id === ids.Two) : x);
  data.set("maxxing.wallet.v3", JSON.stringify(c));
  assert.deepEqual(vault.walletsNeedingOldPin().map(w => w.label), ["Two"]);
  await vault.signOutPlatformWallet();
  await vault.unlockPlatformWallet("111111"); // the next unlock picks it up (same PIN), quietly
  assert.deepEqual(vault.walletsNeedingOldPin(), []);
  assert.equal(await phraseOf(ids.Two!, "111111"), phraseTwo);

  // A record whose key doesn't open its own addresses is never moved: it keeps its PIN wrap.
  await reset();
  await vault.createPlatformWallet("111111", "Damaged");
  await vault.signOutPlatformWallet();
  const damaged = collection();
  damaged.accounts[0].evm = "0x000000000000000000000000000000000000dEaD"; // saved addresses no longer match the phrase
  data.set("maxxing.wallet.v3", JSON.stringify(damaged));
  vault.useKeyring(true);
  await assert.rejects(vault.unlockPlatformWallet("111111"));
  const after = collection().accounts[0];
  assert.ok(after.pin && !after.ring, "the damaged wallet keeps its own PIN wrap");
});

test("the web wallet (keyring off) is unchanged: each wallet keeps its own PIN", async () => {
  await reset();
  await vault.createPlatformWallet("111111", "Web 1");
  await vault.createPlatformWallet("222222", "Web 2");
  assert.equal(vault.keyringExists(), false);
  assert.ok(collection().accounts.every((x: { pin?: unknown; ring?: unknown }) => x.pin && !x.ring));
  await assert.rejects(vault.createPlatformWallet(undefined as unknown as string, "No PIN"), /6 digits/);
});
