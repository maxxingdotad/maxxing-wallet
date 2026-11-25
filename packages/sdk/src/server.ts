/**
 * Server helpers for signing people in with their MAXXING wallet (`@maxxing/wallet-sdk/server`).
 *
 *   const { message, nonce } = createSignIn({ domain: "app.example.com", uri: "https://app.example.com", address, chainId: 8453 });
 *   // store { nonce, message } once, send `message` to the browser, the user signs it in the wallet window, then:
 *   const { address } = verifySignIn({ message: stored.message, signature, domain: "app.example.com", nonce: stored.nonce });
 *
 * Verify against the message you stored, never one the browser sends back, and use each nonce once.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";
import { formatSignInMessage, parseSignInMessage, type SignInFamily, type SignInMessage } from "./siwe";

export { parseSignInMessage, formatSignInMessage, type SignInMessage, type SignInFamily } from "./siwe";
export { verifyWebhook, signWebhookPayload, WebhookVerificationError, type MaxxingWebhookEvent, type WebhookTrade, type WebhookErrorCode } from "./webhooks";

export type SignInErrorCode = "INVALID_REQUEST" | "MALFORMED_MESSAGE" | "WRONG_DOMAIN" | "WRONG_NONCE" | "EXPIRED" | "NOT_YET_VALID" | "BAD_SIGNATURE";
export class SignInError extends Error {
  constructor(readonly code: SignInErrorCode, message: string = code) { super(message); this.name = "SignInError"; }
}

export type CreateSignInOptions = {
  /** Your site's host, e.g. "app.example.com" (with port in development, e.g. "localhost:3000"). */
  domain: string;
  /** Your site's address, e.g. "https://app.example.com". */
  uri: string;
  /** The address the user connected: 0x… for EVM, base58 for Solana. */
  address: string;
  /** "evm" (default) or "solana". */
  family?: SignInFamily;
  /** The EVM network the user is on. Required for EVM. */
  chainId?: number;
  /** One line shown to the user, e.g. "Sign in to Acme." */
  statement?: string;
  /** How long the message stays valid. Default 10 minutes. */
  ttlSeconds?: number;
  /** For tests: the time to write. */
  now?: Date;
};

const encodeHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const decodeHex = (hex: string) => {
  const clean = hex.replace(/^0x/i, "");
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new SignInError("BAD_SIGNATURE", "Signature is not hex.");
  return Uint8Array.from(clean.match(/../g) ?? [], b => parseInt(b, 16));
};
const randomNonce = () => { const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes); return encodeHex(bytes); };

/** EIP-55 mixed-case address. */
export function checksumAddress(address: string): `0x${string}` {
  const lower = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new SignInError("INVALID_REQUEST", "Not an EVM address.");
  const hash = encodeHex(keccak_256(new TextEncoder().encode(lower)));
  return `0x${[...lower].map((c, i) => parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c).join("")}`;
}

/** Writes a one-time sign-in message for `address`. Store `nonce` and `message`; send `message` to the browser. */
export function createSignIn(options: CreateSignInOptions): { message: string; nonce: string; expiresAt: string } {
  const family = options.family ?? "evm";
  if (!options.domain || /[\s/]/.test(options.domain)) throw new SignInError("INVALID_REQUEST", "domain is a host like app.example.com.");
  try { new URL(options.uri); } catch { throw new SignInError("INVALID_REQUEST", "uri must be a full URL."); }
  if (family === "evm" && !(Number.isSafeInteger(options.chainId) && options.chainId! > 0)) throw new SignInError("INVALID_REQUEST", "chainId is required for EVM.");
  if (options.statement && /\n/.test(options.statement)) throw new SignInError("INVALID_REQUEST", "statement is one line.");
  const address = family === "evm" ? checksumAddress(options.address) : options.address;
  if (family === "solana" && !isSolanaAddress(address)) throw new SignInError("INVALID_REQUEST", "Not a Solana address.");
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (options.ttlSeconds ?? 600) * 1000).toISOString();
  const nonce = randomNonce();
  const message = formatSignInMessage({
    family, domain: options.domain, address, statement: options.statement ?? null, uri: options.uri, chainId: family === "evm" ? options.chainId! : null,
    nonce, issuedAt: now.toISOString(), expirationTime: expiresAt, notBefore: null, requestId: null, resources: [],
  });
  return { message, nonce, expiresAt };
}

export type VerifySignInOptions = {
  /** The message you stored when you created it. */
  message: string;
  /** EVM: the 0x… signature from personal_sign. Solana: base58 (as wallet adapters encode it), or the raw bytes. */
  signature: string | Uint8Array;
  /** Your site's host; the message must name it. */
  domain: string;
  /**
   * The nonce you stored with the message (required). Without it a signed message could be replayed; delete the stored nonce
   * once it is used.
   */
  nonce: string;
  /** For tests: the time to check against. */
  now?: Date;
};

/** Checks the message (domain, nonce, time window) and that the signature is the named address's. Throws a SignInError if not. */
export function verifySignIn(options: VerifySignInOptions): SignInMessage {
  // Required since 0.2.0: a check without the stored nonce accepts the same signed message again and again.
  if (typeof options.nonce !== "string" || !options.nonce) throw new SignInError("INVALID_REQUEST", "nonce is required: pass the nonce you stored with the message.");
  const parsed = parseSignInMessage(options.message);
  if (!parsed) throw new SignInError("MALFORMED_MESSAGE", "Not a sign-in message.");
  if (parsed.domain.toLowerCase() !== options.domain.toLowerCase()) throw new SignInError("WRONG_DOMAIN", `The message is for ${parsed.domain}.`);
  if (parsed.nonce !== options.nonce) throw new SignInError("WRONG_NONCE");
  const now = (options.now ?? new Date()).getTime();
  if (parsed.expirationTime && now > Date.parse(parsed.expirationTime)) throw new SignInError("EXPIRED");
  if (parsed.notBefore && now < Date.parse(parsed.notBefore)) throw new SignInError("NOT_YET_VALID");
  const ok = parsed.family === "evm" ? evmSigner(options.message, options.signature)?.toLowerCase() === parsed.address.toLowerCase() : solanaVerifies(options.message, options.signature, parsed.address);
  if (!ok) throw new SignInError("BAD_SIGNATURE");
  return parsed;
}

