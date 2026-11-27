import { decodeFunctionData, formatUnits, hexToString, isHex, maxUint160, parseAbi, type Hex, type TransactionSerializable, type TypedDataDefinition } from "viem";
import { getChain, KNOWN_SOLANA_MINTS, knownTokens, PERMIT2, normalizeNetworkId, wrappedNative } from "./chains";
import { isSolanaTransactionMessage, parseSolanaTransaction, type SolanaTxSummary, type TokenAction } from "./solana-tx";

/** Plain-language summaries of what an app asks the wallet to sign. Everything here is shown, never trusted. */

export type Row = [label: string, value: string];
const clip = (value: string, max = 160) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
export const short = (address: string) => address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;

const printable = (text: string) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F�]/.test(text);

/** A message as the user should read it: text when it is text, otherwise the raw bytes. */
export function messageForDisplay(message: unknown): { text: string; raw: boolean } {
  if (typeof message === "string") return { text: message, raw: false };
  const raw = (message as { raw?: unknown })?.raw;
  if (typeof raw === "string" && isHex(raw)) {
    try {
      const text = hexToString(raw as Hex);
      if (text && printable(text)) return { text, raw: false };
    } catch { /* not text */ }
    return { text: raw, raw: true };
  }
  throw new Error("INVALID_SIGN_REQUEST");
}

export function bytesForDisplay(bytes: Uint8Array): { text: string; raw: boolean } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text && printable(text)) return { text, raw: false };
  } catch { /* not text */ }
  return { text: `0x${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}`, raw: true };
}

export function networkName(chainId: number | bigint | string | undefined): string {
  if (chainId === undefined || chainId === null || chainId === "") return "Any network";
  try {
    const chain = getChain(Number(chainId));
    if (chain) return chain.testnet ? `${chain.name} (test network)` : chain.name;
  } catch { /* unknown */ }
  return `Network ${String(chainId)}`;
}

/** Whether the chain registry lists this network for this build (production builds list no test networks). */
export function networkKnown(chainId: unknown): boolean {
  try { return chainId !== undefined && chainId !== null && chainId !== "" && Boolean(getChain(Number(chainId))); } catch { return false; }
}

function nativeSymbol(chainId: number) {
  try { return getChain(chainId)?.nativeSymbol ?? "ETH"; } catch { return "ETH"; }
}

/** Signatures that let someone else move the user's tokens later (permits). They get a plain warning. */
const SPENDING_TYPES = /^(Permit|PermitSingle|PermitBatch|PermitTransferFrom|PermitBatchTransferFrom|PermitWitnessTransferFrom|PermitBatchWitnessTransferFrom|Order|OrderComponents)$/;

/** Most rows the typed-data screen shows. A request with more signed fields is refused, never cut short. */
const MAX_TYPED_ROWS = 60;
/** Field names that hand something over: spending rights, an operator, or the parties of an order. */
const SPENDING_FIELDS = /^(spender|operator|allowance|approved|taker|offerer|consideration|offer|permitted|details)$/i;

/**
 * The rows of exactly what gets signed: the fields `types[primaryType]` lists, in order, walked through nested structs and arrays. Keys
 * in `message` that the types don't list are not signed and not shown. Too many signed fields, or nesting too deep to show, is refused.
 */
function signedRows(types: Record<string, readonly { name: string; type: string }[]>, type: string, value: unknown, path: string, rows: Row[], depth: number, flags: { spending: boolean; unlimited: boolean }) {
  if (depth > 6) throw new Error("EIP712_TOO_DEEP");
  const list = type.match(/^(.*)\[(\d*)\]$/);
  if (list) {
    if (!Array.isArray(value)) throw new Error("EIP712_PAYLOAD_INVALID");
    if (!value.length) rows.push([path, "(empty list)"]);
    value.forEach((inner, index) => signedRows(types, list[1]!, inner, `${path}.${index}`, rows, depth + 1, flags));
  } else if (types[type]) {
    if (!value || typeof value !== "object") throw new Error("EIP712_PAYLOAD_INVALID");
    for (const field of types[type]!) {
      if (SPENDING_FIELDS.test(field.name)) flags.spending = true;
      signedRows(types, field.type, (value as Record<string, unknown>)[field.name], path ? `${path}.${field.name}` : field.name, rows, depth + 1, flags);
    }
  } else {
    // A number as large as the largest a token can hold is how apps write "no limit": it is said in words, not as 78 digits.
    if (/^uint/.test(type) && /(value|amount|allowance|allowed|wad)$/i.test(path) && noLimit(value)) { flags.unlimited = true; rows.push([path || "value", "No limit (the maximum amount)"]); }
    else rows.push([path || "value", clip(typeof value === "object" ? JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v) : String(value))]);
  }
  if (rows.length > MAX_TYPED_ROWS) throw new Error("EIP712_TOO_LARGE");
}

