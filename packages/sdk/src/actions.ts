/**
 * Wallet actions that work the same from plain JavaScript and from the React hooks: balances (native or any ERC-20),
 * signing, sending and waiting for a transaction. Signing and sending open the wallet window; reads go to the network.
 */
import { networksFor, type MaxxingWallet } from "./index";
import type { EvmNetwork } from "./ethereum";
import { ERROR_CODES, ProviderRpcError } from "./protocol";
import { rpcCall, toQuantity } from "./rpc";

type Hex = `0x${string}`;
const isAddress = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

/** 1234500000000000000n, 18 → "1.2345". Exact: no floating point. */
export function formatUnits(value: bigint, decimals = 18, maxFractionDigits = 6): string {
  const negative = value < 0n, abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const fraction = decimals ? (abs % base).toString().padStart(decimals, "0").slice(0, maxFractionDigits).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${abs / base}${fraction ? `.${fraction}` : ""}`;
}

/** "1.5", 18 → 1500000000000000000n. Rejects more decimals than the token has. */
export function parseUnits(value: string, decimals = 18): bigint {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) throw new Error("INVALID_AMOUNT");
  const fraction = match[2] ?? "";
  if (fraction.replace(/0+$/, "").length > decimals) throw new Error("TOO_MANY_DECIMALS");
  return BigInt(match[1] || "0") * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

/** The wallet's network for `chainId`, or the registry's when the app didn't list it (reads only). */
export function networkFor(wallet: MaxxingWallet, chainId?: number): EvmNetwork {
  if (chainId === undefined) return wallet.ethereum.network;
  return wallet.ethereum.availableNetworks.find(n => n.chainId === chainId) ?? networksFor({ chains: [chainId] })[0]!;
}

export type Balance = { chainId: number; address: Hex; token: Hex | null; value: bigint; decimals: number; symbol: string; formatted: string };

const SELECTOR = { balanceOf: "0x70a08231", decimals: "0x313ce567", symbol: "0x95d89b41" } as const;
const word = (hex: string, index: number) => hex.slice(2 + index * 64, 2 + (index + 1) * 64);

/** ABI string or bytes32 (older tokens) → text; null when it is neither. */
export function decodeSymbol(hex: string): string | null {
  if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex.length < 66) return null;
  const bytesToText = (bytes: string) => {
    const pairs = bytes.match(/../g) ?? [];
    const text = new TextDecoder().decode(new Uint8Array(pairs.map(b => parseInt(b, 16)))).replace(/\0+$/, "");
    return /^[\x20-\x7e]{1,32}$/.test(text) ? text : null;
  };
  if (hex.length >= 194 && BigInt(`0x${word(hex, 0)}`) === 32n) {
    const length = Number(BigInt(`0x${word(hex, 1)}`));
    if (length <= 32) return bytesToText(hex.slice(130, 130 + length * 2));
  }
  return bytesToText(word(hex, 0));
}

/** A wallet's balance on one network: the native coin, or an ERC-20 when `token` is given. */
export async function readBalance(network: EvmNetwork, address: string, token?: string | null, fetcher?: typeof fetch): Promise<Balance> {
  if (!isAddress(address)) throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid address");
  const call = <T>(method: string, params: unknown[]) => rpcCall<T>(network.rpcUrls, method, params, fetcher);
  if (!token) {
    const value = BigInt(await call<string>("eth_getBalance", [address, "latest"]));
    return { chainId: network.chainId, address, token: null, value, decimals: 18, symbol: network.nativeSymbol, formatted: formatUnits(value, 18) };
  }
  if (!isAddress(token)) throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid token");
  const read = (data: string) => call<string>("eth_call", [{ to: token, data }, "latest"]);
  const [raw, rawDecimals, rawSymbol] = await Promise.all([
    read(`${SELECTOR.balanceOf}${address.slice(2).toLowerCase().padStart(64, "0")}`),
    read(SELECTOR.decimals).catch(() => "0x12"),
    read(SELECTOR.symbol).catch(() => "0x"),
  ]);
  const value = raw && raw !== "0x" ? BigInt(raw.slice(0, 66)) : 0n;
  const decimals = rawDecimals && rawDecimals !== "0x" ? Number(BigInt(rawDecimals.slice(0, 66))) : 18;
  if (decimals > 77) throw new ProviderRpcError(ERROR_CODES.invalidParams, "Token decimals out of range");
  return { chainId: network.chainId, address, token, value, decimals, symbol: decodeSymbol(rawSymbol) ?? "", formatted: formatUnits(value, decimals) };
}

export type Receipt = { hash: Hex; status: "success" | "reverted"; blockNumber: bigint; gasUsed: bigint; from: Hex; to: Hex | null; contractAddress: Hex | null };

/** The receipt once the transaction is in a block, or null while it is pending. */
export async function readReceipt(network: EvmNetwork, hash: string, fetcher?: typeof fetch): Promise<Receipt | null> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid transaction hash");
  const raw = await rpcCall<Record<string, string | null> | null>(network.rpcUrls, "eth_getTransactionReceipt", [hash], fetcher);
  if (!raw || !raw.blockNumber) return null;
  return {
    hash: hash as Hex, status: raw.status === "0x1" ? "success" : "reverted",
    blockNumber: BigInt(raw.blockNumber), gasUsed: BigInt(raw.gasUsed ?? "0x0"),
    from: raw.from as Hex, to: (raw.to ?? null) as Hex | null, contractAddress: (raw.contractAddress ?? null) as Hex | null,
  };
}

/** Polls until the transaction is in a block (every 2 s, up to `timeoutMs`, default 3 minutes). */
export async function waitForReceipt(network: EvmNetwork, hash: string, options: { timeoutMs?: number; intervalMs?: number; fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Receipt> {
  const until = Date.now() + (options.timeoutMs ?? 180_000);
  for (;;) {
    if (options.signal?.aborted) throw new Error("ABORTED");
    const receipt = await readReceipt(network, hash, options.fetch).catch(() => null);
    if (receipt) return receipt;
    if (Date.now() > until) throw new Error("RECEIPT_TIMEOUT");
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 2000));
  }
}

const connected = async (wallet: MaxxingWallet) => wallet.connection ?? await wallet.connect();
const bytesToHex = (bytes: Uint8Array) => `0x${Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")}` as Hex;

/** Switches the wallet to `chainId` (one of the app's networks). */
export async function switchChain(wallet: MaxxingWallet, chainId: number) {
  if (wallet.ethereum.network.chainId === chainId) return;
  await wallet.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toQuantity(chainId) }] });
}

