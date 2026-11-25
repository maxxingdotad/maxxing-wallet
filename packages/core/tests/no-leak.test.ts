import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import bs58 from "bs58";
import ts from "typescript";

/**
 * Self-custody, tested: the wallet core never touches the network, other windows or the console, and keeps no key material in
 * readable form. Every such API is trapped while wallets are created, opened, used to sign (EVM messages, typed data, transactions,
 * authorizations; Solana bytes and transactions), locked, reopened with the PIN and with a passkey, re-keyed, restored from the
 * phrase and from an older backup file, and removed. Then storage is searched for the phrase, the keys, the PIN and the passkey
 * secret.
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
const win = Object.assign(new EventTarget(), { localStorage, postMessage: trap("postMessage"), open: trap("window.open") });
Object.assign(globalThis, {
  window: win, localStorage, location: { hostname: "wallet.maxxing.ad", origin: "https://wallet.maxxing.ad" },
  fetch: trap("fetch"),
  XMLHttpRequest: class XMLHttpRequest extends Trapped {}, WebSocket: class WebSocket extends Trapped {}, EventSource: class EventSource extends Trapped {},
  BroadcastChannel: class BroadcastChannel extends Trapped {}, Worker: class Worker extends Trapped {}, SharedWorker: class SharedWorker extends Trapped {},
});

// A passkey authenticator that answers with a fixed PRF secret (what a real one returns after verifying the user).
const PRF = crypto.getRandomValues(new Uint8Array(32));
const credentialId = crypto.getRandomValues(new Uint8Array(20));
const credential = () => ({ rawId: credentialId.buffer, getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: PRF } } }) });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  locks: { request: async (_: string, action: () => unknown) => action() }, sendBeacon: trap("sendBeacon"),
  credentials: { create: async () => credential(), get: async () => credential() },
} });
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
  console[method] = (...args: unknown[]) => { printed.push(args.map(a => { try { return typeof a === "string" ? a : JSON.stringify(a, (_k, v) => typeof v === "bigint" ? v.toString() : v); } catch { return String(a); } }).join(" ")); };
}

const vault = await import("../src/vault");
const signing = await import("../src/signing");
const { signSolanaTransaction } = await import("../src/solana-tx");
const { derivePlatformAccount, bytesToHex } = await import("../src/derive");

const PIN = "246810", NEW_PIN = "975318", FILE_PASSWORD = "correct horse battery staple";
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Every form a secret could take on its way out: the phrase, its words in order, the keys in hex, base58 and base64. */
function secretForms(phrase: string): string[] {
  const account = derivePlatformAccount(phrase);
  const evmHex = bytesToHex(account.evm.privateKeyBytes), solHex = bytesToHex(account.solana.secretKey);
  const words = phrase.split(" ");
  return [phrase, `${words[0]} ${words[1]} ${words[2]}`, words.join(","), JSON.stringify(words), evmHex, `0x${evmHex}`, solHex,
    bs58.encode(account.solana.secretKey), b64(account.evm.privateKeyBytes), b64(account.solana.secretKey), bytesToHex(account.solana.secretKey.slice(0, 32)),
    bytesToHex(PRF), b64(PRF)];
}

/** A one-instruction legacy Solana transaction with this signer as fee payer. */
function solanaTransaction(signer: string) {
  const from = bs58.decode(signer), to = new Uint8Array(32).fill(7), system = new Uint8Array(32);
  const message = [1, 0, 1, 3, ...from, ...to, ...system, ...new Uint8Array(32).fill(1), 1, 2, 2, 0, 1, 12, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([1, ...new Uint8Array(64), ...message]);
}

/** A backup file in the format the wallet made before files were retired. */
async function olderBackupFile(mnemonic: string, account: { evm: string; solana: string }) {
  const text = (value: string) => new TextEncoder().encode(value);
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey("raw", text(FILE_PASSWORD), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: text("MAXXING wallet v2") }, key, text(mnemonic)));
  return JSON.stringify({ format: "maxxing-encrypted-wallet", version: 2, account: { id: "old", label: "My wallet", evm: account.evm, solana: account.solana, backedUp: true,
    vault: { version: 2, iterations: 600_000, salt: b64(salt), iv: b64(iv), cipher: b64(cipher) } } });
}

