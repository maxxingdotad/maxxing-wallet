/** Sign-in messages (EIP-4361), checked before the wallet shows one as a sign-in. */
import { parseSignInMessage, signInDomainMatches, type SignInMessage } from "@maxxing/wallet-sdk/siwe";

export type { SignInMessage };
export type SignInCheck =
  | { ok: true; message: SignInMessage; warnings: string[] }
  | { ok: false; code: "SIGN_IN_WRONG_SITE" | "SIGN_IN_WRONG_ACCOUNT" | "SIGN_IN_EXPIRED" | "SIGN_IN_NOT_YET_VALID"; message: SignInMessage };

/** Reads a sign-in message and checks it against the site asking and the wallet signing. Null when the text isn't one. */
export function checkSignIn(text: string, origin: string, address: string, now = Date.now()): SignInCheck | null {
  const message = parseSignInMessage(text);
  if (!message) return null;
  if (!signInDomainMatches(message, origin)) return { ok: false, code: "SIGN_IN_WRONG_SITE", message };
  if (message.address.toLowerCase() !== address.toLowerCase()) return { ok: false, code: "SIGN_IN_WRONG_ACCOUNT", message };
  if (message.expirationTime && now > Date.parse(message.expirationTime)) return { ok: false, code: "SIGN_IN_EXPIRED", message };
  if (message.notBefore && now < Date.parse(message.notBefore)) return { ok: false, code: "SIGN_IN_NOT_YET_VALID", message };
  const warnings: string[] = [];
  try { if (new URL(message.uri).host.toLowerCase() !== message.domain.toLowerCase()) warnings.push(`It also names ${new URL(message.uri).host}.`); } catch { warnings.push("Its address line isn't a normal web address."); }
  return { ok: true, message, warnings };
}

/** "in 9 minutes", "in 2 hours" */
export function untilText(iso: string, now = Date.now()) {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 90) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} hours` : `in ${Math.round(hours / 24)} days`;
}