/** At or above this an amount is "everything": no real token amount comes near 2^160, and apps write no-limit as the largest number the field holds. */
const NO_LIMIT = maxUint160;
function noLimit(value: unknown): boolean {
  try { return (typeof value === "bigint" || typeof value === "number" || (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value))) && BigInt(value) >= NO_LIMIT; } catch { return false; }
}

export type TypedDataSummary = { app: string | null; network: string | null; contract: string | null; kind: string; rows: Row[]; spending: boolean; /** A signed amount is the maximum: no limit. */ unlimited: boolean };
export function typedDataSummary(input: unknown): TypedDataSummary {
  const data = input as TypedDataDefinition;
  if (!data || typeof data !== "object" || !data.types || typeof data.primaryType !== "string" || !data.message || typeof data.message !== "object") throw new Error("EIP712_PAYLOAD_INVALID");
  const types = data.types as unknown as Record<string, readonly { name: string; type: string }[]>;
  if (!Array.isArray(types[data.primaryType])) throw new Error("EIP712_PAYLOAD_INVALID");
  const domain = (data.domain ?? {}) as { name?: unknown; chainId?: unknown; verifyingContract?: unknown };
  // A request may list the domain's fields itself (types.EIP712Domain), and only the listed ones are signed: a network or
  // contract left out of that list is not part of the signature, so it is not shown as if it were.
  const listed = Array.isArray(types.EIP712Domain) ? new Set(types.EIP712Domain.map(f => f?.name)) : null;
  const signed = (field: string) => !listed || listed.has(field);
  const rows: Row[] = [];
  const flags = { spending: false, unlimited: false };
  signedRows(types, data.primaryType, data.message, "", rows, 0, flags);
  return {
    app: signed("name") && typeof domain.name === "string" ? clip(domain.name, 60) : null,
    // No chainId (absent or null): the signature isn't tied to a network, so none is named and none is flagged.
    network: signed("chainId") && domain.chainId != null ? networkName(domain.chainId as number) : null,
    contract: signed("verifyingContract") && typeof domain.verifyingContract === "string" ? domain.verifyingContract : null,
    kind: clip(data.primaryType, 60),
    rows,
    spending: SPENDING_TYPES.test(data.primaryType) || flags.spending,
    unlimited: flags.unlimited,
  };
}

/** What a token call does, in words, and a warning when it hands over more than this one moment. */
export type TokenCall = { text: string; warning: string | null; /** Who gets the tokens or the permission, in full: a shortened address can be imitated. */ party?: Row };

/** Tokens the chain registry knows on this network: symbol and decimals for showing amounts. */
export function knownEvmToken(chainId: number, address: string): { symbol: string; decimals: number } | null {
  const a = address.toLowerCase();
  let networkId: string;
  try { networkId = normalizeNetworkId(chainId); } catch { return null; }
  const known = knownTokens(networkId).find(token => token.address.toLowerCase() === a);
  if (known) return { symbol: known.symbol, decimals: known.decimals };
  try {
    if (wrappedNative(chainId)?.toLowerCase() === a) return { symbol: `W${getChain(chainId)?.nativeSymbol ?? "ETH"}`, decimals: 18 };
  } catch { /* no wrapped coin listed */ }
  return null;
}