test("the wallet core keeps every secret on the device", async () => {
  await vault.createPlatformWallet(PIN, "First");
  const phrase = await vault.revealPlatformMnemonic(PIN);
  const forms = secretForms(phrase);
  const solana = vault.platformSolanaAddress()!;

  // Every kind of signature.
  await signing.evmSignMessage({ message: "hello" });
  await signing.evmSignTypedData({ domain: { name: "Acme", chainId: 1 }, types: { Login: [{ name: "nonce", type: "string" }] }, primaryType: "Login", message: { nonce: "x" } });
  await signing.evmSignTransaction({ transaction: { chainId: 1, to: "0x2222222222222222222222222222222222222222", value: 1n, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0, type: "eip1559" } });
  await signing.evmSignAuthorization({ address: signing.ALLOWED_DELEGATE, chainId: 1, nonce: 0 });
  await signing.solanaSignBytes({ bytes: new TextEncoder().encode("hello") });
  const signed = await signSolanaTransaction(solanaTransaction(solana), solana, bytes => signing.solanaSignBytes({ bytes }));
  assert.equal(signed.length, solanaTransaction(solana).length);

  // Lock and reopen: wrong PIN, PIN, passkey; change the PIN.
  await assert.rejects(vault.unlockPlatformWallet("000000"), /Wrong PIN/);
  await vault.signOutPlatformWallet();
  await vault.unlockPlatformWallet(PIN);
  await vault.addPlatformPasskey();
  await vault.signOutPlatformWallet();
  await vault.unlockPlatformWalletWithPasskey();
  assert.equal(vault.platformWalletUnlocked(), true, "the passkey opened the wallet");
  await vault.changePlatformPin(PIN, NEW_PIN);
  await vault.confirmPlatformBackup(NEW_PIN, [{ index: 0, word: phrase.split(" ")[0]! }]);

  // Restore: a second wallet, switch back, remove, then restore from the phrase and again from an older backup file.
  await vault.createPlatformWallet(PIN, "Second");
  await vault.selectPlatformWallet(vault.savedPlatformWallets().find(w => w.label === "First")!.id);
  await vault.unlockPlatformWallet(NEW_PIN);
  const file = await olderBackupFile(phrase, vault.platformWalletPublic()!);
  await vault.forgetPlatformWallet(NEW_PIN);
  vault.previewPlatformPhrase(phrase);
  await vault.importPlatformWallet(phrase, PIN, "Restored");
  await vault.forgetPlatformWallet(PIN);
  await vault.previewPlatformBackup(file, FILE_PASSWORD);
  await vault.importPlatformBackup(file, FILE_PASSWORD, PIN, "From file");

  // Nothing went out, nothing was printed.
  assert.deepEqual(outbound, [], "the wallet core made no network call and sent no message");
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

/** Every use of a way out of the page in a file, read from the syntax tree (so comments and strings don't count, and nothing hides). */
const WAYS_OUT = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts", "postMessage", "BroadcastChannel", "Worker", "SharedWorker", "MessageChannel", "console", "eval", "Function"]);
function waysOut(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    // A key in an object literal ({ prf: { eval: … } } for WebAuthn) names data, not a way out.
    if (ts.isIdentifier(node) && WAYS_OUT.has(node.text) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) found.add(node.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.add("import()");
    if (ts.isPropertyAccessExpression(node) && node.name.text === "open" && /^(window|globalThis|self)$/.test(node.expression.getText(source))) found.add("window.open");
    if (ts.isNewExpression(node) && node.expression.getText(source) === "Image") found.add("Image");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found];
}

test("no wallet core file can reach a network, another window, a worker or the console", () => {
  const dir = new URL("../src/", import.meta.url);
  const files: string[] = [];
  (function walk(at: URL) {
    for (const name of readdirSync(at)) {
      const next = new URL(name, at);
      if (statSync(next).isDirectory()) walk(new URL(`${name}/`, at)); else if (/\.tsx?$/.test(name)) files.push(next.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    }
  })(dir);
  assert.ok(files.length >= 10);
  for (const file of files) assert.deepEqual(waysOut(file), [], `${file.split("/src/")[1]} must not use the network, messaging, workers or the console`);
});
