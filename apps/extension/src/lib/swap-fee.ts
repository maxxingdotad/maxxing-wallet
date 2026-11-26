/**
 * MAXXING's fee on swaps made in the extension. Admin sets it (Settings → Money: on/off, a percent, the EVM address that claims it)
 * and the extension reads it from the API's public config. It is asked of Relay as an app fee on the quote, so it rides inside the
 * trade: Relay keeps it and the recipient claims it; MAXXING never holds anyone's funds.
 * - Whatever the config says, the fee is capped here at 2%, so a bad value can't overcharge.
 * - No recipient, the switch off, a 0 percent or no answer from the API: no fee.
 * - Every quote's app fee is checked against the fee shown: a quote that charges more (or charges one when none was shown) is refused.
 */
import { getAddress, isAddress } from "viem";
import { API_URL } from "./balances";

export const MAX_FEE_BPS = 200; // 2%
export type SwapFee = { bps: number; recipient: string } | null;

/** The fee from the public config's values, capped; null means no fee. */
export function feeFromConfig(values: Record<string, unknown> | null | undefined): SwapFee {
  if (!values || values["extension.swapFee.enabled"] === false) return null;
  const percent = Number(values["extension.swapFee.percent"]);
  const recipient = String(values["extension.swapFee.recipient"] ?? "");
  // Admin already refuses these; checked again here so a bad config charges nothing rather than paying a mistyped or burn address.
  if (!Number.isFinite(percent) || percent <= 0 || !/^0x[0-9a-fA-F]{40}$/.test(recipient) || /^0x0{40}$/.test(recipient) || !isAddress(recipient, { strict: true })) return null;
  return { bps: Math.min(MAX_FEE_BPS, Math.round(percent * 100)), recipient: getAddress(recipient) };
}

let cached: { at: number; fee: Promise<SwapFee> } | null = null;
const CACHE_MS = 5 * 60_000;
/** The fee now (read at most every 5 minutes). */
export function swapFee(now = Date.now()): Promise<SwapFee> {
  if (cached && now - cached.at < CACHE_MS) return cached.fee;
  const fee = fetch(`${API_URL}/v1/config`, { credentials: "omit", referrerPolicy: "no-referrer" })
    .then(r => r.ok ? r.json() as Promise<{ values?: Record<string, unknown> }> : null)
    .then(body => feeFromConfig(body?.values))
    .catch(() => null);
  cached = { at: now, fee };
  return fee;
}
export const forgetSwapFee = () => { cached = null; };

/** The fee in percent, for the review ("0.85%"). */
export const feePercent = (bps: number) => `${(bps / 100).toFixed(bps % 10 ? 2 : bps % 100 ? 1 : 0)}%`;

const num = (v: unknown) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
/**
 * Checks the app fee a Relay quote will charge against the fee shown, in dollars (Relay prices the input and the fee), or in the
 * input token itself when the fee is in it. Returns the fee in dollars (null when unpriced). Throws, so nothing is signed, when the
 * quote charges more than shown (2% and a cent of rounding allowed), charges one when none was shown, or can't be checked.
 */
export function checkAppFee(raw: any, fee: SwapFee, input: { amountRaw: bigint; currency: string }): number | null {
  const app = raw?.fees?.app;
  const appAmount = (() => { try { return BigInt(String(app?.amount ?? "0")); } catch { return 0n; } })();
  const appUsd = num(app?.amountUsd);
  if (!fee) {
    if (appAmount > 0n || (appUsd ?? 0) > 0) throw new Error("This quote charges a fee you weren't shown. Nothing was signed.");
    return null;
  }
  const inUsd = num(raw?.details?.currencyIn?.amountUsd);
  if (appUsd !== null && inUsd !== null) {
    if (appUsd > inUsd * fee.bps / 10_000 * 1.02 + 0.01) throw new Error("This quote charges more than the MAXXING fee shown. Nothing was signed.");
    return appUsd;
  }
  const sameToken = String(app?.currency?.address ?? "").toLowerCase() === input.currency.toLowerCase();
  if (sameToken) {
    if (appAmount * 10_000n > input.amountRaw * BigInt(fee.bps) * 102n / 100n + 10_000n) throw new Error("This quote charges more than the MAXXING fee shown. Nothing was signed.");
    return appUsd;
  }
  if (appAmount === 0n && appUsd === null) return null; // Relay charges nothing (a fee too small to collect)
  throw new Error("The fee in this quote couldn't be checked, so nothing was signed. Try again in a moment.");
}
