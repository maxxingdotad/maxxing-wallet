import "./env";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import bs58 from "bs58";
import nacl from "tweetnacl";

const { encode, decode } = await import("../src/lib/codec");
const { checkSite, parseList, unicodeHost } = await import("../src/lib/phishing");
const { siteName } = await import("../src/lib/site");
const { readFileSync } = await import("node:fs");
const { parseSuffixList } = await import("../src/lib/psl");
const { clearIfSame } = await import("../src/lib/clipboard");
const { sha256 } = await import("../src/app/kit");

test("the clipboard is cleared only if it still holds the copied secret", async () => {
  let clipboard = "the secret", emptied = 0;
  const read = () => clipboard, empty = () => { emptied++; clipboard = ""; };
  const hash = await sha256("the secret");
  clipboard = "something the user copied since";
  assert.equal(await clearIfSame(read, empty, hash), false);
  assert.equal(clipboard, "something the user copied since");
  clipboard = "the secret";
  assert.equal(await clearIfSame(read, empty, hash), true);
  assert.equal(clipboard, "");
  assert.equal(await clearIfSame(read, empty, hash), false, "nothing to clear");
  assert.equal(emptied, 1);
});
const { parseUnits, solTransferTransaction, checkRecipient, validRecipient } = await import("../src/lib/send");
const { parseSolanaTransaction, isSolanaTransactionMessage } = await import("@maxxing/wallet-core/solana-tx");
const wallet = await import("../src/lib/wallet");
const store = await import("../src/lib/store");

test("requests survive the JSON hops: bigints and bytes come back exactly", () => {
  const value = { transaction: { chainId: 8453, value: 10n ** 18n, gas: 21000n, data: "0x" }, bytes: new Uint8Array([0, 1, 254, 255]), list: [1n, "a"] };
  const back = decode(JSON.parse(JSON.stringify(encode(value)))) as typeof value;
  assert.equal(back.transaction.value, 10n ** 18n);
  assert.deepEqual([...back.bytes], [0, 1, 254, 255]);
  assert.equal(back.list[0], 1n);
  // A look-alike tag with extra keys stays a plain object.
  assert.deepEqual(decode({ $bigint: "1", other: 2 }), { $bigint: "1", other: 2 });
});

const PSL = parseSuffixList(readFileSync(new URL("../public/psl/public_suffix_list.dat", import.meta.url), "utf8"));

test("phishing: MAXXING's own sites pass; listed hosts are known scams; names that read as MAXXING get a warning", () => {
  const verdict = (origin: string, listed = new Set<string>()) => checkSite(origin, listed, PSL).kind;
  for (const ok of ["https://maxxing.ad", "https://wallet.maxxing.ad", "https://any.sub.maxxing.ad", "https://app.example-dex.io", "http://localhost:3000", "https://maximizing.io",
    "https://mixing.app", "https://boxing.club", "https://taxing.gov", "https://looksmaxxing.com", "https://looksmaxxing.co.uk", "https://blog.gymmaxxing.io", "https://maxxingtips.vercel.app"])
    assert.equal(verdict(ok), "ok", ok);
  for (const lookalike of ["https://maxxing-airdrop.claims", "https://m4xxing.io", "https://maxxlng.com", "https://claim-maxxing.net", "https://maxing.ad", "https://rnaxxing.ad",
    "https://maxxing.ad.evil.io", "https://mаxxing.ad" /* Cyrillic а */, "https://maxxіng.io" /* Cyrillic і */, "https://maxxinq.io", "https://maxxing.com", "https://m-a-x-x-i-n-g.net",
    "https://maxxing.co.uk", "https://maxxing.vercel.app", "https://waxxing.com"])
    assert.equal(verdict(lookalike), "lookalike", lookalike);
  // One letter away counts only for the site's own name, not a word elsewhere in the address.
  assert.equal(verdict("https://maxing.example.com"), "ok");
  assert.equal(verdict("https://waxxing-supplies.example.com"), "ok");
  // Punycode is read as the letters a person sees.
  assert.equal(new URL("https://mаxxing.ad").hostname.startsWith("xn--"), true);
  assert.equal(unicodeHost(new URL("https://mаxxing.ad").hostname), "mаxxing.ad");
  assert.equal(verdict("https://evil.example", new Set(["evil.example"])), "scam");
  assert.equal(verdict("https://a.b.evil.example", new Set(["evil.example"])), "scam", "subdomains of a listed host too");
  assert.equal(verdict("https://maxxing-claim.example", new Set(["maxxing-claim.example"])), "scam", "listed beats look-alike");
  // The shipped blocklist reads as hosts, and never lists MAXXING itself.
  const shipped = parseList(readFileSync(new URL("../public/phishing/hosts.txt", import.meta.url), "utf8"));
  assert.ok(shipped.size > 1000, "the shipped list is the real one");
  assert.ok(![...shipped].some(h => h === "maxxing.ad" || h.endsWith(".maxxing.ad")));
  assert.deepEqual([...parseList(JSON.stringify({ deny: ["Evil.Example.", "*.wild.example", "nodot"] }))], ["evil.example", "wild.example"]);
});

