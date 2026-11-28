/**
 * The user's own RPC endpoints and networks, as the leading wallets offer them:
 * - for any network, extra RPC URLs (tried before the registry's own) and a preferred one, with "reset to default";
 * - EVM networks the user adds (or approves when a site asks with wallet_addEthereumChain), always marked as added by them.
 * Every URL is checked before it is kept: https only (plain http only for this computer: localhost, 127.0.0.1), and the
 * endpoint's own eth_chainId must be the network's. A URL can hold a provider's key, so it is never shown whole outside the network
 * screen, never written to Activity (only its host is), and never handed to websites.
 */
import { activity, kept } from "./store";
import { registryNameTaken } from "./chains";
import { setEndpointGuard } from "./rpc";
import { EMPTY, setUserNetworksNow, userNetworksNow, type CustomNetwork, type UserNetworks } from "./user-networks-state";

const KEY = "user-networks";
export async function loadUserNetworks(): Promise<UserNetworks> {
  const saved = await kept.get<UserNetworks>(KEY, EMPTY).catch(() => EMPTY);
  const next = { ...EMPTY, ...saved, rpcs: { ...saved?.rpcs }, preferred: { ...saved?.preferred }, custom: [...(saved?.custom ?? [])] };
  setUserNetworksNow(next);
  return next;
}
async function change(update: (s: UserNetworks) => UserNetworks) {
  let next: UserNetworks = EMPTY;
  await kept.update<UserNetworks>(KEY, EMPTY, s => { next = update({ ...EMPTY, ...s }); return next; });
  setUserNetworksNow(next);
  return next;
}

// ── Checking the user's endpoints again, once per session ─────────────────────────────────────────────────────────────
/** The chain a URL must serve when it is one of the user's own endpoints; null for the registry's own (not checked here). */
function expectedChain(url: string, s: UserNetworks = userNetworksNow()): { chainId: number; networkId: string; custom: boolean } | null {
  for (const [networkId, urls] of Object.entries(s.rpcs)) if (urls.includes(url) && networkId.startsWith("eip155:")) return { chainId: Number(networkId.slice(7)), networkId, custom: false };
  const c = s.custom.find(n => n.rpcUrls.includes(url));
  return c ? { chainId: c.evmChainId, networkId: c.networkId, custom: true } : null;
}
const sessionChecks = new Map<string, Promise<boolean>>();
/**
 * Before a user's endpoint is first used in this session it is asked for its chain id again (an endpoint can be repointed after it
 * was added). A mismatch: the user's own RPC for a listed network is dropped (the defaults take over) and Activity says so; a
 * user-added network's endpoint isn't used. An endpoint that doesn't answer is left to the usual failover and asked again next time.
 */
export function checkEndpointOnce(url: string): Promise<boolean> {
  const expected = expectedChain(url);
  if (!expected) return Promise.resolve(true);
  const key = `${url}|${expected.chainId}`;
  if (!sessionChecks.has(key)) {
    const check = endpointChainId(url).then(async id => {
      if (id === expected.chainId) return true;
      if (!expected.custom) await removeRpc(expected.networkId, url);
      await activity.add({ kind: "connect", text: `An endpoint you added (${rpcHost(url)}) now serves chain ${id}, not ${expected.chainId}${expected.custom ? "; it isn't used" : "; it was removed"}`, networkId: expected.networkId });
      return false;
    }, () => { sessionChecks.delete(key); return true; }); // not answering: the usual failover decides, and it's asked again next time
    sessionChecks.set(key, check);
  }
  return sessionChecks.get(key)!;
}
setEndpointGuard(checkEndpointOnce);
export const forgetEndpointChecks = () => sessionChecks.clear();

// ── Checking a URL ────────────────────────────────────────────────────────────────────────────────────────────────────────
const LOCAL = new Set(["localhost", "127.0.0.1"]); // matches csp.ts LOCAL_HTTP (Chrome's CSP can't name [::1])
/** Why this URL can't be an RPC endpoint, or null when it can. */
export function rpcUrlProblem(text: string): string | null {
  let url: URL;
  try { url = new URL(text.trim()); } catch { return "That isn't a web address."; }
  if (url.protocol === "http:" && !LOCAL.has(url.hostname)) return "Use an https address (plain http only for this computer).";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an https address.";
  if (url.username || url.password) return "Remove the user name and password from the address; use the provider's key in the path instead.";
  if (text.trim().length > 300) return "That address is too long.";
  return null;
}
/** The address as shown in lists and Activity: its host only, so a key in the path or query is never shown or stored there. */
export const rpcHost = (text: string) => { try { return new URL(text).host; } catch { return "(invalid address)"; } };

