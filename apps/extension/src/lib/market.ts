/**
 * Prices and charts for the token screen, from MAXXING's public Data API (which serves MAXXING's own tokens from its index and
 * outside tokens through its own provider; the extension never calls another market service). A native coin is priced as its
 * wrapped token from the chain registry. No answer is shown as "no price yet", never as 0.
 */
import { KNOWN_SOLANA_MINTS, wrappedNative } from "@maxxing/wallet-core/chains";
import { API_URL } from "./balances";

/**
 * The Data API's name for the extension (a name, not a secret). Chrome sends the extension's requests without an Origin header
 * (its content scripts' https access counts as host access), so prices, charts and balances (lib/balances.ts) come from the API's
 * public read tier: keyless, read-only, those routes only, limited per visitor address.
 */
const APP_ID = "maxxing-extension";
const get = async <T>(path: string): Promise<T | null> => {
  try {
    const r = await fetch(`${API_URL}${path}`, { headers: { "x-maxxing-app": APP_ID }, credentials: "omit", referrerPolicy: "no-referrer" });
    return r.ok ? (await r.json()) as T : null;
  } catch { return null; }
};

/** The token the market knows for this asset: itself, or for a native coin its wrapped token. */
export function marketToken(networkId: string, address: string | null): string | null {
  // The Data API names EVM tokens in lowercase (`eip155:8453:0xabc…`); Solana mints keep their case.
  const evm = (a: string | null) => a && networkId.startsWith("eip155:") ? a.toLowerCase() : a;
  if (address) return evm(address);
  if (networkId.startsWith("solana:")) return Object.entries(KNOWN_SOLANA_MINTS).find(([, t]) => t.symbol === "SOL")?.[0] ?? null;
  try { return evm(wrappedNative(networkId)); } catch { return null; }
}

export type Price = { priceUsd: number | null; change24hPct: number | null };
export async function price(networkId: string, address: string | null): Promise<Price> {
  const token = marketToken(networkId, address);
  if (!token) return { priceUsd: null, change24hPct: null };
  const body = await get<{ items: { priceUsd: string | number | null; change24hPct: string | number | null }[] }>(`/v1/public/prices?ids=${encodeURIComponent(`${networkId}:${token}`)}`);
  const item = body?.items?.[0];
  const num = (v: unknown) => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  return { priceUsd: num(item?.priceUsd), change24hPct: num(item?.change24hPct) };
}

const PRICES_PER_CALL = 10; // the Data API takes 25; smaller calls answer sooner and lose less when one fails
/**
 * Prices for many assets at once (Home's balances read from the chains carry no dollar value of their own). Keyed by
 * `networkId|address` in lowercase (`networkId|` for the native coin); an asset the market doesn't know is simply absent.
 */
export async function prices(assets: { networkId: string; address: string | null }[]): Promise<Map<string, Price>> {
  const out = new Map<string, Price>();
  const wanted = new Map<string, string[]>(); // the market's id → the assets asking for it (a coin and its wrapped token share one)
  for (const a of assets) {
    const token = marketToken(a.networkId, a.address);
    if (!token) continue;
    const id = `${a.networkId}:${token}`, key = `${a.networkId}|${(a.address ?? "").toLowerCase()}`;
    wanted.set(id, [...(wanted.get(id) ?? []), key]);
  }
  const ids = [...wanted.keys()], calls: string[][] = [];
  for (let i = 0; i < ids.length; i += PRICES_PER_CALL) calls.push(ids.slice(i, i + PRICES_PER_CALL));
  const num = (v: unknown) => v == null || !Number.isFinite(Number(v)) ? null : Number(v);
  const ask = async (chunk: string[]): Promise<void> => {
    const body = await get<{ items: { id: string; priceUsd: string | number | null; change24hPct: string | number | null }[] }>(`/v1/public/prices?ids=${encodeURIComponent(chunk.join(","))}`);
    // One token the service can't answer for fails its whole call: ask again in halves, so the rest still get their price.
    if (!body) { if (chunk.length > 1) { const half = Math.ceil(chunk.length / 2); await Promise.all([ask(chunk.slice(0, half)), ask(chunk.slice(half))]); } return; }
    // Each answer is matched by its id, so a reordered answer can't price the wrong asset.
    for (const item of body.items ?? []) {
      const id = chunk.find(c => c.toLowerCase() === String(item?.id ?? "").toLowerCase());
      const priceUsd = num(item?.priceUsd);
      if (!id || priceUsd === null || priceUsd <= 0) continue;
      for (const key of wanted.get(id) ?? []) out.set(key, { priceUsd, change24hPct: num(item.change24hPct) });
    }
  };
  await Promise.all(calls.map(ask));
  return out;
}

export type Range = "1H" | "1D" | "1W" | "1M" | "All";
/** Each range's candles: how long one is, and how many cover the range. "All" is every daily candle the market has. */
export const RANGES: Record<Range, readonly [interval: string, limit: number]> = { "1H": ["5m", 12], "1D": ["15m", 96], "1W": ["1h", 168], "1M": ["4h", 180], All: ["1d", 1000] };
/**
 * Closing prices over the range, oldest first. A token the market has followed for less time than the range answers with what
 * there is (the screen says how far back that goes, from the points' own times).
 */
export async function chart(networkId: string, address: string | null, range: Range): Promise<{ time: number; close: number }[]> {
  const token = marketToken(networkId, address);
  if (!token) return [];
  const [interval, limit] = RANGES[range];
  const body = await get<{ items: { time: number; close: string }[] }>(`/v1/public/tokens/${encodeURIComponent(networkId)}/${encodeURIComponent(token)}/candles?interval=${interval}&limit=${limit}`);
  return (body?.items ?? []).map(c => ({ time: c.time, close: Number(c.close) })).filter(c => Number.isFinite(c.close) && c.close > 0);
}