test("RPC: an endpoint's own failure moves on to the next, with retries; the chain's answer is final; the good endpoint goes first", async () => {
  const { rpc, RETRY_WAITS_MS } = await import("../src/lib/rpc");
  const waits = [...RETRY_WAITS_MS];
  RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  const real = globalThis.fetch;
  const calls: string[] = [];
  let script: Record<string, () => Response> = {};
  globalThis.fetch = (async (input: string | URL) => { const url = String(input); calls.push(url); return (script[url] ?? (() => new Response("", { status: 503 })))(); }) as typeof fetch;
  const ok = (result: unknown) => () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  const err = (code: number, message: string, status = 200) => () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status });
  try {
    // Rate limit (JSON error), "method not available" (HTTP 400), then an answer.
    script = { "https://a": err(-32005, "Rate limit exceeded"), "https://b": err(-32601, "the method eth_blockNumber does not exist", 400), "https://c": ok("0x10") };
    assert.equal(await rpc(["https://a", "https://b", "https://c"], "eth_blockNumber"), "0x10");
    // The endpoint that answered is tried first next time.
    calls.length = 0;
    assert.equal(await rpc(["https://a", "https://b", "https://c"], "eth_blockNumber"), "0x10");
    assert.deepEqual(calls, ["https://c"]);
    // A revert is the chain's answer: no other endpoint is asked.
    calls.length = 0;
    script = { "https://x": err(3, "execution reverted"), "https://y": ok("0x1") };
    await assert.rejects(rpc(["https://x", "https://y"], "eth_call"), /reverted/);
    assert.deepEqual(calls, ["https://x"]);
    // Every endpoint down: three rounds, then an error.
    calls.length = 0;
    script = {};
    await assert.rejects(rpc(["https://d1", "https://d2"], "eth_blockNumber"));
    assert.equal(calls.length, 6);
    // A transaction is never sent again in a later round.
    calls.length = 0;
    await assert.rejects(rpc(["https://d1", "https://d2"], "eth_sendRawTransaction", ["0x"]));
    assert.equal(calls.length, 2);

    // Sending: the id comes from the signed bytes, so a send that may have gone through is waited for, never failed or redone.
    const { sendSigned } = await import("../src/lib/rpc");
    const send = (urls: string[]) => sendSigned(urls, "eth_sendRawTransaction", ["0xsigned"], "0xhash");
    // A times out or fails with 5xx (it may have taken it); B then says "already known" or "nonce too low": probably sent.
    script = { "https://down": () => new Response("", { status: 502 }), "https://known": err(-32000, "already known"), "https://nonce": err(-32000, "nonce too low") };
    assert.deepEqual(await send(["https://down", "https://nonce"]), { id: "0xhash", certain: false });
    assert.deepEqual(await send(["https://down", "https://known"]), { id: "0xhash", certain: true });
    // "already known" on its own: the network has it.
    assert.deepEqual(await send(["https://known"]), { id: "0xhash", certain: true });
    // "nonce too low" when nothing could have taken it: a real refusal (another transaction used the nonce).
    await assert.rejects(send(["https://nonce"]), /nonce too low/);
    // A rate limit (429) refuses before taking it, so a later "nonce too low" is still a real refusal.
    script["https://limited"] = () => new Response("", { status: 429 });
    await assert.rejects(send(["https://limited", "https://nonce"]), /nonce too low/);
    // Every endpoint failed after one may have taken it: the id comes back, marked uncertain, for the receipt to settle.
    assert.deepEqual(await send(["https://down", "https://down2"]), { id: "0xhash", certain: false });
    // A plain refusal from the chain is final.
    script["https://broke"] = err(-32000, "insufficient funds for gas * price + value");
    await assert.rejects(send(["https://broke", "https://known"]), /insufficient funds/);
    // A clean answer.
    script["https://fine"] = ok("0xhash");
    assert.deepEqual(await send(["https://fine"]), { id: "0xhash", certain: true });
    // (B) Only timeouts, dropped connections and 5xx may have taken it. 400/401/403 and pages that aren't JSON refused it, so a
    // later "nonce too low" is a real refusal, and if nothing else answers, it's an error (not "probably sent").
    for (const refusal of [() => new Response("bad request", { status: 400 }), () => new Response("", { status: 401 }), () => new Response("<html>forbidden</html>", { status: 403 }), () => new Response("<html>gateway</html>", { status: 200 })]) {
      script["https://refused"] = refusal;
      await assert.rejects(send(["https://refused", "https://nonce"]), /nonce too low/);
      await assert.rejects(send(["https://refused"]));
    }
    script["https://5xx-json"] = err(-32603, "internal error", 503);
    assert.deepEqual(await send(["https://5xx-json", "https://nonce"]), { id: "0xhash", certain: false }, "a 5xx with an error body may still have taken it");
    script["https://hang"] = () => { throw new TypeError("network error"); };
    assert.deepEqual(await send(["https://hang", "https://nonce"]), { id: "0xhash", certain: false }, "a dropped connection may have taken it");
    // After a possible take, any nonce / replacement / underpriced answer may be this same transaction: not confirmed yet, never
    // a failure. Before any possible take, they are refusals.
    script["https://underpriced"] = err(-32000, "replacement transaction underpriced");
    script["https://nonce-high"] = err(-32000, "nonce too high");
    for (const answer of ["https://underpriced", "https://nonce", "https://nonce-high"]) {
      assert.deepEqual(await send(["https://down", answer]), { id: "0xhash", certain: false }, answer);
      await assert.rejects(send([answer]), /./, `${answer} alone is a refusal`);
    }
    // 408 (request timeout) and 499 (client closed) may have taken it, like 5xx.
    for (const status of [408, 499]) {
      script[`https://s${status}`] = () => new Response("", { status });
      assert.deepEqual(await send([`https://s${status}`, "https://nonce"]), { id: "0xhash", certain: false }, String(status));
    }
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); }
});