/** Asks the endpoint itself which chain it serves (no fallback: this is the endpoint being judged). */
export async function endpointChainId(url: string, timeoutMs = 8000): Promise<number> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url.trim(), { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    const body = await response.json().catch(() => null) as { result?: string } | null;
    const id = Number(BigInt(String(body?.result ?? "")));
    if (!response.ok || !Number.isSafeInteger(id) || id <= 0) throw new Error();
    return id;
  } catch { throw new Error("That endpoint didn't answer as an EVM network."); }
  finally { clearTimeout(timer); }
}

/** Checks an RPC URL for an EVM network: a fine address, and the endpoint answers with that network's chain id. */
export async function checkRpc(url: string, chainId: number): Promise<void> {
  const problem = rpcUrlProblem(url);
  if (problem) throw new Error(problem);
  const answered = await endpointChainId(url);
  if (answered !== chainId) throw new Error(`That endpoint serves chain ${answered}, not ${chainId}. It wasn't added.`);
}

// ── A site's wallet_addEthereumChain ─────────────────────────────────────────────────────────────────────────────────────
export type AddChainRequest = { chainId: number; name: string; symbol: string; rpcUrls: string[]; explorerUrl?: string };
/**
 * A site's request to add a network (EIP-3085), read strictly: a chain id, a name, an 18-decimal coin, and at least one RPC URL
 * the wallet would accept (https). Anything else is null and the request is refused.
 */
export function parseAddChain(params: unknown): AddChainRequest | null {
  const p = (Array.isArray(params) ? params[0] : params) as { chainId?: unknown; chainName?: unknown; nativeCurrency?: { symbol?: unknown; decimals?: unknown }; rpcUrls?: unknown; blockExplorerUrls?: unknown } | null;
  if (!p || typeof p !== "object") return null;
  let chainId: number;
  try { chainId = Number(BigInt(String(p.chainId))); } catch { return null; }
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  const name = typeof p.chainName === "string" ? p.chainName.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 40) : "";
  const symbol = typeof p.nativeCurrency?.symbol === "string" ? p.nativeCurrency.symbol.trim().toUpperCase().slice(0, 12) : "";
  if (!name || !/^[A-Z0-9.$_-]{1,12}$/.test(symbol) || Number(p.nativeCurrency?.decimals) !== 18) return null;
  const rpcUrls = (Array.isArray(p.rpcUrls) ? p.rpcUrls : []).filter((u): u is string => typeof u === "string" && !rpcUrlProblem(u) && u.startsWith("https://")).slice(0, 3);
  if (!rpcUrls.length) return null;
  const explorer = Array.isArray(p.blockExplorerUrls) ? p.blockExplorerUrls.find((u): u is string => typeof u === "string" && u.startsWith("https://")) : undefined;
  return { chainId, name, symbol, rpcUrls, ...(explorer ? { explorerUrl: explorer } : {}) };
}

// ── Health ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Health = { url: string; ok: boolean; ms: number | null; head: number | null };
/** How each endpoint answers now: the latest block (or Solana slot) and how long it took; down after 6 s. */
export function checkHealth(urls: readonly string[], family: "EVM" | "SOLANA"): Promise<Health[]> {
  const method = family === "SOLANA" ? "getSlot" : "eth_blockNumber";
  return Promise.all(urls.map(async url => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 6000), t0 = performance.now();
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) });
      const body = await response.json().catch(() => null) as { result?: string | number } | null;
      const head = body?.result == null ? null : Number(typeof body.result === "string" ? BigInt(body.result) : body.result);
      return { url, ok: response.ok && head !== null && Number.isFinite(head), ms: Math.round(performance.now() - t0), head };
    } catch { return { url, ok: false, ms: null, head: null }; }
    finally { clearTimeout(timer); }
  }));
}

