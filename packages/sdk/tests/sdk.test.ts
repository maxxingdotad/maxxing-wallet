import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectionStore } from "../src/connection";
import { MaxxingEthereumProvider, announceProvider } from "../src/ethereum";
import { MaxxingSolanaWallet, registerWallet } from "../src/solana";
import { WalletWindow, type HostWindow } from "../src/transport";
import { networksFor } from "../src/index";
import { WALLET_PROTOCOL } from "../src/protocol";

const WALLET = "https://wallet.maxxing.ad";
const CONNECTION = { evm: "0x1111111111111111111111111111111111111111" as const, solana: "11111111111111111111111111111112" };
type Sent = { id: string; method: string; params?: any; app: string; protocol: string; v: number };

/** A browser stand-in: `open` returns a fake wallet window whose answers come from `answer`. */
function fakeHost(answer: (request: Sent) => unknown | { error: { message: string; code?: number } }, opts: { block?: boolean; autoReady?: boolean } = {}) {
  const target = new EventTarget();
  const opened: string[] = [];
  const sent: Sent[] = [];
  let intervals: (() => void)[] = [];
  const popup = {
    closed: false,
    focus() {},
    close() { this.closed = true; },
    postMessage(message: Sent, origin: string) {
      assert.equal(origin, WALLET, "requests go only to the wallet's origin");
      sent.push(message);
      queueMicrotask(() => {
        const result = answer(message);
        if (result === undefined) return;
        const body = result && typeof result === "object" && "error" in (result as object) ? { ok: false, error: (result as { error: unknown }).error } : { ok: true, result };
        deliver({ protocol: WALLET_PROTOCOL, v: 1, id: message.id, ...body });
      });
    },
  };
  function deliver(data: unknown, origin = WALLET, source: unknown = popup) {
    target.dispatchEvent(Object.assign(new Event("message"), { data, origin, source }));
  }
  const host = {
    open: (url: string) => { opened.push(url); if (opts.block) return null; popup.closed = false; if (opts.autoReady !== false) queueMicrotask(() => deliver({ protocol: WALLET_PROTOCOL, v: 1, event: "ready" })); return popup; },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    setInterval: (fn: () => void) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => { intervals = []; },
    setTimeout,
  } as unknown as HostWindow;
  const tick = () => { for (const fn of [...intervals]) fn(); };
  return { host, opened, sent, popup, deliver, tick };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
}

function setup(answer: Parameters<typeof fakeHost>[0], opts?: Parameters<typeof fakeHost>[1], fetcher?: typeof fetch) {
  const fake = fakeHost(answer, opts);
  const transport = new WalletWindow({ appId: "app_0123456789abcdef0123", walletUrl: WALLET, host: fake.host, dialog: false });
  const storage = memoryStorage();
  const store = new ConnectionStore("app_0123456789abcdef0123", storage);
  const networks = networksFor({ chains: [8453, 84532], rpcUrls: { 84532: ["https://rpc.example/base-sepolia"] } });
  const ethereum = new MaxxingEthereumProvider(transport, store, networks, 84532, fetcher);
  const solana = new MaxxingSolanaWallet(transport, store, ["solana:mainnet", "solana:devnet"]);
  return { ...fake, transport, store, storage, ethereum, solana };
}

test("connecting opens the wallet window for this app and remembers only the addresses", async () => {
  const { ethereum, opened, sent, storage } = setup(request => request.method === "connect" ? CONNECTION : undefined);
  const changes: unknown[] = [];
  ethereum.on("accountsChanged", accounts => changes.push(accounts));
  assert.deepEqual(await ethereum.request({ method: "eth_accounts" }), []);
  assert.deepEqual(await ethereum.request({ method: "eth_requestAccounts" }), [CONNECTION.evm]);
  assert.equal(opened[0], `${WALLET}/connect.html?app=app_0123456789abcdef0123`);
  assert.equal(sent[0]!.app, "app_0123456789abcdef0123");
  assert.equal(sent[0]!.protocol, "maxxing-wallet");
  assert.equal(sent[0]!.v, 1);
  assert.deepEqual(changes, [[CONNECTION.evm]]);
  assert.deepEqual(await ethereum.request({ method: "eth_accounts" }), [CONNECTION.evm]);
  assert.deepEqual(JSON.parse([...storage.map.values()][0]!), { connection: CONNECTION, chainId: null });
  // A second request does not open the wallet again.
  await ethereum.request({ method: "eth_requestAccounts" });
  assert.equal(opened.length, 1);
});

