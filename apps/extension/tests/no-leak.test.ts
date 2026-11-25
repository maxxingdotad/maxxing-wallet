import { localData, chromeData, tabMessages } from "./env";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";
import type { Asset } from "../src/lib/relay";

/**
 * Self-custody, tested on the extension: every request it can make while a wallet is open (balances, prices, sending on EVM and
 * Solana, Relay quotes and the swap's transactions) carries addresses, amounts and signed transactions, never a recovery phrase,
 * a private key or the PIN, in the URL, a header or the body. chrome.storage (which the background can read) holds public data
 * only. And only reviewed files can reach the network, other windows, the clipboard or the background.
 */
type Sent = { url: string; headers: string; body: string };
const sent: Sent[] = [];
const ADDRESS_HEX = "0".repeat(24);
const RELAY_ROUTER = "0x0729e2a4716d9f7dd17858d5d504426d228697f7", RELAY_PROXY = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";
let user = "0x";
let quoteSteps: () => unknown[] = () => [{ id: "deposit", action: "Confirm swap", kind: "transaction", requestId: "0xreq", items: [{ status: "incomplete", data: { from: user, to: RELAY_ROUTER, data: "0x", value: "1000", chainId: 8453, gas: "90000", maxFeePerGas: "999999999999999" } }] }];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input), body = typeof init?.body === "string" ? init.body : "";
  sent.push({ url, headers: JSON.stringify(init?.headers ?? {}), body });
  if (url.includes("api.maxxing.ad")) return new Response(JSON.stringify({ error: "API_KEY_INVALID" }), { status: 401 });
  if (url.includes("api.relay.link/chains")) return new Response(JSON.stringify({ chains: [{ id: 8453, contracts: { erc20Router: RELAY_ROUTER, v3: { approvalProxy: RELAY_PROXY } }, protocol: { v2: { depository: "0x4cd00e387622c35bddb9b4c962c136462338bc31" } }, solverAddresses: [] }] }));
  if (url.includes("api.relay.link/quote")) return new Response(JSON.stringify({
    steps: quoteSteps(),
    details: { currencyIn: { amountFormatted: "0.000001", amountUsd: "0.01" }, currencyOut: { amountFormatted: "0.009", amountUsd: "0.009", minimumAmount: "8000", currency: { decimals: 6 } }, totalImpact: { percent: "-0.1" }, timeEstimate: 4 },
    fees: { gas: { amountUsd: "0.001" } },
  }));
  if (url.includes("api.relay.link")) return new Response(JSON.stringify({ status: "success" }));
  const { method, params } = JSON.parse(body || "{}");
  const answers: Record<string, unknown> = {
    eth_getBalance: "0xde0b6b3a7640000", eth_call: `0x${ADDRESS_HEX}${"0".repeat(39)}1`, eth_getTransactionCount: "0x0", eth_estimateGas: "0x5208",
    eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, eth_maxPriorityFeePerGas: "0x1", eth_gasPrice: "0x1", eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
    eth_getTransactionReceipt: { status: "0x1" }, getBalance: { value: 2_000_000_000 }, getTokenAccountsByOwner: { value: [] },
    getLatestBlockhash: { value: { blockhash: "11111111111111111111111111111111" } }, sendTransaction: "5".repeat(64),
  };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answers[method] ?? null }));
}) as typeof fetch;

const wallet = await import("../src/lib/wallet");
const { loadPortfolio } = await import("../src/lib/balances");
const { draftEvmSend, sendEvm, draftSolSend, sendSol } = await import("../src/lib/send");
const { networks } = await import("../src/lib/chains");
const relay = await import("../src/lib/relay");
const { derivePlatformAccount, bytesToHex } = await import("@maxxing/wallet-core/derive");
const { default: bs58 } = await import("bs58");
const PIN = "246810";

