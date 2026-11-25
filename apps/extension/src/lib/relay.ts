/**
 * Swaps and bridges through Relay's public API: any asset to any asset, across EVM chains and to Solana. Relay answers a quote
 * with the transactions to send (an approval when needed, then the deposit); each is filled here, shown through the wallet core's
 * review, signed by the core and sent through the chain's public RPC, one after another.
 */
import * as signing from "@maxxing/wallet-core/signing";
import { checkedTransaction, transactionSummary, type TransactionSummary } from "@maxxing/wallet-core/review";
import { evmNetwork, type Network } from "./chains";
import { rpc } from "./rpc";
import { activity } from "./store";
import { browserRpcUrls } from "@maxxing/wallet-sdk";

export const RELAY_API = "https://api.relay.link";
export const RELAY_SOLANA_CHAIN_ID = 792703809;
const EVM_NATIVE = "0x0000000000000000000000000000000000000000";
const SOLANA_NATIVE = "11111111111111111111111111111111";

export type Asset = { network: Network; address: string | null; symbol: string; decimals: number };
const relayChainId = (network: Network) => network.family === "SOLANA" ? RELAY_SOLANA_CHAIN_ID : network.evmChainId!;
const relayCurrency = (asset: Asset) => asset.address ?? (asset.network.family === "SOLANA" ? SOLANA_NATIVE : EVM_NATIVE);

type RelayTxData = { from: string; to: string; data: string; value: string; chainId: number; gas?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string };
type RelayStep = { id: string; action?: string; description?: string; kind: "transaction" | "signature"; requestId?: string; items: { status: string; data: RelayTxData }[] };
export type Quote = {
  requestId: string | null; steps: RelayStep[];
  amountIn: string; amountOut: string; minimumOut: string | null; amountOutUsd: number | null; amountInUsd: number | null;
  impactPercent: number | null; timeSeconds: number | null; feesUsd: number | null; rate: string | null;
};

