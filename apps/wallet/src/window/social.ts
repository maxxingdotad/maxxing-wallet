/**
 * Social sign-in for partner apps, inside the wallet window: "Continue with Google / X / TikTok …" with the app's own OAuth
 * clients or MAXXING's, then one MAXXING wallet. The app receives a signed identity token it can check on its server.
 */
import { API_URL } from "../registry";
import { LOGIN_CHANNEL } from "./login-channel";
import * as signing from "@maxxing/wallet-core/signing";

export type LoginMethod = { provider: string; label: string };
export type SocialIdentity = { provider: string; label: string; subject: string; username: string | null; displayName: string | null; avatarUrl: string | null; profileUrl: string | null };
export type Redeemed = { identity: SocialIdentity; linkedWallet: { evm: string; solana: string } | null; grant: string };
export type AppUser = { id: string; wallet: { evm: string; solana: string }; accounts: { provider: string; subject: string; username: string | null; name: string | null; avatar: string | null; profile: string | null }[] };
export type AppSession = { identityToken: string; user: AppUser; expiresAt: string };

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (size = 32) => b64url(crypto.getRandomValues(new Uint8Array(size)));
const sha256 = async (text: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `HTTP_${response.status}`);
  return json;
}

/** The sign-in buttons this app turned on and how its sign-in looks (cleaned by the caller); none when they can't be read. */
export async function loginMethods(appId: string): Promise<{ methods: LoginMethod[]; appearance: unknown }> {
  try {
    const response = await fetch(`${API_URL}/v1/wallet-apps/${encodeURIComponent(appId)}/login-methods`, { credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) return { methods: [], appearance: null };
    const body = await response.json() as { methods?: LoginMethod[]; appearance?: unknown };
    const methods = (body.methods ?? []).filter(m => typeof m.provider === "string" && /^[a-z]{1,20}$/.test(m.provider) && typeof m.label === "string")
      .map(m => ({ provider: m.provider, label: m.label.slice(0, 30) }));
    return { methods, appearance: body.appearance ?? null };
  } catch { return { methods: [], appearance: null }; }
}

/**
 * Opens the provider in its own window and waits for the ticket to come back to this one. Only this window can redeem
 * it: it holds the verifier behind the challenge the sign-in started with. Must run from a click (popup).
 */
export async function signInWithProvider(appId: string, provider: string, signal?: AbortSignal): Promise<Redeemed> {
  const verifier = randomToken(), nonce = randomToken(18);
  const challenge = await sha256(verifier);
  const url = `${API_URL}/v1/wallet-apps/${encodeURIComponent(appId)}/login/${encodeURIComponent(provider)}/start?${new URLSearchParams({ challenge, nonce, origin: location.origin })}`;
  const popup = window.open(url, `maxxing-login-${nonce}`, "popup,width=480,height=720");
  if (!popup) throw new Error("LOGIN_POPUP_BLOCKED");
  // Providers often cut this window's view of the popup (it then reads as closed), so waiting ends on an answer, Cancel, or time.
  const result = await new Promise<{ ticket?: string | null; error?: string | null }>((resolve, reject) => {
    const channel = new BroadcastChannel(LOGIN_CHANNEL);
    const finish = (fn: () => void) => { channel.close(); clearTimeout(timeout); signal?.removeEventListener("abort", onAbort); fn(); };
    const onAbort = () => finish(() => { try { popup.close(); } catch { /* gone */ } reject(new Error("LOGIN_CANCELLED")); });
    channel.onmessage = event => {
      const data = event.data as { nonce?: string; ticket?: string | null; error?: string | null };
      if (data?.nonce === nonce) finish(() => resolve(data));
    };
    signal?.addEventListener("abort", onAbort);
    const timeout = setTimeout(() => finish(() => reject(new Error("LOGIN_TIMED_OUT"))), 5 * 60_000);
  });
  if (result.error) throw new Error(result.error === "CANCELLED" ? "LOGIN_CANCELLED" : "LOGIN_FAILED");
  if (!result.ticket) throw new Error("LOGIN_FAILED");
  return post<Redeemed>(`/v1/wallet-apps/${encodeURIComponent(appId)}/login/redeem`, { ticket: result.ticket, verifier });
}

/** Must match the message MAXXING's API checks, character for character (tests/social.test.ts pins it; the API's tests pin the same text). */
export async function sessionMessage(input: { appName: string; appId: string; evm: string; solana: string; nonce: string; issuedAt: string; account?: { label: string; username: string | null } | null; grant?: string }) {
  return [
    `Sign in to ${input.appName} with your MAXXING wallet.`,
    ...(input.account ? [`Account: ${input.account.label}${input.account.username ? ` @${input.account.username}` : ""}`] : []),
    `EVM: ${input.evm}`,
    `Solana: ${input.solana}`,
    `App: ${input.appId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    ...(input.grant ? [`Grant: ${await sha256hex(input.grant)}`] : []),
  ].join("\n");
}
async function sha256hex(text: string) { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))).slice(0, 32); }

/**
 * Proves this wallet (both keys) to the app and, after a social sign-in, links that account to it. The wallet must be
 * unlocked. Returns the identity token the app's server can check.
 */
export async function openAppSession(app: { id: string; name: string }, wallet: { evm: string; solana: string }, signedIn?: Redeemed | null): Promise<AppSession> {
  const nonce = randomToken(18), issuedAt = new Date().toISOString();
  const message = await sessionMessage({
    appName: app.name, appId: app.id, evm: wallet.evm, solana: wallet.solana, nonce, issuedAt,
    account: signedIn ? { label: signedIn.identity.label, username: signedIn.identity.username } : null, grant: signedIn?.grant,
  });
  const evmSignature = await signing.evmSignMessage({ message });
  const solanaSignature = hex(await signing.solanaSignBytes({ bytes: new TextEncoder().encode(message) }));
  return post<AppSession>(`/v1/wallet-apps/${encodeURIComponent(app.id)}/session`, { ...(signedIn ? { grant: signedIn.grant } : {}), evm: wallet.evm, solana: wallet.solana, nonce, issuedAt, evmSignature, solanaSignature });
}
