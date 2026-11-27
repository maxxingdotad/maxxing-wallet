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

test("activity: per account and network, filters, statuses (also read from older text-only entries)", async () => {
  const { visibleActivity, statusOf } = await import("../src/app/Activity");
  const me = { evm: "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa", solana: "So1anaMe11111111111111111111111111111111111" };
  const other = "0xbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbB";
  const items = [
    { at: 6, kind: "send" as const, text: "Sent on Base: 1 USDC · 0x01", account: me.evm.toLowerCase(), networkId: "eip155:8453", hash: "0x01", status: "pending" as const },
    { at: 5, kind: "send" as const, text: "Sent 1 SOL on Solana · sig", account: me.solana, networkId: "solana:mainnet", hash: "sig", status: "confirmed" as const },
    { at: 4, kind: "send" as const, text: "Sent on Base: 2 USDC · 0x02", account: other, networkId: "eip155:8453", hash: "0x02", status: "failed" as const },
    { at: 3, kind: "lock" as const, text: "Wallet locked" },
    { at: 2, kind: "connect" as const, text: "Connected a site", site: "https://app.example" },
    { at: 1, kind: "send" as const, text: "Confirmed on Base: 3 USDC · 0x03" },
  ];
  const ats = (xs: { at: number }[]) => xs.map(x => x.at);
  assert.deepEqual(ats(visibleActivity(items, me, "all", "all")), [6, 5, 3, 2, 1], "another account's send is not shown");
  assert.deepEqual(ats(visibleActivity(items, me, "eip155:8453", "all")), [6], "one network: only its transactions");
  assert.deepEqual(ats(visibleActivity(items, me, "all", "tx")), [6, 5, 1]);
  assert.deepEqual(ats(visibleActivity(items, me, "all", "sites")), [2]);
  assert.deepEqual(ats(visibleActivity(items, me, "all", "security")), [3]);
  assert.equal(statusOf(items[0]!), "pending");
  assert.equal(statusOf(items[5]!), "confirmed", "older entries: status read from the text");
  assert.equal(statusOf({ at: 0, kind: "send", text: "Not confirmed yet (check the explorer before sending again) on Base" }), "pending");
  assert.equal(statusOf(items[3]!), null);
});

test("custom RPCs: https only (http for this computer), chain id must match, the user's first, then the defaults; reset; custom networks never verified", async () => {
  const un = await import("../src/lib/user-networks");
  const { userNetworksNow, setUserNetworksNow, EMPTY } = await import("../src/lib/user-networks-state");
  const { networks, networkById, evmNetwork, registryHasChain } = await import("../src/lib/chains");
  const { verifiedAssets, listAssets, NO_PREFS, assetKey } = await import("../src/lib/assets");
  const { rpc, RETRY_WAITS_MS } = await import("../src/lib/rpc");
  const waits = [...RETRY_WAITS_MS]; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  await store.kept.set("user-networks", EMPTY); setUserNetworksNow(EMPTY);
  // Addresses: https, or http only on this computer; no user:password in them.
  assert.equal(un.rpcUrlProblem("https://base.example/rpc/KEY"), null);
  assert.equal(un.rpcUrlProblem("http://localhost:8545"), null);
  assert.equal(un.rpcUrlProblem("http://127.0.0.1:8545"), null);
  assert.match(un.rpcUrlProblem("http://node.example")!, /https/);
  assert.match(un.rpcUrlProblem("wss://node.example")!, /https/);
  assert.match(un.rpcUrlProblem("https://user:pass@node.example")!, /user name/);
  assert.equal(un.rpcHost("https://base.example/v2/SECRETKEY?x=1"), "base.example", "shown and logged by host only");
  // The endpoint is asked for its chain id: another chain's endpoint is refused and nothing is kept.
  const answers: Record<string, string> = { "https://mine.example/base": "0x2105", "https://wrong.example/rpc": "0x1", "https://down.example/rpc": "" };
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    const { method } = JSON.parse(String(init?.body));
    if (url === "https://down.example/rpc" || url === "https://mine-down.example/base") return new Response("", { status: 503 });
    if (method === "eth_chainId") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answers[url] ?? "0x2105" }));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: url.includes("mine") ? "0xaaaa" : "0xbbbb" }));
  }) as typeof fetch;
  try {
    const base = networkById("eip155:8453")!;
    await assert.rejects(un.addRpc(base, "https://wrong.example/rpc"), /serves chain 1, not 8453/);
    await assert.rejects(un.addRpc(base, "https://down.example/rpc"), /didn't answer/);
    assert.deepEqual(userNetworksNow().rpcs, {}, "nothing kept after a refusal");
    await un.addRpc(base, "https://mine.example/base");
    const after = networkById("eip155:8453")!;
    assert.equal(after.rpc[0], "https://mine.example/base", "the user's endpoint is tried first");
    assert.deepEqual(after.rpc.slice(1), after.defaults, "then the registry's defaults");
    calls.length = 0;
    assert.equal(await rpc<string>(after.rpc, "eth_blockNumber"), "0xaaaa");
    assert.equal(calls[0], "https://mine.example/base");
    // When the user's endpoint is down, the defaults answer.
    await un.addRpc(base, "https://mine-down.example/base").catch(() => {}); // refused at add time (down), so simulate one that went down later:
    setUserNetworksNow({ ...userNetworksNow(), rpcs: { "eip155:8453": ["https://mine-down.example/base"] } });
    calls.length = 0;
    assert.equal(await rpc<string>(networkById("eip155:8453")!.rpc, "eth_getBalance"), "0xbbbb", "fell back to a default");
    const firstOther = calls.findIndex(c => c !== "https://mine-down.example/base");
    assert.ok(firstOther > 0, "the user's endpoint was tried first (its session check, then the call)");
    assert.equal(calls[firstOther], networkById("eip155:8453")!.defaults[0], "then the first default");
    // A preferred endpoint goes first; reset drops the user's own and their choice.
    await un.loadUserNetworks();
    await un.preferRpc("eip155:8453", base.defaults[2]!);
    assert.equal(networkById("eip155:8453")!.rpc[0], base.defaults[2]);
    await un.resetRpcs("eip155:8453");
    assert.deepEqual(networkById("eip155:8453")!.rpc, base.defaults);
    // A network the user adds: chain id checked, never one the registry has, marked custom, its coin never verified.
    await assert.rejects(un.addCustomNetwork({ name: "Base again", rpcUrl: "https://mine.example/base", chainId: 8453, symbol: "ETH", registryHas: registryHasChain }), /already has this network/);
    answers["https://new.example/rpc"] = "0x7a69";
    await assert.rejects(un.addCustomNetwork({ name: "Mine", rpcUrl: "https://new.example/rpc", chainId: 999_000, symbol: "MINE", registryHas: registryHasChain }), /serves chain 31337/);
    await un.addCustomNetwork({ name: "Local Chain", rpcUrl: "https://new.example/rpc", chainId: 31337, symbol: "tEth", explorerUrl: "https://scan.example", registryHas: registryHasChain });
    const custom = evmNetwork(31337)!;
    assert.equal(custom.custom, "user");
    assert.equal(custom.nativeSymbol, "TETH");
    assert.ok(networks(false).some(n => n.networkId === "eip155:31337"), "listed with the others");
    assert.ok(verifiedAssets(networks(false)).has(assetKey("eip155:8453", null)), "a registry coin is verified (the check is real)");
    assert.ok(!verifiedAssets(networks(false)).has(assetKey("eip155:31337", null)), "a custom network's coin never is");
    const listed = listAssets(networks(false), [], NO_PREFS).find(a => a.ref.networkId === "eip155:31337")!;
    assert.equal(listed.trust, "unverified");
    await un.removeCustomNetwork("eip155:31337");
    assert.equal(evmNetwork(31337), null);
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); setUserNetworksNow(EMPTY); await store.kept.set("user-networks", EMPTY); }
});