/** The address that made an EIP-191 personal_sign signature over `message`, or null. */
export function evmSigner(message: string, signature: string | Uint8Array): `0x${string}` | null {
  try {
    const sig = typeof signature === "string" ? decodeHex(signature) : signature;
    if (sig.length !== 65) return null;
    const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!;
    if (v !== 0 && v !== 1) return null;
    const body = new TextEncoder().encode(message);
    const hash = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`), ...body]));
    const recovered = secp256k1.recoverPublicKey(new Uint8Array([v, ...sig.slice(0, 64)]), hash, { prehash: false });
    const point = secp256k1.Point.fromBytes(recovered).toBytes(false);
    return checksumAddress(encodeHex(keccak_256(point.slice(1)).slice(12)));
  } catch { return null; }
}

function isSolanaAddress(address: string) { try { return bs58.decode(address).length === 32; } catch { return false; } }

function solanaVerifies(message: string, signature: string | Uint8Array, address: string) {
  try {
    const sig = typeof signature === "string" ? bs58.decode(signature) : signature;
    return sig.length === 64 && ed25519.verify(sig, new TextEncoder().encode(message), bs58.decode(address));
  } catch { return false; }
}

// ── Identity tokens (signIn) ─────────────────────────────────────────────────────
export type IdentityClaims = {
  iss: string; aud: string; sub: string; iat: number; exp: number;
  wallet: { evm: string; solana: string };
  accounts: { provider: string; subject: string; username: string | null; name: string | null; avatar: string | null; profile: string | null }[];
};
export type VerifyIdentityOptions = {
  /** Your app id: the token must be for your app. */
  appId: string;
  /** Where MAXXING publishes its keys. Default https://api.maxxing.ad/v1/wallet-apps/.well-known/jwks.json. */
  jwksUrl?: string;
  /** The issuer the token must name. Default https://api.maxxing.ad (MAXXING issues every token, also to apps in test mode). */
  issuer?: string;
  /** For tests. */
  now?: Date;
  fetcher?: typeof fetch;
};
const DEFAULT_JWKS = "https://api.maxxing.ad/v1/wallet-apps/.well-known/jwks.json";
const DEFAULT_ISSUER = "https://api.maxxing.ad";
/** Keys are kept an hour; a token with an unknown key fetches them again at most once a minute (a flood of bad tokens can't hammer the JWKS). */
const JWKS_KEEP_MS = 3_600_000, JWKS_REFRESH_MS = 60_000;
const jwksCache = new Map<string, { at: number; keys: { kid?: string; x: string }[] }>();
const fromB64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), c => c.charCodeAt(0));

async function jwks(url: string, fetcher: typeof fetch, refresh = false) {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.at < (refresh ? JWKS_REFRESH_MS : JWKS_KEEP_MS)) return cached.keys;
  const response = await fetcher(url);
  if (!response.ok) throw new SignInError("BAD_SIGNATURE", "Couldn't load MAXXING's keys.");
  const body = await response.json() as { keys?: { kty?: string; crv?: string; kid?: string; x?: string }[] };
  const keys = (body.keys ?? []).filter(k => k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string").map(k => ({ kid: k.kid, x: k.x! }));
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

/**
 * Checks an identity token from wallet.signIn() on your server: MAXXING's signature (EdDSA, keys from its JWKS), that it's
 * for your app, and not expired. Returns who signed in: `sub` (their id for your app), their wallet and verified accounts.
 */
export async function verifyIdentityToken(token: string, options: VerifyIdentityOptions): Promise<IdentityClaims> {
  const [head, payload, signature] = token.split(".");
  if (!head || !payload || !signature) throw new SignInError("MALFORMED_MESSAGE", "Not an identity token.");
  let header: { alg?: string; kid?: string }, claims: IdentityClaims;
  try { header = JSON.parse(new TextDecoder().decode(fromB64url(head))); claims = JSON.parse(new TextDecoder().decode(fromB64url(payload))); }
  catch { throw new SignInError("MALFORMED_MESSAGE", "Not an identity token."); }
  if (header.alg !== "EdDSA") throw new SignInError("BAD_SIGNATURE", "Unexpected algorithm.");
  const fetcher = options.fetcher ?? fetch, url = options.jwksUrl ?? DEFAULT_JWKS;
  const signed = new TextEncoder().encode(`${head}.${payload}`), sig = fromB64url(signature);
  const check = (keys: { kid?: string; x: string }[]) => keys.filter(k => !header.kid || !k.kid || k.kid === header.kid).some(k => { try { return ed25519.verify(sig, signed, fromB64url(k.x)); } catch { return false; } });
  // A key MAXXING has rotated in since the last fetch: look again (at most once a minute per JWKS address).
  if (!check(await jwks(url, fetcher)) && !check(await jwks(url, fetcher, true))) throw new SignInError("BAD_SIGNATURE");
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.iss !== (options.issuer ?? DEFAULT_ISSUER)) throw new SignInError("BAD_SIGNATURE", "Unknown issuer.");
  if (claims.aud !== options.appId) throw new SignInError("WRONG_DOMAIN", "The token is for another app.");
  if (typeof claims.exp !== "number" || claims.exp <= now) throw new SignInError("EXPIRED");
  return claims;
}