test("everything the extension sends is public: addresses, amounts and signed transactions", async () => {
  await wallet.create(PIN);
  await wallet.addAccount("Second");
  const phrase = await wallet.vault.revealPlatformMnemonic(PIN);
  const secrets = [0, 1].flatMap(index => {
    const a = derivePlatformAccount(phrase, index);
    return [bytesToHex(a.evm.privateKeyBytes), bytesToHex(a.solana.secretKey), bytesToHex(a.solana.secretKey.slice(0, 32)), bs58.encode(a.solana.secretKey), Buffer.from(a.evm.privateKeyBytes).toString("base64")];
  });
  const words = phrase.split(" ");
  secrets.push(phrase, `${words[0]} ${words[1]} ${words[2]}`, JSON.stringify(words), PIN);
  const open = wallet.snapshot().public!;
  const all = networks(true);
  const base = all.find(n => n.networkId === "eip155:8453")!, solana = all.find(n => n.networkId === "solana:mainnet")!;

  await loadPortfolio(open, true);
  await sendEvm(await draftEvmSend({ network: base, from: open.evm, to: "0x2222222222222222222222222222222222222222", amount: "0.01", token: null }));
  await sendEvm(await draftEvmSend({ network: base, from: open.evm, to: "0x2222222222222222222222222222222222222222", amount: "5", token: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 } }));
  await sendSol(await draftSolSend({ network: solana, from: open.solana, to: bs58.encode(new Uint8Array(32).fill(7)), amount: "0.1" }), open.solana);
  user = open.evm;
  const eth: Asset = { network: base, address: null, symbol: "ETH", decimals: 18 }, usdc: Asset & { address: string } = { network: base, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 };
  const quote = await relay.quote({ from: eth, to: usdc, amountRaw: 1000n, user: open.evm, recipient: open.evm });
  const prepared = await relay.prepare(quote, open.evm, eth);
  // Fees are set from the network (base fee 1 gwei × 2 + tip), not from the quote's maxFeePerGas.
  assert.equal(prepared.txs[0]!.transaction.maxFeePerGas, 2_000_000_001n);
  assert.equal(prepared.maxFee, prepared.txs[0]!.transaction.gas! * 2_000_000_001n);
  await relay.execute(prepared, () => {});

  // Relay's transactions are checked before anything is signed.
  const swapTo = async (step: Record<string, unknown>, pay = eth) => relay.prepare(await relay.quote({ from: pay, to: usdc, amountRaw: 1000n, user: open.evm, recipient: open.evm }), open.evm, pay);
  const step = (data: Record<string, unknown>) => { quoteSteps = () => [{ id: "x", action: "x", kind: "transaction", requestId: "0xreq", items: [{ status: "incomplete", data: { from: open.evm, to: RELAY_ROUTER, data: "0x", value: "0", chainId: 8453, ...data } }] }]; return {}; };
  await assert.rejects(swapTo(step({ to: "0x9999999999999999999999999999999999999999" })), /isn't one of Relay's contracts/);
  await assert.rejects(swapTo(step({ from: "0x9999999999999999999999999999999999999999" })), /isn't from your address/);
  await assert.rejects(swapTo(step({ chainId: 1 })), /another network/);
  const approveFor = (spender: string) => `0x095ea7b3${spender.slice(2).padStart(64, "0")}${"f".repeat(64)}`;
  await assert.rejects(swapTo(step({ to: usdc.address, data: approveFor("0x9999999999999999999999999999999999999999") }), usdc), /approval/);
  await assert.rejects(swapTo(step({ to: "0xdAC17F958D2ee523a2206206994597C13D831ec7", data: approveFor(RELAY_PROXY) }), usdc), /approval/, "an approval of another token");
  assert.equal((await swapTo(step({ to: usdc.address, data: approveFor(RELAY_PROXY) }), usdc)).txs.length, 1, "approving the paid token to a Relay contract is fine");

  assert.ok(sent.some(r => r.url.includes("api.relay.link/quote")) && sent.some(r => r.body.includes("eth_sendRawTransaction")) && sent.some(r => r.body.includes("sendTransaction")), "every path was exercised");
  for (const request of sent) for (const secret of secrets) for (const part of [request.url, request.headers, request.body])
    assert.ok(!part.includes(secret), `no phrase, key or PIN in a request to ${new URL(request.url).host}`);
  // What the background can read, and what goes to sites' tabs, is public too.
  const shared = JSON.stringify([...chromeData.local.entries(), ...chromeData.session.entries(), tabMessages]);
  for (const secret of secrets) assert.ok(!shared.includes(secret), "chrome.storage and tab messages hold public data only");
  // The page storage holds the vault only in encrypted form.
  const stored = [...localData.values()].join("\n");
  for (const secret of secrets.slice(0, -1)) assert.ok(!stored.includes(secret), "no readable secret in page storage");
});

