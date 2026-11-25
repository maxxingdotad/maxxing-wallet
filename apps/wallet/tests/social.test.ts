import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionMessage } from "../src/window/social";

/** The same text is pinned in the API's login tests: the window and the API must agree exactly. */
export const GOLDEN = [
  "Sign in to Acme with your MAXXING wallet.",
  "Account: Google @jean@example.com",
  "EVM: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "Solana: 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  "App: app_0123456789abcdef0123",
  "Nonce: session-nonce-123456",
  "Issued At: 2026-11-21T10:00:00.000Z",
  "Grant: ecd440ad2cfd8381114bcfb4422743ee",
].join("\n");

test("the session message the window signs is exactly the one the API checks", async () => {
  const text = await sessionMessage({ appName: "Acme", appId: "app_0123456789abcdef0123", evm: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", solana: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", nonce: "session-nonce-123456", issuedAt: "2026-11-21T10:00:00.000Z", account: { label: "Google", username: "jean@example.com" }, grant: "grant-value" });
  assert.equal(text, GOLDEN);
});