test("after a send, the chain says where it stands: confirmed, failed, seen, or unknown (the Send screen shows 'Sent' only when known)", async () => {
  const { sendStatus } = await import("../src/lib/send");
  const { networks } = await import("../src/lib/chains");
  const { RETRY_WAITS_MS } = await import("../src/lib/rpc");
  const waits = [...RETRY_WAITS_MS]; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  const all = networks(true), base = all.find(n => n.networkId === "eip155:8453")!, sol = all.find(n => n.networkId === "solana:mainnet")!;
  const real = globalThis.fetch;
  let answers: Record<string, unknown> = {};
  globalThis.fetch = (async (_: string, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answers[method] ?? null }));
  }) as typeof fetch;
  try {
    answers = { eth_getTransactionReceipt: { status: "0x1" } };
    assert.equal(await sendStatus(base, "0xh"), "confirmed");
    answers = { eth_getTransactionReceipt: { status: "0x0" } };
    assert.equal(await sendStatus(base, "0xh"), "failed");
    answers = { eth_getTransactionReceipt: null, eth_getTransactionByHash: { hash: "0xh" } };
    assert.equal(await sendStatus(base, "0xh"), "seen", "a node has it, not in a block yet");
    answers = {};
    assert.equal(await sendStatus(base, "0xh"), "unknown", "no node knows it");
    answers = { getSignatureStatuses: { value: [{ err: null, confirmationStatus: "finalized" }] } };
    assert.equal(await sendStatus(sol, "sig"), "confirmed");
    answers = { getSignatureStatuses: { value: [{ err: { InstructionError: [0, "x"] } }] } };
    assert.equal(await sendStatus(sol, "sig"), "failed");
    answers = { getSignatureStatuses: { value: [null] } };
    assert.equal(await sendStatus(sol, "sig"), "unknown");
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); }
});

