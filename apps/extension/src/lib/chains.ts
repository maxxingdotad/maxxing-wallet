/**
 * The networks the extension shows, from the MAXXING chain registry's public data (the SDK's generated chain list): names,
 * native symbols and public RPC endpoints. Test networks appear only when the user turns them on.
 */
import { SDK_CHAINS, browserRpcUrls, type SdkChain } from "@maxxing/wallet-sdk";
import type { ChainMark } from "../ui/parts";

export type Network = SdkChain & { rpc: string[] };

/** Logos the extension carries; every other chain gets its initial on its color. */
const LOGOS: Record<string, string> = { "eip155:1": "/brand/eth-symbol.webp", "eip155:8453": "/brand/base-symbol.webp", "solana:mainnet": "/brand/sol-symbol.webp", "solana:devnet": "/brand/sol-symbol.webp", "eip155:84532": "/brand/base-symbol.webp", "eip155:11155111": "/brand/eth-symbol.webp" };
const COLORS: Record<string, string> = {
  "eip155:1": "#8C9BF0", "eip155:8453": "#3B6FF6", "eip155:42161": "#4FB4F7", "eip155:10": "#FF3B3B", "eip155:137": "#8247E5", "eip155:56": "#F0B90B",
  "eip155:43114": "#E84142", "eip155:4663": "#C4C6CC", "solana:mainnet": "#9B6BFF", "solana:devnet": "#9B6BFF",
};

/** The registry's chains, most used first (its `popularRank`), the rest in registry order. */
const ORDERED = SDK_CHAINS.map((chain, i) => ({ chain, i })).sort((a, b) => (a.chain.popularRank ?? Infinity) - (b.chain.popularRank ?? Infinity) || a.i - b.i).map(x => x.chain);

export function networks(showTestnets: boolean): Network[] {
  return ORDERED.filter(chain => showTestnets || !chain.testnet).map(chain => ({ ...chain, rpc: browserRpcUrls(chain) })).filter(chain => chain.rpc.length);
}

export function chainMark(chain: Pick<SdkChain, "networkId" | "name">): ChainMark {
  return { id: chain.networkId, name: chain.name, color: COLORS[chain.networkId] ?? "#8E919A", logo: LOGOS[chain.networkId] };
}

export const networkById = (networkId: string) => SDK_CHAINS.find(chain => chain.networkId === networkId) ?? null;
export const evmNetwork = (chainId: number) => SDK_CHAINS.find(chain => chain.evmChainId === chainId) ?? null;
export const explorerTx = (chain: SdkChain, hash: string) => chain.explorerUrl ? chain.family === "SOLANA"
  ? `${chain.explorerUrl.replace(/\/?(\?.*)?$/, "")}/tx/${hash}${chain.explorerUrl.includes("?") ? chain.explorerUrl.slice(chain.explorerUrl.indexOf("?")) : ""}`
  : `${chain.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
