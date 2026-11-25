/**
 * What the open account holds, on every network. First from MAXXING's Data API (every token, with logos and USD values); where
 * that can't answer, straight from each chain's public RPC: the native coin, the tokens the wallet core names (cash assets, listed
 * tokens), and on Solana every SPL token account.
 */
import { knownTokens, KNOWN_SOLANA_MINTS } from "@maxxing/wallet-core/chains";
import { chainMark, networks, type Network } from "./chains";
import { rpc } from "./rpc";
import type { Holding } from "../ui/parts";

export const API_URL = "https://api.maxxing.ad";
const APP_ID = "maxxing-extension";
const STABLE = /^(USDC|USDT|USDG|DAI|USDC\.E|USDBC|PYUSD)$/i;

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
  out.push({ network, symbol: network.nativeSymbol, name: network.nativeSymbol === "ETH" ? "Ether" : network.nativeSymbol, decimals: 18, raw: native, address: null });
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
async function apiBalances(address: string, wanted: Network[]): Promise<Raw[] | null> {
  try {
    const response = await fetch(`${API_URL}/v1/public/wallets/${encodeURIComponent(address)}/balances`, { headers: { "x-maxxing-app": APP_ID }, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) return null;
    const body = await response.json() as { items: { chainId: string; address: string; native: boolean; symbol: string; name: string; imageUrl: string | null; balanceRaw: string; decimals: number | null; valueUsd: string | null }[] };
    return body.items.flatMap(item => {
      const network = wanted.find(n => n.networkId === item.chainId);
      if (!network || item.decimals === null) return [];
      return [{ network, symbol: item.symbol, name: item.name, decimals: item.decimals, raw: BigInt(item.balanceRaw), address: item.native ? null : item.address, logo: item.imageUrl, usd: item.valueUsd === null ? null : Number(item.valueUsd) }];
    });
  } catch { return null; }
}

export async function loadPortfolio(account: { evm: string; solana: string }, showTestnets: boolean): Promise<Portfolio> {
  const all = networks(showTestnets);
  const errors: string[] = [];
  let raws: Raw[] = [];
  let source: Portfolio["source"] = "chain";
  const [fromApiEvm, fromApiSol] = await Promise.all([apiBalances(account.evm, all), apiBalances(account.solana, all)]);
  if (fromApiEvm && fromApiSol) {
    raws = [...fromApiEvm, ...fromApiSol];
    source = "api";
    // The Data API covers mainnets; test networks are read from the chain.
    for (const network of all.filter(n => n.testnet)) {
      try { raws.push(...await (network.family === "SOLANA" ? solanaBalances(network, account.solana) : evmBalances(network, account.evm))); } catch { errors.push(network.name); }
    }
  } else {
    const reads = await Promise.allSettled(all.map(network => network.family === "SOLANA" ? solanaBalances(network, account.solana) : evmBalances(network, account.evm)));
    reads.forEach((read, i) => { if (read.status === "fulfilled") raws.push(...read.value); else errors.push(all[i]!.name); });
  }
  const holdings: Holding[] = raws.filter(r => r.raw > 0n || (r.address === null && !r.network.testnet && ["eip155:1", "eip155:8453", "solana:mainnet"].includes(r.network.networkId))).map(r => {
    const amount = Number(r.raw) / 10 ** r.decimals;
    const usd = r.usd ?? (STABLE.test(r.symbol) ? amount : null);
    return {
      symbol: r.symbol, name: r.name, chain: chainMark(r.network), amount: format(r.raw, r.decimals), usd: usd ?? 0, change: 0,
      // Only the extension's own logos: a remote image would tell its host when the wallet is open (the CSP allows none).
      logo: r.symbol === "ETH" ? "/brand/eth-symbol.webp" : r.symbol === "SOL" ? "/brand/sol-symbol.webp" : undefined,
      color: STABLE.test(r.symbol) ? "#3E73C4" : undefined, priced: usd !== null, raw: r.raw.toString(), decimals: r.decimals, address: r.address, networkId: r.network.networkId,
    } as Holding;
  }).sort((a, b) => b.usd - a.usd || Number(b.raw ?? 0) - Number(a.raw ?? 0));
  return { holdings, totalUsd: holdings.reduce((s, h) => s + h.usd, 0), priced: holdings.every(h => h.priced !== false), source, errors };
}
