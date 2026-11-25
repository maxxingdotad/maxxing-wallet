import { SDK_CHAINS } from "./chains.generated";
import type { EvmNetwork } from "./ethereum";

/**
 * The networks the SDK offers, from the MAXXING chain registry (generated into chains.generated.ts, so the SDK builds on its own).
 * A partner site always talks to the live wallet: networks default to mainnets, and a test network is offered only when the app
 * names it in `chains` or `solanaChains`.
 */
type RpcSource = { publicRpcUrls?: string[]; rpc?: { http: string[] }; rpcUrls?: string[] };

const evmChains = SDK_CHAINS.filter(chain => chain.family === "EVM" && chain.evmChainId != null);
const mainnetEvmChains = evmChains.filter(chain => !chain.testnet);
/** Wallet Standard ids of the Solana mainnets MAXXING supports. */
export const mainnetSolanaChains: string[] = SDK_CHAINS.filter(chain => chain.family === "SOLANA" && !chain.testnet).map(chain => chain.networkId);

/** A chain's public RPC endpoints, safe for a browser: keyed providers are left out. */
export function browserRpcUrls(chain: RpcSource): string[] {
  return [...new Set([...(chain.publicRpcUrls ?? []), ...(chain.rpc?.http ?? []), ...(chain.rpcUrls ?? [])].filter(url => !/alchemy|helius|api-key|apikey/i.test(url)))];
}

/** Every origin the SDK may call for chain reads on the mainnets (a site's Content-Security-Policy `connect-src`). */
export function browserRpcOrigins(): string[] {
  const origins = new Set<string>();
  for (const chain of mainnetEvmChains) for (const url of browserRpcUrls(chain)) { try { origins.add(new URL(url).origin); } catch { /* not a URL */ } }
  return [...origins].sort();
}

/** The EVM networks for these options: your `chains` (default every mainnet), your `rpcUrls` first, then the public ones. */
export function networksFor(options: { chains?: number[]; rpcUrls?: Record<number, string[]> }): EvmNetwork[] {
  const wanted = options.chains?.length ? options.chains : mainnetEvmChains.map(chain => chain.evmChainId!);
  return wanted.map(chainId => {
    const chain = evmChains.find(c => c.evmChainId === chainId);
    if (!chain) throw new Error(`MAXXING_WALLET_UNSUPPORTED_CHAIN:${chainId}`);
    return { chainId, name: chain.name, nativeSymbol: chain.nativeSymbol, testnet: chain.testnet, explorerUrl: chain.explorerUrl, rpcUrls: [...new Set([...(options.rpcUrls?.[chainId] ?? []), ...browserRpcUrls(chain)])] };
  });
}