test("after a send, 'not sent' only when the send wasn't certain, nothing ever saw it, and the chain said 'unknown' at the end", async () => {
  const { watchSend } = await import("../src/lib/send-watch");
  const run = async (answers: ("confirmed" | "failed" | "seen" | "unknown" | "error")[], certain: boolean) => {
    const updates: string[] = [];
    let i = 0;
    const outcome = await watchSend({
      check: async () => { const a = answers[Math.min(i++, answers.length - 1)]!; if (a === "error") throw new Error("endpoint down"); return a; },
      certain, ticks: answers.length, settleUnknowns: 3, sleep: async () => {}, onUpdate: s => updates.push(s),
    });
    return { outcome, updates };
  };
  const u = (n: number) => Array<"unknown">(n).fill("unknown");
  // Nothing ever knew it, the send wasn't certain, and the last checks were the chain's own "unknown": not sent.
  assert.equal((await run(u(6), false)).outcome, "not-sent");
  // Checks that failed (endpoints down) prove nothing, even at the end.
  assert.equal((await run([...u(5), "error"], false)).outcome, "unsettled");
  assert.equal((await run(Array(6).fill("error"), false)).outcome, "unsettled");
  // Seen once (in a node's pool), then nothing: never "not sent".
  assert.equal((await run(["seen", ...u(5)], false)).outcome, "unsettled");
  // A certain send is never "not sent", however long the chain says "unknown".
  const certain = await run(u(6), true);
  assert.equal(certain.outcome, "unsettled");
  assert.ok(certain.updates.every(s => s === "seen"), "a certain send shows as sent while it waits");
  // Settled answers end the watch at once.
  assert.deepEqual(await run(["unknown", "seen", "confirmed"], false), { outcome: "confirmed", updates: ["checking", "seen", "confirmed"] });
  assert.equal((await run(["error", "failed"], true)).outcome, "failed");
  // Too few clean "unknown" answers at the end: not settled.
  assert.equal((await run(["error", "error", "error", "unknown", "unknown"], false)).outcome, "unsettled");
  // Stopped (the screen closed): nothing is concluded.
  let alive = true;
  const stopped = watchSend({ check: async () => { alive = false; return "unknown"; }, certain: false, ticks: 5, sleep: async () => {}, alive: () => alive });
  assert.equal(await stopped, "stopped");
});

test("a send's Activity entry is updated once its outcome is known", async () => {
  const { settleSendActivity } = await import("../src/lib/send");
  await store.activity.add({ kind: "send", text: "Not confirmed yet (check the explorer before sending again) on Base: 1 USDC · 0xfeed" });
  await store.activity.add({ kind: "send", text: "Sent on Base: 2 USDC · 0xbeef" });
  await settleSendActivity("0xfeed", "not-sent");
  await settleSendActivity("0xbeef", "confirmed");
  const texts = (await store.activity.all()).map(a => a.text);
  assert.ok(texts.includes("Not sent on Base: 1 USDC · 0xfeed"));
  assert.ok(texts.includes("Confirmed on Base: 2 USDC · 0xbeef"));
});

test("blocklist refreshes only add hosts, never public suffixes, and a short download is refused", async () => {
  const { withoutSuffixes, refreshBlocklist, blocklist } = await import("../src/lib/blocklist");
  assert.deepEqual([...withoutSuffixes(["vercel.app", "drainer.vercel.app", "co.uk", "evil.co.uk", "com"], PSL)], ["drainer.vercel.app", "evil.co.uk"]);
  const real = globalThis.fetch;
  let deny: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("phishing/hosts.txt")) return new Response("shipped-scam.example\n");
    if (url.endsWith("psl/public_suffix_list.dat")) return new Response(readFileSync(new URL("../public/psl/public_suffix_list.dat", import.meta.url), "utf8"));
    return new Response(JSON.stringify({ deny }));
  }) as typeof fetch;
  try {
    deny = ["tiny.example"];
    await assert.rejects(refreshBlocklist(), /looked wrong/);
    deny = [...Array.from({ length: 1200 }, (_, i) => `scam-${i}.example`), "vercel.app", "pages.dev"];
    await refreshBlocklist();
    const list = await blocklist();
    assert.ok(list.has("shipped-scam.example"), "the shipped hosts stay");
    assert.ok(list.has("scam-7.example"));
    assert.ok(!list.has("vercel.app") && !list.has("pages.dev"), "a public suffix would block every site under it");
  } finally { globalThis.fetch = real; }
});

