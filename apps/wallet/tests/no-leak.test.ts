import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";

/**
 * Self-custody, tested on the wallet window: every request it can send to MAXXING's API carries public addresses, ids and
 * signatures, never a recovery phrase, a key or the PIN, in the URL, a header or the body (text or binary). And the only files that
 * can reach the network, other windows or workers are the ones reviewed below, so a new way out fails this test until it is reviewed.
 */

const data = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, String(v)),
  removeItem: (k: string) => void data.delete(k), clear: () => data.clear(),
  key: (i: number) => [...data.keys()][i] ?? null, get length() { return data.size; },
};

// Everything that leaves: requests (URL, headers, body), windows opened, messages posted.
type Sent = { url: string; headers: string; body: string };
const sent: Sent[] = [];
const opened: string[] = [];
const posted: string[] = [];
const printed: string[] = [];
/** A body as every form a secret could hide in: text, and binary read as Latin-1, hex and base64. */
async function bodyText(body: unknown): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  const bytes = body instanceof Uint8Array ? body : body instanceof ArrayBuffer ? new Uint8Array(body)
    : body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : new TextEncoder().encode(String(body));
  return [Buffer.from(bytes).toString("latin1"), Buffer.from(bytes).toString("hex"), Buffer.from(bytes).toString("base64")].join("\n");
}
const channels = new Set<{ onmessage: ((e: { data: unknown }) => void) | null }>();
class FakeChannel { onmessage: ((e: { data: unknown }) => void) | null = null; constructor(_name: string) { channels.add(this); } postMessage(message: unknown) { posted.push(JSON.stringify(message)); } close() { channels.delete(this); } }

Object.assign(globalThis, {
  window: Object.assign(new EventTarget(), {
    localStorage,
    // The provider's sign-in page answers through the channel with a ticket, as login.html does.
    open: (url: string) => { opened.push(url); const nonce = new URL(url).searchParams.get("nonce"); setTimeout(() => { for (const c of channels) c.onmessage?.({ data: { nonce, ticket: "ticket-123" } }); }, 5); return { close() {} }; },
  }),
  localStorage, BroadcastChannel: FakeChannel,
  location: { origin: "https://wallet.maxxing.ad", hostname: "wallet.maxxing.ad" },
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: { request: async (_: string, action: () => unknown) => action() } } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  sent.push({ url, headers: JSON.stringify(init?.headers ?? {}), body: await bodyText(init?.body) });
  const path = new URL(url).pathname;
  const answer = path.includes("/rpc/") ? { jsonrpc: "2.0", id: 1, result: path.endsWith("/rpc/8453") && String(init?.body).includes("eth_getBalance") ? "0x1" : [{ calls: [{ status: "0x1", logs: [] }] }] }
    : path.endsWith("/login-methods") ? { methods: [{ provider: "google", label: "Google" }] }
    : path.endsWith("/login/redeem") ? { identity: { provider: "google", label: "Google", subject: "s", username: "u", displayName: null, avatarUrl: null, profileUrl: null }, linkedWallet: null, grant: "grant" }
    : /\/v1\/wallet-apps\/app_[0-9a-f]{20}$/.test(path) ? { id: "app_0123456789abcdef0123", name: "Acme", status: "live", origins: ["https://acme.example"], logoUrl: null }
    : { identityToken: "t", user: { id: "u", wallet: { evm: "", solana: "" }, accounts: [] }, expiresAt: "" };
  return new Response(JSON.stringify(answer), { status: 200 });
}) as typeof fetch;
for (const method of ["log", "info", "warn", "error", "debug"] as const) console[method] = (...args: unknown[]) => { printed.push(args.map(String).join(" ")); };

const vault = await import("@maxxing/wallet-core/vault");
const { derivePlatformAccount, bytesToHex } = await import("@maxxing/wallet-core/derive");
const { openAppSession, loginMethods, signInWithProvider } = await import("../src/window/social");
const { previewTransaction, nativeBalance } = await import("../src/window/insight");
const { reportUsage, loadPartnerApp } = await import("../src/registry");
const PIN = "246810";
const APP = { id: "app_0123456789abcdef0123", name: "Acme" };

