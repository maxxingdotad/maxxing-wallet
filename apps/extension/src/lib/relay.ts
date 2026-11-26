/**
 * Swaps and bridges through Relay's public API: any asset to any asset, across EVM chains and to Solana. Relay answers a quote
 * with what to sign: transactions (an approval when needed, then the deposit), each filled here, shown through the wallet core's
 * review, signed by the core and sent through the chain's public RPC; or, gasless, one authorization for exactly the amount,
 * after which Relay sends the transaction and takes the network fee out of the swap.
 */
import * as signing from "@maxxing/wallet-core/signing";
import { checkedTransaction, transactionSummary, typedDataSummary, type TransactionSummary, type TypedDataSummary } from "@maxxing/wallet-core/review";
import { keccak256, type TypedDataDefinition } from "viem";
import { evmNetwork, type Network } from "./chains";
import { rpc, RpcError, sendSigned } from "./rpc";
import { activity } from "./store";
import { approvalInTransaction, approvals } from "./approvals";
import { MAX_FEE_BPS, checkAppFee, swapFee, type SwapFee } from "./swap-fee";
import PINNED from "./relay-pinned.json";

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
  requestId: string | null; steps: RelayStep[]; amountRaw: bigint; gasless: boolean; fromChainId: number; toChainId: number;
  amountIn: string; amountOut: string; minimumOut: string | null; amountOutUsd: number | null; amountInUsd: number | null;
  impactPercent: number | null; timeSeconds: number | null; feesUsd: number | null; rate: string | null;
  /** MAXXING's fee on this swap (null: none), checked against the quote: its rate in basis points and its value in dollars. */
  maxxingFee: { bps: number; usd: number | null } | null;
};

/**
 * A quote. `gasless` (paying with a token, not the network's coin): the user signs an EIP-3009 authorization for exactly the
 * amount, Relay sends the transaction and takes the network fee out of the swap, so no ETH is needed. Tokens or routes that would
 * need a lasting allowance (EIP-2612, Permit2) are refused at review, not signed.
 */
