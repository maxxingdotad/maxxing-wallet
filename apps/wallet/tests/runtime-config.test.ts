import { test } from "node:test";
import { strict as assert } from "node:assert";
import { loadRuntimeConfig, resetRuntimeConfigForTest, websiteUrl } from "../src/window/runtime-config";

const production = { DEV: false, VITE_PUBLIC_WEB_URL: "https://built.example/" };

test("the wallet window's website link: the build's until admin's loads, https only, the local site while developing", async () => {
  resetRuntimeConfigForTest();
  assert.equal(websiteUrl(production), "https://built.example");
  assert.equal(websiteUrl({ DEV: false }), "https://maxxing.ad");
  const calls: { url: string; init?: RequestInit }[] = [];
  const send = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ values: { "links.website": "https://maxxing.example/" } }));
  }) as unknown as typeof fetch;
  await loadRuntimeConfig("https://api.example/", send);
  await loadRuntimeConfig("https://api.example/", send);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example/v1/config");
  assert.equal(calls[0].init?.credentials, "omit");
  assert.equal(websiteUrl(production), "https://maxxing.example");
  assert.equal(websiteUrl({ DEV: true }), "http://localhost:5173");
});

test("an unsafe or unreadable admin value, or a failed load, keeps the build's link", async () => {
  for (const value of ["http://plain.example", "javascript:alert(1)", 7]) {
    resetRuntimeConfigForTest();
    await loadRuntimeConfig("https://api.example", (async () => new Response(JSON.stringify({ values: { "links.website": value } }))) as unknown as typeof fetch);
    assert.equal(websiteUrl(production), "https://built.example");
  }
  resetRuntimeConfigForTest();
  await loadRuntimeConfig("https://api.example", (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
  assert.equal(websiteUrl(production), "https://built.example");
});
