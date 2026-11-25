import { KNOWN_EVM_TOKENS, KNOWN_SOLANA_MINTS, PERMIT2, WALLET_CHAINS, type KnownToken, type WalletChain } from "./chain-data.generated";

/**
 * The networks the wallet names, from the generated chain data. Same rule as the MAXXING chain registry: on the production cluster
 * test networks are switched off, so a production wallet never describes a request as being on one.
 */
export type WalletCluster = "development" | "production";
export type { KnownToken, WalletChain };
export { KNOWN_SOLANA_MINTS, PERMIT2 };

const env = (key: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[key];

/** MAXXING_CLUSTER on a server or in tests; in a browser the build defines __MAXXING_CLUSTER__. NODE_ENV=production means production. */
export function walletCluster(): WalletCluster {
  const built = (globalThis as { __MAXXING_CLUSTER__?: string }).__MAXXING_CLUSTER__;
  const fallback = env("NODE_ENV")?.trim().toLowerCase() === "production" ? "production" : "development";
  return (env("MAXXING_CLUSTER") ?? built ?? fallback).trim().toLowerCase() === "production" ? "production" : "development";
}

/** The networks active on this cluster. */
export const walletChains: WalletChain[] = walletCluster() === "production" ? WALLET_CHAINS.filter(c => !c.testnet) : WALLET_CHAINS;

const byNetwork = new Map(walletChains.map(c => [c.networkId, c]));
const byKey = new Map(walletChains.map(c => [c.key, c]));
const byEvm = new Map(walletChains.filter(c => c.evmChainId).map(c => [String(c.evmChainId), c]));

/** "eip155:8453", "base" or 8453 → "eip155:8453". Unknown ids that look like network ids pass through; anything else throws. */
export function normalizeNetworkId(input: string | number): string {
  const value = String(input).trim().toLowerCase();
  if (byNetwork.has(value)) return value;
  if (byKey.has(value)) return byKey.get(value)!.networkId;
  if (byEvm.has(value)) return byEvm.get(value)!.networkId;
  if (/^eip155:\d+$/.test(value) || value.startsWith("solana:")) return value;
  throw new Error(`UNKNOWN_NETWORK:${input}`);
}

export const getChain = (input: string | number): WalletChain | undefined => byNetwork.get(normalizeNetworkId(input));

export function wrappedNative(input: string | number): string | null {
  return WALLET_CHAINS.find(c => c.networkId === normalizeNetworkId(input))?.wrappedNative ?? null;
}

/** Tokens the wallet names by symbol on a network: reviewed cash assets, then listed reward tokens. */
export function knownTokens(networkId: string): readonly KnownToken[] {
  return KNOWN_EVM_TOKENS[networkId] ?? [];
}