/** Every way out of a page in a file, read from the syntax tree. */
const WAYS_OUT = new Set(["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts", "postMessage", "BroadcastChannel", "Worker", "SharedWorker", "MessageChannel", "console", "eval", "Function", "sendMessage", "clipboard",
  // Storage other code could read, documents that load URLs, and the clipboard's old API.
  "storage", "indexedDB", "Image", "execCommand", "offscreen", "localStorage", "sessionStorage", "cookie"]);
function waysOut(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && WAYS_OUT.has(node.text) && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)) found.add(node.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.add("import()");
    if (ts.isPropertyAccessExpression(node) && node.name.text === "open" && /^(window|globalThis|self)$/.test(node.expression.getText(source))) found.add("window.open");
    // Opening tabs and windows (each carries a URL), and navigating a page.
    if (ts.isPropertyAccessExpression(node) && node.name.text === "create" && /(^|\.)(tabs|windows)$/.test(node.expression.getText(source))) found.add(`${node.expression.getText(source).split(".").pop()}.create`);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /(^|\.)location(\.href)?$/.test(node.left.getText(source))) found.add("location=");
    if (ts.isPropertyAccessExpression(node) && /^(assign|replace)$/.test(node.name.text) && /(^|\.)location$/.test(node.expression.getText(source))) found.add("location=");
    // Loading a URL into an element: src or href set from code, or an <img>/<iframe>/<script> in JSX with a non-literal src.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\.(src|href)$/.test(node.left.getText(source))) found.add("src=");
    if (ts.isJsxAttribute(node) && /^(src|href)$/.test(node.name.getText(source)) && node.initializer && !ts.isStringLiteral(node.initializer)) found.add("src=");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

/**
 * The SDK files the in-page script bundles (it runs inside every website): from the names src/inpage.ts imports, through the SDK's
 * index to the files that define them, then every file those import (types-only imports aside, as the bundler drops them).
 */
function inpageSdkFiles(): string[] {
  // The SDK's source as this package resolves it (a workspace link here and in the public repository).
  const sdk = new URL("./", import.meta.resolve("@maxxing/wallet-sdk"));
  const toPath = (u: URL) => decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, "$1");
  const parse = (file: string) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const resolveFrom = (file: string, spec: string) => {
    const base = toPath(new URL(spec, `file:///${file.replace(/\\/g, "/")}`));
    for (const candidate of [base, `${base}.ts`, `${base.replace(/\.js$/, "")}.ts`, `${base}/index.ts`]) { try { if (statSync(candidate).isFile()) return candidate; } catch { /* next */ } }
    return null;
  };
  const inpage = toPath(new URL("../src/inpage.ts", import.meta.url)), index = toPath(new URL("index.ts", sdk));
  const wanted = new Set<string>();
  for (const st of parse(inpage).statements) if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "@maxxing/wallet-sdk" && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings))
    for (const el of st.importClause.namedBindings.elements) if (!el.isTypeOnly) wanted.add(el.name.text);
  const queue: string[] = [];
  for (const st of parse(index).statements) if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && st.exportClause && ts.isNamedExports(st.exportClause)
    && st.exportClause.elements.some(el => !el.isTypeOnly && wanted.has(el.name.text))) { const f = resolveFrom(index, st.moduleSpecifier.text); if (f) queue.push(f); }
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const st of parse(file).statements) {
      const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      if (!spec?.startsWith(".") || (ts.isImportDeclaration(st) && st.importClause?.isTypeOnly) || (ts.isExportDeclaration(st) && st.isTypeOnly)) continue;
      const f = resolveFrom(file, spec); if (f) queue.push(f);
    }
  }
  return [...seen].sort();
}