test("swap fee: from admin's public config, capped at 2%; off or without a recipient, none; a quote charging more is refused", async () => {
  const { feeFromConfig, checkAppFee, feePercent, swapFee, forgetSwapFee, MAX_FEE_BPS } = await import("../src/lib/swap-fee");
  const relay = await import("../src/lib/relay");
  const { networks } = await import("../src/lib/chains");
  const R = "0x9999999999999999999999999999999999999999";
  const cfg = (o: Record<string, unknown>) => ({ "extension.swapFee.enabled": true, "extension.swapFee.percent": 0.85, "extension.swapFee.recipient": R, ...o });
  assert.deepEqual(feeFromConfig(cfg({})), { bps: 85, recipient: R }, "applied");
  assert.equal(feeFromConfig(cfg({ "extension.swapFee.enabled": false })), null, "off");
  assert.equal(feeFromConfig(cfg({ "extension.swapFee.recipient": "" })), null, "no recipient: no fee");
  assert.equal(feeFromConfig(cfg({ "extension.swapFee.recipient": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" })), null, "a non-EVM recipient: no fee");
  assert.equal(feeFromConfig(cfg({ "extension.swapFee.percent": 0 })), null);
  assert.equal(feeFromConfig(cfg({ "extension.swapFee.recipient": `0x${"0".repeat(40)}` })), null, "the zero address: no fee");
  assert.equal(feeFromConfig(cfg({ "extension.swapFee.recipient": "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD" })), null, "a failed checksum: no fee");
  assert.equal(feeFromConfig(cfg({ "extension.swapFee.recipient": "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" }))?.recipient, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "lowercase: checksummed");
  assert.deepEqual(feeFromConfig(cfg({ "extension.swapFee.percent": 5 })), { bps: MAX_FEE_BPS, recipient: R }, "a bad config is capped at 2%");
  assert.equal(feeFromConfig(null), null, "no answer from the API: no fee");
  assert.equal(feePercent(85), "0.85%"); assert.equal(feePercent(200), "2%"); assert.equal(feePercent(50), "0.5%");
  // The quote's app fee against the fee shown (dollars, or the input token's own units).
  const quoteWith = (appUsd: string | null, amount = "0", currency = "0x0") => ({ fees: { app: { amount, amountUsd: appUsd, currency: { address: currency } } }, details: { currencyIn: { amountUsd: "1000" } } });
  const fee = { bps: 85, recipient: R }, input = { amountRaw: 10n ** 9n, currency: "0xUSDC" };
  assert.equal(checkAppFee(quoteWith("8.5"), fee, input), 8.5);
  assert.equal(checkAppFee(quoteWith("8.6"), fee, input), 8.6, "rounding is allowed");
  assert.throws(() => checkAppFee(quoteWith("9.5"), fee, input), /more than the MAXXING fee shown/);
  assert.throws(() => checkAppFee(quoteWith("1", "100"), null, input), /fee you weren't shown/);
  assert.equal(checkAppFee(quoteWith(null, "0"), null, input), null, "no fee, none charged");
  assert.equal(checkAppFee(quoteWith(null, "8500000", "0xusdc"), fee, input), null, "checked in the input token: 0.85% of 1,000");
  assert.throws(() => checkAppFee(quoteWith(null, "9900000", "0xusdc"), fee, input), /more than the MAXXING fee/);
  assert.throws(() => checkAppFee(quoteWith(null, "5", "0xother"), fee, input), /couldn't be checked/);
  // Through quote(): the fee is asked of Relay as an app fee, and a quote charging more is refused before anything is prepared.
  const base = networks(false).find(n => n.networkId === "eip155:8453")!;
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const eth = { network: base, address: null, symbol: "ETH", decimals: 18 } as never, usdc = { network: base, address: USDC, symbol: "USDC", decimals: 6 } as never;
  const user = "0x1111111111111111111111111111111111111111";
  let sent: any = null, appUsd = "8.5";
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/config")) return new Response(JSON.stringify({ values: cfg({}) }));
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ steps: [], fees: { app: { amount: appUsd === "0" ? "0" : "1", amountUsd: appUsd, currency: { address: "0x0" } },
        gas: { amountFormatted: "0.00002", amountUsd: "0.05", currency: { symbol: "ETH" } }, relayer: { amountUsd: "0.3" } },
      details: { recipient: user, currencyIn: { amountUsd: "1000" }, currencyOut: { amountFormatted: "1000", currency: { chainId: 8453, address: USDC, decimals: 6 } } } }));
  }) as typeof fetch;
  try {
    forgetSwapFee();
    assert.deepEqual(await swapFee(), { bps: 85, recipient: R }, "read from the API's public config");
    const q = await relay.quote({ from: eth, to: usdc, amountRaw: 10n ** 18n, user, recipient: user });
    assert.deepEqual(sent.appFees, [{ recipient: R, fee: "85" }]);
    assert.deepEqual(q.maxxingFee, { bps: 85, usd: 8.5 });
    assert.deepEqual(q.networkFee, { amount: 0.00002, symbol: "ETH", usd: 0.05 }, "your own transaction's network fee, on its own line");
    assert.equal(q.feesUsd, 0.3, "Relay's fees are what comes out of the price, not the network fee on top");
    appUsd = "12";
    await assert.rejects(relay.quote({ from: eth, to: usdc, amountRaw: 10n ** 18n, user, recipient: user }), /more than the MAXXING fee shown/);
    appUsd = "0";
    const none = await relay.quote({ from: eth, to: usdc, amountRaw: 10n ** 18n, user, recipient: user, fee: null });
    assert.equal(sent.appFees, undefined, "fee off: no app fee asked");
    assert.equal(none.maxxingFee, null);
    const capped = await relay.quote({ from: eth, to: usdc, amountRaw: 10n ** 18n, user, recipient: user, fee: { bps: 900, recipient: R } }).catch(() => null);
    assert.deepEqual(sent.appFees, [{ recipient: R, fee: "200" }], "never more than 2% asked, whatever is passed");
    void capped;
  } finally { globalThis.fetch = real; forgetSwapFee(); }
});

test("added networks can't pass for listed ones; a repointed RPC is dropped; fees capped; balances from their own chain, unpriced", async () => {
  const un = await import("../src/lib/user-networks");
  const { setUserNetworksNow, userNetworksNow, EMPTY } = await import("../src/lib/user-networks-state");
  const { registryNameTaken, registryHasChain, networkById, evmNetwork, networkLabel } = await import("../src/lib/chains");
  const { draftEvmCall } = await import("../src/lib/send");
  const { loadPortfolio } = await import("../src/lib/balances");
  const { chainIcon } = await import("../src/ui/logos");
  const { rpc, RETRY_WAITS_MS } = await import("../src/lib/rpc");
  const waits = [...RETRY_WAITS_MS]; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  await store.kept.set("user-networks", EMPTY); setUserNetworksNow(EMPTY); un.forgetEndpointChecks();
  // Names that read as a listed network are refused, whatever the case, spacing or added words.
  for (const name of ["Ethereum", "ETHEREUM mainnet", "base", "Base Mainnet", "Arbitrum One", "B.A.S.E"]) assert.ok(registryNameTaken(name), name);
  for (const name of ["Local Test", "My Rollup", "Basement"]) assert.equal(registryNameTaken(name), null, name);
  const chainAnswer: Record<string, string> = { "https://own.example/base": "0x2105", "https://new.example/rpc": "0x7a69" };
  let tip = "0xba43b7400", baseFee = "0x3b9aca00"; // a 50 gwei tip asked, a 1 gwei base fee
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input), { method } = JSON.parse(String(init?.body ?? "{}"));
    calls.push(`${url} ${method}`);
    const result = method === "eth_chainId" ? chainAnswer[url] ?? "0x2105" : method === "eth_getBalance" ? "0xde0b6b3a7640000" : method === "eth_maxPriorityFeePerGas" ? tip
      : method === "eth_getBlockByNumber" ? { baseFeePerGas: baseFee } : method === "eth_getTransactionCount" ? "0x0" : method === "eth_estimateGas" ? "0x5208" : method === "eth_blockNumber" ? "0x1" : "0x";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;
  try {
    await assert.rejects(un.addCustomNetwork({ name: "Ethereum", rpcUrl: "https://new.example/rpc", chainId: 31337, symbol: "ETH", registryHas: registryHasChain }), /reads as Ethereum/);
    await assert.rejects(un.addCustomNetwork({ name: "Еthereum", rpcUrl: "https://new.example/rpc", chainId: 31337, symbol: "ETH", registryHas: registryHasChain }), /plain letters/, "a Cyrillic look-alike");
    await un.addCustomNetwork({ name: "Local Test", rpcUrl: "https://new.example/rpc", chainId: 31337, symbol: "USDC", registryHas: registryHasChain });
    const local = evmNetwork(31337)!;
    assert.equal(networkLabel(local), "Local Test (added by you)");
    assert.equal(chainIcon(local.networkId), null, "no branded chain logo");
    // Its tip is capped at 2 gwei and the review says so; a fee above 500 gwei is refused.
    const draft = await draftEvmCall({ network: local, from: "0x1111111111111111111111111111111111111111", call: { to: "0x2222222222222222222222222222222222222222", value: 1n } });
    assert.equal((draft.transaction as { maxPriorityFeePerGas: bigint }).maxPriorityFeePerGas, 2_000_000_000n);
    assert.equal(draft.feeCapped, true);
    const listed = await draftEvmCall({ network: networkById("eip155:8453")!, from: "0x1111111111111111111111111111111111111111", call: { to: "0x2222222222222222222222222222222222222222", value: 1n } });
    assert.equal((listed.transaction as { maxPriorityFeePerGas: bigint }).maxPriorityFeePerGas, 50_000_000_000n, "a listed network uses what the chain reports");
    baseFee = `0x${(400_000_000_000n).toString(16)}`; // 400 gwei: twice that is past the cap
    await assert.rejects(draftEvmCall({ network: local, from: "0x1111111111111111111111111111111111111111", call: { to: "0x2222222222222222222222222222222222222222", value: 1n } }), /above 500 gwei/);
    baseFee = "0x3b9aca00";
    // Home reads it from its own chain; a coin named USDC there gets no dollar value and no real logo.
    const p = await loadPortfolio({ evm: "0x1111111111111111111111111111111111111111", solana: "So11111111111111111111111111111111111111112" }, false, local.networkId);
    const coin = p.holdings.find(h => h.networkId === local.networkId)!;
    assert.equal(coin.name, "USDC on Local Test");
    assert.equal(coin.priced, false, "never priced from its name");
    assert.equal(coin.logo, undefined);
    // A user's RPC that now serves another chain is dropped the first time it's used this session; the defaults take over.
    await un.addRpc(networkById("eip155:8453")!, "https://own.example/base");
    un.forgetEndpointChecks();
    chainAnswer["https://own.example/base"] = "0x1";
    calls.length = 0;
    await rpc<string>(networkById("eip155:8453")!.rpc, "eth_blockNumber");
    assert.ok(!calls.includes("https://own.example/base eth_blockNumber"), "never asked for data");
    assert.deepEqual(userNetworksNow().rpcs["eip155:8453"] ?? [], [], "dropped");
    assert.ok((await store.activity.all()).some(a => /now serves chain 1, not 8453; it was removed/.test(a.text) && !a.text.includes("/base")), "noted by host only");
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); setUserNetworksNow(EMPTY); await store.kept.set("user-networks", EMPTY); un.forgetEndpointChecks(); }
});