test("answers from another origin or another window are ignored", async () => {
  const { ethereum, deliver, sent } = setup(() => undefined);
  const pending = ethereum.request({ method: "eth_requestAccounts" });
  await new Promise(resolve => setTimeout(resolve, 5));
  const id = sent[0]!.id;
  deliver({ protocol: WALLET_PROTOCOL, v: 1, id, ok: true, result: { evm: "0x2222222222222222222222222222222222222222", solana: CONNECTION.solana } }, "https://evil.example");
  deliver({ protocol: WALLET_PROTOCOL, v: 1, id, ok: true, result: { evm: "0x2222222222222222222222222222222222222222", solana: CONNECTION.solana } }, WALLET, {});
  deliver({ protocol: WALLET_PROTOCOL, v: 1, id, ok: true, result: CONNECTION });
  assert.deepEqual(await pending, [CONNECTION.evm]);
});

test("the wallet's refusals keep their EIP-1193 codes, and closing the window rejects", async () => {
  const { ethereum, popup, tick } = setup(() => ({ error: { code: 4001, message: "User rejected the request." } }));
  await assert.rejects(ethereum.request({ method: "eth_requestAccounts" }), (error: any) => error.code === 4001);
  const second = setup(() => undefined);
  const pending = second.ethereum.request({ method: "eth_requestAccounts" });
  await new Promise(resolve => setTimeout(resolve, 5));
  second.popup.close();
  await new Promise(resolve => setTimeout(resolve, 1100));
  second.tick();
  await assert.rejects(pending, (error: any) => error.code === 4001 && /closed/.test(error.message));
  void popup; void tick;
});

test("signing goes to the wallet with the connected address; other addresses and eth_sign are refused", async () => {
  const { ethereum, sent } = setup(request => request.method === "connect" ? CONNECTION : request.method === "evm.signMessage" ? "0xsig" : undefined);
  await assert.rejects(ethereum.request({ method: "personal_sign", params: ["0x68656c6c6f", CONNECTION.evm] }), (error: any) => error.code === 4100);
  await ethereum.request({ method: "eth_requestAccounts" });
  assert.equal(await ethereum.request({ method: "personal_sign", params: ["0x68656c6c6f", CONNECTION.evm] }), "0xsig");
  assert.deepEqual(sent.at(-1)!.params, { address: CONNECTION.evm, message: { raw: "0x68656c6c6f" } });
  await ethereum.request({ method: "personal_sign", params: [CONNECTION.evm, "plain text"] });
  assert.deepEqual(sent.at(-1)!.params, { address: CONNECTION.evm, message: "plain text" });
  await assert.rejects(ethereum.request({ method: "personal_sign", params: ["hi", "0x2222222222222222222222222222222222222222"] }), (error: any) => error.code === 4100);
  await assert.rejects(ethereum.request({ method: "eth_sign", params: [CONNECTION.evm, "0x00"] }), (error: any) => error.code === 4200);
  await assert.rejects(ethereum.request({ method: "eth_signTypedData_v4", params: [CONNECTION.evm, JSON.stringify({ domain: { chainId: 1 }, types: {}, primaryType: "X", message: {} })] }), /another network/);
});

test("a wallet switched since connecting disconnects the app", async () => {
  const { ethereum } = setup(request => request.method === "connect" ? CONNECTION : { error: { code: 4100, message: "WALLET_CHANGED" } });
  await ethereum.request({ method: "eth_requestAccounts" });
  const events: string[] = [];
  ethereum.on("disconnect", () => events.push("disconnect"));
  await assert.rejects(ethereum.request({ method: "personal_sign", params: ["hi", CONNECTION.evm] }), (error: any) => error.code === 4100);
  assert.deepEqual(await ethereum.request({ method: "eth_accounts" }), []);
  assert.deepEqual(events, ["disconnect"]);
});

test("networks: switching only to supported chains", async () => {
  const { ethereum, store } = setup(() => undefined);
  assert.equal(await ethereum.request({ method: "eth_chainId" }), "0x14a34");
  const changed: unknown[] = [];
  ethereum.on("chainChanged", id => changed.push(id));
  await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] });
  assert.deepEqual(changed, ["0x2105"]);
  assert.equal(store.chainId, 8453);
  await assert.rejects(ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x99999" }] }), (error: any) => error.code === 4902);
  assert.throws(() => networksFor({ chains: [424242] }), /UNSUPPORTED_CHAIN/);
  assert.ok(networksFor({ chains: [8453] })[0]!.rpcUrls.every(url => !/alchemy|api-key/i.test(url)), "only public endpoints reach the browser");
});

