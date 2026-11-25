/**
 * Swaps and bridges through Relay's public API: any asset to any asset, across EVM chains and to Solana. Relay answers a quote
 * with what to sign: transactions (an approval when needed, then the deposit), each filled here, shown through the wallet core's
 * review, signed by the core and sent through the chain's public RPC; or, gasless, one authorization for exactly the amount,
 * after which Relay sends the transaction and takes the network fee out of the swap.
 */
import * as signing from "@maxxing/wallet-core/signing";
import { checkedTransaction, transactionSummary, typedDataSummary, type TransactionSummary, type TypedDataSummary } from "@maxxing/wallet-core/review";
import type { TypedDataDefinition } from "viem";
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
  requestId: string | null; steps: RelayStep[]; amountRaw: bigint; gasless: boolean;
  amountIn: string; amountOut: string; minimumOut: string | null; amountOutUsd: number | null; amountInUsd: number | null;
  impactPercent: number | null; timeSeconds: number | null; feesUsd: number | null; rate: string | null;
};

/**
 * A quote. `gasless` (paying with a token, not the network's coin): the user signs an EIP-3009 authorization for exactly the
 * amount, Relay sends the transaction and takes the network fee out of the swap, so no ETH is needed. Tokens or routes that would
 * need a lasting allowance (EIP-2612, Permit2) are refused at review, not signed.
 */
