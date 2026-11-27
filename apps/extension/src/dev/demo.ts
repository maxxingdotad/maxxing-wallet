/**
 * Development only (dev.html?demo): test mode. Every account holds the same made-up sample balances, and the networks' answers
 * are faked here, so Send, Receive and Swap can be clicked through to the end without real money and without anything reaching
 * a network: a "sent" transaction gets a made-up hash and confirms at once. Prices, charts and Relay's quotes stay real.
 * Never part of the extension build.
 */
import bs58 from "bs58";
import { keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { networks } from "../lib/chains";
import { API_URL } from "../lib/balances";
import { RELAY_API } from "../lib/relay";

type Row = [networkId: string, token: string, native: boolean, symbol: string, name: string, raw: string, decimals: number, usd: string];
const ZERO = "0x0000000000000000000000000000000000000000";
const SAMPLE: { evm: Row[]; solana: Row[] } = {
  evm: [
    ["eip155:1", ZERO, true, "ETH", "Ether", "420000000000000000", 18, "1302.00"],
    ["eip155:8453", ZERO, true, "ETH", "Ether", "180000000000000000", 18, "558.00"],
    ["eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", false, "USDC", "USD Coin", "1250000000", 6, "1250.00"],
    ["eip155:42161", ZERO, true, "ETH", "Ether", "50000000000000000", 18, "155.00"],
    ["eip155:42161", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", false, "USDC", "USD Coin", "340500000", 6, "340.50"],
  ],
  solana: [
    ["solana:mainnet", "So11111111111111111111111111111111111111112", true, "SOL", "Solana", "6800000000", 9, "1054.00"],
    ["solana:mainnet", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", false, "USDC", "USD Coin", "210000000", 6, "210.00"],
  ],
};

// Which network an endpoint belongs to, from the chain registry (so a balance read answers with that network's sample).
const byUrl = new Map<string, string>();
for (const n of networks(true)) for (const url of n.rpc) byUrl.set(url.replace(/\/+$/, ""), n.networkId);
const networkOf = (url: string) => byUrl.get(url.replace(/\/+$/, "")) ?? null;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;
const randomHex = (bytes: number) => `0x${[...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, "0")).join("")}`;
const sent = new Set<string>();
const nonces = new Map<string, number>();

/**
 * dev.html?demo&stuck: a sent EVM transaction stays waiting (a node has it, no block does), so speeding it up or cancelling it can
 * be clicked through. A second transaction with the same account and nonce lands at once, and the one it replaced is forgotten.
 */
const STUCK = new URLSearchParams(location.search).has("stuck");
const waiting = new Map<string, { networkId: string; nonce: number; answer: Record<string, string | null> }>();
async function takeWaiting(networkId: string, raw: `0x${string}`): Promise<string> {
  const tx = parseTransaction(raw), from = await recoverTransactionAddress({ serializedTransaction: raw as never }), hash = keccak256(raw), nonce = tx.nonce ?? 0;
  const rival = [...waiting].find(([, w]) => w.networkId === networkId && w.nonce === nonce && w.answer.from === from);
  if (rival) { waiting.delete(rival[0]); sent.add(hash); }
  else waiting.set(hash, { networkId, nonce, answer: {
    hash, from, to: tx.to ?? null, value: hex(tx.value ?? 0n), input: tx.data ?? "0x", nonce: hex(nonce), gas: hex(tx.gas ?? 0n), blockNumber: null,
    ...(tx.maxFeePerGas !== undefined ? { maxFeePerGas: hex(tx.maxFeePerGas), maxPriorityFeePerGas: hex(tx.maxPriorityFeePerGas ?? 0n) } : { gasPrice: hex(tx.gasPrice ?? 0n) }),
  } });
  nonces.set(networkId, Math.max(nonces.get(networkId) ?? 5, nonce + 1));
  return hash;
}

function evmAnswer(networkId: string | null, method: string, params: unknown[]): unknown {
  const native = SAMPLE.evm.find(r => r[0] === networkId && r[2]);
  switch (method) {
    case "eth_chainId": return hex(Number(networkId?.split(":")[1] ?? 1));
    case "eth_blockNumber": return "0x100";
    case "eth_getBlockByNumber": return { number: "0x100", baseFeePerGas: "0x989680", timestamp: hex(Math.floor(Date.now() / 1000)) };
    case "eth_gasPrice": return "0x1312d00";
    case "eth_maxPriorityFeePerGas": return "0xf4240";
    case "eth_estimateGas": return "0xfde8";
    case "eth_getTransactionCount": return hex(nonces.get(String(networkId)) ?? 5);
    case "eth_getBalance": return hex(BigInt(native?.[5] ?? "0"));
    case "eth_call": {
      const call = params[0] as { to?: string; data?: string };
      // A token balance: the sample's, for a token in the sample.
      if (call.data?.startsWith("0x70a08231")) {
        const row = SAMPLE.evm.find(r => r[0] === networkId && r[1].toLowerCase() === call.to?.toLowerCase());
        return `0x${BigInt(row?.[5] ?? "0").toString(16).padStart(64, "0")}`;
      }
      return `0x${"0".repeat(64)}`;
    }
    case "eth_sendRawTransaction": { const hash = randomHex(32); sent.add(hash); return hash; }
    case "eth_getTransactionByHash": return waiting.has(String(params[0])) ? waiting.get(String(params[0]))!.answer : sent.has(String(params[0])) ? { hash: params[0], blockNumber: "0x101", nonce: "0x5" } : null;
    case "eth_getTransactionReceipt": return sent.has(String(params[0])) ? { transactionHash: params[0], status: "0x1", blockNumber: "0x101", gasUsed: "0x5208", effectiveGasPrice: "0x1312d00", logs: [] } : null;
    default: return null;
  }
}

function solanaAnswer(method: string, params: unknown[]): unknown {
  const context = { slot: 1000 };
  switch (method) {
    case "getBalance": return { context, value: Number(SAMPLE.solana.find(r => r[2])![5]) };
    case "getSlot": return 1000;
    case "getLatestBlockhash": return { context, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 2000 } };
    case "getMinimumBalanceForRentExemption": return 890880;
    case "getTokenAccountsByOwner": return { context, value: [] };
    case "sendTransaction": {
      // The id of a Solana transaction is its first signature: bytes 1–64 of the signed transaction.
      const raw = Uint8Array.from(atob(String(params[0])), c => c.charCodeAt(0));
      const id = bs58.encode(raw.slice(1, 65));
      sent.add(id);
      return id;
    }
    case "getSignatureStatuses": return { context, value: (params[0] as string[]).map(id => sent.has(id) ? { slot: 1001, confirmations: null, err: null, confirmationStatus: "finalized" } : null) };
    default: return null;
  }
}

const realFetch = window.fetch.bind(window);
// The sample coins are valued at today's price (read once), so a swap's quote agrees with the balance; the amount written in
// the sample is the fallback when the price can't be read.
const live = new Map<string, Promise<number | null>>();
// From Relay (the Data API doesn't answer a page on localhost), so the balance and Relay's quote use the same price.
const coinPrice = (networkId: string) => {
  if (!live.has(networkId)) {
    const solana = networkId.startsWith("solana:");
    const query = solana ? "address=11111111111111111111111111111111&chainId=792703809" : `address=${ZERO}&chainId=${networkId.split(":")[1]}`;
    live.set(networkId, realFetch(`${RELAY_API}/currencies/token/price?${query}`).then(r => r.ok ? r.json() : null).then((b: { price?: unknown } | null) => typeof b?.price === "number" && b.price > 0 ? b.price : null, () => null));
  }
  return live.get(networkId)!;
};
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(`${API_URL}/v1/public/wallets/`)) {
    const address = decodeURIComponent(url.split("/wallets/")[1]!.split("/")[0]!);
    const rows = address.startsWith("0x") ? SAMPLE.evm : SAMPLE.solana;
    return json({ items: await Promise.all(rows.map(async ([chainId, address, native, symbol, name, balanceRaw, decimals, written]) => {
      const now = native ? await coinPrice(chainId) : null;
      const valueUsd = now === null ? written : (Number(balanceRaw) / 10 ** decimals * now).toFixed(2);
      return { chainId, address, native, symbol, name, imageUrl: null, balanceRaw, decimals, valueUsd };
    })) });
  }
  // Relay's status for a swap "sent" here: delivered.
  if (url.startsWith(`${RELAY_API}/intents/status`)) return json({ status: "success" });
  const body = typeof init?.body === "string" && init.body.includes('"jsonrpc"') ? JSON.parse(init.body) as { id: unknown; method: string; params?: unknown[] } | { id: unknown; method: string; params?: unknown[] }[] : null;
  if (body) {
    const networkId = networkOf(url);
    const solana = networkId?.startsWith("solana:") ?? false;
    const answer = async (one: { id: unknown; method: string; params?: unknown[] }) => {
      if (!solana && STUCK && one.method === "eth_sendRawTransaction") return { jsonrpc: "2.0", id: one.id, result: await takeWaiting(String(networkId), String(one.params?.[0]) as `0x${string}`) };
      // The next nonce on that network, so a second send in a row looks like a real one.
      if (!solana && one.method === "eth_sendRawTransaction") nonces.set(String(networkId), (nonces.get(String(networkId)) ?? 5) + 1);
      return { jsonrpc: "2.0", id: one.id, result: solana ? solanaAnswer(one.method, one.params ?? []) : evmAnswer(networkId, one.method, one.params ?? []) };
    };
    return json(Array.isArray(body) ? await Promise.all(body.map(answer)) : await answer(body));
  }
  return realFetch(input, init);
};
