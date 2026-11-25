import test from "node:test";
import assert from "node:assert/strict";
import { createMaxxingData, formatUsd, MaxxingDataError, parseTokenId } from "../src/data";

function fakeFetch(answer: (url: URL, headers: Record<string, string>) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: string[] = [];
  const fetcher = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    const out = answer(url, init.headers as Record<string, string>);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200, headers: out.headers });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

test("a web page sends its app id, a server its secret; token ids and refs both work", async () => {
  const { fetcher, calls } = fakeFetch((url, headers) => ({ body: { token: { id: url.pathname, key: headers["x-maxxing-app"] ?? headers.authorization } } }));
  const web = createMaxxingData({ appId: "app_1", fetch: fetcher, baseUrl: "https://api.test" });
  assert.equal((await web.token("eip155:8453:0x4ed4e862860bed51a9570b96d89af5e1b0efefed") as unknown as { key: string }).key, "app_1");
  const server = createMaxxingData({ secret: "mxsk_x", fetch: fetcher, baseUrl: "https://api.test" });
  assert.equal((await server.token({ chainId: "solana:mainnet", address: "So11111111111111111111111111111111111111112" }) as unknown as { key: string }).key, "Bearer mxsk_x");
  assert.equal(calls[0], "/v1/public/tokens/eip155%3A8453/0x4ed4e862860bed51a9570b96d89af5e1b0efefed");
  await assert.rejects(web.token("nope"), (e: MaxxingDataError) => e.code === "INVALID_TOKEN_ID");
});

test("prices go 25 to a call and come back in order", async () => {
  const { fetcher, calls } = fakeFetch(url => ({ body: { items: url.searchParams.get("ids")!.split(",").map(id => ({ id, priceUsd: "1" })) } }));
  const data = createMaxxingData({ appId: "app_1", fetch: fetcher });
  const ids = Array.from({ length: 30 }, (_, i) => `eip155:1:0x${String(i).padStart(40, "0")}`);
  const prices = await data.prices(ids);
  assert.equal(calls.length, 2);
  assert.deepEqual(prices.map(p => p.id), ids);
});

test("errors carry a stable code; a short 429 is retried once", async () => {
  let n = 0;
  const { fetcher } = fakeFetch(() => (++n === 1 ? { status: 429, body: { error: "RATE_LIMITED" }, headers: { "retry-after": "0" } } : { status: 404, body: { error: "NOT_FOUND" } }));
  const data = createMaxxingData({ appId: "app_1", fetch: fetcher });
  await assert.rejects(data.search("max"), (e: MaxxingDataError) => e.code === "NOT_FOUND" && e.status === 404);
  assert.equal(n, 2);
});

test("all() walks every page", async () => {
  const { fetcher } = fakeFetch(url => ({ body: url.searchParams.get("cursor") ? { items: [{ id: "b" }], nextCursor: null } : { items: [{ id: "a" }], nextCursor: "2" } }));
  const data = createMaxxingData({ appId: "app_1", fetch: fetcher });
  const seen: string[] = [];
  for await (const token of data.all(cursor => data.tokens({ cursor }))) seen.push(token.id);
  assert.deepEqual(seen, ["a", "b"]);
});

test("ids and money read the way people expect", () => {
  assert.deepEqual(parseTokenId("eip155:8453:0x4ed4e862860bed51a9570b96d89af5e1b0efefed"), { chainId: "eip155:8453", address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed" });
  assert.equal(parseTokenId("8453:0xabc"), null);
  assert.equal(formatUsd("1234.5"), "$1,234.50");
  assert.equal(formatUsd("24354382", { compact: true }), "$24.35M");
  assert.equal(formatUsd("0.00068"), "$0.00068");
  assert.equal(formatUsd(null), "—");
});
