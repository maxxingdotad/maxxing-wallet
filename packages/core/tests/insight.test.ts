import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSignIn, untilText } from "../src/sign-in";
import { decodeSymbol, fundsCheck, netChanges } from "../src/simulation";

const ME = "0x1111111111111111111111111111111111111111";
const NOW = Date.parse("2026-11-21T10:00:00Z");
const siwe = (domain: string, address = ME, extra: string[] = []) => [
  `${domain} wants you to sign in with your Ethereum account:`, address, "", "Sign in to Acme.", "",
  `URI: https://${domain}`, "Version: 1", "Chain ID: 8453", "Nonce: abcdef123456", "Issued At: 2026-11-21T09:59:00Z", "Expiration Time: 2026-11-21T10:10:00Z", ...extra,
].join("\n");

test("a sign-in message is shown as a sign-in only to the site it names, for the wallet signing", () => {
  const ok = checkSignIn(siwe("acme.com"), "https://acme.com", ME, NOW);
  assert.ok(ok?.ok);
  assert.equal(ok.ok && ok.message.statement, "Sign in to Acme.");
  assert.equal(checkSignIn(siwe("acme.com"), "https://evil.com", ME, NOW)?.ok, false);
  assert.deepEqual((({ ok, code }) => ({ ok, code }))(checkSignIn(siwe("acme.com"), "https://evil.com", ME, NOW) as { ok: boolean; code: string }), { ok: false, code: "SIGN_IN_WRONG_SITE" });
  assert.equal((checkSignIn(siwe("acme.com"), "https://acme.com.evil.io", ME, NOW) as { code: string }).code, "SIGN_IN_WRONG_SITE");
  assert.equal((checkSignIn(siwe("acme.com", "0x2222222222222222222222222222222222222222"), "https://acme.com", ME, NOW) as { code: string }).code, "SIGN_IN_WRONG_ACCOUNT");
  assert.equal((checkSignIn(siwe("acme.com"), "https://acme.com", ME, NOW + 11 * 60_000) as { code: string }).code, "SIGN_IN_EXPIRED");
  assert.equal(checkSignIn("Welcome to Acme! Click to sign in.", "https://acme.com", ME, NOW), null, "ordinary messages stay ordinary");
  assert.equal(untilText("2026-11-21T10:10:00Z", NOW), "in 10 minutes");
});

test("transfer logs add up to what leaves and arrives in the wallet", () => {
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", max = "0x5dab2f3adea610c35ab1c330c84c6fd13c3df92e", other = "0x9999999999999999999999999999999999999999";
  const totals = netChanges([
    { address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", topics: [TRANSFER, pad(ME), pad(other)], data: "0x0de0b6b3a7640000" },
    { address: usdc, topics: [TRANSFER, pad(ME), pad(other)], data: "0x05f5e100" },
    { address: usdc, topics: [TRANSFER, pad(other), pad(ME)], data: "0x02faf080" },
    { address: max, topics: [TRANSFER, pad(other), pad(ME)], data: "0x1000" },
    { address: max, topics: [TRANSFER, pad(other), pad(other), pad(ME)], data: "0x" }, // an NFT-style log is ignored
    { address: max, topics: [TRANSFER, pad(other), pad(other)], data: "0x5" },          // not ours
  ], ME);
  assert.equal(totals.get("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"), -(10n ** 18n));
  assert.equal(totals.get(usdc), -50_000_000n);
  assert.equal(totals.get(max), 4096n);
});

test("token symbols are read whether a contract returns a string or bytes32, and anything odd is dropped", () => {
  const abiString = "0x" + "20".padStart(64, "0") + "3".padStart(64, "0") + "4d41580000000000000000000000000000000000000000000000000000000000";
  assert.equal(decodeSymbol(abiString), "MAX");
  assert.equal(decodeSymbol("0x" + "4d4b520000000000000000000000000000000000000000000000000000000000"), "MKR");
  assert.equal(decodeSymbol("0x"), null);
  assert.equal(decodeSymbol("0x" + "20".padStart(64, "0") + "2".padStart(64, "0") + "0a1b000000000000000000000000000000000000000000000000000000000000"), null);
});

test("the balance must cover the amount plus the most the fee can be", () => {
  assert.deepEqual(fundsCheck(10n, 5n, 5n), { enough: true, balance: 10n, needs: 10n });
  assert.equal(fundsCheck(9n, 5n, 5n).enough, false);
  assert.equal(fundsCheck(5n, 5n, null).enough, true);
});
