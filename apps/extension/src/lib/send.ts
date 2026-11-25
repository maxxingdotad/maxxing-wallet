/**
 * Sending from the extension: EVM coins and ERC-20 tokens, and SOL. The transaction is built here, shown through the wallet core's
 * own review (the same checks as any site's request), signed by the core, and broadcast through the chain's public RPC.
 */
import bs58 from "bs58";
import { getAddress, isAddress, keccak256 } from "viem";
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
export type RecipientCheck = { firstTime: boolean; lookalike: string | null };
const recipients = () => kept.get<string[]>("recipients", []);
/**
 * Address poisoning: scammers send dust from an address that starts and ends like one you used, hoping you copy it from your
 * history. A new recipient that matches a known one's first and last characters, but isn't it, is flagged.
 */
export async function checkRecipient(to: string): Promise<RecipientCheck> {
  const known = await recipients(), t = to.trim().toLowerCase();
  if (known.includes(t)) return { firstTime: false, lookalike: null };
  const lookalike = known.find(k => k !== t && k.slice(0, 6) === t.slice(0, 6) && k.slice(-4) === t.slice(-4)) ?? null;
  return { firstTime: true, lookalike };
}
const remember = (to: string) => kept.update<string[]>("recipients", [], all => [to.trim().toLowerCase(), ...all.filter(r => r !== to.trim().toLowerCase())].slice(0, 100));

// ── EVM ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type EvmDraft = { network: Network; transaction: ReturnType<typeof checkedTransaction>; summary: TransactionSummary; to: string };

export async function draftEvmSend(input: { network: Network; from: string; to: string; amount: string; token: { address: string; decimals: number } | null }): Promise<EvmDraft> {
  const { network, from } = input;
  if (!isAddress(input.to.trim())) throw new Error("That isn't an EVM address.");
  const to = getAddress(input.to.trim());
  const value = parseUnits(input.amount, input.token ? input.token.decimals : 18);
  if (value <= 0n) throw new Error("Enter an amount above zero.");
  const call = input.token
    ? { to: getAddress(input.token.address), value: 0n, data: `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, "0")}${value.toString(16).padStart(64, "0")}` as `0x${string}` }
    : { to, value, data: undefined };
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
  return { network, transaction, summary: transactionSummary(transaction), to };
}

/** What a send returns: its id, and whether a node is known to have taken it (false: not confirmed yet, see sendStatus). */
export type Sent = { id: string; certain: boolean };

export async function sendEvm(draft: EvmDraft): Promise<Sent> {
  const raw = await signing.evmSignTransaction({ transaction: draft.transaction });
  // The hash comes from the signed bytes, so it is known even if no endpoint answers cleanly (see sendSigned).
  const { id: hash, certain } = await sendSigned(draft.network.rpc, "eth_sendRawTransaction", [raw], keccak256(raw));
  await remember(draft.to);
  await activity.add({ kind: "send", text: `${certain ? "Sent" : "Not confirmed yet (check the explorer before sending again)"} on ${draft.network.name}: ${draft.summary.tokenCall?.text ?? draft.summary.amount} · ${hash}` });
  return { id: hash, certain };
}

/** Updates a send's Activity entry once its outcome is known: confirmed, failed on the network, or not sent. */
export function settleSendActivity(id: string, outcome: "confirmed" | "failed" | "not-sent") {
  const label = outcome === "confirmed" ? "Confirmed" : outcome === "failed" ? "Failed on the network" : "Not sent";
  return activity.settle(id, text => text.replace(/^(Sent|Not confirmed yet \(check the explorer before sending again\))/, label));
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
  const { value } = await rpc<{ value: { blockhash: string } }>(input.network.rpc, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = solTransferTransaction(input.from, input.to.trim(), lamports, value.blockhash);
  return { network: input.network, tx, lamports, to: input.to.trim(), fee: 5000n };
}

export async function sendSol(draft: SolDraft, from: string): Promise<Sent> {
  const signed = await signSolanaTransaction(draft.tx, from, bytes => signing.solanaSignBytes({ bytes }));
  let b64 = ""; for (const b of signed) b64 += String.fromCharCode(b);
  // A Solana transaction's id is its first signature, in the signed bytes (after the signature count).
  const { id: signature, certain } = await sendSigned(draft.network.rpc, "sendTransaction", [btoa(b64), { encoding: "base64", preflightCommitment: "confirmed" }], bs58.encode(signed.subarray(1, 65)));
  await remember(draft.to);
  await activity.add({ kind: "send", text: `${certain ? "Sent" : "Not confirmed yet (check the explorer before sending again)"} ${Number(draft.lamports) / 1e9} SOL on ${draft.network.name} · ${signature}` });
  return { id: signature, certain };
}

export const rpcFor = (networkId: string) => { const chain = networkById(networkId); return chain ? browserRpcUrls(chain) : []; };