const TOKEN_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function increaseAllowance(address spender, uint256 addedValue)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
  "function setApprovalForAll(address operator, bool approved)",
]);
const PERMIT2_ABI = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
/** At or above this an allowance is "everything": apps use the maximum to mean no limit, and no real amount comes near 2^160. */
const UNLIMITED = maxUint160;

/** Decodes the token actions people must see before signing. Anything else returns null and shows as app code. */
export function decodeTokenCall(chainId: number, to: string | null, data: string | null): TokenCall | null {
  if (!to || !data || !isHex(data) || data.length < 10) return null;
  const amount = (value: bigint, address: string) => {
    const known = knownEvmToken(chainId, address);
    return known ? `${trim(formatUnits(value, known.decimals), known.decimals)} ${known.symbol}` : `${value.toString()} units of token ${short(address)}`;
  };
  const symbol = (address: string) => knownEvmToken(chainId, address)?.symbol ?? `token ${short(address)}`;
  const allowance = (spender: string, value: bigint, address: string, unlimited: boolean): TokenCall => {
    const party: Row = ["Spender", spender];
    if (value === 0n) return { text: `Removes ${short(spender)}'s permission to spend your ${symbol(address)}`, warning: null, party };
    if (unlimited) return { text: `Lets ${short(spender)} spend all your ${symbol(address)}, now and later`, warning: `There's no limit. Only confirm if you trust ${short(spender)}.`, party };
    return { text: `Lets ${short(spender)} spend your ${symbol(address)}: ${amount(value, address)}`, warning: null, party };
  };
  if (to.toLowerCase() === PERMIT2.toLowerCase()) {
    try {
      const [tokenAddress, spender, value] = decodeFunctionData({ abi: PERMIT2_ABI, data: data as Hex }).args;
      return allowance(spender, value, tokenAddress, value >= maxUint160);
    } catch { return null; }
  }
  try {
    const call = decodeFunctionData({ abi: TOKEN_ABI, data: data as Hex });
    switch (call.functionName) {
      case "approve":
      case "increaseAllowance": {
        const [spender, value] = call.args;
        return allowance(spender, value, to, value >= UNLIMITED);
      }
      case "transfer": { const [recipient, value] = call.args; return { text: `Send ${amount(value, to)} to ${short(recipient)}`, warning: null, party: ["Recipient", recipient] }; }
      case "transferFrom": { const [, recipient, value] = call.args; return { text: `Send ${amount(value, to)} to ${short(recipient)}`, warning: null, party: ["Recipient", recipient] }; }
      case "setApprovalForAll": {
        const [operator, approved] = call.args;
        return approved
          ? { text: `Lets ${short(operator)} move all your items in this collection`, warning: `That's every item you hold in it, now and later. Only confirm if you trust ${short(operator)}.`, party: ["Operator", operator] }
          : { text: `Removes ${short(operator)}'s access to your items in this collection`, warning: null, party: ["Operator", operator] };
      }
    }
  } catch { /* not a token call we know */ }
  return null;
}

export type TransactionSummary = { network: string; chainId: number; to: string | null; amount: string; maxFee: string | null; callsContract: boolean; tokenCall: TokenCall | null; rows: Row[] };
const TX_AMOUNTS = ["value", "gas", "gasPrice", "maxFeePerGas", "maxPriorityFeePerGas"] as const;
const TX_FIELDS = new Set<string>(["chainId", "to", "data", "nonce", "type", "accessList", ...TX_AMOUNTS]);
const TX_TYPES = new Set(["legacy", "eip2930", "eip1559"]);

/**
 * The transaction exactly as it will be signed, checked field by field. The screen and the signature both use this object, so what the
 * user confirms is what is signed: an amount sent as a string or anything else viem would read differently than the screen is refused,
 * and so is any field the screen does not show (an EIP-7702 authorization list, blobs). Numbers are accepted as whole safe integers.
 */
