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

export type Range = "24h" | "7d";
/** Closing prices over the range: 24 hourly points, or 42 four-hourly points. */
export async function chart(networkId: string, address: string | null, range: Range): Promise<{ time: number; close: number }[]> {
  const token = marketToken(networkId, address);
  if (!token) return [];
  const [interval, limit] = range === "24h" ? ["1h", 24] : ["4h", 42];
  const body = await get<{ items: { time: number; close: string }[] }>(`/v1/public/tokens/${encodeURIComponent(networkId)}/${encodeURIComponent(token)}/candles?interval=${interval}&limit=${limit}`);
  return (body?.items ?? []).map(c => ({ time: c.time, close: Number(c.close) })).filter(c => Number.isFinite(c.close) && c.close > 0);
}
