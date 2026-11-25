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

const vault = await import("../src/vault");
const PIN = "246810", OTHER = "135791";

async function rejects(promise: Promise<unknown>, pattern: RegExp) { await assert.rejects(promise, pattern); }

/** A backup file in the format the wallet made before files were retired: the phrase sealed with a file password. */
async function olderBackupFile(mnemonic: string, account: { evm: string; solana: string }, password: string) {
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)), text = (value: string) => new TextEncoder().encode(value);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey("raw", text(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text("MAXXING wallet v2") }, key, text(mnemonic)));
  const vaultRecord = { version: 2, iterations: 600_000, salt: b64(salt), iv: b64(iv), cipher: b64(cipher) };
  return JSON.stringify({ format: "maxxing-encrypted-wallet", version: 2, account: { id: "old", label: "My wallet", evm: account.evm, solana: account.solana, backedUp: true, vault: vaultRecord } });
}

test("MAXXING wallet with a PIN", async t => {
  let phrase = "";

  await t.test("only 6 digits are accepted as a PIN", async () => {
    await rejects(vault.createPlatformWallet("12345"), /6 digits/);
    await rejects(vault.createPlatformWallet("abcdef"), /6 digits/);
    assert.equal(vault.savedPlatformWallets().length, 0);
  });

  await t.test("a new wallet opens at once and tells the app, without a backup yet", async () => {
    const created = await vault.createPlatformWallet(PIN);
    assert.equal(vault.platformWalletUnlocked(), true);
    assert.equal(localStorage.getItem("maxxing.wallet"), created.evm.toLowerCase());
    const saved = vault.savedPlatformWallets();
    assert.equal(saved.length, 1);
    assert.equal(saved[0].backedUp, false);
    phrase = await vault.revealPlatformMnemonic(PIN);
    assert.equal(phrase.split(" ").length, 12);
    assert.ok(![...data.values()].some(value => value.includes(phrase.split(" ")[0] + " " + phrase.split(" ")[1])), "the phrase is never stored in readable form");
    assert.ok(!JSON.stringify([saved, vault.platformWalletPublic()]).includes(phrase.split(" ")[0] + " "), "the public reads never carry the phrase");
  });

  await t.test("the wallet stays open after the page goes away, until sign-out", async () => {
    vault.startWalletProtection();
    window.dispatchEvent(new Event("pagehide"));
    assert.equal(vault.platformWalletUnlocked(), false);
    assert.equal(await vault.restoreDeviceSession(), true);
    assert.equal(vault.platformWalletUnlocked(), true);
    const signer = vault.platformEvmAccount()!;
    await vault.signOutPlatformWallet();
    assert.equal(vault.platformWalletUnlocked(), false);
    assert.throws(() => signer.signMessage({ message: "after sign-out" }), /CANCELLED|LOCKED/);
    assert.equal(await vault.restoreDeviceSession(), false, "sign-out removes the device session");
  });

  await t.test("an app can keep open sessions in its own store; forgetting them there locks the wallet", async () => {
    const sessions = await import("../src/device-session");
    const kept = new Map<string, Uint8Array>();
    sessions.setDeviceSessionStore({
      remember: async (id, key) => void kept.set(id, new Uint8Array(key)), read: async id => kept.has(id) ? new Uint8Array(kept.get(id)!) : null,
      forget: async id => void kept.delete(id), forgetAll: async () => kept.clear(),
    });
    try {
      await vault.unlockPlatformWallet(PIN);
      assert.equal(kept.size, 1, "the session went to the app's store");
      window.dispatchEvent(new Event("pagehide"));
      assert.equal(await vault.restoreDeviceSession(), true);
      window.dispatchEvent(new Event("pagehide"));
      kept.clear(); // what a browser restart or an auto-lock does to a memory-only store
      assert.equal(await vault.restoreDeviceSession(), false);
      assert.equal(vault.platformWalletUnlocked(), false);
    } finally { sessions.setDeviceSessionStore(null); }
    // The default store is back: the web wallet stays open until sign-out, as before.
    await vault.unlockPlatformWallet(PIN);
    window.dispatchEvent(new Event("pagehide"));
    assert.equal(await vault.restoreDeviceSession(), true);
    await vault.signOutPlatformWallet();
  });

  await t.test("wrong PINs make the user wait longer each time, never locking them out", async () => {
    assert.deepEqual([1, 4, 5, 6, 7, 12, 20].map(vault.waitAfter), [0, 0, 30_000, 60_000, 120_000, 3_600_000, 3_600_000]);
    for (let i = 0; i < 4; i++) await rejects(vault.unlockPlatformWallet(OTHER), /^Error: Wrong PIN\.$/);
    await rejects(vault.unlockPlatformWallet(OTHER), /Try again in 30 seconds/);
    assert.ok(vault.pinWaitUntil() > Date.now());
    await rejects(vault.unlockPlatformWallet(PIN), /Too many wrong PINs/);
    // Once the wait is over the right PIN works and the count starts again.
    const id = vault.activePlatformWalletId()!;
    const saved = JSON.parse(localStorage.getItem(`maxxing.wallet.attempts.${id}`)!);
    localStorage.setItem(`maxxing.wallet.attempts.${id}`, JSON.stringify({ ...saved, waitUntil: Date.now() - 1 }));
    await vault.unlockPlatformWallet(PIN);
    assert.equal(vault.platformWalletUnlocked(), true);
    assert.equal(localStorage.getItem(`maxxing.wallet.attempts.${id}`), null);
  });

  await t.test("a PIN check counts wrong tries and opens nothing", async () => {
    await vault.checkPlatformPin(PIN);
    await rejects(vault.checkPlatformPin(OTHER), /^Error: Wrong PIN\.$/);
    const id = vault.activePlatformWalletId()!;
    assert.equal(JSON.parse(localStorage.getItem(`maxxing.wallet.attempts.${id}`)!).failures, 1);
    await vault.checkPlatformPin(PIN);
    assert.equal(localStorage.getItem(`maxxing.wallet.attempts.${id}`), null);
  });

  await t.test("Solana signatures come from inside the vault and stop at sign-out", async () => {
    const { default: nacl } = await import("tweetnacl");
    const { default: bs58 } = await import("bs58");
    const bytes = new TextEncoder().encode("hello");
    const signature = vault.platformSolanaSign(bytes);
    assert.ok(nacl.sign.detached.verify(bytes, signature, bs58.decode(vault.platformSolanaAddress()!)));
    assert.equal("platformSolanaSecret" in vault, false, "the secret key has no way out of the vault");
    await vault.signOutPlatformWallet();
    assert.throws(() => vault.platformSolanaSign(bytes), /WALLET_LOCKED/);
    await vault.unlockPlatformWallet(PIN);
  });

  await t.test("backup is confirmed only with the right words", async () => {
    const words = phrase.split(" ");
    await rejects(vault.confirmPlatformBackup(PIN, [{ index: 2, word: "wrong" }]), /don't match/);
    assert.equal(vault.savedPlatformWallets()[0].backedUp, false);
    await vault.confirmPlatformBackup(PIN, [{ index: 2, word: words[2] }, { index: 9, word: ` ${words[9].toUpperCase()} ` }]);
    assert.equal(vault.savedPlatformWallets()[0].backedUp, true);
  });

  await t.test("changing the PIN keeps the wallet and retires the old PIN", async () => {
    await rejects(vault.changePlatformPin(OTHER, "111111"), /Wrong PIN/);
    await vault.changePlatformPin(PIN, "111111");
    await rejects(vault.revealPlatformMnemonic(PIN), /Wrong PIN/);
    assert.equal(await vault.revealPlatformMnemonic("111111"), phrase);
    await vault.changePlatformPin("111111", PIN);
  });

  await t.test("backup files are no longer made, but an older one still restores the same wallet on a clean device", async () => {
    assert.equal((vault as Record<string, unknown>).exportPlatformBackup, undefined);
    const file = await olderBackupFile(phrase, vault.platformWalletPublic()!, "correct horse battery staple");
    assert.ok(!file.includes(phrase.split(" ")[0] + " "));
    const before = vault.platformWalletPublic()!;
    await vault.forgetPlatformWallet(PIN);
    assert.equal(vault.savedPlatformWallets().length, 0);
    assert.equal(localStorage.getItem("maxxing.wallet"), null);
    await rejects(vault.previewPlatformBackup(file, "wrong password here"), /Wrong file password/);
    assert.deepEqual(await vault.previewPlatformBackup(file, "correct horse battery staple"), before);
    assert.equal(vault.savedPlatformWallets().length, 0, "a preview saves nothing");
    await vault.importPlatformBackup(file, "correct horse battery staple", OTHER);
    assert.deepEqual(vault.platformWalletPublic(), before);
    assert.equal(vault.savedPlatformWallets()[0].backedUp, true);
    assert.equal(await vault.revealPlatformMnemonic(OTHER), phrase);
  });

  await t.test("a recovery phrase restores, and the same wallet cannot be added twice", async () => {
    assert.throws(() => vault.previewPlatformPhrase("not a real phrase"), /Check the words/);
    await rejects(vault.importPlatformWallet(phrase, PIN), /already on this device/);
    const second = await vault.createPlatformWallet(PIN, "Second");
    assert.equal(vault.savedPlatformWallets().length, 2);
    assert.equal(vault.platformWalletPublic()!.evm, second.evm);
  });

  await t.test("switching wallets opens the other one only if it is still signed in", async () => {
    const [first, second] = vault.savedPlatformWallets();
    await vault.signOutPlatformWallet();
    const switched = await vault.selectPlatformWallet(first.id);
    assert.equal(switched.unlocked, false);
    assert.equal(localStorage.getItem("maxxing.wallet"), first.evm.toLowerCase());
    await vault.unlockPlatformWallet(OTHER);
    assert.equal(vault.platformWalletUnlocked(), true);
    assert.notEqual(first.id, second.id);
  });

  await t.test("a wallet that was never backed up cannot be removed", async () => {
    const second = vault.savedPlatformWallets().find(a => a.label === "Second")!;
    await vault.selectPlatformWallet(second.id);
    await rejects(vault.forgetPlatformWallet(PIN), /Back up this wallet/);
  });

  await t.test("damaged storage is reported instead of silently replaced", async () => {
    const saved = localStorage.getItem("maxxing.wallet.v3")!;
    localStorage.setItem("maxxing.wallet.v3", "{not json");
    assert.throws(() => vault.savedPlatformWallets(), /WALLET_STORAGE_DAMAGED_RESTORE_BACKUP/);
    await rejects(vault.createPlatformWallet(PIN), /DAMAGED/);
    localStorage.setItem("maxxing.wallet.v3", saved);
  });
});

test("the wallet window opens the wallet without signing MAXXING in or out", async () => {
  data.clear();
  vault.setWalletPublishing(false);
  try {
    await vault.createPlatformWallet(PIN, "Window test");
    assert.equal(vault.platformWalletUnlocked(), true);
    assert.equal(localStorage.getItem("maxxing.wallet"), null, "no MAXXING sign-in record is written");
    await vault.signOutPlatformWallet();
    await vault.unlockPlatformWallet(PIN);
    assert.equal(localStorage.getItem("maxxing.wallet"), null);
  } finally { vault.setWalletPublishing(true); }
});

test("one recovery phrase opens many accounts; account 0 is the wallet as it always was", async () => {
  const { derivePlatformAccount } = await import("../src/derive");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { default: nacl } = await import("tweetnacl");
  const { default: bs58 } = await import("bs58");
  data.clear();
  const wallet = await vault.createPlatformWallet(PIN, "Many");
  const phrase = await vault.revealPlatformMnemonic(PIN);
  // Account 0 is the same derivation as before accounts existed, and account n uses the standard n-th paths.
  assert.equal(derivePlatformAccount(phrase, 0).evm.address, derivePlatformAccount(phrase).evm.address);
  assert.equal(derivePlatformAccount(phrase, 1).evm.path, "m/44'/60'/0'/0/1");
  assert.equal(derivePlatformAccount(phrase, 1).solana.path, "m/44'/501'/1'/0'");
  assert.throws(() => derivePlatformAccount(phrase, -1), /ACCOUNT_INDEX_INVALID/);
  assert.equal(vault.savedPlatformWallets()[0]!.accounts.length, 1);

  const second = await vault.addPlatformAccount("Trading");
  const expected = derivePlatformAccount(phrase, 1);
  assert.equal(second.index, 1);
  assert.equal(second.evm, expected.evm.address);
  assert.equal(second.solana, expected.solana.address);
  assert.deepEqual(vault.platformWalletPublic(), { evm: second.evm, solana: second.solana }, "the new account is open");
  // Signatures come from the open account's keys.
  const signer = vault.platformEvmAccount()!;
  assert.equal(signer.address, second.evm);
  const sig = vault.platformSolanaSign(new TextEncoder().encode("hi"));
  assert.ok(nacl.sign.detached.verify(new TextEncoder().encode("hi"), sig, bs58.decode(second.solana)));
  assert.equal((await vault.revealPlatformPrivateKeys(PIN)).evm.toLowerCase(), `0x${[...expected.evm.privateKeyBytes].map(b => b.toString(16).padStart(2, "0")).join("")}`);
  assert.equal(privateKeyToAccount((await vault.revealPlatformPrivateKeys(PIN)).evm).address, second.evm);

  // Locked and reopened, the selected account comes back, checked against its saved addresses.
  await vault.signOutPlatformWallet();
  await vault.unlockPlatformWallet(PIN);
  assert.equal(vault.platformWalletPublic()!.evm, second.evm);
  await vault.selectPlatformAccount(0);
  assert.equal(vault.platformWalletPublic()!.evm, wallet.evm);
  assert.equal(vault.savedPlatformWallets()[0]!.selected, 0);

  await vault.renamePlatformAccount(1, "  Savings  ");
  await vault.setPlatformAccountHidden(1, true);
  assert.deepEqual(vault.savedPlatformWallets()[0]!.accounts.map(a => [a.index, a.label, a.hidden]), [[0, "Many", false], [1, "Savings", true]]);
  await assert.rejects(vault.setPlatformAccountHidden(0, true), /another account/);
  await vault.setPlatformAccountHidden(1, false);

  // A record whose saved addresses don't match the phrase's keys is refused, never opened.
  const saved = JSON.parse(localStorage.getItem("maxxing.wallet.v3")!);
  saved.accounts[0].extra[0].evm = "0x1111111111111111111111111111111111111111";
  saved.accounts[0].selected = 1;
  localStorage.setItem("maxxing.wallet.v3", JSON.stringify(saved));
  await vault.signOutPlatformWallet();
  await rejects(vault.unlockPlatformWallet(PIN), /DAMAGED/);
});

test("private keys are exported only with the right PIN, and are the keys of the recovery phrase", async () => {
  data.clear();
  await vault.createPlatformWallet(PIN, "Keys");
  const { derivePlatformAccount, bytesToHex } = await import("../src/derive");
  const { default: bs58 } = await import("bs58");
  await rejects(vault.revealPlatformPrivateKeys("000000"), /Wrong PIN/);
  const keys = await vault.revealPlatformPrivateKeys(PIN);
  const account = derivePlatformAccount(await vault.revealPlatformMnemonic(PIN));
  assert.equal(keys.evm, `0x${bytesToHex(account.evm.privateKeyBytes)}`);
  assert.equal(keys.solana, bs58.encode(account.solana.secretKey));
  assert.equal(bs58.decode(keys.solana).length, 64);
});