test("wallet_addEthereumChain requests are read strictly", async () => {
  const { parseAddChain } = await import("../src/lib/user-networks");
  const ok = { chainId: "0x7a69", chainName: "Local Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["http://evil.example", "https://rpc.local.example"], blockExplorerUrls: ["https://scan.example"] };
  assert.deepEqual(parseAddChain([ok]), { chainId: 31337, name: "Local Chain", symbol: "ETH", rpcUrls: ["https://rpc.local.example"], explorerUrl: "https://scan.example" }, "only https endpoints are taken");
  assert.equal(parseAddChain([{ ...ok, nativeCurrency: { symbol: "ETH", decimals: 6 } }]), null, "the coin must have 18 decimals");
  assert.equal(parseAddChain([{ ...ok, rpcUrls: ["http://evil.example"] }]), null, "no https endpoint");
  assert.equal(parseAddChain([{ ...ok, chainId: "nope" }]), null);
  assert.equal(parseAddChain([{ ...ok, chainName: "" }]), null);
});

test("password guidance: the codes people guess first are refused with a reason; ordinary ones pass", async () => {
  const { weakPassword } = await import("../src/lib/password");
  // Digits only: 6 or more, no repeats, runs, patterns or the most used codes.
  for (const weak of ["000000", "777777", "123456", "654321", "345678", "121212", "123123", "112233", "12345", "12345678", "1234567890", "45454545"]) assert.ok(weakPassword(weak), weak);
  for (const fine of ["246810", "135790", "583014", "902817", "58301492"]) assert.equal(weakPassword(fine), null, fine);
  // With letters: 8 or more characters, not one character repeated, not a repeated pattern, not a most used password.
  for (const weak of ["hat2026", "aaaaaaaa", "Password", "qwerty123", "abcabcabc", "maxxing1", "x".repeat(129)]) assert.ok(weakPassword(weak), weak);
  for (const fine of ["Orbit-Hat-2046", "correct horse battery", "kXr9!pq2", "Café-Hat 2026"]) assert.equal(weakPassword(fine), null, fine);
});

test("token prices: a native coin is priced as the registry's wrapped token; a token as itself; nothing answers as no price", async () => {
  const { marketToken, price, chart } = await import("../src/lib/market");
  const { wrappedNative, KNOWN_SOLANA_MINTS } = await import("@maxxing/wallet-core/chains");
  const { shownNetworks } = await import("../src/lib/balances");
  for (const n of shownNetworks(false).filter(n => n.networkId.startsWith("eip155:"))) assert.equal(marketToken(n.networkId, null), wrappedNative(n.networkId)?.toLowerCase() ?? null, n.name);
  const sol = shownNetworks(false).find(n => n.networkId.startsWith("solana:"))!;
  assert.equal(KNOWN_SOLANA_MINTS[marketToken(sol.networkId, null)!]?.symbol, "SOL", "a Solana mint keeps its case");
  assert.equal(marketToken("eip155:8453", "0xABC"), "0xabc", "EVM addresses as the API names them: lowercase");
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 401 })) as typeof fetch;
  try {
    assert.deepEqual(await price("eip155:8453", null), { priceUsd: null, change24hPct: null }, "no answer is no price, never 0");
    assert.deepEqual(await chart("eip155:8453", null, "7d"), []);
  } finally { globalThis.fetch = real; }
});

