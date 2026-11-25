/**
 * Runs in the site's own page (the MAIN world). It announces the MAXXING Wallet the standard ways, using the MAXXING SDK's own
 * providers so sites get exactly the provider they already know: EIP-1193 + EIP-6963 for EVM, and the Solana Wallet Standard.
 * Every request goes to the extension through the content script; nothing here ever holds a key.
 */
import { ConnectionStore, MaxxingEthereumProvider, MaxxingSolanaWallet, SDK_CHAINS, announceProvider, networksFor, registerWallet } from "@maxxing/wallet-sdk";
import { PAGE_CHANNEL, type PageEvent, type PageRequest, type PageResponse, type SiteMethod } from "./lib/protocol";

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
    store.set(c && /^0x[0-9a-fA-F]{40}$/.test(c.evm) ? { evm: c.evm as `0x${string}`, solana: c.solana } : null);
    return;
  }
  const entry = waiting.get(data.id);
  if (!entry) return;
  waiting.delete(data.id);
  if (data.ok) entry.resolve(data.result);
  else entry.reject(Object.assign(new Error(data.error.message), { code: data.error.code ?? 4001 }));
});

const transport = new ExtensionTransport() as never;
const evmChains = SDK_CHAINS.filter(chain => chain.family === "EVM" && chain.evmChainId != null).map(chain => chain.evmChainId!);
const networks = networksFor({ chains: evmChains });
const ethereum = new MaxxingEthereumProvider(transport, store as never, networks, networks.find(n => !n.testnet)?.chainId ?? networks[0]!.chainId);
const solana = new MaxxingSolanaWallet(transport, store as never, SDK_CHAINS.filter(chain => chain.family === "SOLANA").map(chain => chain.networkId));

announceProvider(ethereum);
registerWallet(solana);
// Sites that only look at window.ethereum still find a wallet, but never at another wallet's expense.
try { if (!("ethereum" in window)) Object.defineProperty(window, "ethereum", { value: ethereum, configurable: true }); } catch { /* another wallet owns it */ }
try { Object.defineProperty(window, "maxxingWallet", { value: Object.freeze({ ethereum, solana }), configurable: false }); } catch { /* already set */ }