test("a public suffix list refresh must look like the real one", async () => {
  const { plausibleUpdate } = await import("../src/lib/psl");
  const text = readFileSync(new URL("../public/psl/public_suffix_list.dat", import.meta.url), "utf8");
  assert.equal(plausibleUpdate(PSL, PSL), true);
  assert.equal(plausibleUpdate(parseSuffixList(text.split("\n").slice(0, 4000).join("\n")), PSL), false, "truncated");
  assert.equal(plausibleUpdate(parseSuffixList(text.replace(/^!www\.ck$/m, "")), PSL), false, "missing a known exception");
  assert.equal(plausibleUpdate(parseSuffixList(`${text}\n${Array.from({ length: 2000 }, (_, i) => `x${i}.example`).join("\n")}`), PSL), false, "grew by far too much");
  assert.equal(plausibleUpdate(parseSuffixList(`${text}\nnew-hosting.example`), PSL), true, "a normal update");
});

test("the approval window shows who a site is: the registrable domain from the full Public Suffix List, the full address under it", () => {
  const name = (origin: string) => siteName(origin, PSL);
  assert.deepEqual(pick(name("https://app.claim.example.co.uk")), { domain: "example.co.uk", host: "app.claim.example.co.uk", insecure: false });
  for (const [origin, domain] of [
    ["https://drainer.vercel.app", "drainer.vercel.app"], ["https://x.y.github.io", "y.github.io"], ["https://tenant.pages.dev", "tenant.pages.dev"],
    ["https://shop.myshopify.com", "shop.myshopify.com"], ["https://a.b.s3.amazonaws.com", "b.s3.amazonaws.com"], ["https://app.example.com.au", "example.com.au"],
    ["https://site.example.kawasaki.jp", "site.example.kawasaki.jp"] /* wildcard rule *.kawasaki.jp */, ["https://www.city.kawasaki.jp", "city.kawasaki.jp"] /* exception !city.kawasaki.jp */,
    ["https://a.b.c.very-long-name-that-would-not-fit-on-one-line.example", "very-long-name-that-would-not-fit-on-one-line.example"],
  ] as const) assert.equal(name(origin).domain, domain, origin);
  assert.equal(name("http://shop.example").insecure, true);
  assert.equal(name("http://localhost:5173").insecure, false);
  assert.equal(name("https://mаxxing.ad").unicode, "mаxxing.ad");
  assert.ok(PSL.normal.size > 5000, "the shipped list is the full one");
  // The page's CSS never cuts the name: no ellipsis anywhere in the approval window.
  assert.ok(!readFileSync(new URL("../src/approve.tsx", import.meta.url), "utf8").includes("ellipsis"));
});
const pick = (s: ReturnType<typeof siteName>) => ({ domain: s.domain, host: s.host, insecure: s.insecure });

