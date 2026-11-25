import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import bs58 from "bs58";

/**
 * Self-custody, tested: the wallet core never touches the network, never writes to the console, and keeps no key material in
 * readable form. Every network API and console method is trapped while a wallet is created, opened, used to sign, locked,
 * reopened, re-keyed, restored and removed; then storage is searched for the phrase, the keys and the PIN.
 */

// ── A browser-like window whose every way out is recorded ─────────────────────────────────────────────────────────────
const data = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k), clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; },
};
const outbound: string[] = [];
const printed: string[] = [];
const trap = (name: string) => (...args: unknown[]) => { outbound.push(`${name} ${args.map(a => String(a)).join(" ")}`); throw new Error(`NETWORK_FORBIDDEN:${name}`); };
class Trapped { constructor(...args: unknown[]) { trap(this.constructor.name)(...args); } }
const win = Object.assign(new EventTarget(), { localStorage });
Object.assign(globalThis, {
  window: win, localStorage,
  fetch: trap("fetch"),
  XMLHttpRequest: class XMLHttpRequest extends Trapped {}, WebSocket: class WebSocket extends Trapped {}, EventSource: class EventSource extends Trapped {},
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_: string, action: () => unknown) => action() }, sendBeacon: trap("sendBeacon") } });
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
  console[method] = (...args: unknown[]) => { printed.push(args.map(a => { try { return typeof a === "string" ? a : JSON.stringify(a, (_k, v) => typeof v === "bigint" ? v.toString() : v); } catch { return String(a); } }).join(" ")); };
}

const vault = await import("../src/vault");
const signing = await import("../src/signing");
const { derivePlatformAccount } = await import("../src/derive");
const { bytesToHex } = await import("../src/derive");

const PIN = "246810", NEW_PIN = "975318";

/** Every form a secret could take on its way out: the phrase, its words in order, the keys in hex, base58 and base64. */
function secretForms(phrase: string): string[] {
  const account = derivePlatformAccount(phrase);
  const evmHex = bytesToHex(account.evm.privateKeyBytes), solHex = bytesToHex(account.solana.secretKey);
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const words = phrase.split(" ");
  return [phrase, `${words[0]} ${words[1]} ${words[2]}`, words.join(","), JSON.stringify(words), evmHex, `0x${evmHex}`, solHex,
    bs58.encode(account.solana.secretKey), b64(account.evm.privateKeyBytes), b64(account.solana.secretKey), bytesToHex(account.solana.secretKey.slice(0, 32))];
}

test("the wallet core keeps every secret on the device", async () => {
  // Create, reveal, sign every kind of request, lock, reopen, change the PIN, restore from the phrase, remove.
  await vault.createPlatformWallet(PIN, "First");
  const phrase = await vault.revealPlatformMnemonic(PIN);
  const forms = secretForms(phrase);

  await signing.evmSignMessage({ message: "hello" });
  await signing.evmSignTypedData({ domain: { name: "Acme", chainId: 1 }, types: { Login: [{ name: "nonce", type: "string" }] }, primaryType: "Login", message: { nonce: "x" } });
  await signing.evmSignTransaction({ transaction: { chainId: 1, to: "0x2222222222222222222222222222222222222222", value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0, type: "eip1559" } });
  await signing.evmSignAuthorization({ address: signing.ALLOWED_DELEGATE, chainId: 1, nonce: 0 });
  await signing.solanaSignBytes({ bytes: new TextEncoder().encode("hello") });
  await assert.rejects(vault.unlockPlatformWallet("000000"), /Wrong PIN/);
  await vault.signOutPlatformWallet();
  await vault.unlockPlatformWallet(PIN);
  await vault.changePlatformPin(PIN, NEW_PIN);
  await vault.confirmPlatformBackup(NEW_PIN, [{ index: 0, word: phrase.split(" ")[0]! }]);
  await vault.createPlatformWallet(PIN, "Second");
  await vault.selectPlatformWallet(vault.savedPlatformWallets().find(w => w.label === "First")!.id);
  await vault.unlockPlatformWallet(NEW_PIN);
  await vault.forgetPlatformWallet(NEW_PIN);
  vault.previewPlatformPhrase(phrase);
  await vault.importPlatformWallet(phrase, PIN, "Restored");

  // Nothing went out, nothing was printed.
  assert.deepEqual(outbound, [], "the wallet core made no network call");
  assert.deepEqual(printed, [], "the wallet core printed nothing");

  // Storage holds no secret in readable form, and no PIN.
  const stored = [...data.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
  for (const form of forms) assert.ok(!stored.includes(form), `local storage never holds a secret in readable form (${form.length} chars)`);
  for (const pin of [PIN, NEW_PIN]) assert.ok(![...data.values()].some(v => { try { return JSON.stringify(JSON.parse(v)).includes(`"${pin}"`); } catch { return v === pin; } }), "the PIN is never stored");

  // The device session holds a ciphertext and a key the page cannot read out.
  const rows = await new Promise<{ key: CryptoKey; cipher: Uint8Array }[]>((resolve, reject) => {
    const open = indexedDB.open("maxxing-wallet-device-v1", 1);
    open.onsuccess = () => { const all = open.result.transaction("sessions").objectStore("sessions").getAll(); all.onsuccess = () => { resolve(all.result); open.result.close(); }; all.onerror = () => reject(all.error); };
    open.onerror = () => reject(open.error);
  });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.key.extractable, false, "the device key can't be exported");
    const cipher = bytesToHex(new Uint8Array(row.cipher));
    for (const form of forms) assert.ok(!cipher.includes(form));
  }
});

test("the wallet core has no code that can reach a network or a log", () => {
  const dir = new URL("../src/", import.meta.url);
  const pattern = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|console)\b|new\s+Image\b|\.src\s*=/;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const code = readFileSync(new URL(name, dir), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.doesNotMatch(code, pattern, `src/${name} must not use the network or the console`);
  }
});