// ── Changes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Adds a checked RPC URL to an EVM network (a registry one or a custom one). Solana endpoints are checked by their genesis. */
export async function addRpc(network: { networkId: string; family: "EVM" | "SOLANA"; evmChainId?: number }, url: string) {
  const clean = url.trim();
  if (network.family !== "EVM" || !network.evmChainId) throw new Error("Custom endpoints are for EVM networks.");
  await checkRpc(clean, network.evmChainId);
  return change(s => ({ ...s, rpcs: { ...s.rpcs, [network.networkId]: [...new Set([clean, ...(s.rpcs[network.networkId] ?? [])])] } }));
}
export const removeRpc = (networkId: string, url: string) => change(s => {
  const rpcs = { ...s.rpcs, [networkId]: (s.rpcs[networkId] ?? []).filter(u => u !== url) };
  const preferred = { ...s.preferred };
  if (preferred[networkId] === url) delete preferred[networkId];
  return { ...s, rpcs, preferred };
});
export const preferRpc = (networkId: string, url: string) => change(s => ({ ...s, preferred: { ...s.preferred, [networkId]: url } }));
/** Back to the registry's endpoints only: the user's own URLs and their choice are dropped for this network. */
export const resetRpcs = (networkId: string) => change(s => {
  const rpcs = { ...s.rpcs }, preferred = { ...s.preferred };
  delete rpcs[networkId]; delete preferred[networkId];
  return { ...s, rpcs, preferred };
});

/** A network the user adds: an EVM chain the registry doesn't have, its endpoint checked against the chain id given. */
export async function addCustomNetwork(input: { name: string; rpcUrl: string; chainId: number; symbol: string; explorerUrl?: string; source?: CustomNetwork["source"]; origin?: string; registryHas: (chainId: number) => boolean }) {
  const name = input.name.trim().slice(0, 40), symbol = input.symbol.trim().toUpperCase().slice(0, 12), explorer = input.explorerUrl?.trim();
  if (!name) throw new Error("Give the network a name.");
  // Plain letters only (no look-alike characters), and never the name of a network MAXXING lists: a network on another chain
  // can't pass for Ethereum or Base. Its coin may share a symbol (many networks use ETH): it is always shown with its network's name.
  if (!/^[\x20-\x7e]+$/.test(name)) throw new Error("Use plain letters, digits and spaces in the network's name.");
  const taken = registryNameTaken(name);
  if (taken) throw new Error(`"${name}" reads as ${taken}, a network MAXXING already lists on its own chain. Give it a name of its own.`);
  if (!/^[A-Z0-9.$_-]{1,12}$/.test(symbol)) throw new Error("Give its coin's symbol (letters and digits, up to 12).");
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("Enter the network's chain ID (a whole number).");
  if (input.registryHas(input.chainId)) throw new Error("MAXXING Wallet already has this network. Add your endpoint to it in its settings instead.");
  if (userNetworksNow().custom.some(c => c.evmChainId === input.chainId)) throw new Error("You've already added a network with this chain ID.");
  if (explorer) { try { if (new URL(explorer).protocol !== "https:") throw new Error(); } catch { throw new Error("The explorer address must start with https://."); } }
  await checkRpc(input.rpcUrl, input.chainId);
  const network: CustomNetwork = {
    networkId: `eip155:${input.chainId}`, evmChainId: input.chainId, name, nativeSymbol: symbol, rpcUrls: [input.rpcUrl.trim()],
    ...(explorer ? { explorerUrl: explorer } : {}), source: input.source ?? "user", ...(input.origin ? { origin: input.origin } : {}), addedAt: Date.now(),
  };
  await change(s => ({ ...s, custom: [...s.custom.filter(c => c.evmChainId !== input.chainId), network] }));
  return network;
}
export const removeCustomNetwork = (networkId: string) => change(s => {
  const rpcs = { ...s.rpcs }, preferred = { ...s.preferred };
  delete rpcs[networkId]; delete preferred[networkId];
  return { ...s, rpcs, preferred, custom: s.custom.filter(c => c.networkId !== networkId), off: (s.off ?? []).filter(id => id !== networkId) };
});

/**
 * Turns a network off or back on. Off: it isn't listed anywhere and its balances aren't read (fewer calls to public endpoints);
 * nothing held there is touched, and turning it on shows it again. `stillOn` is how many listed networks would remain: the last
 * one can't be turned off.
 */
export async function setNetworkOff(networkId: string, off: boolean, stillOn: number) {
  if (off && stillOn < 1) throw new Error("Keep at least one network on.");
  await change(s => ({ ...s, off: off ? [...new Set([...(s.off ?? []), networkId])] : (s.off ?? []).filter(id => id !== networkId) }));
}