test("the pages may connect only to the registry's RPC origins and the named services", async () => {
  const { connectOrigins, extensionCsp, SERVICES } = await import("../src/lib/csp");
  const { API_URL } = await import("../src/lib/balances");
  const { RELAY_API } = await import("../src/lib/relay");
  const { BLOCKLIST_SOURCE } = await import("../src/lib/blocklist");
  const { PSL_SOURCE } = await import("../src/lib/psl");
  assert.deepEqual(SERVICES, [API_URL, RELAY_API, new URL(BLOCKLIST_SOURCE).origin, new URL(PSL_SOURCE).origin]);
  const origins = connectOrigins();
  assert.ok(origins.every(o => /^https:\/\/[^/*]+$/.test(o)), "exact https origins, no wildcards");
  assert.ok(origins.length > 5);
  const csp = extensionCsp();
  assert.match(csp, /img-src 'self' data:;/);
  assert.ok(!/connect-src[^;]*\bhttps:(\s|;|$)/.test(csp), "no blanket https:");
  assert.ok(!/wss:/.test(csp));
});

test("amounts are exact, and odd input is refused", () => {
  assert.equal(parseUnits("1.5", 6), 1_500_000n);
  assert.equal(parseUnits("1,000", 18), 1000n * 10n ** 18n);
  assert.equal(parseUnits(".25", 9), 250_000_000n);
  assert.throws(() => parseUnits("1.0000001", 6), /decimals/);
  assert.throws(() => parseUnits("abc", 6), /amount/);
  assert.equal(validRecipient("EVM", "0x1111111111111111111111111111111111111111"), true);
  assert.equal(validRecipient("EVM", "0x111"), false);
  assert.equal(validRecipient("SOLANA", bs58.encode(new Uint8Array(32).fill(3))), true);
  assert.equal(validRecipient("SOLANA", "0x1111111111111111111111111111111111111111"), false);
});

test("a SOL transfer is built so the wallet core reads it back exactly: one transfer, the right amount, the user as fee payer", () => {
  const from = bs58.encode(nacl.sign.keyPair().publicKey), to = bs58.encode(nacl.sign.keyPair().publicKey);
  const tx = solTransferTransaction(from, to, 1_250_000_000n, bs58.encode(new Uint8Array(32).fill(9)));
  const parsed = parseSolanaTransaction(tx);
  assert.equal(parsed.feePayer, from);
  assert.deepEqual(parsed.transfers, [{ from, to, lamports: 1_250_000_000n }]);
  assert.equal(parsed.otherInstructions, 0);
  assert.equal(isSolanaTransactionMessage(tx.subarray(parsed.messageOffset)), true);
});

test("address poisoning: a new address that starts and ends like one you paid is flagged", async () => {
  await store.kept.set("recipients", ["0xabcdef1111111111111111111111111111119999"]);
  assert.deepEqual(await checkRecipient("0xabcdef1111111111111111111111111111119999"), { firstTime: false, lookalike: null });
  assert.equal((await checkRecipient("0xabcdef2222222222222222222222222222229999")).lookalike, "0xabcdef1111111111111111111111111111119999");
  assert.deepEqual(await checkRecipient("0x9999999999999999999999999999999999999999"), { firstTime: true, lookalike: null });
});

test("site requests are reviewed by the core and signed as shown; a Solana 'message' that is a transaction is refused", async () => {
  await wallet.create("246810");
  const open = wallet.snapshot().public!;
  const { view, signed } = wallet.review("evm.signMessage", { address: open.evm, message: "hello" }, "https://app.example");
  assert.equal(view.title, "Sign a message");
  assert.equal(view.site, "app.example");
  assert.match(String(await wallet.sign("evm.signMessage", { address: open.evm, message: "hello" }, signed)), /^0x[0-9a-f]{130}$/);
  assert.throws(() => wallet.review("evm.signMessage", { address: "0x1111111111111111111111111111111111111111", message: "x" }, "https://app.example"), /WALLET_CHANGED/);
  const tx = solTransferTransaction(open.solana, bs58.encode(new Uint8Array(32).fill(4)), 1n, bs58.encode(new Uint8Array(32).fill(9)));
  assert.throws(() => wallet.review("solana.signMessage", { address: open.solana, bytes: tx.subarray(parseSolanaTransaction(tx).messageOffset) }, "https://app.example"), /SOLANA_MESSAGE_IS_TRANSACTION/);
  const solTx = wallet.review("solana.signTransaction", { address: open.solana, bytes: tx }, "https://app.example");
  assert.equal(solTx.view.title, "Confirm a Solana transaction");
  const signedTx = await wallet.sign("solana.signTransaction", { address: open.solana, bytes: tx }, solTx.signed) as Uint8Array;
  assert.ok(nacl.sign.detached.verify(signedTx.subarray(parseSolanaTransaction(signedTx).messageOffset), signedTx.subarray(1, 65), bs58.decode(open.solana)));
  // Unlimited approvals carry the core's warning.
  const approve = wallet.review("evm.signTransaction", { address: open.evm, transaction: { chainId: 8453, to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: `0x095ea7b3${"1".padStart(64, "0")}${"f".repeat(64)}`, value: 0n, gas: 60000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonce: 0, type: "eip1559" } }, "https://app.example");
  assert.match(approve.view.warnings.join(" "), /no limit/);
});

test("accounts from one phrase: adding and switching updates what connected sites are told", async () => {
  const before = wallet.snapshot().public!;
  const added = await wallet.addAccount("Second");
  assert.equal(wallet.snapshot().public!.evm, added.evm);
  assert.notEqual(added.evm, before.evm);
  assert.deepEqual(await store.account.read(), { evm: added.evm, solana: added.solana }, "the background's copy follows the open account");
  await wallet.selectAccount(0);
  assert.equal((await store.account.read())!.evm, before.evm);
  // Exports are logged locally, without the secret.
  const phrase = await wallet.revealPhrase("246810");
  const log = await store.activity.all();
  assert.equal(log[0]!.kind, "export");
  assert.ok(!JSON.stringify(log).includes(phrase.split(" ")[0]! + " "));
  await assert.rejects(wallet.revealKeys("000000"), /Wrong PIN/);
});