/** Signs text (or bytes) with the user's EVM address. Connects first if needed. Returns the signature. */
export async function signMessage(wallet: MaxxingWallet, message: string | Uint8Array): Promise<Hex> {
  const { evm } = await connected(wallet);
  const payload = typeof message === "string" ? message : bytesToHex(message);
  return await wallet.ethereum.request({ method: "personal_sign", params: [payload, evm] }) as Hex;
}

/** Signs EIP-712 typed data. bigint values are fine. Switches to the domain's network first when it is one of the app's. */
export async function signTypedData(wallet: MaxxingWallet, typedData: { domain?: { chainId?: number | bigint | string }; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex> {
  const { evm } = await connected(wallet);
  const domainChain = typedData.domain?.chainId;
  if (domainChain !== undefined) await switchChain(wallet, Number(domainChain));
  const json = JSON.stringify(typedData, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  return await wallet.ethereum.request({ method: "eth_signTypedData_v4", params: [evm, json] }) as Hex;
}

export type TransactionRequest = { to?: string; value?: bigint | number | string; data?: string; chainId?: number; gas?: bigint };

/** Sends a transaction (the wallet shows it first) and returns its hash. Switches to `chainId` first when given. */
export async function sendTransaction(wallet: MaxxingWallet, tx: TransactionRequest): Promise<Hex> {
  const { evm } = await connected(wallet);
  if (tx.chainId !== undefined) await switchChain(wallet, tx.chainId);
  const value = tx.value === undefined ? undefined : typeof tx.value === "string" && !/^(0x[0-9a-fA-F]+|\d+)$/.test(tx.value) ? (() => { throw new ProviderRpcError(ERROR_CODES.invalidParams, "value is in wei: a bigint, a whole number or hex"); })() : toQuantity(BigInt(tx.value));
  const request = { from: evm, ...(tx.to ? { to: tx.to } : {}), ...(value ? { value } : {}), ...(tx.data ? { data: tx.data } : {}), ...(tx.gas !== undefined ? { gas: toQuantity(tx.gas) } : {}) };
  return await wallet.ethereum.request({ method: "eth_sendTransaction", params: [request] }) as Hex;
}
