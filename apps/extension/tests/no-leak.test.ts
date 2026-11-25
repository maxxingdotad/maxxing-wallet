import { localData, chromeData, tabMessages } from "./env";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import ts from "typescript";
import type { Asset } from "../src/lib/relay";
import { recoverTypedDataAddress } from "viem";

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
const RELAY_BASE = JSON.parse(readFileSync(new URL("./fixtures/relay-chain-base.json", import.meta.url), "utf8"));
let leftoverAllowance = 0n, approveEstimateFails = false, allowanceDown = false;
let supportMode: "normal" | "down" | "auth-header" | "eip3009" = "normal";
let quoteDetails: () => { recipient?: string; currency?: Record<string, unknown> } = () => ({});
let quoteSteps: () => unknown[] = () => [{ id: "deposit", action: "Confirm swap", kind: "transaction", requestId: "0xreq", items: [{ status: "incomplete", data: { from: user, to: RELAY_ROUTER, data: "0x", value: "1000", chainId: 8453, gas: "90000", maxFeePerGas: "999999999999999" } }] }];
globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
  const url = String(input), body = typeof init?.body === "string" ? init.body : "";
  sent.push({ url, headers: JSON.stringify(init?.headers ?? {}), body });
  if (url.includes("api.maxxing.ad")) return new Response(JSON.stringify({ error: "API_KEY_INVALID" }), { status: 401 });
  // Relay's real Base entry (recorded): routers, multicallers, receivers, approval proxies, the depository and its solvers.
  if (url.includes("api.relay.link/chains")) return new Response(JSON.stringify({ chains: [RELAY_BASE] }));
  if (url.includes("api.relay.link/quote")) {
    const asked = JSON.parse(body);
    return new Response(JSON.stringify({
      steps: quoteSteps(),
      details: {
        recipient: asked.recipient, ...quoteDetails(),
        currencyIn: { amountFormatted: "0.000001", amountUsd: "0.01" },
        currencyOut: { amountFormatted: "0.009", amountUsd: "0.009", minimumAmount: "8000", currency: { decimals: 6, chainId: asked.destinationChainId, address: asked.destinationCurrency, ...quoteDetails().currency } },
        totalImpact: { percent: "-0.1" }, timeEstimate: 4,
      },
      fees: { gas: { amountUsd: "0.001" } },
    }));
  }
  if (url.includes("api.relay.link/execute/")) return new Response(JSON.stringify({ message: "Success" }));
  if (url.includes("api.relay.link")) return new Response(JSON.stringify({ status: "success" }));
  const { method, params } = JSON.parse(body || "{}");
  // An approval that can't be estimated while a non-zero allowance stands (USDT's rule), when a test asks for it.
  if (method === "eth_estimateGas" && approveEstimateFails && String(params?.[0]?.data).startsWith("0x095ea7b3") && !String(params[0].data).endsWith("0".repeat(64)))
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } }));
  // allowance(owner, spender): what's left over from earlier approvals (0 unless a test sets it).
  if (method === "eth_call" && String(params?.[0]?.data).startsWith("0xdd62ed3e") && allowanceDown) return new Response("", { status: 503 });
  if (method === "eth_call" && String(params?.[0]?.data).startsWith("0xdd62ed3e")) return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${leftoverAllowance.toString(16).padStart(64, "0")}` }));
  // A simulated receiveWithAuthorization: USDC has it (rejects the dummy signature); other tokens don't (an empty revert).
  if (method === "eth_call" && String(params?.[0]?.data).startsWith("0xef55bec6")) {
    if (supportMode === "down") return new Response("", { status: 503 });
    if (supportMode === "auth-header") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "authorization header required" } }));
    const usdcLike = supportMode === "eip3009" || String(params[0].to).toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 3, message: usdcLike ? "execution reverted: ECRecover: invalid signature" : "execution reverted" } }));
  }
  const answers: Record<string, unknown> = {
    eth_getBalance: "0xde0b6b3a7640000", eth_call: `0x${ADDRESS_HEX}${"0".repeat(39)}1`, eth_getTransactionCount: "0x0", eth_estimateGas: "0x5208",
    eth_getBlockByNumber: { baseFeePerGas: "0x3b9aca00" }, eth_maxPriorityFeePerGas: "0x1", eth_gasPrice: "0x1", eth_sendRawTransaction: `0x${"ab".repeat(32)}`,
    eth_getTransactionReceipt: { status: "0x1" }, getBalance: { value: 2_000_000_000 }, getTokenAccountsByOwner: { value: [] },
    getLatestBlockhash: { value: { blockhash: "11111111111111111111111111111111" } }, sendTransaction: "5".repeat(64),
  };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answers[method] ?? null }));
}) as typeof fetch;

const { RETRY_WAITS_MS } = await import("../src/lib/rpc");
RETRY_WAITS_MS.splice(0, RETRY_WAITS_MS.length, 0, 0); // endpoints that are down here are down on purpose: no waiting between rounds
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
  const arbEth: Asset = { network: all.find(n => n.networkId === "eip155:42161")!, address: null, symbol: "ETH", decimals: 18 };

  await loadPortfolio(open, true);
  await sendEvm(await draftEvmSend({ network: base, from: open.evm, to: "0x2222222222222222222222222222222222222222", amount: "0.01", token: null }));
  await sendEvm(await draftEvmSend({ network: base, from: open.evm, to: "0x2222222222222222222222222222222222222222", amount: "5", token: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 } }));
  await sendSol(await draftSolSend({ network: solana, from: open.solana, to: bs58.encode(new Uint8Array(32).fill(7)), amount: "0.1" }), open.solana);
  user = open.evm;
  const eth: Asset = { network: base, address: null, symbol: "ETH", decimals: 18 }, usdc: Asset & { address: string } = { network: base, address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 };
  const quote = await relay.quote({ from: eth, to: usdc, amountRaw: 1000n, user: open.evm, recipient: open.evm });
  const prepared = await relay.prepare(quote, open.evm, eth);
  // Fees are set from the network (base fee 1 gwei × 2 + tip), not from the quote's maxFeePerGas.
  const first = prepared.steps[0]!;
  assert.ok(first.kind === "transaction");
  assert.equal(first.transaction.maxFeePerGas, 2_000_000_001n);
  assert.equal(prepared.maxFee, first.transaction.gas! * 2_000_000_001n);
  await relay.execute(prepared, () => {});

  // Relay's transactions are checked before anything is signed.
  const swapTo = async (step: Record<string, unknown>, pay = eth) => relay.prepare(await relay.quote({ from: pay, to: usdc, amountRaw: 1000n, user: open.evm, recipient: open.evm }), open.evm, pay);
  const step = (data: Record<string, unknown>) => { quoteSteps = () => [{ id: "x", action: "x", kind: "transaction", requestId: "0xreq", items: [{ status: "incomplete", data: { from: open.evm, to: RELAY_ROUTER, data: "0x", value: "0", chainId: 8453, ...data } }] }]; return {}; };
  await assert.rejects(swapTo(step({ to: "0x9999999999999999999999999999999999999999" })), /isn't one of Relay's pinned contracts/);
  await assert.rejects(swapTo(step({ from: "0x9999999999999999999999999999999999999999" })), /isn't from your address/);
  await assert.rejects(swapTo(step({ chainId: 1 })), /another network/);
  const approveFor = (spender: string) => `0x095ea7b3${spender.slice(2).padStart(64, "0")}${"f".repeat(64)}`;
  await assert.rejects(swapTo(step({ to: usdc.address, data: approveFor("0x9999999999999999999999999999999999999999") }), usdc), /approval/);
  await assert.rejects(swapTo(step({ to: "0xdAC17F958D2ee523a2206206994597C13D831ec7", data: approveFor(RELAY_PROXY) }), usdc), /approval/, "an approval of another token");
  assert.equal((await swapTo(step({ to: usdc.address, data: approveFor(RELAY_PROXY) }), usdc)).steps.length, 1, "approving the paid token to a Relay contract is fine");

  // Gasless: one authorization for exactly the amount, to a Relay contract, short-lived; signed and handed to Relay's execute endpoint.
  const now = Math.floor(Date.now() / 1000);
  const authorization = (value: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    quoteSteps = () => [{ id: "authorize1", action: "Sign authorization", kind: "signature", items: [{ status: "incomplete", data: {
      sign: { signatureKind: "eip712", primaryType: "ReceiveWithAuthorization", domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: usdc.address.toLowerCase() },
        types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
        value: { from: open.evm, to: RELAY_PROXY, value: "1000", validAfter: 0, validBefore: now + 6 * 3600, nonce: `0x${"ab".repeat(32)}`, ...value } },
      post: { endpoint: "/execute/permits", method: "POST", body: { kind: "eip3009", requestId: "0xreq", api: "swap" } }, ...extra } }] }];
    return relay.quote({ from: usdc, to: arbEth, amountRaw: 1000n, user: open.evm, recipient: open.evm, gasless: true }).then(q => relay.prepare(q, open.evm, usdc));
  };
  const gasless = await authorization();
  assert.equal(gasless.gasless, true);
  assert.equal(gasless.maxFee, 0n, "no network fee from the user");
  assert.match((gasless.steps[0] as { text: string }).text, /exactly 0.001 USDC/);
  assert.ok(sent.filter(r => r.url.includes("/quote/v2")).at(-1)!.body.includes("\"usePermit\":true"), "the quote asked for the gasless route");
  await relay.execute(gasless, () => {});
  const posted = sent.at(-1)!;
  assert.match(posted.url, /^https:\/\/api\.relay\.link\/execute\/permits\?signature=0x[0-9a-f]{130}$/);
  const signature = decodeURIComponent(posted.url.split("signature=")[1]!) as `0x${string}`;
  const typed = (gasless.steps[0] as unknown as { typedData: Record<string, unknown> }).typedData;
  assert.equal((await recoverTypedDataAddress({ ...typed, signature } as unknown as Parameters<typeof recoverTypedDataAddress>[0])).toLowerCase(), open.evm.toLowerCase(), "signed by the user, as shown");
  await assert.rejects(authorization({ value: "1001" }), /exactly the amount/);
  await assert.rejects(authorization({ to: "0x9999999999999999999999999999999999999999" }), /approval contracts/);
  await assert.rejects(authorization({ from: "0x9999999999999999999999999999999999999999" }), /your address/);
  await assert.rejects(authorization({ validBefore: now + 30 * 24 * 3600 }), /too long/);
  await assert.rejects(authorization({}, { post: { endpoint: "https://elsewhere.example/steal", method: "POST", body: {} } }), /somewhere unexpected/);

  // Spenders: only Relay's approval proxies and depository may be given tokens. Never a multicaller (anyone can make it call
  // transferFrom), the receiver, a router or a solver's own address, even though transactions may go to those.
  const { targets, spenders } = relay.relayContractSets(RELAY_BASE);
  assert.deepEqual([...spenders].sort(), ["0x4cd00e387622c35bddb9b4c962c136462338bc31", "0x5567954cd026cebfe486062cb75848e0f1c12e58", "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be"]);
  const notSpenders = { multicall3: RELAY_BASE.contracts.multicall3, multicaller: RELAY_BASE.contracts.multicaller, onlyOwnerMulticaller: RELAY_BASE.contracts.onlyOwnerMulticaller,
    relayReceiver: RELAY_BASE.contracts.relayReceiver, erc20Router: RELAY_BASE.contracts.erc20Router, solver: RELAY_BASE.solverAddresses[0] };
  for (const [name, address] of Object.entries(notSpenders)) {
    assert.ok(targets.has(address.toLowerCase()), `${name} is still a transaction target`);
    await assert.rejects(authorization({ to: address }), /approval contracts/, `no authorization to ${name}`);
    await assert.rejects(swapTo(step({ to: usdc.address, data: approveFor(address) }), usdc), /approval contracts/, `no approval for ${name}`);
  }
  // Only EIP-3009 is signed gasless: a permit (or Permit2) would leave an allowance behind.
  const permit = { sign: { signatureKind: "eip712", primaryType: "Permit", domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: usdc.address.toLowerCase() },
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    value: { owner: open.evm, spender: RELAY_PROXY, value: "1000", nonce: 0, deadline: now + 3600 } } };
  await assert.rejects(authorization({}, permit), /doesn't sign gasless \(Permit\)/);
  await assert.rejects(authorization({}, { sign: { ...permit.sign, primaryType: "ReceiveWithAuthorization", types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }] } } }), /standard EIP-3009/);
  await assert.rejects(authorization({ validAfter: now + 3600 }), /starts later/);
  assert.match((gasless.steps[0] as { text: string }).text, /0xccc8…15be.*once.*expires \w{3} \d{1,2}, \d{4}/, "names the contract, says once, and gives the date with the time");

  // (a) A gasless authorization may name only an approval proxy, not the depository (which may still receive a plain approval).
  const depository = RELAY_BASE.protocol.v2.depository;
  assert.ok(spenders.has(depository) && !relay.relayContractSets(RELAY_BASE).authorizers.has(depository));
  await assert.rejects(authorization({ to: depository }), /approval contracts/);
  assert.equal((await swapTo(step({ to: usdc.address, data: approveFor(depository) }), usdc)).steps.length, 1);
  // (b) An approval for more than the swap ("unlimited") is signed for exactly the swap's amount.
  const capped = (await swapTo(step({ to: usdc.address, data: approveFor(RELAY_PROXY) }), usdc)).steps[0]!;
  assert.ok(capped.kind === "transaction");
  assert.equal(capped.transaction.data, `0x095ea7b3${RELAY_PROXY.slice(2).padStart(64, "0")}${(1000).toString(16).padStart(64, "0")}`);
  const exact = `0x095ea7b3${RELAY_PROXY.slice(2).padStart(64, "0")}${(500).toString(16).padStart(64, "0")}`;
  assert.equal(((await swapTo(step({ to: usdc.address, data: exact }), usdc)).steps[0] as { transaction: { data: string } }).transaction.data, exact, "a smaller approval stays as it is");
  // (c) Gasless only for a token the approval proxy can redeem EIP-3009 from (simulated): USDC yes, another token no.
  assert.equal(await relay.gaslessAvailable(usdc), true);
  const dai: Asset & { address: string } = { network: base, address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 };
  assert.equal(await relay.gaslessAvailable(dai), false);
  assert.equal(await relay.gaslessAvailable(eth), false, "the coin itself has nothing to authorize");
  quoteSteps = () => [{ id: "authorize1", action: "Sign authorization", kind: "signature", items: [{ status: "incomplete", data: {
    sign: { signatureKind: "eip712", primaryType: "ReceiveWithAuthorization", domain: { name: "Dai", version: "1", chainId: 8453, verifyingContract: dai.address.toLowerCase() },
      types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      value: { from: open.evm, to: RELAY_PROXY, value: "1000", validAfter: 0, validBefore: now + 3600, nonce: `0x${"cd".repeat(32)}` } },
    post: { endpoint: "/execute/permits", method: "POST", body: {} } } }] }];
  await assert.rejects(relay.quote({ from: dai, to: arbEth, amountRaw: 1000n, user: open.evm, recipient: open.evm, gasless: true }).then(q => relay.prepare(q, open.evm, dai)), /can't pay the network fee from the swap/);
  // (d) Coins sent along: exactly the swap's amount when paying with the coin; none when paying with a token.
  await assert.rejects(swapTo(step({ to: depository, value: "999" })), /different amount/);
  await assert.rejects(swapTo(step({ to: depository, value: "2000" })), /different amount/);
  assert.equal((await swapTo(step({ value: "1000" }))).steps.length, 1, "a swap on one network: exactly the amount to the router");
  // (4) Coins go to a depository or receiver; a router only for exactly the amount in a swap on one network; a multicaller never.
  await assert.rejects(swapTo(step({ value: "999" })), /shouldn't receive them/, "router, not the exact amount");
  await assert.rejects(swapTo(step({ to: RELAY_BASE.contracts.multicaller, value: "1000" })), /shouldn't receive them/);
  await assert.rejects(swapTo(step({ to: RELAY_BASE.contracts.multicall3, value: "1000" })), /shouldn't receive them/);
  assert.equal((await swapTo(step({ to: RELAY_BASE.contracts.relayReceiver, value: "1000" }))).steps.length, 1, "the receiver may take coins");
  const bridge = async (data: Record<string, unknown>) => { step(data); return relay.prepare(await relay.quote({ from: eth, to: arbEth, amountRaw: 1000n, user: open.evm, recipient: open.evm }), open.evm, eth); };
  await assert.rejects(bridge({ value: "1000" }), /shouldn't receive them/, "across networks, the router takes no coins");
  assert.equal((await bridge({ to: depository, value: "1000" })).steps.length, 1, "across networks, the depository does");
  await assert.rejects(swapTo(step({ to: usdc.address, data: exact, value: "1" }), usdc), /sends coins/);
  await assert.rejects(swapTo(step({ to: depository, value: "1" }), usdc), /sends coins as well/, "a token route's deposit sends no coin");

  // (5) Gasless only across networks, enforced when preparing too (not only by the swap screen).
  quoteSteps = () => [{ id: "authorize1", action: "Sign authorization", kind: "signature", items: [{ status: "incomplete", data: {
    sign: { signatureKind: "eip712", primaryType: "ReceiveWithAuthorization", domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: usdc.address.toLowerCase() },
      types: { ReceiveWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      value: { from: open.evm, to: RELAY_PROXY, value: "1000", validAfter: 0, validBefore: now + 3600, nonce: `0x${"ef".repeat(32)}` } },
    post: { endpoint: "/execute/permits", method: "POST", body: {} } } }] }];
  await assert.rejects(relay.quote({ from: usdc, to: eth, amountRaw: 1000n, user: open.evm, recipient: open.evm, gasless: true }).then(q => relay.prepare(q, open.evm, usdc)), /between networks only/);

  // (6, D, E) Approvals: an approve step then the deposit, the way Relay sends a token route.
  const route = (approveData: string) => { quoteSteps = () => [
    { id: "approve", action: "Approve", kind: "transaction", items: [{ status: "incomplete", data: { from: open.evm, to: usdc.address, data: approveData, value: "0", chainId: 8453 } }] },
    { id: "deposit", action: "Deposit", kind: "transaction", items: [{ status: "incomplete", data: { from: open.evm, to: depository, data: "0x", value: "0", chainId: 8453 } }] },
  ]; return {}; };
  const swapWith = async (approveData: string) => { route(approveData); return swapTo({}, usdc); };
  const txOf = (s: unknown) => (s as { transaction: { data: string; nonce: number; gas: bigint } }).transaction;
  // A leftover allowance that is non-zero and too small: reset to 0 first, as its own step. The approval after it gets a fixed
  // gas limit, because estimating it fails until the reset lands (USDT refuses to change a non-zero allowance).
  leftoverAllowance = 500n; approveEstimateFails = true;
  const withReset = await swapWith(exact);
  assert.deepEqual(withReset.steps.map(s => s.label), ["Reset the old allowance to 0 (this token requires it)", "Approve", "Deposit"]);
  assert.equal(txOf(withReset.steps[0]).data, `0x095ea7b3${RELAY_PROXY.slice(2).padStart(64, "0")}${"0".repeat(64)}`);
  assert.equal(txOf(withReset.steps[1]).gas, 100_000n, "the approval after a reset has a fixed, safe gas limit");
  assert.deepEqual(withReset.steps.map(s => txOf(s).nonce), [0, 1, 2], "the reset goes first");
  approveEstimateFails = false;
  // Enough already allowed: Relay's approval is skipped, only the deposit is signed.
  leftoverAllowance = 5000n;
  assert.deepEqual((await swapWith(exact)).steps.map(s => s.label), ["Deposit"]);
  // The allowance can't be read: nothing is built (it isn't taken as 0).
  allowanceDown = true;
  await assert.rejects(swapWith(exact), /Couldn't read what this token already allows/);
  allowanceDown = false;
  leftoverAllowance = 0n;
  assert.deepEqual((await swapWith(exact)).steps.map(s => s.label), ["Approve", "Deposit"], "nothing allowed yet: approve, then deposit");
  // (5) The deposit re-reads the allowance right before it's signed: if it isn't what the review showed, the deposit isn't sent.
  const twoSteps = await swapWith(exact);
  assert.deepEqual((twoSteps.steps[1] as { needsAllowance?: { atLeast: bigint } }).needsAllowance?.atLeast, 1000n);
  const sendsBefore = sent.filter(r => r.body.includes("eth_sendRawTransaction")).length;
  await assert.rejects(relay.execute(twoSteps, () => {}), /isn't what the review showed/); // the approval "landed" but the allowance read is still 0
  const sendsAfter = sent.filter(r => r.body.includes("eth_sendRawTransaction")).length;
  assert.equal(sendsAfter, sendsBefore + 1, `only the approval was sent (${sendsBefore} → ${sendsAfter})`);
  leftoverAllowance = 1000n;
  assert.deepEqual(await relay.execute(await (async () => { leftoverAllowance = 0n; const p = await swapWith(exact); leftoverAllowance = 1000n; return p; })(), () => {}).then(h => h.length), 2, "allowance in place: approval and deposit");
  leftoverAllowance = 0n;

  // (F) Coins go only to Relay's pinned contracts: never to a solver's address, even though Relay's live list names it.
  await assert.rejects(swapTo(step({ to: RELAY_BASE.solverAddresses[0], value: "1000" })), /pinned contracts/);
  assert.equal((await swapTo(step({ to: depository, value: "1000" }))).steps.length, 1, "to the pinned depository is fine");
  await assert.rejects(swapTo(step({ to: usdc.address, data: exact, value: "5" }), usdc), /sends coins/);

  // (7) The token spenders come from the reviewed, pinned file. If Relay's live list differs, or the network isn't pinned,
  // approvals and gasless swaps are paused there.
  const live = relay.relayContractSets(RELAY_BASE);
  const trusted = relay.withPinnedSpenders(8453, live);
  assert.equal(trusted.paused, undefined, "the recorded Base list matches the pinned file");
  assert.deepEqual([...trusted.authorizers].sort(), ["0x5567954cd026cebfe486062cb75848e0f1c12e58", "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be"]);
  const moved = relay.relayContractSets({ ...RELAY_BASE, contracts: { ...RELAY_BASE.contracts, v4: { approvalProxy: "0x9999999999999999999999999999999999999999" } } });
  const pausedSets = relay.withPinnedSpenders(8453, moved);
  assert.equal(pausedSets.paused, true, "a new approval contract the file doesn't have pauses token spending");
  assert.equal(pausedSets.spenders.size + pausedSets.authorizers.size, 0);
  assert.ok(pausedSets.targets.size > 0, "swaps paying with the coin still have their targets");
  assert.equal(relay.withPinnedSpenders(424242, live).paused, true, "a network the file doesn't list is paused");
  assert.match(relay.PAUSED, /paused until the wallet is updated/);

  // (2, 3) Support is decided by the chain alone: an endpoint that is down or answers about its own auth decides nothing and
  // isn't remembered; the next check asks again.
  const fresh: Asset & { address: string } = { network: base, address: "0x1234567890123456789012345678901234567890", symbol: "TKN", decimals: 6 };
  supportMode = "down";
  assert.equal(await relay.gaslessAvailable(fresh), false);
  supportMode = "auth-header";
  assert.equal(await relay.gaslessAvailable(fresh), false);
  supportMode = "eip3009";
  assert.equal(await relay.gaslessAvailable(fresh), true, "asked again once the endpoint answers, and the chain says yes");
  supportMode = "normal";

  // The quote must deliver what was chosen: to the user, in the chosen token, on the chosen network.
  step({});
  quoteDetails = () => ({ recipient: "0x9999999999999999999999999999999999999999" });
  await assert.rejects(swapTo({}), /someone other than you/);
  quoteDetails = () => ({ currency: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" } });
  await assert.rejects(swapTo({}), /different token or network/);
  quoteDetails = () => ({ currency: { chainId: 1 } });
  await assert.rejects(swapTo({}), /different token or network/);
  quoteDetails = () => ({});

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
  // Named from the SDK's own src/ folder, so the key is the same however the package path resolves (Windows, Linux, symlinks).
  const inSdk = (file: string) => /(?:wallet-sdk|packages\/sdk)\/(src\/.+)$/.exec(file.replace(/\\/g, "/"))?.[1] ?? file;
  for (const file of inpageSdkFiles()) { const ways = waysOut(file); if (ways.length) found[inSdk(file)] = ways; }
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
    "src/lib/psl.ts": ["fetch"],                            // downloads the Public Suffix List: sends nothing
    "src/lib/lock.ts": ["sendMessage", "storage"],         // the open session in memory-only session storage; "check again" to tabs on lock
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
