import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPartnerApp, loadPartnerApp, type PartnerApp } from "../src/registry";
import { parseFirstPartyApps } from "../src/first-party";

// The wallet window's own rules: which apps may use it, from which websites. What it shows and signs is tested in packages/wallet-core.

const ACME = { id: "app_0123456789abcdef0123", name: "Acme" };

const app = (status: PartnerApp["status"]): PartnerApp => ({ ...ACME, status, origins: ["https://acme.example"], logoUrl: null, builtIn: false });
test("a request speaks for an app only from its registered websites, and only while it is allowed", () => {
  assert.deepEqual(checkPartnerApp(null, "https://acme.example"), { ok: false, reason: "unknown" });
  assert.deepEqual(checkPartnerApp(app("suspended"), "https://acme.example"), { ok: false, reason: "suspended" });
  assert.deepEqual(checkPartnerApp(app("live"), "https://evil.example"), { ok: false, reason: "wrong_site" });
  assert.deepEqual(checkPartnerApp(app("live"), "https://acme.example"), { ok: true, app: app("live"), inReview: false });
  // Tests run as a production build: apps in review are refused on their public sites.
  assert.deepEqual(checkPartnerApp(app("pending"), "https://acme.example"), { ok: false, reason: "in_review" });
});

test("test mode: in production an app in review answers only on localhost, a live app never there", () => {
  const both = (status: PartnerApp["status"]): PartnerApp => ({ ...app(status), origins: ["https://acme.example", "http://localhost:3000", "http://127.0.0.1:3000"] });
  assert.deepEqual(checkPartnerApp(both("pending"), "http://localhost:3000"), { ok: true, app: both("pending"), inReview: true });
  assert.deepEqual(checkPartnerApp(both("pending"), "http://127.0.0.1:3000"), { ok: true, app: both("pending"), inReview: true });
  assert.deepEqual(checkPartnerApp(both("pending"), "https://acme.example"), { ok: false, reason: "in_review" });
  assert.deepEqual(checkPartnerApp(both("pending"), "http://localhost:4000"), { ok: false, reason: "wrong_site" });
  assert.deepEqual(checkPartnerApp(both("live"), "http://localhost:3000"), { ok: false, reason: "wrong_site" });
  assert.deepEqual(checkPartnerApp(both("live"), "https://acme.example"), { ok: true, app: both("live"), inReview: false });
  // Development builds answer every registered origin.
  assert.deepEqual(checkPartnerApp(both("pending"), "https://acme.example", true), { ok: true, app: both("pending"), inReview: true });
});

test("app records are read from the API, validated and cached", async () => {
  let calls = 0;
  const fetcher = (async (url: string) => {
    calls++;
    assert.equal(url, `https://api.maxxing.ad/v1/wallet-apps/${ACME.id}`);
    return new Response(JSON.stringify({ id: ACME.id, name: "Acme", status: "live", origins: ["https://acme.example"], logoUrl: `/v1/wallet-apps/${ACME.id}/logo?v=1` }));
  }) as typeof fetch;
  const loaded = await loadPartnerApp(ACME.id, fetcher);
  assert.equal(loaded?.logoUrl, `https://api.maxxing.ad/v1/wallet-apps/${ACME.id}/logo?v=1`);
  await loadPartnerApp(ACME.id, fetcher);
  assert.equal(calls, 1);
  const forged = (async () => new Response(JSON.stringify({ id: "app_ffffffffffffffffffff", name: "x", status: "live", origins: ["*"], logoUrl: "https://evil.example/x.png" }))) as unknown as typeof fetch;
  assert.equal(await loadPartnerApp("app_ffffffffffffffffffff", forged), null);
  assert.equal(await loadPartnerApp("../admin", fetcher), null);
  assert.equal((await loadPartnerApp("maxxing-developers"))?.builtIn, true);
});

test("first-party apps must be https outside development, and a bad list is refused whole", () => {
  const list = (origins: string[]) => JSON.stringify([{ id: "maxxing", name: "MAXXING", origins }]);
  assert.deepEqual(parseFirstPartyApps(list(["https://maxxing.ad"]), false)?.[0]?.origins, ["https://maxxing.ad"]);
  assert.equal(parseFirstPartyApps(list(["https://maxxing.ad", "http://maxxing.ad"]), false), null);
  assert.notEqual(parseFirstPartyApps(list(["http://localhost:5173"]), true), null);
  assert.equal(parseFirstPartyApps(list(["https://maxxing.ad/path"]), true), null);
  assert.equal(parseFirstPartyApps("not json", true), null);
  assert.equal(parseFirstPartyApps("[]", true), null);
});
