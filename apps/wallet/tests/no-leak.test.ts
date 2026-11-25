import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";

/**
 * Self-custody, tested on the wallet window: every request it sends to MAXXING's API carries public addresses and signatures,
 * never a recovery phrase, a key or the PIN. And the only files that can reach the network are the ones listed here, so a new way
 * out fails this test until it has been reviewed.
 */

const data = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k), clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; },
};
Object.assign(globalThis, { window: Object.assign(new EventTarget(), { localStorage }), localStorage });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_: string, action: () => unknown) => action() } } });

type Sent = { url: string; body: string };
const sent: Sent[] = [];
const printed: string[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  sent.push({ url: String(url), body: typeof init?.body === "string" ? init.body : init?.body ? "[non-text body]" : "" });
  const answer = String(url).includes("/rpc/") ? { jsonrpc: "2.0", id: 1, result: [{ calls: [{ status: "0x1", logs: [] }] }] }
    : { identityToken: "t", user: { id: "u", wallet: { evm: "", solana: "" }, accounts: [] }, expiresAt: "" };
  return new Response(JSON.stringify(answer), { status: 200 });
}) as typeof fetch;
for (const method of ["log", "info", "warn", "error", "debug"] as const) console[method] = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };

const vault = await import("@maxxing/wallet-core/vault");
const { derivePlatformAccount, bytesToHex } = await import("@maxxing/wallet-core/derive");
const { openAppSession } = await import("../src/window/social");
const { previewTransaction, nativeBalance } = await import("../src/window/insight");
const { reportUsage } = await import("../src/registry");
const PIN = "246810";

test("everything the wallet window sends to MAXXING is public: addresses and signatures", async () => {
  const wallet = await vault.createPlatformWallet(PIN);
  const phrase = await vault.revealPlatformMnemonic(PIN);
  const account = derivePlatformAccount(phrase);
  const words = phrase.split(" ");
  const secrets = [phrase, `${words[0]} ${words[1]} ${words[2]}`, JSON.stringify(words), bytesToHex(account.evm.privateKeyBytes),
    bytesToHex(account.solana.secretKey), bytesToHex(account.solana.secretKey.slice(0, 32)), Buffer.from(account.evm.privateKeyBytes).toString("base64"),
    Buffer.from(account.solana.secretKey).toString("base64")];

  // Every request the window makes while a wallet is open: app sign-in, usage count, balance and transaction preview.
  await openAppSession({ id: "app_0123456789abcdef0123", name: "Acme" }, wallet);
  reportUsage({ id: "app_0123456789abcdef0123", name: "Acme", origins: ["https://acme.example"], status: "live", logoUrl: null, builtIn: false }, "sign");
  await nativeBalance(8453, wallet.evm).catch(() => 0n);
  await previewTransaction({ chainId: 8453, to: "0x2222222222222222222222222222222222222222", value: 1n }, wallet.evm);

  assert.ok(sent.length >= 4, "every request was seen");
  for (const request of sent) {
    for (const secret of secrets) {
      assert.ok(!request.body.includes(secret) && !request.url.includes(secret), `no key material in ${new URL(request.url).pathname}`);
    }
    assert.ok(!request.body.includes(PIN) && !request.url.includes(PIN), `the PIN never leaves (${new URL(request.url).pathname})`);
  }
  // The sign-in request carries exactly these fields.
  const session = sent.find(r => r.url.endsWith("/session"))!;
  assert.deepEqual(Object.keys(JSON.parse(session.body)).sort(), ["evm", "evmSignature", "issuedAt", "nonce", "solana", "solanaSignature"]);
  for (const line of printed) for (const secret of [...secrets, PIN]) assert.ok(!line.includes(secret), "nothing secret is printed");
});

test("only reviewed files in the wallet window can reach the network", () => {
  /** Each file allowed to make requests, and why. A new one fails here until it is added after review. */
  const ALLOWED = new Set([
    "src/registry.ts",       // partner app records and usage counts: app ids only
    "src/window/social.ts",  // social sign-in and app sessions: addresses and signatures
    "src/window/insight.ts", // balance and preview reads: public addresses and the unsigned transaction
  ]);
  // Any mention, not only calls: passing `fetch` along as a value is a way out too.
  const network = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b|new\s+Image\b/;
  const root = new URL("../", import.meta.url);
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(new URL(dir, root))) {
      const rel = `${dir}${name}`;
      if (statSync(new URL(rel, root)).isDirectory()) walk(`${rel}/`); else if (/\.(ts|tsx)$/.test(name)) files.push(rel);
    }
  })("src/");
  const using = files.filter(file => network.test(readFileSync(new URL(file, root), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));
  assert.deepEqual(using.sort(), [...ALLOWED].sort());
});
