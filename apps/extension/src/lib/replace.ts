/**
 * Speed up or cancel an EVM transaction that is still waiting for a block. A network keeps one transaction per account and nonce:
 * a second one with the same nonce and a higher fee takes the first one's place.
 * - Speed up: the same transaction (recipient, amount, data, gas limit, nonce), read back from the network, with a higher fee.
 * - Cancel: nothing sent to yourself with that nonce and a higher fee. If it gets into a block first, the original never can.
 * Either can lose the race: the original may land first, and then the replacement is dropped (Activity says "too late").
 * The replacement is checked by the wallet core like any transaction and signed by it. Solana has no such thing: a transaction
 * there lands within about a minute or expires by itself.
 */
import { formatUnits, getAddress, keccak256 } from "viem";
import * as signing from "@maxxing/wallet-core/signing";
import { checkedTransaction, transactionSummary, type TransactionSummary } from "@maxxing/wallet-core/review";
import type { Network } from "./chains";
import { rpc, sendSigned } from "./rpc";
import { activity, type Activity } from "./store";
import { CUSTOM_MAX_FEE, CUSTOM_MAX_TIP, SENT_PREFIX, maxFeeOf, sendStatus, type Sent } from "./send";

export type ReplaceKind = "speed-up" | "cancel";
/** A transaction as a node reports it (`blockNumber` null while it waits). */
type ChainTx = { from: string; to: string | null; value: string; input: string; nonce: string; gas: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; blockNumber: string | null };

export type Replacement = {
  network: Network; kind: ReplaceKind; /** The hash of the transaction it replaces. */ original: string; from: string; nonce: number;
  transaction: ReturnType<typeof checkedTransaction>; summary: TransactionSummary;
  /** The most the original could cost in fees, and the most this one can. */ oldMaxFee: bigint; newMaxFee: bigint;
};

/** Why nothing can be replaced: the transaction is already in a block ("landed"), or no node has it ("gone"). */
export class ReplaceError extends Error { constructor(readonly reason: "landed" | "gone", message: string) { super(message); } }

/** Networks take a replacement only if its fee is at least a tenth higher; an eighth is asked, rounded up. */
export const bumped = (old: bigint) => (old * 1125n + 999n) / 1000n;
const most = (a: bigint, b: bigint) => a > b ? a : b;

/**
 * Builds the replacement for a waiting transaction: its fee is the higher of an eighth more than the original's and what the
 * network asks now. Refuses when the transaction is in a block already, when no node has it, when it isn't this account's, and
 * when the account can't pay the higher fee.
 */