test("every request the wallet window can send carries public data only", async () => {
  const wallet = await vault.createPlatformWallet(PIN);
  const phrase = await vault.revealPlatformMnemonic(PIN);
  const account = derivePlatformAccount(phrase);
  const words = phrase.split(" ");
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
  const secrets = [phrase, `${words[0]} ${words[1]} ${words[2]}`, JSON.stringify(words), bytesToHex(account.evm.privateKeyBytes),
    bytesToHex(account.solana.secretKey), bytesToHex(account.solana.secretKey.slice(0, 32)), b64(account.evm.privateKeyBytes),
    b64(account.solana.secretKey), Buffer.from(account.evm.privateKeyBytes).toString("latin1"), PIN];

  // Every function in the window that talks to the network, run while the wallet is open.
  const app = await loadPartnerApp(APP.id);
  assert.ok(app);
  await loginMethods(APP.id);
  const signedIn = await signInWithProvider(APP.id, "google");
  await openAppSession(APP, wallet, signedIn);
  await openAppSession(APP, wallet);
  reportUsage(app!, "connect");
  reportUsage(app!, "sign");
  await nativeBalance(8453, wallet.evm);
  await previewTransaction({ chainId: 8453, to: "0x2222222222222222222222222222222222222222", value: 1n, data: "0x" }, wallet.evm);
  await new Promise(resolve => setTimeout(resolve, 20));

  const paths = sent.map(r => new URL(r.url).pathname);
  for (const expected of [`/v1/wallet-apps/${APP.id}`, `/v1/wallet-apps/${APP.id}/login-methods`, `/v1/wallet-apps/${APP.id}/login/redeem`, `/v1/wallet-apps/${APP.id}/session`, `/v1/wallet-apps/${APP.id}/usage`, "/v1/wallet-apps/rpc/8453"])
    assert.ok(paths.includes(expected), `${expected} was exercised`);
  for (const request of [...sent, ...opened.map(url => ({ url, headers: "", body: "" })), ...posted.map(body => ({ url: "channel:", headers: "", body }))]) {
    for (const secret of secrets) for (const part of [request.url, decodeURIComponent(request.url), request.headers, request.body])
      assert.ok(!part.includes(secret), `no key material, phrase or PIN in ${request.url.split("?")[0]}`);
  }
  // The sign-in requests carry exactly these fields.
  const sessions = sent.filter(r => r.url.endsWith("/session")).map(r => Object.keys(JSON.parse(r.body)).sort());
  assert.deepEqual(sessions, [["evm", "evmSignature", "grant", "issuedAt", "nonce", "solana", "solanaSignature"], ["evm", "evmSignature", "issuedAt", "nonce", "solana", "solanaSignature"]]);
  assert.deepEqual(Object.keys(JSON.parse(sent.find(r => r.url.endsWith("/login/redeem"))!.body)).sort(), ["ticket", "verifier"]);
  assert.deepEqual([...new URL(opened[0]!).searchParams.keys()].sort(), ["challenge", "nonce", "origin"]);
  for (const line of printed) for (const secret of secrets) assert.ok(!line.includes(secret), "nothing secret is printed");
});

/** Every use of a way out of the page in a file: network APIs, other windows, messaging, workers, dynamic code, the console. */
const WAYS_OUT = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts", "postMessage", "BroadcastChannel", "Worker", "SharedWorker", "MessageChannel", "console", "eval", "Function"]);
function waysOut(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    // A key in an object literal names data, not a way out.
    if (ts.isIdentifier(node) && WAYS_OUT.has(node.text) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) found.add(node.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.add("import()");
    if (ts.isPropertyAccessExpression(node) && node.name.text === "open" && /^(window|globalThis|self)$/.test(node.expression.getText(source))) found.add("window.open");
    if (ts.isNewExpression(node) && node.expression.getText(source) === "Image") found.add("Image");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

test("only reviewed files in the wallet window reach the network, other windows or workers", () => {
  /** Each file's ways out, and why. A new one, or a new way out in a listed file, fails here until it is reviewed. */
  const REVIEWED: Record<string, string[]> = {
    "src/main.ts": ["postMessage"],                                            // answers maxxing.ad, the parent that embeds it
    "src/registry.ts": ["console", "fetch"],                                   // partner app records and usage counts: app ids only
    "src/window/insight.ts": ["fetch"],                                        // balance and preview reads: address and the unsigned transaction
    "src/window/login.ts": ["BroadcastChannel", "postMessage"],                // hands the sign-in ticket back to the wallet window
    "src/window/main.ts": ["postMessage"],                                     // answers the partner site that opened the window
    "src/window/preview.ts": ["postMessage"],                                  // tells the developer dashboard its preview's height
    "src/window/social.ts": ["BroadcastChannel", "fetch", "window.open"],      // social sign-in and app sessions: addresses and signatures
  };
  const root = new URL("../", import.meta.url);
  const found: Record<string, string[]> = {};
  (function walk(dir: string) {
    for (const name of readdirSync(new URL(dir, root))) {
      const rel = `${dir}${name}`;
      if (statSync(new URL(rel, root)).isDirectory()) walk(`${rel}/`);
      else if (/\.(ts|tsx)$/.test(name)) { const ways = waysOut(new URL(rel, root).pathname.replace(/^\/([A-Za-z]:)/, "$1")); if (ways.length) found[rel] = ways; }
    }
  })("src/");
  assert.deepEqual(found, REVIEWED);
});
