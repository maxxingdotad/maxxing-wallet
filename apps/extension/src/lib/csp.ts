/**
 * The extension pages' Content-Security-Policy, built from the chain registry: the pages may connect only to the registry's public
 * RPC endpoints (every network the extension can show, test networks included), the MAXXING API, Relay and the phishing blocklist.
 * Images are the extension's own files only; token logos from the Data API aren't loaded (a remote image would tell its host when
 * the wallet is open).
 */
import { SDK_CHAINS, browserRpcUrls } from "@maxxing/wallet-sdk";

/**
 * The services besides chain RPC (balances.ts API_URL, relay.ts RELAY_API, blocklist.ts BLOCKLIST_SOURCE, psl.ts PSL_SOURCE; a test
 * keeps them equal).
 */
export const SERVICES = ["https://api.maxxing.ad", "https://api.relay.link", "https://polkadot.js.org", "https://publicsuffix.org"];

export function connectOrigins(): string[] {
  const origins = new Set<string>(SERVICES);
  for (const chain of SDK_CHAINS) for (const url of browserRpcUrls(chain)) {
    try { const u = new URL(url); if (u.protocol === "https:") origins.add(u.origin); } catch { /* not a URL */ }
  }
  return [...origins].sort();
}

export const extensionCsp = () => [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", `connect-src 'self' ${connectOrigins().join(" ")}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");