export async function draftReplacement(input: { network: Network; from: string; hash: string; kind: ReplaceKind }): Promise<Replacement> {
  const { network, kind } = input;
  if (network.family !== "EVM" || !network.evmChainId) throw new Error("Only transactions on EVM networks can be sped up or cancelled.");
  const tx = await rpc<ChainTx | null>(network.rpc, "eth_getTransactionByHash", [input.hash]);
  if (!tx) throw new ReplaceError("gone", "No node has this transaction right now, so there is nothing to replace. If the network dropped it, your next send takes its place.");
  if (tx.blockNumber) throw new ReplaceError("landed", "This transaction is already in a block.");
  if (tx.from.toLowerCase() !== input.from.toLowerCase()) throw new Error("This transaction was sent from another account.");
  const from = getAddress(input.from), nonce = Number(tx.nonce), oldGas = BigInt(tx.gas);
  const [block, balance] = await Promise.all([
    rpc<{ baseFeePerGas?: string } | null>(network.rpc, "eth_getBlockByNumber", ["latest", false]),
    rpc<string>(network.rpc, "eth_getBalance", [from, "latest"]).then(BigInt),
  ]);
  let fees: { type: "eip1559"; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { type: "legacy"; gasPrice: bigint };
  if (tx.maxFeePerGas) {
    const reported = await rpc<string>(network.rpc, "eth_maxPriorityFeePerGas", []).then(BigInt).catch(() => 0n);
    // A network the user added: what its endpoint reports is capped (as for any send); the original's own tip still sets the floor.
    const asked = network.custom && reported > CUSTOM_MAX_TIP ? CUSTOM_MAX_TIP : reported;
    const tip = most(bumped(BigInt(tx.maxPriorityFeePerGas ?? "0x0")), asked);
    const max = most(bumped(BigInt(tx.maxFeePerGas)), BigInt(block?.baseFeePerGas ?? "0x0") * 2n + tip);
    fees = { type: "eip1559", maxFeePerGas: max, maxPriorityFeePerGas: tip > max ? max : tip };
  } else {
    const now = await rpc<string>(network.rpc, "eth_gasPrice", []).then(BigInt);
    fees = { type: "legacy", gasPrice: most(bumped(BigInt(tx.gasPrice ?? "0x0")), now) };
  }
  const perGas = "maxFeePerGas" in fees ? fees.maxFeePerGas : fees.gasPrice;
  if (network.custom && perGas > CUSTOM_MAX_FEE)
    throw new Error(`Replacing it needs a fee above ${formatUnits(CUSTOM_MAX_FEE, 9)} gwei, more than a network you added may charge. Nothing was signed.`);
  const body = kind === "cancel"
    ? { to: from, value: 0n, gas: await rpc<string>(network.rpc, "eth_estimateGas", [{ from, to: from, value: "0x0" }]).then(g => BigInt(g) * 12n / 10n).catch(() => oldGas) }
    : { ...(tx.to ? { to: getAddress(tx.to) } : {}), value: BigInt(tx.value), gas: oldGas, ...(tx.input && tx.input !== "0x" ? { data: tx.input } : {}) };
  if (balance < body.value + body.gas * perGas)
    throw new Error(kind === "cancel" ? `This account doesn't hold enough ${network.nativeSymbol} to pay for a cancel.` : `This account doesn't hold enough ${network.nativeSymbol} for the higher fee. A cancel costs less.`);
  const transaction = checkedTransaction({ chainId: network.evmChainId, nonce, ...body, ...fees });
  return { network, kind, original: input.hash, from, nonce, transaction, summary: transactionSummary(transaction),
    oldMaxFee: oldGas * BigInt(tx.maxFeePerGas ?? tx.gasPrice ?? "0x0"), newMaxFee: maxFeeOf(transaction as { gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint }) };
}

/** What an entry was about, without how it starts ("Sent on Base:") and its hash: "0.01 ETH to 0x12…". */
export const describe = (entry: Pick<Activity, "text">) =>
  entry.text.replace(/ · [0-9A-Za-z]{40,}$/, "").replace(/^[^:]*: /, "").replace(/^(Speed-up|Cancel) · /, "");

/**
 * Signs and sends the replacement, and writes it to Activity next to the one it replaces (both wait until one of them is in a
 * block; settleSendActivity then settles the other).
 */
export async function sendReplacement(r: Replacement): Promise<Sent> {
  const raw = await signing.evmSignTransaction({ transaction: r.transaction });
  const { id: hash, certain } = await sendSigned(r.network.rpc, "eth_sendRawTransaction", [raw], keccak256(raw));
  let what = "a transaction";
  // The original gets its nonce written down (entries from before nonces were kept have none), so the two are known as rivals.
  await activity.change(all => all.map(a => { if (a.hash !== r.original) return a; what = describe(a); return { ...a, nonce: r.nonce }; }));
  await activity.add({ kind: "send", text: `${certain ? "Sent" : "Not confirmed yet (check the explorer before sending again)"} on ${r.network.name}: ${r.kind === "cancel" ? "Cancel" : "Speed-up"} · ${what} · ${hash}`,
    account: r.from, networkId: r.network.networkId, hash, status: "pending", nonce: r.nonce, replaceKind: r.kind });
  return { id: hash, certain };
}

/** A network's refusal of a replacement, in plain words. */
export function replaceMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/nonce too low|already (been )?(used|processed)/i.test(text)) return "This transaction got into a block in the meantime, so there is nothing left to replace.";
  if (/underpriced|fee too low|replacement/i.test(text)) return "The network wants a higher fee than this to replace it. Try again: the fee is read fresh each time.";
  if (/insufficient funds/i.test(text)) return "This account doesn't hold enough for the higher fee.";
  return text;
}

/** How long a transaction no node knows must have waited before "its nonce is used" is read as "something else took its place". */
const REPLACED_AFTER_MS = 120_000;
/**
 * A waiting transaction that no node knows, whose nonce the chain has used: another transaction took its place (sent from another
 * wallet or device with the same account). Asked twice, and only for a transaction older than two minutes, since an endpoint a
 * block behind may not know a transaction that just landed.
 */
export async function replacedElsewhere(network: Network, entry: Activity, now = Date.now()): Promise<boolean> {
  if (network.family !== "EVM" || entry.nonce === undefined || !entry.account || !entry.hash || now - entry.at < REPLACED_AFTER_MS) return false;
  const used = Number(await rpc<string>(network.rpc, "eth_getTransactionCount", [entry.account, "latest"]));
  if (used <= entry.nonce) return false;
  return (await sendStatus(network, entry.hash)) === "unknown";
}
export const markReplaced = (hash: string) =>
  activity.change(all => all.map(a => a.hash === hash && a.status === "pending" ? { ...a, text: a.text.replace(SENT_PREFIX, "Replaced"), status: "replaced" as const } : a));