export async function quote(input: { from: Asset; to: Asset; amountRaw: bigint; user: string; recipient: string; slippageBps?: number; gasless?: boolean }): Promise<Quote> {
  if (input.from.network.family !== "EVM") throw new Error("Swaps from Solana come next. Swap from an EVM chain for now.");
  const gasless = !!input.gasless && input.from.address !== null;
  const body = {
    user: input.user, recipient: input.recipient, refundTo: input.user,
    originChainId: relayChainId(input.from.network), destinationChainId: relayChainId(input.to.network),
    originCurrency: relayCurrency(input.from), destinationCurrency: relayCurrency(input.to),
    amount: input.amountRaw.toString(), tradeType: "EXACT_INPUT",
    ...(input.slippageBps ? { slippageTolerance: String(input.slippageBps) } : {}),
    ...(gasless ? { usePermit: true } : {}),
  };
  const response = await fetch(`${RELAY_API}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", body: JSON.stringify(body) });
  const raw: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(raw?.message ?? `No route right now (${response.status}).`);
  const out = raw?.details?.currencyOut, inn = raw?.details?.currencyIn;
  // The quote must deliver what was asked: to the chosen recipient, in the chosen currency, on the chosen network.
  const same = (a: unknown, b: string, family: string) => family === "SOLANA" ? String(a ?? "") === b : String(a ?? "").toLowerCase() === b.toLowerCase();
  if (!same(raw?.details?.recipient, input.recipient, input.to.network.family)) throw new Error("Relay's quote pays someone other than you. Nothing was signed.");
  if (Number(out?.currency?.chainId) !== relayChainId(input.to.network) || !same(out?.currency?.address, relayCurrency(input.to), input.to.network.family))
    throw new Error("Relay's quote delivers a different token or network than you chose. Nothing was signed.");
  const num = (v: unknown) => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    requestId: raw?.steps?.find((s: any) => s?.requestId)?.requestId ?? raw?.steps?.flatMap((s: any) => s?.items ?? []).find((i: any) => i?.data?.post?.body?.requestId)?.data.post.body.requestId ?? null,
    steps: Array.isArray(raw?.steps) ? raw.steps : [], amountRaw: input.amountRaw, gasless,
    amountIn: String(inn?.amountFormatted ?? ""), amountOut: String(out?.amountFormatted ?? "0"),
    minimumOut: out?.minimumAmount != null && out?.currency?.decimals != null ? (Number(out.minimumAmount) / 10 ** out.currency.decimals).toPrecision(6) : null,
    amountOutUsd: num(out?.amountUsd), amountInUsd: num(inn?.amountUsd),
    impactPercent: num(raw?.details?.totalImpact?.percent), timeSeconds: num(raw?.details?.timeEstimate),
    feesUsd: ["gas", "relayer", "app"].reduce<number | null>((sum, k) => { const v = num(raw?.fees?.[k]?.amountUsd); return v === null ? sum : (sum ?? 0) + v; }, null),
    rate: raw?.details?.rate != null ? String(raw.details.rate) : null,
  };
}

type RelaySign = { sign: { signatureKind: string; domain: Record<string, unknown>; types: Record<string, { name: string; type: string }[]>; primaryType: string; value: Record<string, unknown> }; post: { endpoint: string; method: string; body: unknown } };

// ── Checking Relay's transactions before anything is signed ───────────────────────────────────────────────────────────────
/**
 * Relay's own addresses on a chain, from Relay's public chain list, in two sets:
 * - `targets`: what a Relay transaction may be sent to (routers, receivers, depositories, multicallers, solvers);
 * - `spenders`: the only contracts the wallet lets spend a token, by an approval or an authorization: Relay's approval proxies
 *   (every version's `approvalProxy`) and its depositories. Never a multicaller (anyone can make it call anything), a receiver or
 *   a solver's own address: an allowance there could be used by someone else.
 */
export type RelayContracts = { targets: Set<string>; spenders: Set<string> };
const contractCache = new Map<number, Promise<RelayContracts>>();
const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
export function relayContractSets(chain: any): RelayContracts {
  const targets = new Set<string>(), spenders = new Set<string>();
  const collect = (v: unknown, key = "") => {
    if (isAddress(v)) { targets.add(v.toLowerCase()); if (key === "approvalProxy" || key === "depository") spenders.add(v.toLowerCase()); }
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collect(x, Array.isArray(v) ? key : k);
  };
  collect(chain?.contracts); collect(chain?.protocol); collect(chain?.solverAddresses);
  return { targets, spenders };
}
export function relayContracts(chainId: number): Promise<RelayContracts> {
  if (!contractCache.has(chainId)) contractCache.set(chainId, (async () => {
    const response = await fetch(`${RELAY_API}/chains`, { credentials: "omit", referrerPolicy: "no-referrer" });
    const raw: any = await response.json().catch(() => ({}));
    const sets = relayContractSets((raw?.chains ?? []).find((c: any) => Number(c?.id) === chainId));
    if (!sets.targets.size || !sets.spenders.size) { contractCache.delete(chainId); throw new Error("Couldn't read Relay's contracts for this network. Try again."); }
    return sets;
  })());
  return contractCache.get(chainId)!;
}

const APPROVE = "0x095ea7b3";
/** Gas a Relay step may use at most when it can't be estimated yet (it runs after an approval that hasn't landed). */
const GAS_CEILING = 1_500_000n;

/** Longest an authorization may stay usable: a signed one that leaked couldn't be replayed days later. */
const AUTHORIZATION_MAX_SECONDS = 24 * 3600;

export type PreparedTx = { kind: "transaction"; transaction: ReturnType<typeof checkedTransaction>; summary: TransactionSummary; label: string; urls: string[]; maxFee: bigint };
export type PreparedSignature = { kind: "signature"; typedData: TypedDataDefinition; summary: TypedDataSummary; label: string; text: string; post: RelaySign["post"] };
export type PreparedStep = PreparedTx | PreparedSignature;
export type Prepared = { steps: PreparedStep[]; maxFee: bigint; nativeSymbol: string; chainId: number; gasless: boolean };

/** The EIP-3009 message a gasless swap signs, exactly as the token's contract defines it. */
const RECEIVE_WITH_AUTHORIZATION = [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
];

/**
 * Checks a gasless authorization before it is signed. Only EIP-3009 `ReceiveWithAuthorization` is signed: it moves exactly one
 * amount, once (its nonce), and only the named recipient contract can redeem it, so the signature is useless to anyone who sees
 * it (Relay takes it in the request's address, so it does pass through logs). An EIP-2612 permit or Permit2 would leave an
 * allowance behind, and isn't signed here; that route just isn't offered gasless. Checked: EIP-712 on the network you pay from,
 * the token you pay with, the exact message type, from your address, to one of Relay's approval contracts, exactly the amount,
 * valid for a day at most, and handed only to Relay's execute endpoint.
 */
function checkedAuthorization(item: RelaySign, q: Quote, from: string, pay: Asset, chainId: number, contracts: RelayContracts, label: string): PreparedSignature {
  const { sign, post } = item;
  const refuse = (why: string) => { throw new Error(`Relay's authorization ${why}. Nothing was signed.`); };
  if (sign?.signatureKind !== "eip712") refuse("isn't a typed message");
  if (sign.primaryType !== "ReceiveWithAuthorization") refuse(`is of a kind the wallet doesn't sign gasless (${sign.primaryType}). Turn off "Pay the network fee with" for this route`);
  if (JSON.stringify(sign.types?.ReceiveWithAuthorization) !== JSON.stringify(RECEIVE_WITH_AUTHORIZATION) || Object.keys(sign.types ?? {}).some(t => t !== "ReceiveWithAuthorization" && t !== "EIP712Domain")) refuse("isn't the standard EIP-3009 message");
  if (Number(sign.domain?.chainId) !== chainId) refuse("is for another network");
  if (String(sign.domain?.verifyingContract ?? "").toLowerCase() !== (pay.address ?? "").toLowerCase()) refuse("isn't for the token you pay with");
  const v = sign.value ?? {}, now = Math.floor(Date.now() / 1000);
  const spender = String(v.to).toLowerCase();
  if (String(v.from).toLowerCase() !== from.toLowerCase()) refuse("isn't from your address");
  if (!contracts.spenders.has(spender)) refuse("isn't for one of Relay's approval contracts");
  if (BigInt(String(v.value ?? "-1")) !== q.amountRaw) refuse("isn't for exactly the amount you're swapping");
  if (Number(v.validAfter) > now) refuse("starts later than now");
  if (!(Number(v.validBefore) > now && Number(v.validBefore) <= now + AUTHORIZATION_MAX_SECONDS)) refuse("stays valid too long");
  if (post?.method !== "POST" || !/^\/execute\/[a-z]+$/.test(post?.endpoint ?? "")) refuse("would be sent somewhere unexpected");
  const typedData = { domain: sign.domain, types: { ReceiveWithAuthorization: RECEIVE_WITH_AUTHORIZATION }, primaryType: "ReceiveWithAuthorization", message: v } as unknown as TypedDataDefinition;
  const amount = Number(q.amountRaw) / 10 ** pay.decimals;
  const until = new Date(Number(v.validBefore) * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return { kind: "signature", typedData, summary: typedDataSummary(typedData), label, post,
    text: `Lets Relay's contract ${spender.slice(0, 6)}…${spender.slice(-4)} take exactly ${amount} ${pay.symbol} from you, once, for this swap. Unused, it expires ${until}.` };
}

/**
 * Turns the quote into exactly what will be signed, after checking each step:
 * - transactions: on the network you pay from and from your own address, to one of Relay's contracts (an approval: of the token
 *   you pay with, for one of Relay's approval contracts only); fees set here from the network, not taken from the quote; the gas limit estimated here,
 *   or Relay's capped;
 * - gasless authorizations: see checkedAuthorization. Relay sends the transaction and takes its fee out of the swap.
 * What `prepare` returns is shown in full (with the most the network fees can cost), and `execute` signs exactly that.
 */
export async function prepare(q: Quote, from: string, pay: Asset): Promise<Prepared> {
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
  const out: PreparedStep[] = [];
  let i = 0;
  for (const step of q.steps) for (const item of step.items) {
    const label = step.action ?? step.description ?? step.id;
    if (step.kind === "signature") { out.push(checkedAuthorization(item.data as unknown as RelaySign, q, from, pay, chainId, contracts, label)); continue; }
    if (step.kind !== "transaction") throw new Error("Relay asked for a step the wallet doesn't know. Nothing was signed.");
    const data = item.data;
    const summary = transactionSummary(checkedTransaction({ chainId: data.chainId, to: data.to, data: data.data, value: BigInt(data.value || "0") }));
    if (Number(data.chainId) !== chainId) throw new Error("Relay asked for a transaction on another network than the one you pay from. Nothing was signed.");
    if (data.from.toLowerCase() !== from.toLowerCase()) throw new Error("Relay's transaction isn't from your address. Nothing was signed.");
    const to = data.to.toLowerCase(), call = data.data.toLowerCase();
    if (call.startsWith(APPROVE)) {
      const spender = `0x${call.slice(34, 74)}`;
      if (to !== (pay.address ?? "").toLowerCase() || !contracts.spenders.has(spender)) throw new Error("Relay's approval isn't for the token you pay with, or not for one of Relay's approval contracts. Nothing was signed.");
    } else if (!contracts.targets.has(to)) throw new Error("Relay's transaction goes to an address that isn't one of Relay's contracts. Nothing was signed.");
    const value = BigInt(data.value || "0");
    const estimate = await rpc<string>(urls, "eth_estimateGas", [{ from, to: data.to, data: data.data, value: `0x${value.toString(16)}` }]).then(g => BigInt(g) * 12n / 10n).catch(() => null);
    const relayGas = data.gas ? BigInt(data.gas) : null;
    const gas = estimate ?? (relayGas && relayGas <= GAS_CEILING ? relayGas : null);
    if (!gas) throw new Error("Couldn't work out this route's network fee. Try again.");
    const transaction = checkedTransaction({ chainId, to: data.to, data: data.data, value, nonce: nonce + i++, gas, ...fees });
    out.push({ kind: "transaction", transaction, summary, label, urls, maxFee: gas * perGas });
  }
  if (!out.length) throw new Error("Relay's route had nothing to sign. Try again.");
  const maxFee = out.reduce((s, t) => s + (t.kind === "transaction" ? t.maxFee : 0n), 0n);
  return { steps: out, maxFee, nativeSymbol: chain.nativeSymbol, chainId, gasless: out.every(s => s.kind === "signature") };
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

/**
 * Signs exactly the prepared steps, in order: a transaction is sent through the chain's public RPC and waited for (an approval must
 * land before the deposit); a gasless authorization is handed to Relay, which sends the transaction itself.
 */
export async function execute(prepared: Prepared, onProgress: (text: string) => void): Promise<string[]> {
  const hashes: string[] = [];
  for (const [i, step] of prepared.steps.entries()) {
    onProgress(`${step.label} (${i + 1} of ${prepared.steps.length})`);
    if (step.kind === "signature") {
      const signature = await signing.evmSignTypedData(step.typedData);
      const response = await fetch(`${RELAY_API}${step.post.endpoint}?signature=${encodeURIComponent(signature)}`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", body: JSON.stringify(step.post.body),
      });
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { message?: string }).message ?? `Relay didn't take the authorization (${response.status}).`);
      continue;
    }
    const raw = await signing.evmSignTransaction({ transaction: step.transaction });
    const hash = await rpc<string>(step.urls, "eth_sendRawTransaction", [raw]);
    hashes.push(hash);
    await waitForReceipt(step.urls, hash);
  }
  await activity.add({ kind: "send", text: prepared.gasless ? "Gasless swap sent through Relay (fee paid from the swap)" : `Swap/bridge sent through Relay (${hashes.length} transaction${hashes.length === 1 ? "" : "s"})` });
  return hashes;
}

export async function status(requestId: string): Promise<string> {
  const response = await fetch(`${RELAY_API}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { credentials: "omit" });
  const raw: any = await response.json().catch(() => ({}));
  return String(raw?.status ?? "waiting").toLowerCase();
}
