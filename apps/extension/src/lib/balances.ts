/**
 * What the open account holds, on every network. First from MAXXING's Data API (every token, with logos and USD values); where
 * that can't answer, straight from each chain's public RPC: the native coin, the tokens the wallet core names (cash assets, listed
 * tokens), and on Solana every SPL token account.
 */
import { knownTokens, KNOWN_SOLANA_MINTS } from "@maxxing/wallet-core/chains";
import { chainMark, networks, type Network } from "./chains";
import { rpc } from "./rpc";
import { nativeAsset } from "./assets";
import { prices, type Price } from "./market";
import { kept } from "./store";
import type { Holding } from "../ui/parts";

export const API_URL = "https://api.maxxing.ad";
const APP_ID = "maxxing-extension";
/** How many holdings get a price looked up in one load. */
const MAX_PRICED = 40;
const PRICE_WAIT_MS = 6000;
/** The longest one network's balances, or the Data API's answer, may take before the screen goes on without it. */
export const NETWORK_WAIT_MS = 6000;
const ETHEREUM = "eip155:1";
const STABLE =/^(USDC|USDT|USDG|DAI|USDC\.E|USDBC|PYUSD)$/i;

export type Portfolio = { holdings: Holding[]; totalUsd: number; priced: boolean; source: "api" | "chain"; errors: string[] };
type Raw = { network: Network; symbol: string; name: string; decimals: number; raw: bigint; address: string | null; logo?: string | null; usd?: number | null };

const format = (raw: bigint, decimals: number) => {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, 6);
  return `${Number(whole).toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
};

async function evmBalances(network: Network, owner: string): Promise<Raw[]> {
  const out: Raw[] = [];
  const native = BigInt(await rpc<string>(network.rpc, "eth_getBalance", [owner, "latest"]));
  out.push({ network, symbol: network.nativeSymbol, name: nativeAsset(network).name, decimals: 18, raw: native, address: null });
  const tokens = knownTokens(network.networkId).slice(0, 12);
  const reads = await Promise.allSettled(tokens.map(token => rpc<string>(network.rpc, "eth_call", [{ to: token.address, data: `0x70a08231${owner.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"])));
  reads.forEach((read, i) => {
    if (read.status !== "fulfilled" || !read.value || read.value === "0x") return;
    const raw = BigInt(read.value);
    if (raw > 0n) out.push({ network, symbol: tokens[i]!.symbol, name: tokens[i]!.symbol, decimals: tokens[i]!.decimals, raw, address: tokens[i]!.address });
  });
  return out;
}

const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
type ParsedTokenAccount = { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } };

async function solanaBalances(network: Network, owner: string): Promise<Raw[]> {
  const out: Raw[] = [];
  const lamports = await rpc<{ value: number }>(network.rpc, "getBalance", [owner, { commitment: "confirmed" }]);
  out.push({ network, symbol: "SOL", name: "Solana", decimals: 9, raw: BigInt(lamports.value), address: null });
  const pages = await Promise.allSettled(TOKEN_PROGRAMS.map(programId => rpc<{ value: ParsedTokenAccount[] }>(network.rpc, "getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }])));
  for (const page of pages) {
    if (page.status !== "fulfilled") continue;
    for (const item of page.value.value) {
      const info = item.account.data.parsed.info, raw = BigInt(info.tokenAmount.amount);
      if (raw === 0n) continue;
      const known = KNOWN_SOLANA_MINTS[info.mint];
      out.push({ network, symbol: known?.symbol ?? `${info.mint.slice(0, 4)}…`, name: known?.symbol ?? "SPL token", decimals: info.tokenAmount.decimals, raw, address: info.mint });
    }
  }
  return out;
}

/** The Data API's balances for one address (all its networks at once), or null when the API can't answer. */
/**
 * `complete: false`: the API listed only MAXXING's own tokens (its full portfolio data is off right now), so coins and the
 * tokens the wallet names still have to be read from the chains. Only an explicit `true` counts as the whole picture.
 */
async function apiBalances(address: string, wanted: Network[]): Promise<{ items: Raw[]; complete: boolean } | null> {
  try {
    const response = await fetch(`${API_URL}/v1/public/wallets/${encodeURIComponent(address)}/balances`, { headers: { "x-maxxing-app": APP_ID }, credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(NETWORK_WAIT_MS) });
    if (!response.ok) return null;
    const body = await response.json() as { complete?: boolean; items: { chainId: string; address: string; native: boolean; symbol: string; name: string; imageUrl: string | null; balanceRaw: string; decimals: number | null; valueUsd: string | null }[] };
    return { complete: body.complete === true, items: body.items.flatMap(item => {
      const network = wanted.find(n => n.networkId === item.chainId);
      if (!network || item.decimals === null) return [];
      return [{ network, symbol: item.symbol, name: item.name, decimals: item.decimals, raw: BigInt(item.balanceRaw), address: item.native ? null : item.address, logo: item.imageUrl, usd: item.valueUsd === null ? null : Number(item.valueUsd) }];
    }) };
  } catch { return null; }
}

/** The networks a screen shows: every enabled one ("all"), or just the one picked in the network selector. */
export const shownNetworks = (showTestnets: boolean, selected = "all") => {
  const all = networks(showTestnets);
  return selected === "all" ? all : all.filter(n => n.networkId === selected);
};

// ── The last reading, kept ───────────────────────────────────────────────────────────────────────────────────────────────
// Screens show the last reading at once and read again behind it, instead of starting from nothing each time one opens.
/** A reading younger than this is used as it is; older, it still shows while a new one is read. */
export const FRESH_MS = 20_000;
type Kept = { at: number; portfolio: Portfolio };
const KEPT_KEY = "portfolio-last", KEPT_MAX = 12;
const recent = new Map<string, Kept>(), reading = new Map<string, Promise<Portfolio>>();
const keyOf = (account: { evm: string; solana: string }, showTestnets: boolean, selected: string) => `${account.evm.toLowerCase()}|${account.solana}|${selected}|${showTestnets ? 1 : 0}`;

/** The last reading for this account and network choice (from this session, else from the device), or null. */
export async function lastPortfolio(account: { evm: string; solana: string }, showTestnets: boolean, selected = "all"): Promise<Kept | null> {
  const key = keyOf(account, showTestnets, selected);
  if (!recent.has(key)) { const saved = (await kept.get<Record<string, Kept>>(KEPT_KEY, {}).catch(() => ({} as Record<string, Kept>)))[key]; if (saved) recent.set(key, saved); }
  return recent.get(key) ?? null;
}
/** After something that changes balances (a send, a swap): the next read asks the networks again. */
export function forgetFreshness() { for (const [key, k] of recent) recent.set(key, { ...k, at: 0 }); }

/**
 * The account's holdings for the screens: a reading under FRESH_MS old is returned as it is; two screens asking at once share
 * one read; `force` (the refresh button) always reads. Every new reading is kept for next time.
 */
export async function portfolio(account: { evm: string; solana: string }, showTestnets: boolean, selected = "all", force = false): Promise<Portfolio> {
  const key = keyOf(account, showTestnets, selected);
  const last = await lastPortfolio(account, showTestnets, selected);
  if (!force && last && Date.now() - last.at < FRESH_MS) return last.portfolio;
  const running = reading.get(key);
  if (running) return running;
  const read = loadPortfolio(account, showTestnets, selected).then(async p => {
    // A reading where networks failed doesn't replace a good one's rows: the screen says "may be out of date" either way.
    const entry = { at: Date.now(), portfolio: p };
    recent.set(key, entry);
    await kept.update<Record<string, Kept>>(KEPT_KEY, {}, all => Object.fromEntries(Object.entries({ ...all, [key]: entry }).sort((a, b) => b[1].at - a[1].at).slice(0, KEPT_MAX))).catch(() => {});
    return p;
  }).finally(() => reading.delete(key));
  reading.set(key, read);
  return read;
}

export async function loadPortfolio(account: { evm: string; solana: string }, showTestnets: boolean, selected = "all"): Promise<Portfolio> {
  const all = shownNetworks(showTestnets, selected);
  const errors: string[] = [];
  let raws: Raw[] = [];
  let source: Portfolio["source"] = "chain";
  const [fromApiEvm, fromApiSol] = await Promise.all([apiBalances(account.evm, all), apiBalances(account.solana, all)]);
  const id = (r: Raw) => `${r.network.networkId}|${(r.address ?? "").toLowerCase()}`;
  const fromApi = [...(fromApiEvm?.items ?? []), ...(fromApiSol?.items ?? [])];
  if (fromApiEvm && fromApiSol) source = "api";
  // Read from its own chain: every network the API didn't fully answer for (it can't be reached, or it listed only MAXXING's
  // tokens), and always test networks and networks the user added, which the API doesn't cover.
  const whole = (n: Network) => !n.testnet && !n.custom && (n.family === "SOLANA" ? fromApiSol : fromApiEvm)?.complete === true;
  const onChain = all.filter(n => !whole(n));
  // No network holds the rest up: one that hasn't answered in NETWORK_WAIT_MS counts as not read this time (the screen says
  // some balances may be out of date, with Retry), and what the others said shows now.
  const soon = <T,>(read: Promise<T>) => Promise.race([read, new Promise<never>((_, fail) => setTimeout(() => fail(new Error("NETWORK_SLOW")), NETWORK_WAIT_MS))]);
  const reads = await Promise.allSettled(onChain.map(network => soon(network.family === "SOLANA" ? solanaBalances(network, account.solana) : evmBalances(network, account.evm))));
  const chain: Raw[] = [];
  reads.forEach((read, i) => { if (read.status === "fulfilled") chain.push(...read.value); else errors.push(onChain[i]!.name); });
  // The chain's balance is the fresh one; the API's row adds what the chain can't say (the name, the dollar value) and the
  // MAXXING tokens the wallet doesn't name.
  const seen = new Map(fromApi.map(r => [id(r), r]));
  raws = [...chain.map(r => { const api = seen.get(id(r)); seen.delete(id(r)); return api ? { ...api, raw: r.raw, usd: api.raw === r.raw ? api.usd : undefined } : r; }), ...seen.values()];
  // Dollar values for what the chains reported, from the Data API's prices (one call per 25 assets). Never for a test network
  // or a network the user added: a coin there is worth whatever it says.
  // Only coins and the tokens the wallet names: a wallet can be sent hundreds of worthless tokens, the price service is slow
  // for ones it has never seen, and one it can't answer for fails its whole call. An unnamed token is priced on its own screen.
  const named = (r: Raw) => r.address === null || (r.network.family === "SOLANA" ? !!KNOWN_SOLANA_MINTS[r.address] : knownTokens(r.network.networkId).some(t => t.address.toLowerCase() === r.address!.toLowerCase()));
  // Dollar coins are a dollar each and need no lookup.
  const unpriced = raws.filter(r => r.raw > 0n && r.usd == null && !r.network.testnet && !r.network.custom && named(r) && !STABLE.test(r.symbol)).slice(0, MAX_PRICED);
  // ETH is one coin on every network that uses it: asked once (as Ethereum's), not once per network.
  const asked = (r: Raw) => r.address === null && r.network.family === "EVM" && r.network.nativeSymbol === "ETH" ? { networkId: ETHEREUM, address: null } : { networkId: r.network.networkId, address: r.address };
  const askedKey = (r: Raw) => { const a = asked(r); return `${a.networkId}|${(a.address ?? "").toLowerCase()}`; };
  // Prices get a few seconds: balances show either way, and a slow answer is ready (cached by the API) for the next load.
  const market = unpriced.length ? await Promise.race([prices(unpriced.map(asked)), new Promise<Map<string, Price>>(done => setTimeout(() => done(new Map()), PRICE_WAIT_MS))]) : new Map<string, Price>();
  const change = new Map<string, number>();
  for (const r of unpriced) {
    const p = market.get(askedKey(r));
    if (!p?.priceUsd) continue;
    r.usd = Number(r.raw) / 10 ** r.decimals * p.priceUsd;
    if (p.change24hPct !== null) change.set(id(r), p.change24hPct);
  }
  // What's held. Home adds each network's default assets at 0 itself (lib/assets.ts), so nothing is listed here at 0.
  const holdings: Holding[] = raws.filter(r => r.raw > 0n).map(r => {
    const amount = Number(r.raw) / 10 ** r.decimals;
    // A network the user added gets no dollar value from its coin's name and no real logo: "USDC" there is whatever it says.
    const custom = !!r.network.custom;
    const usd = r.usd ?? (STABLE.test(r.symbol) && !custom ? amount : null);
    return {
      symbol: r.symbol, name: r.name, chain: chainMark(r.network), amount: format(r.raw, r.decimals), usd: usd ?? 0, change: change.get(id(r)) ?? 0,
      // Only the extension's own logos: a remote image would tell its host when the wallet is open (the CSP allows none).
      logo: custom ? undefined : r.symbol === "ETH" ? "/brand/eth-symbol.webp" : r.symbol === "SOL" ? "/brand/sol-symbol.webp" : undefined,
      color: STABLE.test(r.symbol) ? "#3E73C4" : undefined, priced: usd !== null, raw: r.raw.toString(), decimals: r.decimals, address: r.address, networkId: r.network.networkId,
    } as Holding;
  }).sort((a, b) => b.usd - a.usd || Number(b.raw ?? 0) - Number(a.raw ?? 0));
  return { holdings, totalUsd: holdings.reduce((s, h) => s + h.usd, 0), priced: holdings.every(h => h.priced !== false), source, errors };
}
