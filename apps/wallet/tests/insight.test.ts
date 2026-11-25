import { test } from "node:test";
import assert from "node:assert/strict";
import { previewTransaction } from "../src/window/insight";

// Sign-in checks and reading the simulation are tested in packages/wallet-core; this is the window's own network read.
const ME = "0x1111111111111111111111111111111111111111";

test("a preview comes from simulating through the wallet relay, and says so when it can't", async () => {
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  const token = "0x5dab2f3adea610c35ab1c330c84c6fd13c3df92e";
  const symbol = "0x" + "20".padStart(64, "0") + "3".padStart(64, "0") + "4d41580000000000000000000000000000000000000000000000000000000000";
  const answer = (method: string, params: any[]) => {
    if (method === "eth_simulateV1") return { result: [{ calls: [{ status: "0x1", logs: [
      { address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", topics: [TRANSFER, pad(ME), pad(token)], data: "0x016345785d8a0000" },
      { address: token, topics: [TRANSFER, pad(token), pad(ME)], data: "0x" + (1240n * 10n ** 18n).toString(16) },
    ] }] }] };
    if (method === "eth_call" && params[0].data === "0x95d89b41") return { result: symbol };
    if (method === "eth_call" && params[0].data === "0x313ce567") return { result: "0x12" };
    return { error: { code: -32601, message: "method not found" } };
  };
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.match(url, /\/v1\/wallet-apps\/rpc\/8453$/, "reads go to MAXXING's relay, nowhere else");
    const { method, params } = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...answer(method, params) }), { status: 200 });
  }) as typeof fetch;
  const preview = await previewTransaction({ chainId: 8453, to: token, value: 10n ** 17n, data: "0x" }, ME, fetcher);
  assert.deepEqual(preview, { kind: "changes", changes: [
    { direction: "out", amount: "0.1", symbol: "ETH", token: null },
    { direction: "in", amount: "1,240", symbol: "MAX", token },
  ] });
  const unsupported = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "the method eth_simulateV1 does not exist/is not available" } }))) as typeof fetch;
  assert.deepEqual(await previewTransaction({ chainId: 8453, to: token }, ME, unsupported), { kind: "unavailable" });
  const reverted = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ calls: [{ status: "0x0", error: { message: "execution reverted: TOO_LITTLE_RECEIVED" } }] }] }))) as typeof fetch;
  assert.equal((await previewTransaction({ chainId: 8453, to: token }, ME, reverted)).kind, "fails");
});