test("transactions are filled from the network, confirmed in the wallet, then sent", async () => {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const answers: Record<string, unknown> = { eth_getTransactionCount: "0x7", eth_estimateGas: "0x5208", eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, eth_maxPriorityFeePerGas: "0x5f5e100", eth_sendRawTransaction: "0xhash" };
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, method: body.method, params: body.params });
    if (url.includes("rpc.example")) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answers[body.method] }));
  }) as typeof fetch;
  const { ethereum, sent } = setup(request => request.method === "connect" ? CONNECTION : request.method === "evm.signTransaction" ? "0xsigned" : undefined, {}, fetcher);
  await ethereum.request({ method: "eth_requestAccounts" });
  const hash = await ethereum.request({ method: "eth_sendTransaction", params: [{ from: CONNECTION.evm, to: "0x3333333333333333333333333333333333333333", value: "0x1" }] });
  assert.equal(hash, "0xhash");
  assert.equal(calls[0]!.url, "https://rpc.example/base-sepolia", "the app's own endpoint is tried first");
  const tx = sent.at(-1)!.params.transaction;
  assert.equal(sent.at(-1)!.method, "evm.signTransaction");
  assert.deepEqual({ ...tx }, { chainId: 84532, nonce: 7, gas: 25200n, value: 1n, to: "0x3333333333333333333333333333333333333333", type: "eip1559", maxFeePerGas: 2_100_000_000n, maxPriorityFeePerGas: 100_000_000n });
  assert.deepEqual(calls.filter(c => c.method === "eth_sendRawTransaction").at(-1)!.params, ["0xsigned"]);
  await assert.rejects(ethereum.request({ method: "eth_sendTransaction", params: [{ from: CONNECTION.evm, to: "0x3333333333333333333333333333333333333333", chainId: "0x1" }] }), /another network/);
  assert.equal(await ethereum.request({ method: "eth_blockNumber" }), undefined, "reads pass straight to the network");
  await assert.rejects(ethereum.request({ method: "eth_coinbase" }), (error: any) => error.code === 4200);
});

test("Solana Wallet Standard: silent connect, message and transaction signing", async () => {
  const signature = new Uint8Array(64).fill(7);
  const { solana, sent } = setup(request => request.method === "connect" ? CONNECTION : request.method === "solana.signMessage" ? signature : request.method === "solana.signTransaction" ? new Uint8Array([9, 9]) : undefined);
  assert.deepEqual(await solana.features["standard:connect"].connect({ silent: true }), { accounts: [] });
  const changes: number[] = [];
  solana.features["standard:events"].on("change", ({ accounts }) => changes.push(accounts?.length ?? -1));
  const { accounts } = await solana.features["standard:connect"].connect();
  assert.equal(accounts[0]!.address, CONNECTION.solana);
  assert.equal(accounts[0]!.publicKey.length, 32);
  assert.deepEqual(changes, [1]);
  const message = new TextEncoder().encode("hello");
  const [signed] = await solana.features["solana:signMessage"].signMessage({ account: accounts[0]!, message });
  assert.deepEqual(signed!.signature, signature);
  assert.equal(sent.at(-1)!.params.address, CONNECTION.solana);
  const [tx] = await solana.features["solana:signTransaction"].signTransaction({ account: accounts[0]!, transaction: new Uint8Array([1, 2]), chain: "solana:devnet" });
  assert.deepEqual(tx!.signedTransaction, new Uint8Array([9, 9]));
  await assert.rejects(solana.features["solana:signTransaction"].signTransaction({ account: accounts[0]!, transaction: new Uint8Array([1]), chain: "solana:testnet" }), /doesn't support/);
  await solana.features["standard:disconnect"].disconnect();
  assert.equal(solana.accounts.length, 0);
});

test("the wallet announces itself to EIP-6963 and Wallet Standard apps", () => {
  const target = new EventTarget();
  const { ethereum, solana } = setup(() => undefined);
  const seen: any[] = [];
  target.addEventListener("eip6963:announceProvider", event => seen.push((event as CustomEvent).detail));
  const info = announceProvider(ethereum, target as unknown as Window);
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  assert.equal(seen.length, 2);
  assert.equal(seen[0].info.rdns, "ad.maxxing.wallet");
  assert.equal(seen[0].info.uuid, info.uuid);
  assert.equal(seen[0].provider, ethereum);
  const registered: unknown[] = [];
  target.addEventListener("wallet-standard:register-wallet", event => (event as unknown as { detail: (api: { register: (w: unknown) => void }) => void }).detail({ register: w => registered.push(w) }));
  registerWallet(solana, target as unknown as Window);
  target.dispatchEvent(Object.assign(new Event("wallet-standard:app-ready"), { detail: { register: (w: unknown) => registered.push(w) } }));
  assert.deepEqual(registered, [solana, solana]);
});

test("by default a partner site is offered mainnets only; a test network comes only when the app names it", () => {
  const defaults = networksFor({});
  assert.ok(defaults.length > 0);
  assert.ok(defaults.every(network => !network.testnet), "no test network by default");
  assert.ok(!defaults.some(network => network.chainId === 84532 || network.chainId === 11155111));
  assert.equal(networksFor({ chains: [84532] })[0]?.testnet, true, "a named test network still works");
});
