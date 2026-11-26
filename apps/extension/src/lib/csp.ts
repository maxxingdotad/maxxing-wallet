/**
 * The extension pages' Content-Security-Policy (scripts/build.mjs writes it into the manifest). Scripts, styles and images are the
 * extension's own files only; token logos from the Data API aren't loaded (a remote image would tell its host when the wallet is
 * open). connect-src allows any https host, for RPC endpoints and networks added after install; why, and what still bounds what's
 * sent, is in apps/extension/SECURITY.md.
 */
import { SDK_CHAINS, browserRpcUrls } from "@maxxing/wallet-sdk";

/**
 * The services besides chain RPC (balances.ts API_URL, relay.ts RELAY_API, blocklist.ts BLOCKLIST_SOURCE, psl.ts PSL_SOURCE; a test
 * keeps them equal).
 */
export const SERVICES = ["https://api.maxxing.ad", "https://api.relay.link", "https://polkadot.js.org", "https://publicsuffix.org"];

/** The hosts the extension itself uses by default (services and the registry's RPCs): what a host list would have to name. */
export function connectOrigins(): string[] {
  const origins = new Set<string>(SERVICES);
  for (const chain of SDK_CHAINS) for (const url of browserRpcUrls(chain)) {
    try { const u = new URL(url); if (u.protocol === "https:") origins.add(u.origin); } catch { /* not a URL */ }
  }
  return [...origins].sort();
}

/**
 * Where the pages may connect. The user may add their own RPC endpoint (Settings → Networks), and a site may add a network the user
 * approves (wallet_addEthereumChain), on any https host, so connect-src allows https (and plain http only for this computer, for a
 * local node): a manifest's policy can't list hosts chosen later. What is sent stays bounded by the code: only the files reviewed in
 * tests/no-leak.test.ts call fetch, each with public data only, and no outside script can run (script-src 'self'). No WebSocket.
 * Details: apps/extension/SECURITY.md.
 */
export const LOCAL_HTTP = ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"];
export const extensionCsp = () => [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", `connect-src 'self' https: ${LOCAL_HTTP.join(" ")}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");