export function checkedTransaction(input: unknown): TransactionSerializable & { chainId: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_TRANSACTION");
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (raw[key] !== undefined && !TX_FIELDS.has(key)) throw new Error("INVALID_TRANSACTION");
  const out: Record<string, unknown> = {};
  if (typeof raw.chainId !== "number" || !Number.isSafeInteger(raw.chainId) || raw.chainId <= 0) throw new Error("INVALID_TRANSACTION");
  out.chainId = raw.chainId;
  for (const key of TX_AMOUNTS) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "bigint" && value >= 0n) out[key] = value;
    else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out[key] = BigInt(value);
    else throw new Error("INVALID_TRANSACTION");
  }
  if (raw.nonce !== undefined && raw.nonce !== null) {
    if (typeof raw.nonce !== "number" || !Number.isSafeInteger(raw.nonce) || raw.nonce < 0) throw new Error("INVALID_TRANSACTION");
    out.nonce = raw.nonce;
  }
  if (raw.to !== undefined && raw.to !== null) {
    if (typeof raw.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw.to)) throw new Error("INVALID_TRANSACTION");
    out.to = raw.to;
  }
  if (raw.data !== undefined && raw.data !== null) {
    if (typeof raw.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.data)) throw new Error("INVALID_TRANSACTION");
    out.data = raw.data;
  }
  if (raw.type !== undefined && raw.type !== null) {
    if (typeof raw.type !== "string" || !TX_TYPES.has(raw.type)) throw new Error("INVALID_TRANSACTION");
    out.type = raw.type;
  }
  if (raw.accessList !== undefined && raw.accessList !== null) {
    if (!Array.isArray(raw.accessList)) throw new Error("INVALID_TRANSACTION");
    out.accessList = raw.accessList;
  }
  return out as TransactionSerializable & { chainId: number };
}

export function transactionSummary(input: unknown): TransactionSummary {
  const tx = checkedTransaction(input);
  const symbol = nativeSymbol(tx.chainId);
  const value = typeof tx.value === "bigint" ? tx.value : 0n;
  const gas = typeof tx.gas === "bigint" ? tx.gas : null;
  const price = typeof (tx as { maxFeePerGas?: bigint }).maxFeePerGas === "bigint" ? (tx as { maxFeePerGas: bigint }).maxFeePerGas
    : typeof (tx as { gasPrice?: bigint }).gasPrice === "bigint" ? (tx as { gasPrice: bigint }).gasPrice : null;
  const data = typeof tx.data === "string" && tx.data !== "0x" ? tx.data : null;
  const tokenCall = decodeTokenCall(tx.chainId, typeof tx.to === "string" ? tx.to : null, data);
  const rows: Row[] = [];
  if (tokenCall?.party) rows.push(tokenCall.party);
  if (data) rows.push(["App data", data.length > 10 ? `${data.slice(0, 10)} · ${(data.length - 2) / 2} bytes` : data]);
  if (typeof tx.nonce === "number") rows.push(["Nonce", String(tx.nonce)]);
  return {
    network: networkName(tx.chainId), chainId: tx.chainId,
    to: typeof tx.to === "string" ? tx.to : null,
    amount: `${trim(formatUnits(value, 18))} ${symbol}`,
    maxFee: gas !== null && price !== null ? `${trim(formatUnits(gas * price, 18), 8)} ${symbol}` : null,
    callsContract: Boolean(data),
    tokenCall,
    rows,
  };
}
function trim(value: string, decimals = 6) {
  const [whole, fraction = ""] = value.split(".");
  const cut = fraction.slice(0, decimals).replace(/0+$/, "");
  if (!cut && fraction.replace(/0/g, "")) return `<0.${"0".repeat(decimals - 1)}1`;
  return cut ? `${whole}.${cut}` : whole!;
}

const SOLANA_MINTS = KNOWN_SOLANA_MINTS;

