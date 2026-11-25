/**
 * Checks a MAXXING webhook on your server (`@maxxing/wallet-sdk/server`). Calls are signed as Standard Webhooks define
 * (standardwebhooks.com), so any of their libraries works too.
 *
 *   app.post("/maxxing", express.raw({ type: "application/json" }), (req, res) => {
 *     const event = verifyWebhook(process.env.MAXXING_WEBHOOK_SECRET!, req.headers, req.body.toString("utf8"));
 *     if (event.type === "trade.created") console.log(event.data.side, event.data.amountUsd);
 *     res.sendStatus(200);
 *   });
 *
 * Pass the body exactly as it arrived (not parsed and re-written). Answer 2xx within 10 seconds; anything else is retried
 * (30 s, 2 min, 10 min, 1 h, 3 h, 6 h, 12 h). The same event can arrive twice: drop repeats by `event.id`.
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export type WebhookTrade = {
  /** The token, as `<chainId>:<address>` (the Data API's id). */
  token: string; txHash: string; time: string; side: "buy" | "sell"; trader: string | null; amountUsd: string | null; priceUsd: string | null;
};
export type MaxxingWebhookEvent =
  | { id: string; type: "trade.created"; createdAt: string; data: WebhookTrade }
  | { id: string; type: "webhook.test"; createdAt: string; data: { webhook: string; message: string } };

export type WebhookErrorCode = "MISSING_HEADERS" | "TIMESTAMP_TOO_OLD" | "TIMESTAMP_TOO_NEW" | "BAD_SIGNATURE" | "BAD_BODY";
export class WebhookVerificationError extends Error {
  constructor(readonly code: WebhookErrorCode) { super(code); this.name = "WebhookVerificationError"; }
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;
const header = (headers: HeaderBag, name: string) => {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? "";
  const bag = headers as Record<string, string | string[] | undefined>;
  const value = bag[name] ?? bag[Object.keys(bag).find(k => k.toLowerCase() === name) ?? ""];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
};
const base64 = {
  decode: (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0)),
  encode: (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)),
};
const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** The signature MAXXING sends for this body (`v1,<base64>`). */
export function signWebhookPayload(secret: string, id: string, timestamp: number, body: string) {
  const key = base64.decode(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  return `v1,${base64.encode(hmac(sha256, key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))}`;
}

/**
 * Checks the signature and time of a webhook call and returns its event. Throws WebhookVerificationError when it isn't a
 * genuine, recent call from MAXXING (answer 400 then). `toleranceSeconds` (default 300) is how old or early a call may be.
 */
export function verifyWebhook(secret: string, headers: HeaderBag, body: string, options: { toleranceSeconds?: number; now?: number } = {}): MaxxingWebhookEvent {
  const id = header(headers, "webhook-id"), timestamp = header(headers, "webhook-timestamp"), signatures = header(headers, "webhook-signature");
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError("MISSING_HEADERS");
  const seconds = Number(timestamp), now = Math.floor((options.now ?? Date.now()) / 1000), tolerance = options.toleranceSeconds ?? 300;
  if (!Number.isInteger(seconds) || seconds < now - tolerance) throw new WebhookVerificationError("TIMESTAMP_TOO_OLD");
  if (seconds > now + tolerance) throw new WebhookVerificationError("TIMESTAMP_TOO_NEW");
  const expected = signWebhookPayload(secret, id, seconds, body);
  // The header may carry several signatures (space-separated) while a secret is being changed.
  if (!signatures.split(" ").some(candidate => sameText(candidate, expected))) throw new WebhookVerificationError("BAD_SIGNATURE");
  let event: MaxxingWebhookEvent;
  try { event = JSON.parse(body); } catch { throw new WebhookVerificationError("BAD_BODY"); }
  if (!event || typeof event !== "object" || event.id !== id) throw new WebhookVerificationError("BAD_BODY");
  return event;
}