export async function quote(input: { from: Asset; to: Asset; amountRaw: bigint; user: string; recipient: string; slippageBps?: number }): Promise<Quote> {
  if (input.from.network.family !== "EVM") throw new Error("Swaps from Solana come next. Swap from an EVM chain for now.");
  const body = {
    user: input.user, recipient: input.recipient, refundTo: input.user,
    originChainId: relayChainId(input.from.network), destinationChainId: relayChainId(input.to.network),
    originCurrency: relayCurrency(input.from), destinationCurrency: relayCurrency(input.to),
    amount: input.amountRaw.toString(), tradeType: "EXACT_INPUT",
    ...(input.slippageBps ? { slippageTolerance: String(input.slippageBps) } : {}),
  };
  const response = await fetch(`${RELAY_API}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", body: JSON.stringify(body) });
  const raw: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(raw?.message ?? `No route right now (${response.status}).`);
  const out = raw?.details?.currencyOut, inn = raw?.details?.currencyIn;
  const num = (v: unknown) => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    requestId: raw?.steps?.find((s: any) => s?.requestId)?.requestId ?? null,
    steps: Array.isArray(raw?.steps) ? raw.steps : [],
    amountIn: String(inn?.amountFormatted ?? ""), amountOut: String(out?.amountFormatted ?? "0"),
    minimumOut: out?.minimumAmount != null && out?.currency?.decimals != null ? (Number(out.minimumAmount) / 10 ** out.currency.decimals).toPrecision(6) : null,
    amountOutUsd: num(out?.amountUsd), amountInUsd: num(inn?.amountUsd),
    impactPercent: num(raw?.details?.totalImpact?.percent), timeSeconds: num(raw?.details?.timeEstimate),
    feesUsd: ["gas", "relayer", "app"].reduce<number | null>((sum, k) => { const v = num(raw?.fees?.[k]?.amountUsd); return v === null ? sum : (sum ?? 0) + v; }, null),
    rate: raw?.details?.rate != null ? String(raw.details.rate) : null,
  };
}

/** Every transaction the quote asks for, as the core's review shows it. Signature steps (gasless permits) aren't used here. */
export function quoteTransactions(q: Quote): { data: RelayTxData; summary: TransactionSummary; label: string }[] {
  const out: { data: RelayTxData; summary: TransactionSummary; label: string }[] = [];
  for (const step of q.steps) {
    if (step.kind !== "transaction") throw new Error("This route needs a signature step the extension doesn't run yet.");
    for (const item of step.items) {
      const tx = checkedTransaction({ chainId: item.data.chainId, to: item.data.to, data: item.data.data, value: BigInt(item.data.value || "0") });
      out.push({ data: item.data, summary: transactionSummary(tx), label: step.action ?? step.description ?? step.id });
    }
  }
  return out;
}

// ── Checking Relay's transactions before anything is signed ───────────────────────────────────────────────────────────────
/** Relay's own contracts on a chain (routers, receivers, depositories, solvers), from Relay's public chain list. */
const contractCache = new Map<number, Promise<Set<string>>>();
export function relayContracts(chainId: number): Promise<Set<string>> {
  if (!contractCache.has(chainId)) contractCache.set(chainId, (async () => {
    const response = await fetch(`${RELAY_API}/chains`, { credentials: "omit", referrerPolicy: "no-referrer" });
    const raw: any = await response.json().catch(() => ({}));
    const chain = (raw?.chains ?? []).find((c: any) => Number(c?.id) === chainId);
    const out = new Set<string>();
    const collect = (v: unknown) => { if (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v)) out.add(v.toLowerCase()); else if (v && typeof v === "object") for (const x of Object.values(v)) collect(x); };
    collect(chain?.contracts); collect(chain?.protocol); collect(chain?.solverAddresses);
    if (!out.size) { contractCache.delete(chainId); throw new Error("Couldn't read Relay's contracts for this network. Try again."); }
    return out;
  })());
  return contractCache.get(chainId)!;
}

const APPROVE = "0x095ea7b3";
/** Gas a Relay step may use at most when it can't be estimated yet (it runs after an approval that hasn't landed). */
const GAS_CEILING = 1_500_000n;

export type PreparedTx = { transaction: ReturnType<typeof checkedTransaction>; summary: TransactionSummary; label: string; urls: string[]; maxFee: bigint };
export type Prepared = { txs: PreparedTx[]; maxFee: bigint; nativeSymbol: string; chainId: number };

/**
 * Turns the quote into the exact transactions that will be signed, after checking each one:
 * - it is on the network you pay from, and from your own address;
 * - it goes to one of Relay's contracts (an approval: the token you pay with, letting only a Relay contract spend it);
 * - its fees are set here from the network, not taken from the quote; the gas limit is estimated here, or Relay's capped.
 * What `prepare` returns is shown in full (with the most the network fees can cost), and `execute` signs exactly that.
 */
export async function prepare(q: Quote, from: string, pay: Asset): Promise<Prepared> {
  const txs = quoteTransactions(q);
  const chainId = relayChainId(pay.network);
  const chain = evmNetwork(chainId);
  if (!chain) throw new Error(`Relay asked for a network the wallet doesn't know (${chainId}).`);
  const urls = browserRpcUrls(chain);
  const contracts = await relayContracts(chainId);
  const [nonce, block, tip] = await Promise.all([
    rpc<string>(urls, "eth_getTransactionCount", [from, "pending"]).then(Number),
    rpc<{ baseFeePerGas?: string } | null>(urls, "eth_getBlockByNumber", ["latest", false]),
    rpc<string>(urls, "eth_maxPriorityFeePerGas", []).then(BigInt).catch(() => 1_000_000n),
  ]);
  const fees = block?.baseFeePerGas
    ? { type: "eip1559" as const, maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + tip, maxPriorityFeePerGas: tip }
    : { type: "legacy" as const, gasPrice: BigInt(await rpc<string>(urls, "eth_gasPrice", [])) * 12n / 10n };
  const perGas = fees.type === "eip1559" ? fees.maxFeePerGas : fees.gasPrice;
  const out: PreparedTx[] = [];
  for (const [i, { data, summary, label }] of txs.entries()) {
    if (Number(data.chainId) !== chainId) throw new Error("Relay asked for a transaction on another network than the one you pay from. Nothing was signed.");
    if (data.from.toLowerCase() !== from.toLowerCase()) throw new Error("Relay's transaction isn't from your address. Nothing was signed.");
    const to = data.to.toLowerCase(), call = data.data.toLowerCase();
    if (call.startsWith(APPROVE)) {
      const spender = `0x${call.slice(34, 74)}`;
      if (to !== (pay.address ?? "").toLowerCase() || !contracts.has(spender)) throw new Error("Relay's approval isn't for the token you pay with, or not for a Relay contract. Nothing was signed.");
    } else if (!contracts.has(to)) throw new Error("Relay's transaction goes to an address that isn't one of Relay's contracts. Nothing was signed.");
    const value = BigInt(data.value || "0");
    const estimate = await rpc<string>(urls, "eth_estimateGas", [{ from, to: data.to, data: data.data, value: `0x${value.toString(16)}` }]).then(g => BigInt(g) * 12n / 10n).catch(() => null);
    const relayGas = data.gas ? BigInt(data.gas) : null;
    const gas = estimate ?? (relayGas && relayGas <= GAS_CEILING ? relayGas : null);
    if (!gas) throw new Error("Couldn't work out this route's network fee. Try again.");
    const transaction = checkedTransaction({ chainId, to: data.to, data: data.data, value, nonce: nonce + i, gas, ...fees });
    out.push({ transaction, summary, label, urls, maxFee: gas * perGas });
  }
  return { txs: out, maxFee: out.reduce((s, t) => s + t.maxFee, 0n), nativeSymbol: chain.nativeSymbol, chainId };
}

async function waitForReceipt(urls: string[], hash: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const receipt = await rpc<{ status: string } | null>(urls, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (receipt) { if (receipt.status !== "0x1") throw new Error("A transaction in the route failed on chain."); return; }
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error("The network is slow to confirm. Check Activity in a moment.");
}

/** Signs and sends exactly the prepared transactions, in order, waiting for each to land (an approval must land before the deposit). */
export async function execute(prepared: Prepared, onProgress: (text: string) => void): Promise<string[]> {
  const hashes: string[] = [];
  for (const [i, { transaction, label, urls }] of prepared.txs.entries()) {
    onProgress(`${label} (${i + 1} of ${prepared.txs.length})`);
    const raw = await signing.evmSignTransaction({ transaction });
    const hash = await rpc<string>(urls, "eth_sendRawTransaction", [raw]);
    hashes.push(hash);
    await waitForReceipt(urls, hash);
  }
  await activity.add({ kind: "send", text: `Swap/bridge sent through Relay (${hashes.length} transaction${hashes.length === 1 ? "" : "s"})` });
  return hashes;
}

export async function status(requestId: string): Promise<string> {
  const response = await fetch(`${RELAY_API}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { credentials: "omit" });
  const raw: any = await response.json().catch(() => ({}));
  return String(raw?.status ?? "waiting").toLowerCase();
}