/** One plain line per token instruction, and a warning when it hands something over. */
export function solanaTokenAction(action: TokenAction, signer: string): TokenCall {
  const who = (address: string | null) => address === null ? "an account listed outside this request" : address === signer ? "you" : short(address);
  const tokenAmount = (value: bigint, mint: string | null, decimals: number | null) => {
    const known = mint ? SOLANA_MINTS[mint] : undefined;
    if (known) return `${trim(formatUnits(value, known.decimals), known.decimals)} ${known.symbol}`;
    if (decimals !== null) return `${trim(formatUnits(value, decimals), decimals)} of token ${mint ? short(mint) : "(unknown)"}`;
    return `${value.toString()} token units`;
  };
  switch (action.kind) {
    case "transfer":
      return { text: `Send ${tokenAmount(action.amount, action.mint, action.decimals)} to ${who(action.destination)}`, warning: null };
    case "approve":
      return { text: `Lets ${who(action.delegate)} spend your tokens: up to ${tokenAmount(action.amount, action.mint, action.decimals)}`, warning: `Only confirm if you trust ${who(action.delegate)}.` };
    case "setAuthority": {
      const to = action.newAuthority === null ? "no one" : who(action.newAuthority);
      if (action.currentAuthority !== signer) return { text: `Changes who controls a token account, to ${to}`, warning: null };
      return { text: `Gives control of your token account to ${to}`, warning: action.newAuthority === null ? "You lose control of this account for good." : `${to} will control this account and everything in it. You can't take it back.` };
    }
    case "close":
      return { text: `Closes a token account. Its leftover SOL goes to ${who(action.destination)}`, warning: action.destination !== null && action.destination !== signer ? "The leftover SOL goes to someone else." : null };
  }
}

export type SolanaSummary = SolanaTxSummary & { rows: Row[]; actions: TokenCall[] };
export function solanaSummary(bytes: unknown, signer: string): SolanaSummary {
  if (!(bytes instanceof Uint8Array)) throw new Error("SOLANA_TX_INVALID");
  const parsed = parseSolanaTransaction(bytes);
  if (!parsed.signers.includes(signer)) throw new Error("SOLANA_SIGNER_NOT_IN_TRANSACTION");
  // A send names its recipient in full: a shortened address can be imitated by one that starts and ends the same.
  const rows: Row[] = parsed.transfers.flatMap((t): Row[] => {
    const amount = `${trim(formatUnits(t.lamports, 9), 9)} SOL`;
    return t.from === signer ? [["Send", amount], ["To", t.to]] : [[`Move from ${short(t.from)}`, amount], ["To", t.to]];
  });
  const actions = parsed.tokenActions.map(action => solanaTokenAction(action, signer));
  for (const a of parsed.assigns) actions.push(a.account === signer
    ? { text: `Hands your whole account to the program ${short(a.owner)}`, warning: "That program would control your account and everything in it. This is how accounts get emptied: decline unless you are certain." }
    : { text: `Hands the account ${short(a.account)} to the program ${short(a.owner)}`, warning: null });
  if (parsed.unreadPrograms.length) {
    const named = parsed.unreadPrograms.slice(0, 3).map(short).join(", "), more = parsed.unreadPrograms.length - 3;
    actions.push({ text: `Runs app code the wallet can't read (${named}${more > 0 ? ` and ${more} more` : ""}). It can move what's in your account.`, warning: null });
  }
  if (parsed.otherInstructions) rows.push(["Other actions", `${parsed.otherInstructions} · ${parsed.programs.length} program${parsed.programs.length === 1 ? "" : "s"}`]);
  rows.push(["Network fee paid by", parsed.feePayer === signer ? "You" : short(parsed.feePayer)]);
  return { ...parsed, rows, actions };
}

/**
 * Solana bytes as the user should see them before signing: a transaction message is summarised like a transaction (signature slots
 * are added around it, as it would be sent), anything else is shown as a message.
 */
export type SolanaBytesView = { kind: "transaction"; summary: SolanaSummary } | { kind: "message"; text: string; raw: boolean };
export function solanaBytesView(bytes: unknown, signer: string): SolanaBytesView {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error("INVALID_SIGN_REQUEST");
  if (!isSolanaTransactionMessage(bytes)) return { kind: "message", ...bytesForDisplay(bytes) };
  const required = bytes[0]! & 0x80 ? bytes[1]! : bytes[0]!;
  const tx = new Uint8Array(1 + required * 64 + bytes.length);
  tx[0] = required;
  tx.set(bytes, 1 + required * 64);
  return { kind: "transaction", summary: solanaSummary(tx, signer) };
}
