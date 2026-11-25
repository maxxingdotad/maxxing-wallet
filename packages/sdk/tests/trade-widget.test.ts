import test from "node:test";
import assert from "node:assert/strict";
import { amountText, reasonText, sparkline } from "../src/trade-widget";
import { createMaxxingData, MaxxingDataError } from "../src/data";

test("token amounts read short", () => {
  assert.equal(amountText("1590774811277326759900173", 18), "1.59M");
  assert.equal(amountText(5_000_000n, 6), "5");
  assert.equal(amountText(1_234_500n, 6), "1.2345");
  assert.equal(amountText(1234n, 6), "0.00123");
  assert.equal(amountText(0n, 18), "0");
});

test("the sparkline fills its box and knows its direction", () => {
  const rising = sparkline([1, 2, 3], 300, 60)!;
  assert.ok(rising.up);
  assert.match(rising.line, /^M0\.0 58\.0 L150\.0 30\.0 L300\.0 2\.0$/);
  assert.ok(rising.area.endsWith("L300 60 L0 60 Z"));
  assert.equal(sparkline([5, 4], 100, 20)!.up, false);
  assert.equal(sparkline([1], 100, 20), null);
  assert.ok(sparkline([2, 2, 2], 100, 20), "a flat line still draws");
});

test("blocking reasons read as plain words", () => {
  assert.equal(reasonText("INSUFFICIENT_QUOTE_BALANCE", { pay: "USDC", chain: "Base" }), "Not enough USDC on Base.");
  assert.equal(reasonText("BELOW_MIN_BUY", { minBuyUsd: 2 }), "The smallest buy is $2.00.");
  assert.equal(reasonText("SELL_AMOUNT_EXCEEDS_POSITION", { token: "MAX" }), "You don't hold that much MAX.");
  assert.match(reasonText("TRADE_REFUSED:LaunchGuardMaxBuy", {}), /refused/);
  assert.match(reasonText("SOMETHING_NEW", {}), /went wrong/);
});

test("a trade quote is a POST with the app key, and keeps the minimum buy from the error", async () => {
  const seen: { method?: string; body?: string; key?: string; url: string }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method, body: String(init.body ?? ""), key: (init.headers as Record<string, string>)["x-maxxing-app"] });
    const body = JSON.parse(String(init.body));
    return body.amountUsd < 1
      ? new Response(JSON.stringify({ error: "BELOW_MIN_BUY", minBuyUsd: 1 }), { status: 409 })
      : new Response(JSON.stringify({ mode: "wallet", side: "BUY", token: body.token, blockingReason: null, transactions: [], tradeUrl: "https://maxxing.ad/t/base/0x1" }));
  }) as unknown as typeof fetch;
  const data = createMaxxingData({ appId: "app_1", fetch: fetcher, baseUrl: "https://api.test" });
  const quote = await data.tradeQuote({ token: { chainId: "eip155:8453", address: "0x1111111111111111111111111111111111111111" }, side: "BUY", wallet: "0x2222222222222222222222222222222222222222", amountUsd: 10 });
  assert.equal(quote.token, "eip155:8453:0x1111111111111111111111111111111111111111");
  assert.deepEqual([seen[0]!.url, seen[0]!.method, seen[0]!.key], ["https://api.test/v1/public/trade/quote", "POST", "app_1"]);
  await assert.rejects(data.tradeQuote({ token: "eip155:8453:0x1111111111111111111111111111111111111111", side: "BUY", wallet: "0x2222222222222222222222222222222222222222", amountUsd: 0.5 }),
    (error: MaxxingDataError) => error.code === "BELOW_MIN_BUY" && error.minBuyUsd === 1);
});
