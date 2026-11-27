/**
 * The networks the extension shows, from the MAXXING chain registry's public data (the SDK's generated chain list): names,
 * native symbols and public RPC endpoints. Test networks appear only when the user turns them on. The user's own changes are
 * merged in (user-networks-state.ts): their RPC URLs go first, and EVM networks they added come after the registry's, marked
 * `custom`. A custom network is never verified, never gas-free, and swaps there only where Relay itself lists the chain.
 */
import { SDK_CHAINS, browserRpcUrls, type SdkChain } from "@maxxing/wallet-sdk";
import type { ChainMark } from "../ui/parts";
import { orderedRpcs, userNetworksNow, type CustomNetwork } from "./user-networks-state";

/** `rpc`: the endpoints in the order tried. `defaults`: the registry's own. `custom`: added by the user, or by a site they approved. */
export type Network = SdkChain & { rpc: string[]; defaults: string[]; custom?: CustomNetwork["source"]; addedBy?: string };

const fromRegistry = (chain: SdkChain): Network => { const defaults = browserRpcUrls(chain); return { ...chain, defaults, rpc: orderedRpcs(chain.networkId, defaults) }; };
const fromUser = (c: CustomNetwork): Network => ({
  family: "EVM", networkId: c.networkId, evmChainId: c.evmChainId, name: c.name, nativeSymbol: c.nativeSymbol, testnet: false,
  explorerUrl: c.explorerUrl, rpcUrls: c.rpcUrls, defaults: [], rpc: orderedRpcs(c.networkId, c.rpcUrls), custom: c.source, addedBy: c.origin,
});

/** Logos the extension carries; every other chain gets its initial on its color. */
const LOGOS: Record<string, string> = { "eip155:1": "/brand/eth-symbol.webp", "eip155:8453": "/brand/base-symbol.webp", "solana:mainnet": "/brand/sol-symbol.webp", "solana:devnet": "/brand/sol-symbol.webp", "eip155:84532": "/brand/base-symbol.webp", "eip155:11155111": "/brand/eth-symbol.webp" };
const COLORS: Record<string, string> = {
  "eip155:1": "#8C9BF0", "eip155:8453": "#3B6FF6", "eip155:42161": "#4FB4F7", "eip155:10": "#FF3B3B", "eip155:137": "#8247E5", "eip155:56": "#F0B90B",
  "eip155:43114": "#E84142", "eip155:4663": "#C4C6CC", "solana:mainnet": "#9B6BFF", "solana:devnet": "#9B6BFF",
};

/** The registry's chains, most used first (its `popularRank`), the rest in registry order. */
const ORDERED = SDK_CHAINS.map((chain, i) => ({ chain, i })).sort((a, b) => (a.chain.popularRank ?? Infinity) - (b.chain.popularRank ?? Infinity) || a.i - b.i).map(x => x.chain);

export function networks(showTestnets: boolean): Network[] {
  const registry = ORDERED.filter(chain => showTestnets || !chain.testnet).map(fromRegistry);
  const custom = userNetworksNow().custom.filter(c => !SDK_CHAINS.some(chain => chain.evmChainId === c.evmChainId)).map(fromUser);
  return [...registry, ...custom].filter(chain => chain.rpc.length);
}
/** Every network, test networks and user-added ones included, with its endpoints in order. */
const everyNetwork = () => [...SDK_CHAINS.map(fromRegistry), ...userNetworksNow().custom.filter(c => !SDK_CHAINS.some(chain => chain.evmChainId === c.evmChainId)).map(fromUser)];

export function chainMark(chain: Pick<SdkChain, "networkId" | "name">): ChainMark {
  return { id: chain.networkId, name: chain.name, color: COLORS[chain.networkId] ?? "#8E919A", logo: LOGOS[chain.networkId] };
}

export const networkById = (networkId: string): Network | null => everyNetwork().find(chain => chain.networkId === networkId) ?? null;
export const evmNetwork = (chainId: number): Network | null => everyNetwork().find(chain => chain.evmChainId === chainId) ?? null;
/** Whether the chain registry has this EVM chain (a site may never add its own endpoints for one). */
export const registryHasChain = (chainId: number) => SDK_CHAINS.some(chain => chain.evmChainId === chainId);

/**
 * A name reduced to what a person reads: lower case, letters and digits only, without the words a network name often adds
 * ("Base Mainnet" reads as "Base", "Arbitrum One" as "Arbitrum").
 */
const readAs = (name: string) => name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w && !["mainnet", "network", "chain", "one", "l2", "evm"].includes(w)).join("");
/** The registry network a user-added name would pass for, if any (such names are refused: no "Ethereum" on another chain). */
export function registryNameTaken(name: string): string | null {
  const wanted = readAs(name);
  if (!wanted) return null;
  return SDK_CHAINS.find(chain => readAs(chain.name) === wanted || readAs(chain.networkId.split(":")[1] ?? "") === wanted)?.name ?? null;
}

/** A network's name with who added it, where only text fits (a select's options): "Local Test (added by you)". */
export const networkLabel = (n: Pick<Network, "name" | "custom" | "addedBy">) =>
  !n.custom ? n.name : `${n.name} (added by ${n.custom === "site" && n.addedBy ? (() => { try { return new URL(n.addedBy!).host; } catch { return "a site"; } })() : "you"})`;
/** A token's page on the network's explorer (its contract on EVM, its mint on Solana), or null without an explorer. */
export const explorerToken = (chain: SdkChain, address: string) => chain.explorerUrl ? chain.family === "SOLANA"
  ? `${chain.explorerUrl.replace(/\/?(\?.*)?$/, "")}/address/${address}${chain.explorerUrl.includes("?") ? chain.explorerUrl.slice(chain.explorerUrl.indexOf("?")) : ""}`
  : `${chain.explorerUrl.replace(/\/$/, "")}/token/${address}` : null;
export const explorerTx = (chain: SdkChain, hash: string) => chain.explorerUrl ? chain.family === "SOLANA"
  ? `${chain.explorerUrl.replace(/\/?(\?.*)?$/, "")}/tx/${hash}${chain.explorerUrl.includes("?") ? chain.explorerUrl.slice(chain.explorerUrl.indexOf("?")) : ""}`
  : `${chain.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