test("networks and assets: the selector filters, defaults show at 0, the registry's tokens are verified, spam is hidden", async () => {
  const { shownNetworks } = await import("../src/lib/balances");
  const { defaultAssets, listAssets, trustOf, verifiedAssets, NO_PREFS, assetKey } = await import("../src/lib/assets");
  const { networks } = await import("../src/lib/chains");
  // Network filter: all enabled networks, or the one picked; test networks only when on.
  const mainnets = shownNetworks(false);
  assert.ok(mainnets.length > 5 && mainnets.every(n => !n.testnet));
  assert.ok(shownNetworks(true).some(n => n.testnet));
  assert.deepEqual(shownNetworks(false, "eip155:8453").map(n => n.networkId), ["eip155:8453"]);
  assert.deepEqual(shownNetworks(false, "eip155:84532"), [], "a test network isn't shown while they're off");
  // Defaults: every enabled network has its native coin; stables from the registry where it names them; never a duplicate.
  const defaults = defaultAssets(mainnets);
  for (const n of mainnets) assert.ok(defaults.some(a => a.networkId === n.networkId && a.address === null), `${n.name} has its native coin`);
  const base = defaults.filter(a => a.networkId === "eip155:8453").map(a => a.symbol);
  assert.ok(base.includes("ETH") && base.includes("USDC"));
  assert.ok(!base.includes("BRETT"), "listed non-stable tokens aren't defaults");
  const sol = defaults.filter(a => a.networkId === "solana:mainnet").map(a => a.symbol).sort();
  assert.deepEqual(sol, ["SOL", "USDC", "USDT"]);
  assert.equal(new Set(defaults.map(a => assetKey(a.networkId, a.address))).size, defaults.length);
  // Home's list: defaults at 0, held ones with their data, only the selected network's.
  const baseOnly = networks(false).filter(n => n.networkId === "eip155:8453");
  const held = [
    { networkId: "eip155:8453", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", name: "USD Coin", decimals: 6, usd: 12 },
    { networkId: "eip155:8453", address: "0x1111111111111111111111111111111111111111", symbol: "FROG", name: "Frog", decimals: 18, usd: 0 },
    { networkId: "eip155:8453", address: "0x2222222222222222222222222222222222222222", symbol: "CLAIM", name: "Visit claim-rewards.xyz", decimals: 18, usd: 0 },
    { networkId: "eip155:1", address: null, symbol: "ETH", name: "Ether", decimals: 18, usd: 50 },
  ];
  const list = listAssets(baseOnly, held, NO_PREFS);
  assert.ok(list.every(a => a.ref.networkId === "eip155:8453"), "other networks' holdings are filtered out");
  assert.equal(list.find(a => a.ref.symbol === "ETH")?.held, null, "Base ETH shows at 0");
  assert.equal(list.find(a => a.ref.symbol === "USDC")?.held?.usd, 12);
  assert.equal(list.find(a => a.ref.symbol === "USDC")?.trust, "verified");
  assert.equal(list.find(a => a.ref.symbol === "FROG")?.trust, "unverified");
  assert.equal(list.find(a => a.ref.symbol === "CLAIM"), undefined, "spam is hidden by default");
  assert.equal(listAssets(baseOnly, held, { ...NO_PREFS, showSpam: true }).find(a => a.ref.symbol === "CLAIM")?.trust, "spam");
  // Hidden by the user, and custom tokens added by address.
  const hiddenUsdc = listAssets(baseOnly, held, { ...NO_PREFS, hidden: [assetKey("eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")] });
  assert.equal(hiddenUsdc.find(a => a.ref.symbol === "USDC"), undefined);
  const custom = listAssets(baseOnly, [], { ...NO_PREFS, custom: [{ networkId: "eip155:8453", address: "0x3333333333333333333333333333333333333333", symbol: "MINE", name: "MINE", decimals: 18 }] });
  assert.equal(custom.find(a => a.ref.symbol === "MINE")?.custom, true);
  // A token that pretends to be a registry one by name is still unverified (the address decides).
  assert.equal(trustOf({ networkId: "eip155:8453", address: "0x4444444444444444444444444444444444444444", symbol: "USDC", name: "USD Coin" }, verifiedAssets(baseOnly)), "unverified");
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

test("the pages connect over https (any endpoint, for the user's own RPCs), plain http only locally, scripts only their own", async () => {
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
  assert.match(csp, /script-src 'self';/, "scripts: the extension's own only");
  assert.match(csp, /connect-src 'self' https: http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*;/, "https anywhere (custom RPCs), http only on this computer");
  assert.ok(!csp.includes("[::1]"), "no IPv6 literal: Chrome rejects it in a CSP source list");
  assert.ok(!/connect-src[^;]*\bhttp:(\s|;|$)/.test(csp), "never plain http elsewhere");
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
  assert.deepEqual(await checkRecipient("0xabcdef1111111111111111111111111111119999"), { firstTime: false, lookalike: null, contact: null });
  assert.equal((await checkRecipient("0xabcdef2222222222222222222222222222229999")).lookalike, "0xabcdef1111111111111111111111111111119999");
  assert.deepEqual(await checkRecipient("0x9999999999999999999999999999999999999999"), { firstTime: true, lookalike: null, contact: null });
});

test("address book: contacts by name, recents keep Solana's case, a contact's look-alike is flagged", async () => {
  const { book } = await import("../src/lib/send");
  await store.kept.set("contacts", []);
  const evm = "0x1234561111111111111111111111111111115678", sol = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  await assert.rejects(book.saveContact({ address: evm, family: "EVM", name: "  " }), /name/);
  await assert.rejects(book.saveContact({ address: "nope", family: "EVM", name: "Bad" }), /isn't valid/);
  await book.saveContact({ address: evm, family: "EVM", name: "Alex" });
  await book.saveContact({ address: sol, family: "SOLANA", name: "Sam" });
  await book.saveContact({ address: evm.toUpperCase().replace("0X", "0x"), family: "EVM", name: "Alex 2" }); // same address, any case: replaced
  assert.deepEqual((await book.contacts()).map(c => c.name), ["Alex 2", "Sam"]);
  assert.deepEqual(await checkRecipient(evm), { firstTime: false, lookalike: null, contact: "Alex 2" }, "a contact isn't a first-time recipient");
  assert.equal((await checkRecipient("0x1234569999999999999999999999999999995678")).lookalike, evm.toLowerCase(), "looks like a contact");
  assert.equal((await book.contacts()).find(c => c.family === "SOLANA")!.address, sol, "Solana addresses keep their case");
  await book.removeContact(sol);
  assert.deepEqual((await book.contacts()).map(c => c.name), ["Alex 2"]);
});

test("send max keeps the real fee: a draft's gas × max fee, plus the L1 data fee on OP-stack chains; SOL empties to exactly 0", async () => {
  const { maxSendable } = await import("../src/lib/send");
  const { networks } = await import("../src/lib/chains");
  const { RETRY_WAITS_MS } = await import("../src/lib/rpc");
  const waits = [...RETRY_WAITS_MS]; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  const all = networks(true), base = all.find(n => n.networkId === "eip155:8453")!, eth = all.find(n => n.networkId === "eip155:1")!, sol = all.find(n => n.networkId === "solana:mainnet")!;
  assert.equal(base.l1FeeOracle, "0x420000000000000000000000000000000000000F", "the oracle comes from the registry");
  assert.equal(eth.l1FeeOracle, undefined);
  const FROM = "0x1111111111111111111111111111111111111111";
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    calls.push(method === "eth_call" ? `eth_call:${params[0].to}` : method);
    const result = ({ eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, eth_maxPriorityFeePerGas: "0x0", eth_getTransactionCount: "0x0", eth_estimateGas: "0x5208",
      eth_call: `0x${(10n ** 12n).toString(16)}` } as Record<string, unknown>)[method] ?? null; // 1 gwei base, no tip, 21000 gas, L1 fee 0.000001 ETH
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;
  try {
    // The draft: gas 21000 × 1.2 = 25200 at a max fee of 2 gwei = 0.0000504 ETH; with a quarter more headroom, 0.000063 ETH.
    assert.deepEqual(await maxSendable(eth, { raw: String(10n ** 18n), address: null, decimals: 18 }, FROM), { amount: "0.999937", keep: 63_000_000_000_000n });
    assert.ok(!calls.some(c => c.startsWith("eth_call")), "no L1 fee off the OP stack");
    // Base adds 1.5 × its L1 data fee, read from the oracle: (0.0000504 + 0.0000015) × 1.25.
    calls.length = 0;
    assert.deepEqual(await maxSendable(base, { raw: String(10n ** 18n), address: null, decimals: 18 }, FROM), { amount: "0.999935125", keep: 64_875_000_000_000n });
    assert.ok(calls.includes("eth_call:0x420000000000000000000000000000000000000F"));
    assert.deepEqual(await maxSendable(base, { raw: "1000", address: null, decimals: 18 }, FROM), { amount: "0", keep: 64_875_000_000_000n }, "never below zero");
    assert.deepEqual(await maxSendable(base, { raw: "2500000", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 }, FROM), { amount: "2.5", keep: 0n }, "a token sends all");
    assert.deepEqual(await maxSendable(sol, { raw: "1000000000", address: null, decimals: 9 }, "x"), { amount: "0.999995", keep: 5_000n }, "SOL: all but the fee, the account ends at 0");
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); }
});

test("Max at review: a base fee that rose after Max was pressed is covered, from the review draft's own fee", async () => {
  const { maxSendable, draftEvmMaxSend, maxFeeOf } = await import("../src/lib/send");
  const { networks } = await import("../src/lib/chains");
  const { RETRY_WAITS_MS } = await import("../src/lib/rpc");
  const waits = [...RETRY_WAITS_MS]; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  const base = networks(false).find(n => n.networkId === "eip155:8453")!;
  const FROM = "0x1111111111111111111111111111111111111111", TO = "0x2222222222222222222222222222222222222222", balance = 10n ** 18n;
  let baseFee = 1_000_000_000n;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_: string, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body));
    const result = ({ eth_getBlockByNumber: { baseFeePerGas: `0x${baseFee.toString(16)}` }, eth_maxPriorityFeePerGas: "0x0", eth_getTransactionCount: "0x0", eth_estimateGas: "0x5208",
      eth_call: `0x${(10n ** 12n).toString(16)}` } as Record<string, unknown>)[method] ?? null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;
  try {
    const shown = await maxSendable(base, { raw: String(balance), address: null, decimals: 18 }, FROM, TO);
    baseFee = 3_000_000_000n; // the network got busier before the user pressed Review
    const draft = await draftEvmMaxSend({ network: base, from: FROM, to: TO, balance });
    const tx = draft.transaction as { value?: bigint; gas?: bigint; maxFeePerGas?: bigint };
    const fee = maxFeeOf(tx), l1 = 10n ** 12n;
    assert.equal(tx.maxFeePerGas, 6_000_000_000n, "the review draft's fee is today's");
    assert.equal(tx.value, balance - (fee + l1 * 3n / 2n) * 5n / 4n, "value = balance − that draft's max fee and L1 fee, with headroom");
    assert.ok(tx.value! + fee + l1 <= balance, "what it can cost fits the balance");
    assert.ok(tx.value! < BigInt(Math.round(Number(shown.amount) * 1e18)), "less than shown when fees were lower");
    assert.equal(draft.kind, "send");
    baseFee = 10n ** 16n; // fees above the whole balance
    await assert.rejects(draftEvmMaxSend({ network: base, from: FROM, to: TO, balance }), /doesn't cover the network fee/);
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); }
});

test("SOL sends follow the rent rule: emptying to 0 is fine; leaving dust below the minimum, or funding a new address below it, is refused", async () => {
  const { draftSolSend } = await import("../src/lib/send");
  const { networks } = await import("../src/lib/chains");
  const { RETRY_WAITS_MS } = await import("../src/lib/rpc");
  const waits = [...RETRY_WAITS_MS]; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  const sol = networks(false).find(n => n.networkId === "solana:mainnet")!;
  const FROM = bs58.encode(new Uint8Array(32).fill(1)), TO = bs58.encode(new Uint8Array(32).fill(2));
  let theirs = 5_000_000;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_: string, init?: RequestInit) => {
    const { method, params } = JSON.parse(String(init?.body));
    const result = method === "getBalance" ? { value: params[0] === FROM ? 1_000_000_000 : theirs } : method === "getMinimumBalanceForRentExemption" ? 890_880
      : method === "getLatestBlockhash" ? { value: { blockhash: bs58.encode(new Uint8Array(32).fill(3)) } } : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;
  try {
    assert.equal((await draftSolSend({ network: sol, from: FROM, to: TO, amount: "0.999995" })).lamports, 999_995_000n, "Max: the account ends at exactly 0");
    assert.equal((await draftSolSend({ network: sol, from: FROM, to: TO, amount: "0.5" })).lamports, 500_000_000n);
    await assert.rejects(draftSolSend({ network: sol, from: FROM, to: TO, amount: "0.9995" }), /below Solana's minimum/, "leaves 0.000495 SOL");
    await assert.rejects(draftSolSend({ network: sol, from: FROM, to: TO, amount: "1" }), /more than this account holds/);
    theirs = 0;
    await assert.rejects(draftSolSend({ network: sol, from: FROM, to: TO, amount: "0.0001" }), /must receive at least/, "a new address below the minimum");
    assert.ok(await draftSolSend({ network: sol, from: FROM, to: TO, amount: "0.01" }));
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); }
});

test("approvals: noted from approve/permit/collection calls (not revokes), read live from chain, revoked with a zero approval", async () => {
  const { approvalInTransaction, approvalsInPermit, approvals, readApprovals, revokeCall } = await import("../src/lib/approvals");
  const { networks } = await import("../src/lib/chains");
  const { RETRY_WAITS_MS } = await import("../src/lib/rpc");
  const { encodeFunctionData, parseAbi, decodeFunctionData, maxUint256 } = await import("viem");
  const abi = parseAbi(["function approve(address,uint256)", "function setApprovalForAll(address,bool)", "function transfer(address,uint256)"]);
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", SPENDER = "0x1111111111111111111111111111111111111111", NFT = "0x2222222222222222222222222222222222222222";
  assert.deepEqual(approvalInTransaction(8453, { to: USDC, data: encodeFunctionData({ abi, functionName: "approve", args: [SPENDER, 5n] }) }), { networkId: "eip155:8453", token: USDC, spender: SPENDER, kind: "token" });
  assert.equal(approvalInTransaction(8453, { to: USDC, data: encodeFunctionData({ abi, functionName: "approve", args: [SPENDER, 0n] }) }), null, "a revoke isn't an approval");
  assert.equal(approvalInTransaction(8453, { to: USDC, data: encodeFunctionData({ abi, functionName: "transfer", args: [SPENDER, 5n] }) }), null);
  assert.equal(approvalInTransaction(8453, { to: NFT, data: encodeFunctionData({ abi, functionName: "setApprovalForAll", args: [SPENDER, true] }) })?.kind, "collection");
  assert.equal(approvalInTransaction(999_999_999, { to: USDC, data: encodeFunctionData({ abi, functionName: "approve", args: [SPENDER, 5n] }) }), null, "unknown network");
  assert.deepEqual(approvalsInPermit({ primaryType: "Permit", domain: { chainId: 8453, verifyingContract: USDC }, message: { spender: SPENDER, value: "100" } }), [{ networkId: "eip155:8453", token: USDC, spender: SPENDER, kind: "token" }]);
  assert.deepEqual(approvalsInPermit({ primaryType: "Permit", domain: { chainId: 1, verifyingContract: NFT }, message: { holder: SPENDER, spender: SPENDER, allowed: true } })[0]?.kind, "token", "DAI-style permit: allowed");
  assert.deepEqual(approvalsInPermit({ primaryType: "Permit", domain: { chainId: 1, verifyingContract: NFT }, message: { holder: SPENDER, spender: SPENDER, allowed: false } }), [], "allowed: false takes it back");
  // Permit2: one token or a batch, each with its amount, for the spender; the allowance lives in Permit2.
  const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  assert.deepEqual(approvalsInPermit({ primaryType: "PermitSingle", domain: { chainId: 8453, verifyingContract: PERMIT2 }, message: { spender: SPENDER, details: { token: USDC, amount: "5" } } }),
    [{ networkId: "eip155:8453", token: USDC, spender: SPENDER, kind: "permit2" }]);
  assert.equal(approvalsInPermit({ primaryType: "PermitBatch", domain: { chainId: 8453, verifyingContract: PERMIT2 }, message: { spender: SPENDER, details: [{ token: USDC, amount: "5" }, { token: NFT, amount: "0" }] } }).length, 1, "a zero amount gives nothing");
  const p2abi = parseAbi(["function approve(address,address,uint160,uint48)"]);
  assert.equal(approvalInTransaction(8453, { to: PERMIT2, data: encodeFunctionData({ abi: p2abi, functionName: "approve", args: [USDC, SPENDER, 5n, 9_999_999_999] }) })?.kind, "permit2");
  assert.deepEqual(decodeFunctionData({ abi: p2abi, data: revokeCall({ token: USDC, spender: SPENDER, kind: "permit2" }).data }).args, [USDC, SPENDER, 0n, 0]);
  assert.equal(revokeCall({ token: USDC, spender: SPENDER, kind: "permit2" }).to, PERMIT2);
  assert.deepEqual(approvalsInPermit({ primaryType: "Mail", domain: {}, message: {} }), []);

  await store.kept.set("approvals", []);
  await approvals.note({ networkId: "eip155:8453", token: USDC.toLowerCase(), spender: SPENDER, kind: "token", origin: "https://app.example" });
  await approvals.note({ networkId: "eip155:8453", token: USDC, spender: NFT, kind: "token" });
  await approvals.note({ networkId: "eip155:8453", token: NFT, spender: SPENDER, kind: "collection" });
  await approvals.note({ networkId: "eip155:8453", token: USDC, spender: SPENDER, kind: "token", origin: "https://again.example" }); // same one: moves up
  assert.equal((await approvals.all()).length, 3);
  // The chain says: USDC→SPENDER unlimited, USDC→NFT spent (0), the collection access still on.
  const waits = [...RETRY_WAITS_MS]; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  const real = globalThis.fetch;
  globalThis.fetch = (async (_: string, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body));
    const data: string = params[0].data;
    const result = data.startsWith("0xdd62ed3e") ? (data.toLowerCase().includes(NFT.slice(2).toLowerCase()) ? "0x0" : `0x${maxUint256.toString(16)}`) : data.startsWith("0xe985e9c5") ? `0x${"0".repeat(63)}1` : "0x";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;
  try {
    const live = await readApprovals("0x3333333333333333333333333333333333333333", await approvals.all(), networks(false));
    assert.deepEqual(live.map(a => [a.symbol, a.amount, a.kind, a.origin ?? null]).sort(), [["Collection", "All items", "collection", null], ["USDC", "Unlimited", "token", "https://again.example"]].sort());
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); }
  // Permit2: read from Permit2 itself; an expired allowance is gone.
  const { encodeAbiParameters } = await import("viem");
  const now = 1_800_000_000_000;
  globalThis.fetch = (async (_: string, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body));
    const toUsdc = params[0].data.toLowerCase().includes(USDC.slice(2).toLowerCase());
    const result = encodeAbiParameters([{ type: "uint160" }, { type: "uint48" }, { type: "uint48" }], [5_000_000n, toUsdc ? now / 1000 + 3600 : now / 1000 - 1, 0]);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  }) as typeof fetch;
  RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  try {
    const p2 = [{ networkId: "eip155:8453", token: USDC, spender: SPENDER, kind: "permit2" as const, at: 0 }, { networkId: "eip155:8453", token: NFT, spender: SPENDER, kind: "permit2" as const, at: 0 }];
    const live = await readApprovals("0x3333333333333333333333333333333333333333", p2, networks(false), now);
    assert.deepEqual(live.map(a => [a.symbol, a.amount, a.verified]), [["USDC", "5 USDC", true]], "the expired one is left out");
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); }
  const revoke = revokeCall({ token: USDC, spender: SPENDER, kind: "token" });
  assert.equal(revoke.to, USDC);
  assert.deepEqual(decodeFunctionData({ abi, data: revoke.data }).args, [SPENDER, 0n]);
  assert.deepEqual(decodeFunctionData({ abi, data: revokeCall({ token: NFT, spender: SPENDER, kind: "collection" }).data }).args, [SPENDER, false]);
});

