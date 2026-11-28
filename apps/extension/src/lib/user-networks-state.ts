/**
 * What the user changed about networks, in memory for the synchronous network list (chains.ts): RPC URLs they added to a registry
 * network, the one they prefer, and EVM networks they added themselves. Loaded from storage at start (user-networks.ts); this
 * module imports nothing, so the network list can read it without an import cycle.
 */
export type CustomNetwork = {
  networkId: string; evmChainId: number; name: string; nativeSymbol: string; rpcUrls: string[]; explorerUrl?: string;
  /** "user": added in Settings. "site": a site asked (wallet_addEthereumChain) and the user approved; `origin` is that site. */
  source: "user" | "site"; origin?: string; addedAt: number;
};
export type UserNetworks = {
  /** Extra RPC URLs per registry network (networkId → URLs), tried before the registry's own. */
  rpcs: Record<string, string[]>;
  /** The RPC tried first on a network, when the user picked one. */
  preferred: Record<string, string>;
  custom: CustomNetwork[];
  /** Networks the user turned off (networkIds): not listed, not read. Their sites and past activity still resolve. */
  off: string[];
};
export const EMPTY: UserNetworks = { rpcs: {}, preferred: {}, custom: [], off: [] };

let state: UserNetworks = EMPTY;
export const userNetworksNow = () => state;
export const setUserNetworksNow = (next: UserNetworks) => { state = next; };

/** A network's endpoints in the order to try them: the preferred one, then the user's own, then the defaults. */
export function orderedRpcs(networkId: string, defaults: readonly string[], s: UserNetworks = state): string[] {
  const preferred = s.preferred[networkId];
  const all = [...(s.rpcs[networkId] ?? []), ...defaults];
  return [...new Set(preferred && all.includes(preferred) ? [preferred, ...all] : all)];
}
