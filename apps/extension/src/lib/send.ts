/**
 * Sending from the extension: EVM coins and ERC-20 tokens, and SOL. The transaction is built here, shown through the wallet core's
 * own review (the same checks as any site's request), signed by the core, and broadcast through the chain's public RPC.
 */
import bs58 from "bs58";
import { encodeFunctionData, formatUnits, getAddress, isAddress, keccak256, parseAbi, serializeTransaction } from "viem";
import * as signing from "@maxxing/wallet-core/signing";
import { checkedTransaction, transactionSummary, type TransactionSummary } from "@maxxing/wallet-core/review";
import { signSolanaTransaction } from "@maxxing/wallet-core/solana-tx";
import { networkById, type Network } from "./chains";
import { rpc, sendSigned } from "./rpc";
import { activity, kept } from "./store";
import { browserRpcUrls } from "@maxxing/wallet-sdk";

export function parseUnits(text: string, decimals: number): bigint {
  const clean = text.trim().replace(/,/g, "");
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === "" || clean === ".") throw new Error("Enter an amount.");
  const [whole = "0", frac = ""] = clean.split(".");
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimals.`);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export const validRecipient = (family: "EVM" | "SOLANA", to: string) => family === "EVM" ? isAddress(to.trim()) : (() => { try { return bs58.decode(to.trim()).length === 32; } catch { return false; } })();

// ── Recipient safety ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type RecipientCheck = { firstTime: boolean; lookalike: string | null; contact: string | null };
const recipients = () => kept.get<string[]>("recipients", []);
/**
 * Address poisoning: scammers send dust from an address that starts and ends like one you used, hoping you copy it from your
 * history. A new recipient that matches a known one's (or a contact's) first and last characters, but isn't it, is flagged.
 */
export async function checkRecipient(to: string): Promise<RecipientCheck> {
  const [sent, saved] = await Promise.all([recipients(), book.contacts()]);
  const t = to.trim().toLowerCase(), contact = saved.find(c => same(c.address, to.trim()))?.name ?? null;
  const known = [...sent, ...saved.map(c => c.address.toLowerCase())];
  if (known.includes(t)) return { firstTime: false, lookalike: null, contact };
  const lookalike = known.find(k => k !== t && k.slice(0, 6) === t.slice(0, 6) && k.slice(-4) === t.slice(-4)) ?? null;
  return { firstTime: true, lookalike, contact };
}
// The look-alike list compares lowercased; recents and contacts keep the address exactly (Solana addresses are case-sensitive).
const remember = async (to: string, family: Family) => {
  await kept.update<string[]>("recipients", [], all => [to.trim().toLowerCase(), ...all.filter(r => r !== to.trim().toLowerCase())].slice(0, 100));
  await kept.update<Saved[]>("recent-recipients", [], all => [{ address: to.trim(), family, at: Date.now() }, ...all.filter(r => !same(r.address, to))].slice(0, 20));
};

// ── Address book: recent recipients and named contacts, on this device only ────────────────────────────────────────────
type Family = "EVM" | "SOLANA";
export type Saved = { address: string; family: Family; name?: string; at: number };
/** EVM addresses compare without case; Solana addresses exactly. */
export const same = (a: string, b: string) => a.trim().startsWith("0x") ? a.trim().toLowerCase() === b.trim().toLowerCase() : a.trim() === b.trim();
export const book = {
  recents: () => kept.get<Saved[]>("recent-recipients", []),
  contacts: () => kept.get<Saved[]>("contacts", []),
  saveContact: async (c: { address: string; family: Family; name: string }) => {
    const name = c.name.trim().slice(0, 40);
    if (!name) throw new Error("Give the contact a name.");
    if (!validRecipient(c.family, c.address)) throw new Error("That address isn't valid for this network.");
    return kept.update<Saved[]>("contacts", [], all => [{ address: c.address.trim(), family: c.family, name, at: Date.now() }, ...all.filter(x => !same(x.address, c.address))].slice(0, 200));
  },
  removeContact: (address: string) => kept.update<Saved[]>("contacts", [], all => all.filter(x => !same(x.address, address))),
};

/** Solana's network fee for one signature, in lamports. */
export const SOL_FEE = 5000n;

/**
 * The most that can be sent and still pay the network fee. Tokens: the whole balance (the fee is paid in the coin).
 * - SOL: everything but the fee, so the account ends at exactly 0 (an account may be emptied; one left with less than the rent-exempt
 *   minimum may not, so Max never leaves dust).
 * - EVM coins: the balance minus what `keepFor` says a draft of the transfer needs. When the user then reviews, the send is drafted
 *   again by `draftEvmMaxSend`, from that draft's own fees, so a fee that rose in between doesn't make it fail.
 */
export async function maxSendable(network: Network, holding: { raw?: string; address?: string | null; decimals?: number }, from: string, to?: string): Promise<{ amount: string; keep: bigint }> {
  const decimals = holding.decimals ?? (network.family === "SOLANA" ? 9 : 18), raw = BigInt(holding.raw ?? "0");
  if (holding.address) return { amount: formatUnits(raw, decimals), keep: 0n };
  let keep: bigint;
  if (network.family === "SOLANA") keep = SOL_FEE;
  else {
    const target = to && isAddress(to.trim()) ? getAddress(to.trim()) : getAddress(from);
    keep = await keepFor(network, await draftEvmCall({ network, from, call: { to: target, value: 0n } }), raw);
  }
  return { amount: formatUnits(raw > keep ? raw - keep : 0n, decimals), keep };
}
const L1_FEE_ABI = parseAbi(["function getL1Fee(bytes data) view returns (uint256)"]);

/**
 * What a coin transfer must leave for fees: its draft's most (gas × max fee), plus on chains with an L1 data fee (the registry's
 * oracle) half again that fee, all with a quarter more as headroom.
 */
async function keepFor(network: Network, draft: EvmDraft, balance: bigint): Promise<bigint> {
  let keep = maxFeeOf(draft.transaction as { gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint });
  if (network.l1FeeOracle) {
    const tx = draft.transaction as Parameters<typeof serializeTransaction>[0];
    const unsigned = serializeTransaction({ ...tx, value: balance > keep ? balance - keep : 0n } as Parameters<typeof serializeTransaction>[0]);
    const l1 = BigInt(await rpc<string>(network.rpc, "eth_call", [{ to: network.l1FeeOracle, data: encodeFunctionData({ abi: L1_FEE_ABI, functionName: "getL1Fee", args: [unsigned] }) }, "latest"]));
    keep += l1 * 3n / 2n;
  }
  return keep * 5n / 4n;
}

/**
 * "Max" of the coin, at review: the transfer is drafted (fees as the chain says now), and its value is the balance minus what that
 * very draft must leave (`keepFor`), not the amount shown when Max was pressed. Nothing else changes in the transaction.
 */
export async function draftEvmMaxSend(input: { network: Network; from: string; to: string; balance: bigint }): Promise<EvmDraft> {
  if (!isAddress(input.to.trim())) throw new Error("That isn't an EVM address.");
  const to = getAddress(input.to.trim());
  const probe = await draftEvmCall({ network: input.network, from: input.from, call: { to, value: 0n } });
  const keep = await keepFor(input.network, probe, input.balance);
  if (input.balance <= keep) throw new Error("This balance doesn't cover the network fee right now.");
  const transaction = checkedTransaction({ ...(probe.transaction as unknown as Record<string, unknown>), value: input.balance - keep } as never);
  return { ...probe, transaction, summary: transactionSummary(transaction), to, kind: "send" };
}

/** The most a transaction can cost in fees, in the coin's smallest unit. */
export const maxFeeOf = (tx: { gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint }) => (tx.gas ?? 0n) * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n);

// ── EVM ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `to`: the recipient of a send (kept in Recent), or for a wallet-made call (a revoke) the contract, which isn't. */
export type EvmDraft = { network: Network; transaction: ReturnType<typeof checkedTransaction>; summary: TransactionSummary; to: string; from: string; kind: "send" | "call" };

export async function draftEvmSend(input: { network: Network; from: string; to: string; amount: string; token: { address: string; decimals: number } | null }): Promise<EvmDraft> {
  if (!isAddress(input.to.trim())) throw new Error("That isn't an EVM address.");
  const to = getAddress(input.to.trim());
  const value = parseUnits(input.amount, input.token ? input.token.decimals : 18);
  if (value <= 0n) throw new Error("Enter an amount above zero.");
  const call = input.token
    ? { to: getAddress(input.token.address), value: 0n, data: `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${value.toString(16).padStart(64, "0")}` as `0x${string}` }
    : { to, value, data: undefined };
  return { ...(await draftEvmCall({ network: input.network, from: input.from, call })), to, kind: "send" };
}

/** A transaction the wallet itself makes (a token transfer, a revoke): filled from the chain now, checked by the core. */
export async function draftEvmCall(input: { network: Network; from: string; call: { to: string; value: bigint; data?: `0x${string}` } }): Promise<EvmDraft> {
  const { network, from } = input;
  const call = { ...input.call, to: getAddress(input.call.to) };
  const base = { from, to: call.to, value: `0x${call.value.toString(16)}`, ...(call.data ? { data: call.data } : {}) };
  const [nonce, gas, block] = await Promise.all([
    rpc<string>(network.rpc, "eth_getTransactionCount", [from, "pending"]).then(Number),
    rpc<string>(network.rpc, "eth_estimateGas", [base]).then(g => BigInt(g) * 12n / 10n),
    rpc<{ baseFeePerGas?: string } | null>(network.rpc, "eth_getBlockByNumber", ["latest", false]),
  ]);
  const chainId = network.evmChainId!;
  const fees = block?.baseFeePerGas
    ? await (async () => {
      const priority = await rpc<string>(network.rpc, "eth_maxPriorityFeePerGas", []).then(BigInt).catch(() => 1_000_000n);
      const max = BigInt(block.baseFeePerGas!) * 2n + priority;
      return { type: "eip1559" as const, maxFeePerGas: max, maxPriorityFeePerGas: priority > max ? max : priority };
    })()
    : { type: "legacy" as const, gasPrice: BigInt(await rpc<string>(network.rpc, "eth_gasPrice", [])) };
  const transaction = checkedTransaction({ chainId, nonce, gas, value: call.value, to: call.to, ...(call.data ? { data: call.data } : {}), ...fees });
  return { network, transaction, summary: transactionSummary(transaction), to: call.to, from, kind: "call" };
}

/** What a send returns: its id, and whether a node is known to have taken it (false: not confirmed yet, see sendStatus). */
export type Sent = { id: string; certain: boolean };

export async function sendEvm(draft: EvmDraft): Promise<Sent> {
  const raw = await signing.evmSignTransaction({ transaction: draft.transaction });
  // The hash comes from the signed bytes, so it is known even if no endpoint answers cleanly (see sendSigned).
  const { id: hash, certain } = await sendSigned(draft.network.rpc, "eth_sendRawTransaction", [raw], keccak256(raw));
  if (draft.kind === "send") await remember(draft.to, "EVM");
  await activity.add({ kind: "send", text: `${certain ? "Sent" : "Not confirmed yet (check the explorer before sending again)"} on ${draft.network.name}: ${draft.summary.tokenCall?.text ?? draft.summary.amount} · ${hash}`,
    account: draft.from, networkId: draft.network.networkId, hash, status: "pending" });
  return { id: hash, certain };
}

/** Updates a send's Activity entry once its outcome is known: confirmed, failed on the network, or not sent. */
export function settleSendActivity(id: string, outcome: "confirmed" | "failed" | "not-sent") {
  const label = outcome === "confirmed" ? "Confirmed" : outcome === "failed" ? "Failed on the network" : "Not sent";
  return activity.settle(id, text => text.replace(/^(Sent|Not confirmed yet \(check the explorer before sending again\))/, label), outcome);
}

/**
 * Where a sent transaction stands, asked of the chain: "confirmed" or "failed" once it is in a block; "seen" when a node has it
 * but it isn't in a block yet; "unknown" when no node knows it (it may still arrive, or it was never taken).
 */
export type SendState = "confirmed" | "failed" | "seen" | "unknown";
export async function sendStatus(network: Network, id: string): Promise<SendState> {
  if (network.family === "SOLANA") {
    const { value } = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(network.rpc, "getSignatureStatuses", [[id], { searchTransactionHistory: true }]);
    const s = value?.[0];
    if (!s) return "unknown";
    if (s.err) return "failed";
    return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : "seen";
  }
  const receipt = await rpc<{ status: string } | null>(network.rpc, "eth_getTransactionReceipt", [id]);
  if (receipt) return receipt.status === "0x1" ? "confirmed" : "failed";
  const tx = await rpc<unknown>(network.rpc, "eth_getTransactionByHash", [id]);
  return tx ? "seen" : "unknown";
}

// ── Solana ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SYSTEM = new Uint8Array(32);
const u64 = (value: bigint) => { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, value, true); return out; };

/** A legacy transaction with one System Program transfer, signed by `from` (the fee payer). */
export function solTransferTransaction(from: string, to: string, lamports: bigint, blockhash: string): Uint8Array {
  const data = new Uint8Array([2, 0, 0, 0, ...u64(lamports)]);
  const message = new Uint8Array([1, 0, 1, 3, ...bs58.decode(from), ...bs58.decode(to), ...SYSTEM, ...bs58.decode(blockhash), 1, 2, 2, 0, 1, data.length, ...data]);
  return new Uint8Array([1, ...new Uint8Array(64), ...message]);
}

export type SolDraft = { network: Network; tx: Uint8Array; lamports: bigint; to: string; fee: bigint };
export async function draftSolSend(input: { network: Network; from: string; to: string; amount: string }): Promise<SolDraft> {
  if (!validRecipient("SOLANA", input.to)) throw new Error("That isn't a Solana address.");
  if (input.to.trim() === input.from) throw new Error("That's this account.");
  const lamports = parseUnits(input.amount, 9);
  if (lamports <= 0n) throw new Error("Enter an amount above zero.");
  // Solana's rent rule, checked before signing: an account may be emptied to 0, but not left with less than the rent-exempt minimum;
  // and a new address must receive at least that minimum. Otherwise the network refuses the transfer.
  const [own, theirs, rentMin, { value }] = await Promise.all([
    rpc<{ value: number }>(input.network.rpc, "getBalance", [input.from, { commitment: "confirmed" }]).then(r => BigInt(r.value)),
    rpc<{ value: number }>(input.network.rpc, "getBalance", [input.to.trim(), { commitment: "confirmed" }]).then(r => BigInt(r.value)),
    rpc<number>(input.network.rpc, "getMinimumBalanceForRentExemption", [0]).then(BigInt),
    rpc<{ value: { blockhash: string } }>(input.network.rpc, "getLatestBlockhash", [{ commitment: "confirmed" }]),
  ]);
  const left = own - lamports - SOL_FEE;
  if (left < 0n) throw new Error("That's more than this account holds with the network fee. Use Max.");
  if (left > 0n && left < rentMin) throw new Error(`That would leave ${formatUnits(left, 9)} SOL, below Solana's minimum of ${formatUnits(rentMin, 9)} SOL for an account. Send all of it (Max), or leave at least the minimum.`);
  if (theirs === 0n && lamports < rentMin) throw new Error(`This address has no SOL yet, so it must receive at least ${formatUnits(rentMin, 9)} SOL.`);
  const tx = solTransferTransaction(input.from, input.to.trim(), lamports, value.blockhash);
  return { network: input.network, tx, lamports, to: input.to.trim(), fee: SOL_FEE };
}

export async function sendSol(draft: SolDraft, from: string): Promise<Sent> {
  const signed = await signSolanaTransaction(draft.tx, from, bytes => signing.solanaSignBytes({ bytes }));
  let b64 = ""; for (const b of signed) b64 += String.fromCharCode(b);
  // A Solana transaction's id is its first signature, in the signed bytes (after the signature count).
  const { id: signature, certain } = await sendSigned(draft.network.rpc, "sendTransaction", [btoa(b64), { encoding: "base64", preflightCommitment: "confirmed" }], bs58.encode(signed.subarray(1, 65)));
  await remember(draft.to, "SOLANA");
  await activity.add({ kind: "send", text: `${certain ? "Sent" : "Not confirmed yet (check the explorer before sending again)"} ${Number(draft.lamports) / 1e9} SOL on ${draft.network.name} · ${signature}`,
    account: from, networkId: draft.network.networkId, hash: signature, status: "pending" });
  return { id: signature, certain };
}

export const rpcFor = (networkId: string) => { const chain = networkById(networkId); return chain ? browserRpcUrls(chain) : []; };
