/**
 * Which assets Home shows, and how each is marked. All from the chain registry's data (the wallet core's generated lists), never
 * a list kept here:
 * - default assets: on every enabled network, its native coin and the registry's dollar stables, shown even at 0, so Home is never
 *   empty and the user sees where they can receive;
 * - verified: the native coins and every token the registry names (reviewed cash assets and the MAXXING token list);
 * - spam: an unverified token whose name or symbol advertises something (a link, "claim", "airdrop", "visit"), hidden unless the
 *   user shows it;
 * - everything else the Data API finds is shown as "unverified".
 */
import { knownTokens, KNOWN_SOLANA_MINTS } from "@maxxing/wallet-core/chains";
import type { Network } from "./chains";

export const STABLE = /^(USDC|USDT|USDG|DAI|PYUSD|USDC\.E|USDBC)$/i;
export type AssetKey = string; // `${networkId}|${address or "native"}`
export const assetKey = (networkId: string, address: string | null) => `${networkId}|${address ? (networkId.startsWith("eip155:") ? address.toLowerCase() : address) : "native"}`;

export type AssetRef = { networkId: string; address: string | null; symbol: string; name: string; decimals: number };

/** The registry's tokens on a network (EVM known tokens, or the Solana mints it names). */
function registryTokens(network: Network): AssetRef[] {
  if (network.family === "SOLANA") return Object.entries(KNOWN_SOLANA_MINTS).filter(([, t]) => t.symbol !== "SOL")
    .map(([mint, t]) => ({ networkId: network.networkId, address: mint, symbol: t.symbol, name: t.symbol, decimals: t.decimals }));
  return knownTokens(network.networkId).map(t => ({ networkId: network.networkId, address: t.address, symbol: t.symbol, name: t.symbol, decimals: t.decimals }));
}
export const nativeAsset = (network: Network): AssetRef => ({
  networkId: network.networkId, address: null, symbol: network.nativeSymbol,
  name: network.family === "SOLANA" ? "Solana" : network.nativeSymbol === "ETH" ? "Ether" : network.nativeSymbol, decimals: network.family === "SOLANA" ? 9 : 18,
});

/** Native coin plus the registry's dollar stables, per network (deduplicated: the registry may name a mint twice). */
export function defaultAssets(networks: readonly Network[]): AssetRef[] {
  const out = new Map<AssetKey, AssetRef>();
  for (const n of networks) {
    out.set(assetKey(n.networkId, null), nativeAsset(n));
    // One default per symbol on a network (the registry may name two USDC mints; the first is the main one).
    const symbols = new Set<string>();
    for (const t of registryTokens(n)) if (STABLE.test(t.symbol) && !symbols.has(t.symbol.toUpperCase())) { symbols.add(t.symbol.toUpperCase()); out.set(assetKey(n.networkId, t.address), t); }
  }
  return [...out.values()];
}

/** Every asset the registry names on these networks: these get the verified badge. */
export function verifiedAssets(networks: readonly Network[]): Set<AssetKey> {
  const out = new Set<AssetKey>();
  for (const n of networks) { out.add(assetKey(n.networkId, null)); for (const t of registryTokens(n)) out.add(assetKey(n.networkId, t.address)); }
  return out;
}

const ADVERT = /(https?:|www\.|\.(com|io|xyz|org|net|app|site|top|vip|live|gift|claims?)\b|claim|airdrop|visit|reward|bonus|voucher|free\s|giveaway|\$\s?\d)/i;
export type Trust = "verified" | "unverified" | "spam";
export function trustOf(asset: { networkId: string; address: string | null; symbol: string; name: string }, verified: Set<AssetKey>): Trust {
  if (verified.has(assetKey(asset.networkId, asset.address))) return "verified";
  const text = `${asset.symbol} ${asset.name}`;
  // eslint-disable-next-line no-control-regex
  if (ADVERT.test(text) || asset.symbol.length > 16 || /[^\x20-\x7e]/.test(asset.symbol)) return "spam";
  return "unverified";
}

/** What the user chose: assets hidden, spam shown or not, tokens added by address. */
export type AssetPrefs = { hidden: AssetKey[]; showSpam: boolean; custom: AssetRef[] };
export const NO_PREFS: AssetPrefs = { hidden: [], showSpam: false, custom: [] };

export type ListedAsset<T> = { key: AssetKey; ref: AssetRef; trust: Trust; held: T | null; custom: boolean };

/**
 * Home's list for these networks: what's held, plus default and custom assets at 0, marked; hidden assets out, spam out unless
 * shown. `held` items carry their own data (balance, price), matched by network and address.
 */
export function listAssets<T extends { networkId?: string; address?: string | null; symbol: string; name: string; decimals?: number }>(
  networks: readonly Network[], held: readonly T[], prefs: AssetPrefs,
): ListedAsset<T>[] {
  const ids = new Set(networks.map(n => n.networkId));
  const verified = verifiedAssets(networks);
  const out = new Map<AssetKey, ListedAsset<T>>();
  for (const ref of defaultAssets(networks)) out.set(assetKey(ref.networkId, ref.address), { key: assetKey(ref.networkId, ref.address), ref, trust: "verified", held: null, custom: false });
  for (const ref of prefs.custom) if (ids.has(ref.networkId)) out.set(assetKey(ref.networkId, ref.address), { key: assetKey(ref.networkId, ref.address), ref, trust: trustOf(ref, verified), held: null, custom: true });
  for (const h of held) {
    if (!h.networkId || !ids.has(h.networkId)) continue;
    const key = assetKey(h.networkId, h.address ?? null), before = out.get(key);
    const ref: AssetRef = before?.ref ?? { networkId: h.networkId, address: h.address ?? null, symbol: h.symbol, name: h.name, decimals: h.decimals ?? 18 };
    out.set(key, { key, ref, trust: before?.trust ?? trustOf(ref, verified), held: h, custom: before?.custom ?? false });
  }
  const hidden = new Set(prefs.hidden);
  return [...out.values()].filter(a => !hidden.has(a.key) && (a.trust !== "spam" || prefs.showSpam));
}

/** How many were left out as spam (for the "n hidden as spam · Show" line). */
export const spamCount = <T>(networks: readonly Network[], held: readonly (T & { networkId?: string; address?: string | null; symbol: string; name: string })[]) => {
  const verified = verifiedAssets(networks);
  return held.filter(h => h.networkId && trustOf({ networkId: h.networkId, address: h.address ?? null, symbol: h.symbol, name: h.name }, verified) === "spam").length;
};