test("the SDK code bundled into websites' pages has only reviewed ways out", () => {
  const found: Record<string, string[]> = {};
  const sdkRoot = decodeURIComponent(new URL("../", import.meta.resolve("@maxxing/wallet-sdk")).pathname).replace(/^\/([A-Za-z]:)/, "$1").replace(/\\/g, "/");
  for (const file of inpageSdkFiles()) { const ways = waysOut(file); if (ways.length) found[file.replace(/\\/g, "/").replace(sdkRoot, "")] = ways; }
  assert.deepEqual(found, SDK_REVIEWED);
});
const SDK_REVIEWED: Record<string, string[]> = {
  "src/connection.ts": ["localStorage", "storage"], // the in-page script passes no storage (src/inpage.ts: new ConnectionStore("extension", null))
  "src/dialog.ts": ["src="],                       // the wallet icon, a data: URI bundled in the SDK
  "src/ethereum.ts": ["fetch"],                    // chain reads and sending a signed transaction, to the chain's public RPC
  "src/rpc.ts": ["fetch"],                         // the same RPC calls
};

test("only reviewed files reach the network, other windows, the clipboard or the background", () => {
  const REVIEWED: Record<string, string[]> = {
    "src/app/App.tsx": ["tabs.create"],                     // a transaction or address on the chain's explorer
    "src/app/Send.tsx": ["tabs.create"],                    // the sent transaction on the explorer
    "src/app/Swap.tsx": ["tabs.create"],                    // the swap's transaction on the explorer
    "src/app/kit.tsx": ["clipboard", "offscreen", "sendMessage"], // copy; for secrets, asks the background to clear the clipboard (Chrome only)
    "src/background.ts": ["offscreen", "sendMessage", "storage", "windows.create"], // the approval window; declines to the asking page; clipboard clear
    "src/content.ts": ["postMessage", "sendMessage"],       // carries the page's requests and the answers
    "src/inpage.ts": ["postMessage"],                       // the site's provider asking the content script
    "src/lib/approval.ts": ["sendMessage", "storage"],      // answers the asking document: the signature or a refusal (tested above)
    "src/lib/balances.ts": ["fetch"],                       // balances: addresses only
    "src/lib/blocklist.ts": ["fetch"],                      // downloads the public phishing list: sends nothing
    "src/lib/lock.ts": ["sendMessage", "storage"],          // the open session in memory-only session storage; "check again" to tabs on lock
    "src/lib/relay.ts": ["fetch"],                          // Relay quotes, status and chain list: addresses, assets, amounts
    "src/lib/rpc.ts": ["fetch"],                            // public RPC: reads and signed transactions
    "src/lib/store.ts": ["indexedDB", "storage"],           // public records: extension IndexedDB, and session storage
    "src/lib/wallet.ts": ["sendMessage", "storage"],        // "check again" to tabs after an account change; follows the lock
    "src/offscreen.ts": ["execCommand"],                    // writes an empty clipboard
    "src/ui/parts.tsx": ["src="],                           // logos: the extension's own files (the CSP allows no other image)
  };
  const root = new URL("../", import.meta.url);
  const found: Record<string, string[]> = {};
  (function walk(dir: string) {
    for (const name of readdirSync(new URL(dir, root))) {
      const rel = `${dir}${name}`;
      if (statSync(new URL(rel, root)).isDirectory()) { if (name !== "design") walk(`${rel}/`); }
      else if (/\.(ts|tsx)$/.test(name)) { const ways = waysOut(new URL(rel, root).pathname.replace(/^\/([A-Za-z]:)/, "$1")); if (ways.length) found[rel] = ways; }
    }
  })("src/");
  assert.deepEqual(found, REVIEWED);
});
