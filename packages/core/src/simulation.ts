/**
 * Reading a simulated transaction (eth_simulateV1 with traceTransfers) into what it moves in and out of the wallet, and checking the
 * balance against what a transaction can spend. Where the simulation runs is up to the wallet using this; nothing here talks to a network.
 */
import { formatUnits } from "viem";

export type AssetChange = { direction: "out" | "in"; amount: string; symbol: string; token: string | null };
export type Preview =
  | { kind: "changes"; changes: AssetChange[] }
  | { kind: "fails"; reason: string }
  | { kind: "unavailable" };
export type SimLog = { address: string; topics: string[]; data: string };
export type SimCall = { status: string; logs?: SimLog[]; error?: { message?: string; data?: string }; returnData?: string };

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** eth_simulateV1 reports native-coin movements as Transfer logs from this pseudo-address. */
export const NATIVE_PSEUDO = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const topicAddress = (topic: string) => `0x${topic.slice(-40)}`.toLowerCase();

/** Whether the balance covers what the transaction can spend (amount plus the most it can pay in fees). */
export function fundsCheck(balance: bigint, value: bigint, maxFee: bigint | null) {
  const needs = value + (maxFee ?? 0n);
  return { enough: balance >= needs, balance, needs };
}

/** Net changes for `owner` from a simulated transaction's transfer logs, positive for what comes in. */
export function netChanges(logs: SimLog[], owner: string): Map<string, bigint> {
  const me = owner.toLowerCase();
  const totals = new Map<string, bigint>();
  for (const log of logs) {
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics.length !== 3) continue; // ERC-721 has 4 topics
    const from = topicAddress(log.topics[1]!), to = topicAddress(log.topics[2]!);
    if (from !== me && to !== me) continue;
    let amount: bigint;
    try { amount = BigInt(log.data); } catch { continue; }
    const token = log.address.toLowerCase();
    const delta = (to === me ? amount : 0n) - (from === me ? amount : 0n);
    totals.set(token, (totals.get(token) ?? 0n) + delta);
  }
  for (const [token, amount] of totals) if (amount === 0n) totals.delete(token);
  return totals;
}

/** A token's symbol() result: a string (dynamic ABI encoding) or bytes32. Only plain printable text is shown. */
export function decodeSymbol(data: string): string | null {
  try {
    const body = data.replace(/^0x/, "");
    if (body.length < 64) return null;
    let bytes: number[];
    if (body.length >= 192) {
      const length = Number(BigInt(`0x${body.slice(64, 128)}`));
      bytes = (body.slice(128, 128 + length * 2).match(/../g) ?? []).map(b => parseInt(b, 16));
    } else bytes = (body.slice(0, 64).match(/../g) ?? []).map(b => parseInt(b, 16)).filter(b => b !== 0);
    const text = String.fromCharCode(...bytes);
    return /^[\x20-\x7e]{1,16}$/.test(text) ? text.trim() : null;
  } catch { return null; }
}

/** An amount as people read it: thousands separated, at most six decimals. */
export function amountText(value: bigint, decimals: number) {
  const [whole, fraction = ""] = formatUnits(value < 0n ? -value : value, decimals).split(".");
  const cut = fraction.slice(0, 6).replace(/0+$/, "");
  return cut ? `${Number(whole).toLocaleString("en-US")}.${cut}` : Number(whole).toLocaleString("en-US");
}