test("ENS: only .eth names; invalid names don't resolve; no network answer is no address", async () => {
  const { isEnsName, resolveEns } = await import("../src/lib/ens");
  const { RETRY_WAITS_MS } = await import("../src/lib/rpc");
  assert.ok(isEnsName("vitalik.eth") && isEnsName("pay.alex.eth"));
  assert.ok(!isEnsName("alex.xyz") && !isEnsName("0x1234") && !isEnsName(".eth") && !isEnsName("a b.eth"));
  const real = globalThis.fetch, waits = [...RETRY_WAITS_MS];
  RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0);
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("", { status: 503 }); }) as typeof fetch;
  try {
    assert.equal(await resolveEns("not-a-name"), null);
    assert.equal(calls, 0, "nothing is asked for a non-name");
    assert.equal(await resolveEns("alex.eth"), null, "no answer: no address, never a guess");
  } finally { globalThis.fetch = real; RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, ...waits); }
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

test("balances: when the API lists only MAXXING's tokens, coins come from the chain and are priced by the Data API", async () => {
  const { loadPortfolio } = await import("../src/lib/balances");
  const owner = "0x1111111111111111111111111111111111111111", sol = "So11111111111111111111111111111111111111112";
  let complete = false; const rpcCalls: string[] = [], priceCalls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/balances")) return new Response(JSON.stringify({ items: [], complete, source: complete ? "codex" : "maxxing" }));
    if (url.includes("/v1/public/prices")) {
      priceCalls.push(url);
      const ids = decodeURIComponent(url.split("ids=")[1]!).split(",");
      return new Response(JSON.stringify({ items: ids.map(id => ({ id, priceUsd: "2000.5", change24hPct: "-1.5" })) }));
    }
    const { method } = JSON.parse(String(init?.body ?? "{}"));
    rpcCalls.push(method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x" }));
  }) as typeof fetch;
  try {
    const p = await loadPortfolio({ evm: owner, solana: sol }, false, "eip155:8453");
    const eth = p.holdings.find(h => h.networkId === "eip155:8453" && !h.address)!;
    assert.ok(eth, "the coin is read from the chain, not left out because the API answered");
    assert.equal(eth.amount, "1");
    assert.equal(eth.usd, 2000.5, "valued at the Data API's price");
    assert.equal(eth.priced, true);
    assert.equal(eth.change, -1.5);
    assert.equal(priceCalls.length, 1);
    assert.match(decodeURIComponent(priceCalls[0]!), /ids=eip155:1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2$/, "ETH is priced once, as Ethereum's wrapped token, whatever the network");
    // A complete answer is the whole picture: nothing is read from the chain.
    complete = true; rpcCalls.length = 0;
    const whole = await loadPortfolio({ evm: owner, solana: sol }, false, "eip155:8453");
    assert.equal(whole.holdings.length, 0);
    assert.deepEqual(rpcCalls, []);
  } finally { globalThis.fetch = real; }
});
