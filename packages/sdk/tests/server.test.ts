import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { createSignIn, evmSigner, parseSignInMessage, SignInError, verifyIdentityToken, verifySignIn } from "../src/server";
import { signInDomainMatches } from "../src/siwe";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const NOW = new Date("2026-11-21T10:00:00.000Z");
const code = (fn: () => unknown) => { try { fn(); return "ok"; } catch (e) { return e instanceof SignInError ? e.code : String(e); } };

test("an EVM sign-in made with personal_sign verifies, and only for the right site, nonce and time", async () => {
  const { message, nonce } = createSignIn({ domain: "app.example.com", uri: "https://app.example.com", address: account.address.toLowerCase(), chainId: 8453, statement: "Sign in to Example.", now: NOW });
  const parsed = parseSignInMessage(message)!;
  assert.equal(parsed.address, account.address, "addresses are written checksummed");
  assert.equal(parsed.chainId, 8453);
  assert.equal(parsed.statement, "Sign in to Example.");
  const signature = await account.signMessage({ message });
  assert.equal(evmSigner(message, signature), account.address);
  assert.equal(verifySignIn({ message, signature, domain: "app.example.com", nonce, now: NOW }).address, account.address);
  assert.equal(code(() => verifySignIn({ message, signature, domain: "evil.example", nonce, now: NOW })), "WRONG_DOMAIN");
  assert.equal(code(() => verifySignIn({ message, signature, domain: "app.example.com", nonce: "other", now: NOW })), "WRONG_NONCE");
  assert.equal(code(() => verifySignIn({ message, signature, domain: "app.example.com", nonce, now: new Date(NOW.getTime() + 11 * 60_000) })), "EXPIRED");
  // A signature over a different message, or a tampered message, fails.
  const other = await account.signMessage({ message: message.replace("Sign in to Example.", "Sign in to Other.") });
  assert.equal(code(() => verifySignIn({ message, signature: other, domain: "app.example.com", nonce, now: NOW })), "BAD_SIGNATURE");
  assert.equal(code(() => verifySignIn({ message, signature: "0x1234", domain: "app.example.com", nonce, now: NOW })), "BAD_SIGNATURE");
  assert.equal(code(() => verifySignIn({ message: "hello", signature, domain: "app.example.com", nonce })), "MALFORMED_MESSAGE");
  // The stored nonce is required: without it the same signed message would be accepted again.
  assert.equal(code(() => verifySignIn({ message, signature, domain: "app.example.com", now: NOW } as never)), "INVALID_REQUEST");
  assert.equal(code(() => verifySignIn({ message, signature, domain: "app.example.com", nonce: "", now: NOW })), "INVALID_REQUEST");
});

test("identity tokens: only MAXXING's issuer, and an unknown key refetches the JWKS at most once a minute", async () => {
  const secret = ed25519.utils.randomSecretKey();
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const json = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));
  const sign = (claims: Record<string, unknown>, key = secret) => {
    const head = json({ alg: "EdDSA", kid: "k1" }), body = json(claims);
    return `${head}.${body}.${b64(ed25519.sign(new TextEncoder().encode(`${head}.${body}`), key))}`;
  };
  let fetches = 0;
  const fetcher = (async () => { fetches++; return new Response(JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid: "k1", x: b64(ed25519.getPublicKey(secret)) }] })); }) as unknown as typeof fetch;
  const exp = Math.floor(Date.now() / 1000) + 600;
  const claims = { iss: "https://api.maxxing.ad", aud: "app_x", sub: "u", iat: 1, exp, wallet: { evm: "0x1", solana: "s" }, accounts: [] };
  const options = { appId: "app_x", jwksUrl: "https://test/jwks-server-test", fetcher };
  assert.equal((await verifyIdentityToken(sign(claims), options)).sub, "u");
  const fail = (token: string) => verifyIdentityToken(token, options).then(() => "ok", e => (e as SignInError).code);
  assert.equal(await fail(sign({ ...claims, iss: "http://localhost:4000" })), "BAD_SIGNATURE");
  const before = fetches;
  // Tokens signed by an unknown key: one refetch at most, however many arrive.
  for (let i = 0; i < 5; i++) assert.equal(await fail(sign(claims, ed25519.utils.randomSecretKey())), "BAD_SIGNATURE");
  assert.ok(fetches - before <= 1, `refetched ${fetches - before} times`);
});

test("a Solana sign-in verifies with the account's ed25519 key", () => {
  const secret = ed25519.utils.randomSecretKey();
  const address = bs58.encode(ed25519.getPublicKey(secret));
  const { message, nonce } = createSignIn({ domain: "localhost:3000", uri: "http://localhost:3000", address, family: "solana", now: NOW });
  assert.match(message, /wants you to sign in with your Solana account:/);
  assert.doesNotMatch(message, /Chain ID/);
  const signature = bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret));
  assert.equal(verifySignIn({ message, signature, domain: "localhost:3000", nonce, now: NOW }).address, address);
  const wrong = bs58.encode(ed25519.sign(new TextEncoder().encode(message), ed25519.utils.randomSecretKey()));
  assert.equal(code(() => verifySignIn({ message, signature: wrong, domain: "localhost:3000", nonce, now: NOW })), "BAD_SIGNATURE");
});

test("bad requests are refused before any message is written", () => {
  assert.equal(code(() => createSignIn({ domain: "https://x.com", uri: "https://x.com", address: account.address, chainId: 1 })), "INVALID_REQUEST");
  assert.equal(code(() => createSignIn({ domain: "x.com", uri: "https://x.com", address: account.address })), "INVALID_REQUEST");
  assert.equal(code(() => createSignIn({ domain: "x.com", uri: "https://x.com", address: "nope", chainId: 1 })), "INVALID_REQUEST");
  assert.equal(code(() => createSignIn({ domain: "x.com", uri: "https://x.com", address: account.address, chainId: 1, statement: "a\nURI: https://evil" })), "INVALID_REQUEST");
});

test("the parser reads standard messages from other libraries and checks the asking site", () => {
  const text = ["service.org wants you to sign in with your Ethereum account:", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "", "I accept the ServiceOrg Terms of Service: https://service.org/tos", "", "URI: https://service.org/login", "Version: 1", "Chain ID: 1", "Nonce: 32891756", "Issued At: 2021-09-30T16:25:24Z", "Resources:", "- ipfs://bafybeiemxf5abjwjbikoz4mc3a3dla6ual3jsgpdr4cjr3oz3evfyavhwq/", "- https://example.com/my-web2-claim.json"].join("\n");
  const parsed = parseSignInMessage(text)!;
  assert.equal(parsed.domain, "service.org");
  assert.equal(parsed.statement, "I accept the ServiceOrg Terms of Service: https://service.org/tos");
  assert.equal(parsed.resources.length, 2);
  assert.ok(signInDomainMatches(parsed, "https://service.org"));
  assert.ok(!signInDomainMatches(parsed, "https://service.org.evil.com"));
  assert.equal(parseSignInMessage("Sign this to log in"), null);
});