export async function quote(input: { from: Asset; to: Asset; amountRaw: bigint; user: string; recipient: string; slippageBps?: number; gasless?: boolean; fee?: SwapFee }): Promise<Quote> {
  if (input.from.network.family !== "EVM") throw new Error("Swaps from Solana come next. Swap from an EVM chain for now.");
  const gasless = !!input.gasless && input.from.address !== null;
  // MAXXING's fee (admin's setting, capped at 2%) as Relay's app fee: it rides inside the trade, paid to the recipient's Relay balance.
  const fee = input.fee === undefined ? await swapFee() : input.fee;
  const body = {
    ...(fee ? { appFees: [{ recipient: fee.recipient, fee: String(Math.min(fee.bps, MAX_FEE_BPS)) }] } : {}),
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
  // The fee it charges must be the one shown (or none when none is shown): checked here, before anything is prepared or signed.
  const feeUsd = checkAppFee(raw, fee, { amountRaw: input.amountRaw, currency: relayCurrency(input.from) });
  const num = (v: unknown) => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    requestId: raw?.steps?.find((s: any) => s?.requestId)?.requestId ?? raw?.steps?.flatMap((s: any) => s?.items ?? []).find((i: any) => i?.data?.post?.body?.requestId)?.data.post.body.requestId ?? null,
    steps: Array.isArray(raw?.steps) ? raw.steps : [], amountRaw: input.amountRaw, gasless,
    fromChainId: relayChainId(input.from.network), toChainId: relayChainId(input.to.network),
    amountIn: String(inn?.amountFormatted ?? ""), amountOut: String(out?.amountFormatted ?? "0"),
    minimumOut: out?.minimumAmount != null && out?.currency?.decimals != null ? (Number(out.minimumAmount) / 10 ** out.currency.decimals).toPrecision(6) : null,
    amountOutUsd: num(out?.amountUsd), amountInUsd: num(inn?.amountUsd),
    impactPercent: num(raw?.details?.totalImpact?.percent), timeSeconds: num(raw?.details?.timeEstimate),
    // Relay's own fees (network and relayer); MAXXING's fee is shown on its own line.
    feesUsd: ["gas", "relayer"].reduce<number | null>((sum, k) => { const v = num(raw?.fees?.[k]?.amountUsd); return v === null ? sum : (sum ?? 0) + v; }, null),
    rate: raw?.details?.rate != null ? String(raw.details.rate) : null,
    maxxingFee: fee ? { bps: fee.bps, usd: feeUsd } : null,
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
export type RelayContracts = {
  targets: Set<string>; spenders: Set<string>; authorizers: Set<string>; paused?: boolean;
  /** Where coins may be sent: depositories and receivers; and routers, for a swap on one network only (see prepare). */
  coinTargets?: Set<string>; routers?: Set<string>;
};
export const PAUSED = "Swaps that spend a token on this network are paused until the wallet is updated. Swaps paying with the network's coin still work.";

/**
 * The spenders the wallet trusts come from a reviewed file (src/lib/relay-pinned.json: Relay's approval proxies and depositories
 * per network, each checked on chain), not from Relay's live answer alone. If the live list for a network differs from the file
 * (a contract added, moved or removed), or the network isn't in it, nothing may spend a token there: approvals and gasless swaps
 * are refused until the wallet is updated and the change reviewed.
 */
type Pins = { chains: Record<string, { approvalProxies: string[]; depositories: string[]; contracts: string[]; receivers?: string[]; routers?: string[] }> };
export function withPinnedSpenders(chainId: number, live: RelayContracts, pins: Pins = PINNED as Pins): RelayContracts {
  const pin = pins.chains[String(chainId)];
  // Where a transaction may go: only the pinned contracts, never a solver's address or anything else the live answer names. A
  // network that isn't pinned gets none, so no Relay transaction is built there.
  const targets = new Set((pin?.contracts ?? []).map(a => a.toLowerCase()));
  const coins = { coinTargets: new Set([...(pin?.depositories ?? []), ...(pin?.receivers ?? [])].map(a => a.toLowerCase())), routers: new Set((pin?.routers ?? []).map(a => a.toLowerCase())) };
  const liveProxies = [...live.authorizers].sort(), liveDepositories = [...live.spenders].filter(a => !live.authorizers.has(a)).sort();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!pin || !same(liveProxies, [...pin.approvalProxies].sort()) || !same(liveDepositories, [...pin.depositories].sort()))
    return { targets, spenders: new Set(), authorizers: new Set(), paused: true, ...coins };
  return { targets, spenders: new Set([...pin.approvalProxies, ...pin.depositories]), authorizers: new Set(pin.approvalProxies), ...coins };
}
const contractCache = new Map<number, Promise<RelayContracts>>();
const isAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
/** `authorizers`: the approval proxies alone, the only contracts a gasless (EIP-3009) authorization may name. */
export function relayContractSets(chain: any): RelayContracts {
  const targets = new Set<string>(), spenders = new Set<string>(), authorizers = new Set<string>();
  const collect = (v: unknown, key = "") => {
    if (isAddress(v)) {
      const a = v.toLowerCase();
      targets.add(a);
      if (key === "approvalProxy" || key === "depository") spenders.add(a);
      if (key === "approvalProxy") authorizers.add(a);
    } else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collect(x, Array.isArray(v) ? key : k);
  };
  collect(chain?.contracts); collect(chain?.protocol); collect(chain?.solverAddresses);
  return { targets, spenders, authorizers };
}

/**
 * Whether `token` takes an EIP-3009 `receiveWithAuthorization` from `spender` on this network, found by simulating the call (no
 * transaction): a token that has it rejects the dummy signature ("invalid signature"); one that doesn't has no such function
 * (an empty revert, or a fallback that accepts anything). Gasless is offered only where this says yes.
 * Only the chain's own answer decides, and only that is remembered: the call succeeding (no), or the contract reverting (yes if
 * the revert is about the signature). An endpoint that is down or limited decides nothing: it is asked again next time.
 */
const RECEIVE_SELECTOR = "0xef55bec6"; // receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const supportCache = new Map<string, Promise<boolean>>();
export function eip3009Supported(urls: string[], token: string, spender: string): Promise<boolean> {
  const key = `${urls[0]}|${token.toLowerCase()}|${spender.toLowerCase()}`;
  if (!supportCache.has(key)) supportCache.set(key, (async () => {
    const data = RECEIVE_SELECTOR + [word("0x1111111111111111111111111111111111111111"), word(spender), word("1"), word("0"), word("ffffffffff"), "ab".repeat(32), word("1b"), word("0"), word("0")].join("");
    try { await rpc<string>(urls, "eth_call", [{ from: spender, to: token, data }, "latest"]); return false; } // it accepted a junk signature: not EIP-3009
    catch (error) {
      // A revert is the chain's answer (rpc marks it final); anything else is the endpoint's trouble and decides nothing.
      if (!(error instanceof RpcError) || !(error as { final?: boolean }).final) throw error;
      return /revert/i.test(error.message) && /invalid signature|ecrecover|signature is invalid/i.test(error.message);
    }
  })());
  const answer = supportCache.get(key)!;
  return answer.catch(() => { if (supportCache.get(key) === answer) supportCache.delete(key); return false; });
}

/** Whether a gasless swap can pay with this token on its network: one of Relay's approval proxies there can redeem EIP-3009. */
export async function gaslessAvailable(pay: Asset): Promise<boolean> {
  if (pay.address === null || pay.network.family !== "EVM") return false;
  const chain = evmNetwork(relayChainId(pay.network));
  if (!chain) return false;
  const { authorizers } = await relayContracts(relayChainId(pay.network)).catch(() => ({ authorizers: new Set<string>() })); // empty when paused
  for (const spender of authorizers) if (await eip3009Supported(chain.rpc, pay.address, spender)) return true;
  return false;
}
/** Relay's contracts for a network, checked against the pinned file. Only a good answer is kept; a failed read is tried again next time. */
export function relayContracts(chainId: number): Promise<RelayContracts> {
  if (!contractCache.has(chainId)) {
    const answer = (async () => {
      const response = await fetch(`${RELAY_API}/chains`, { credentials: "omit", referrerPolicy: "no-referrer" });
      const raw: any = await response.json().catch(() => ({}));
      const sets = relayContractSets((raw?.chains ?? []).find((c: any) => Number(c?.id) === chainId));
      if (!sets.targets.size || !sets.spenders.size) throw new Error("Couldn't read Relay's contracts for this network. Try again.");
      return withPinnedSpenders(chainId, sets);
    })();
    contractCache.set(chainId, answer);
    answer.catch(() => { if (contractCache.get(chainId) === answer) contractCache.delete(chainId); });
  }
  return contractCache.get(chainId)!;
}

const APPROVE = "0x095ea7b3";
const ALLOWANCE = "0xdd62ed3e"; // allowance(owner, spender)
/** Gas for an approval that can't be estimated yet (it follows a reset to 0). ERC-20 approvals use about 25,000–60,000. */
const APPROVAL_GAS = 100_000n;
/** Gas a Relay step may use at most when it can't be estimated yet (it runs after an approval that hasn't landed). */
const GAS_CEILING = 1_500_000n;

/** Longest an authorization may stay usable: a signed one that leaked couldn't be replayed days later. */
const AUTHORIZATION_MAX_SECONDS = 24 * 3600;

export type PreparedTx = {
  kind: "transaction"; transaction: ReturnType<typeof checkedTransaction>; summary: TransactionSummary; label: string; urls: string[]; maxFee: bigint;
  /** A deposit that spends the token: the allowance is read again right before it is signed (see execute). */
  needsAllowance?: { token: string; spender: string; atLeast: bigint };
};
export type PreparedSignature = { kind: "signature"; typedData: TypedDataDefinition; summary: TypedDataSummary; label: string; text: string; post: RelaySign["post"] };
export type PreparedStep = PreparedTx | PreparedSignature;
export type Prepared = { steps: PreparedStep[]; maxFee: bigint; nativeSymbol: string; chainId: number; gasless: boolean; from: string };

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
  if (contracts.paused) throw new Error(PAUSED);
  if (!contracts.authorizers.has(spender)) refuse("isn't for one of Relay's approval contracts");
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
  const urls = chain.rpc;
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
  let i = 0, sent = 0n;
  let allowanceFor: PreparedTx["needsAllowance"] | undefined; // set once the route's approval is checked; its deposit re-reads it
  for (const step of q.steps) for (const item of step.items) {
    const label = step.action ?? step.description ?? step.id;
    if (step.kind === "signature") {
      // Gasless only across networks: on one network Relay's gasless route uses Permit2, which leaves a lasting allowance.
      if (q.toChainId === chainId) throw new Error(`Gasless swaps work between networks only. Turn off "Pay the network fee with ${pay.symbol}". Nothing was signed.`);
      const authorization = checkedAuthorization(item.data as unknown as RelaySign, q, from, pay, chainId, contracts, label);
      const spender = String((authorization.typedData.message as { to: string }).to);
      if (!(await eip3009Supported(urls, pay.address!, spender))) throw new Error(`${pay.symbol} can't pay the network fee from the swap here. Turn off "Pay the network fee with ${pay.symbol}". Nothing was signed.`);
      out.push(authorization);
      continue;
    }
    if (step.kind !== "transaction") throw new Error("Relay asked for a step the wallet doesn't know. Nothing was signed.");
    const data = { ...item.data };
    if (Number(data.chainId) !== chainId) throw new Error("Relay asked for a transaction on another network than the one you pay from. Nothing was signed.");
    if (data.from.toLowerCase() !== from.toLowerCase()) throw new Error("Relay's transaction isn't from your address. Nothing was signed.");
    const to = data.to.toLowerCase(), call = data.data.toLowerCase();
    if (call.startsWith(APPROVE)) {
      const spender = `0x${call.slice(34, 74)}`;
      if (contracts.paused) throw new Error(PAUSED);
      if (to !== (pay.address ?? "").toLowerCase() || !contracts.spenders.has(spender)) throw new Error("Relay's approval isn't for the token you pay with, or not for one of Relay's approval contracts. Nothing was signed.");
      // An approval for more than this swap (often "unlimited") is made exactly this swap's amount: nothing is left to spend later.
      if (BigInt(`0x${call.slice(74, 138) || "0"}`) > q.amountRaw) data.data = `${APPROVE}${word(spender)}${word(q.amountRaw.toString(16))}`;
      if (BigInt(data.value || "0") !== 0n) throw new Error("Relay's approval sends coins. Nothing was signed.");
      // What's already allowed decides the steps. If it can't be read, nothing is built: guessing could break the swap halfway.
      const current = await rpc<string>(urls, "eth_call", [{ to: data.to, data: `${ALLOWANCE}${word(from)}${word(spender)}` }, "latest"]).then(BigInt).catch(() => null);
      if (current === null) throw new Error("Couldn't read what this token already allows Relay to spend. Try again in a moment.");
      allowanceFor = { token: data.to, spender, atLeast: q.amountRaw };
      // Enough is already allowed: no approval is needed (and none is signed).
      if (current >= q.amountRaw) continue;
      // Some tokens (USDT on Ethereum) refuse to change an allowance that isn't 0. When one is left over and too small for this
      // swap, a separate step sets it to 0 first, shown to the user as its own transaction. The approval after it can't be
      // estimated before the reset lands (the token would refuse it now), so it gets a fixed gas limit that covers any approval.
      if (current > 0n) {
        await addTx({ ...data, data: `${APPROVE}${word(spender)}${word("0")}`, value: "0", gas: undefined }, "Reset the old allowance to 0 (this token requires it)");
        await addTx(data, label, APPROVAL_GAS);
        continue;
      }
    } else if (!contracts.targets.has(to)) throw new Error("Relay's transaction goes to an address that isn't one of Relay's pinned contracts. Nothing was signed.");
    const value = BigInt(data.value || "0");
    // Coins sent along: none when paying with a token; when paying with the coin, exactly the swap's amount over the whole route,
    // and only ever to one of Relay's pinned contracts (never a solver's address or anything else the live answer names).
    if (pay.address !== null && value !== 0n) throw new Error("Relay's transaction sends coins as well as the token you pay with. Nothing was signed.");
    // Coins go to a pinned depository or receiver. A router takes them only in a swap on one network, for exactly the swap's amount
    // (Relay swaps ETH on one network through its router, in that same transaction); a multicaller or anything else, never.
    if (value !== 0n && !(contracts.coinTargets?.has(to) || (contracts.routers?.has(to) && q.toChainId === chainId && value === q.amountRaw)))
      throw new Error("Relay's transaction sends coins to a contract that shouldn't receive them. Nothing was signed.");
    sent += value;
    await addTx(data, label, undefined, call.startsWith(APPROVE) ? undefined : allowanceFor); // the deposit re-checks, not the approval
  }
  /** Fills one checked transaction: the next nonce, gas estimated here (or Relay's, capped; or a fixed limit), fees set here. */
  async function addTx(data: RelayTxData, label: string, fixedGas?: bigint, needsAllowance?: PreparedTx["needsAllowance"]) {
    const value = BigInt(data.value || "0");
    const summary = transactionSummary(checkedTransaction({ chainId: data.chainId, to: data.to, data: data.data, value }));
    const estimate = fixedGas ?? await rpc<string>(urls, "eth_estimateGas", [{ from, to: data.to, data: data.data, value: `0x${value.toString(16)}` }]).then(g => BigInt(g) * 12n / 10n).catch(() => null);
    const relayGas = data.gas ? BigInt(data.gas) : null;
    const gas = estimate ?? (relayGas && relayGas <= GAS_CEILING ? relayGas : null);
    if (!gas) throw new Error("Couldn't work out this route's network fee. Try again.");
    const transaction = checkedTransaction({ chainId, to: data.to, data: data.data, value, nonce: nonce + i++, gas, ...fees });
    out.push({ kind: "transaction", transaction, summary, label, urls, maxFee: gas * perGas, ...(needsAllowance ? { needsAllowance } : {}) });
  }
  if (!out.length) throw new Error("Relay's route had nothing to sign. Try again.");
  if (pay.address === null && sent !== q.amountRaw) throw new Error("Relay's route sends a different amount than you're swapping. Nothing was signed.");
  const maxFee = out.reduce((s, t) => s + (t.kind === "transaction" ? t.maxFee : 0n), 0n);
  return { steps: out, maxFee, nativeSymbol: chain.nativeSymbol, chainId, gasless: out.every(s => s.kind === "signature"), from };
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
    // A deposit that spends the token: read the allowance again just before signing it (after any approval in the route has
    // landed). The read goes through the same endpoint list, and rpc() asks first the endpoint that last answered, normally the one
    // that just confirmed the approval. Endpoints can't be pinned exactly: a public RPC may serve from a node a block behind.
    // That is accepted; the deposit would then fail on chain rather than spend more than allowed.
    if (step.needsAllowance) {
      const { token, spender, atLeast } = step.needsAllowance;
      const now = await rpc<string>(step.urls, "eth_call", [{ to: token, data: `${ALLOWANCE}${word(prepared.from)}${word(spender)}` }, "latest"]).then(BigInt).catch(() => null);
      if (now === null) throw new Error("Couldn't check the token's allowance before the deposit. Nothing more was sent; try again in a moment.");
      if (now < atLeast) throw new Error("The token's allowance for Relay isn't what the review showed, so the deposit wasn't sent. Nothing more was sent.");
    }
    const raw = await signing.evmSignTransaction({ transaction: step.transaction });
    // The hash is the signed bytes' keccak256: known even when no endpoint answers cleanly. If it may have been sent, the wallet
    // waits for its receipt instead of failing, and never builds the step again (that could make a second deposit).
    const { id: hash, certain } = await sendSigned(step.urls, "eth_sendRawTransaction", [raw], keccak256(raw));
    hashes.push(hash);
    // A route's own token approval is noted too, so it shows (and can be revoked) on the Approvals screen.
    const given = approvalInTransaction(prepared.chainId, step.transaction as { to?: string | null; data?: string | null });
    if (given) await approvals.note({ ...given, origin: "Relay" });
    await waitForReceipt(step.urls, hash, certain ? 120_000 : 240_000).catch(async error => {
      if (!(error instanceof Error && /slow to confirm/.test(error.message))) throw error; // it landed and failed: say so
      await activity.add({ kind: "send", text: `Swap step not confirmed yet: ${step.label} · ${hash}`, account: prepared.from, networkId: `eip155:${prepared.chainId}`, hash, status: "pending" });
      throw new Error(`${step.label} isn't confirmed yet (${hash.slice(0, 10)}…). It may still land: check it on the explorer before trying again.`, { cause: error });
    });
  }
  await activity.add({ kind: "send", text: prepared.gasless ? "Gasless swap sent through Relay (fee paid from the swap)" : `Swap/bridge sent through Relay (${hashes.length} transaction${hashes.length === 1 ? "" : "s"})`,
    account: prepared.from, networkId: `eip155:${prepared.chainId}`, ...(hashes.length ? { hash: hashes.at(-1)!, status: "confirmed" as const } : {}) });
  return hashes;
}

export async function status(requestId: string): Promise<string> {
  const response = await fetch(`${RELAY_API}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`, { credentials: "omit" });
  const raw: any = await response.json().catch(() => ({}));
  return String(raw?.status ?? "waiting").toLowerCase();
}
