/**
 * Runs in the site's own page (the MAIN world). It announces the MAXXING Wallet the standard ways, using the MAXXING SDK's own
 * providers so sites get exactly the provider they already know: EIP-1193 + EIP-6963 for EVM, and the Solana Wallet Standard.
 * Every request goes to the extension through the content script; nothing here ever holds a key.
 */
import { ConnectionStore, MaxxingEthereumProvider, MaxxingSolanaWallet, SDK_CHAINS, announceProvider, networksFor, registerWallet } from "@maxxing/wallet-sdk";
import { PAGE_CHANNEL, type PageEvent, type PageRequest, type PageResponse, type SiteMethod, type SiteNetwork } from "./lib/protocol";

type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const waiting = new Map<string, Waiting>();
let sequence = 0;

/** What the SDK's providers call `WalletWindow`: one request, one answer. Here the answer comes from the extension. */
class ExtensionTransport {
  request<T>(method: SiteMethod, params?: unknown): Promise<T> {
    const id = `${Date.now().toString(36)}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<T>((resolve, reject) => {
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      window.postMessage({ channel: PAGE_CHANNEL, dir: "to-wallet", id, method, params } satisfies PageRequest, window.location.origin);
    });
  }
  destroy() {}
}

/** The connection is the extension's to decide; this copy only lets the providers answer `eth_accounts` without a round trip. */
const store = new ConnectionStore("extension", null);

window.addEventListener("message", event => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as PageResponse | PageEvent | undefined;
  if (!data || data.channel !== PAGE_CHANNEL || data.dir !== "to-page") return;
  if ("event" in data) {
    const c = data.connection;
    const next = c && /^0x[0-9a-fA-F]{40}$/.test(c.evm) ? { evm: c.evm as `0x${string}`, solana: c.solana } : null;
    const now = store.connection;
    if (!next !== !now || (next && now && (next.evm.toLowerCase() !== now.evm.toLowerCase() || next.solana !== now.solana))) store.set(next);
    // Networks this site added before (approved by the user), so the provider knows them again after a reload.
    for (const n of c?.networks ?? []) learn(n);
    // The network the wallet keeps for this site (chosen in the wallet, or approved there): the provider moves to it.
    if (next && typeof c?.chainId === "number" && c.chainId !== ethereum.network.chainId) void switchHere(c.chainId).catch(() => {});
    return;
  }
  const entry = waiting.get(data.id);
  if (!entry) return;
  waiting.delete(data.id);
  if (data.ok) entry.resolve(data.result);
  else entry.reject(Object.assign(new Error(data.error.message), { code: data.error.code ?? 4001 }));
});

const pageTransport = new ExtensionTransport();
const transport = pageTransport as never;
const evmChains = SDK_CHAINS.filter(chain => chain.family === "EVM" && chain.evmChainId != null).map(chain => chain.evmChainId!);
const networks = networksFor({ chains: evmChains });
const ethereum = new MaxxingEthereumProvider(transport, store as never, networks, networks.find(n => !n.testnet)?.chainId ?? networks[0]!.chainId);
// Switching networks: the page's provider switches only after the wallet agrees. A connected site's network is kept per site in
// the wallet, and changing it asks the user; a site that isn't connected switches on its own (nothing is at stake).
const local = ethereum.request.bind(ethereum);
const switchHere = (chainId: number) => local({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${chainId.toString(16)}` }] });
/** A network the provider didn't know (one a site added, approved in the wallet), with the site's own public endpoints. */
function learn(n: SiteNetwork) {
  if (!Number.isSafeInteger(n?.chainId) || networks.some(x => x.chainId === n.chainId)) return;
  const rpcUrls = (n.rpcUrls ?? []).filter(u => typeof u === "string" && u.startsWith("https://"));
  if (rpcUrls.length) networks.push({ chainId: n.chainId, name: String(n.name), nativeSymbol: String(n.nativeSymbol), rpcUrls, ...(n.explorerUrl ? { explorerUrl: n.explorerUrl } : {}) });
}
ethereum.request = async args => {
  if (args?.method !== "wallet_switchEthereumChain" && args?.method !== "wallet_addEthereumChain") return local(args);
  const first = (Array.isArray(args.params) ? args.params[0] : args.params) as { chainId?: unknown; chainName?: unknown; nativeCurrency?: { symbol?: unknown }; rpcUrls?: unknown; blockExplorerUrls?: unknown } | undefined;
  let chainId: number;
  try { chainId = Number(BigInt(String(first?.chainId))); } catch { return local(args); } // the provider answers the bad input
  if (args.method === "wallet_addEthereumChain") {
    // Adding (EIP-3085): the wallet decides (a known network is just a switch; a new one asks the user), then the page learns it.
    await pageTransport.request("evm.addChain", first);
    const urls = Array.isArray(first?.rpcUrls) ? first.rpcUrls.filter((u): u is string => typeof u === "string") : [];
    learn({ chainId, name: String(first?.chainName ?? ""), nativeSymbol: String(first?.nativeCurrency?.symbol ?? ""), rpcUrls: urls, explorerUrl: Array.isArray(first?.blockExplorerUrls) ? first.blockExplorerUrls.find((u): u is string => typeof u === "string") : undefined });
    return chainId === ethereum.network.chainId ? null : switchHere(chainId);
  }
  if (!networks.some(n => n.chainId === chainId)) return local(args); // an unknown network (4902): the site may add it first
  if (chainId === ethereum.network.chainId) return null;
  await pageTransport.request("evm.switchChain", { chainId });
  return switchHere(chainId);
};
const solana = new MaxxingSolanaWallet(transport, store as never, SDK_CHAINS.filter(chain => chain.family === "SOLANA").map(chain => chain.networkId));

announceProvider(ethereum);
registerWallet(solana);
// Sites that only look at window.ethereum still find a wallet, but never at another wallet's expense.
try { if (!("ethereum" in window)) Object.defineProperty(window, "ethereum", { value: ethereum, configurable: true }); } catch { /* another wallet owns it */ }
try { Object.defineProperty(window, "maxxingWallet", { value: Object.freeze({ ethereum, solana }), configurable: false }); } catch { /* already set */ }
