import test from "node:test";
import assert from "node:assert/strict";
import { signWebhookPayload, verifyWebhook, WebhookVerificationError } from "../src/server";

const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

test("signs as Standard Webhooks do", () => {
  assert.equal(signWebhookPayload(SECRET, "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}'), "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
});

test("accepts a genuine call and refuses changed, old or unsigned ones", () => {
  const now = 1_800_000_000_000, ts = now / 1000;
  const body = JSON.stringify({ id: "evt_1", type: "trade.created", createdAt: "x", data: { token: "eip155:8453:0x1", side: "buy" } });
  const headers = { "webhook-id": "evt_1", "webhook-timestamp": String(ts), "webhook-signature": `v1,bogus ${signWebhookPayload(SECRET, "evt_1", ts, body)}` };
  const event = verifyWebhook(SECRET, headers, body, { now });
  assert.equal(event.type, "trade.created");
  assert.equal(verifyWebhook(SECRET, new Headers(headers), body, { now }).id, "evt_1");
  const code = (fn: () => unknown) => { try { fn(); return "none"; } catch (e) { assert.ok(e instanceof WebhookVerificationError); return e.code; } };
  assert.equal(code(() => verifyWebhook(SECRET, headers, body.replace("buy", "sell"), { now })), "BAD_SIGNATURE");
  assert.equal(code(() => verifyWebhook(SECRET, headers, body, { now: now + 301_000 })), "TIMESTAMP_TOO_OLD");
  assert.equal(code(() => verifyWebhook(SECRET, headers, body, { now: now - 301_000 })), "TIMESTAMP_TOO_NEW");
  assert.equal(code(() => verifyWebhook(SECRET, { "webhook-id": "evt_1" }, body, { now })), "MISSING_HEADERS");
  assert.equal(code(() => verifyWebhook("whsec_" + btoa("another key, 24 bytes!!"), headers, body, { now })), "BAD_SIGNATURE");
});
