import "./env";
import { test } from "node:test";
import { strict as assert } from "node:assert";

/**
 * Live check of MAXXING's swap fee against Relay itself: real quotes on Base with the app fee, each run through prepare() exactly as
 * the Swap screen does, and nothing signed. It checks that every guard passes with the fee on (the app fee matches the fee shown,
 * coins sent equal the amount, the approval and the gasless authorization are for exactly the amount), so Relay takes the fee out
 * of the amount swapped rather than adding it on top.
 *
 * Off by default (it calls Relay and Base's public RPCs). Run it with:  LIVE_RELAY=1 pnpm --filter @maxxing/extension exec tsx --test tests/relay-live.test.ts
 * It never runs in CI.
 */
const LIVE = process.env.LIVE_RELAY === "1" && !process.env.CI;
const skip = LIVE ? false : "live Relay check: set LIVE_RELAY=1 (never in CI)";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const OP_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
// Any address works: it's only read (quotes, allowances, gas estimates, which fall back to Relay's capped gas). Nothing is signed.
const USER = "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A";
const FEE = { bps: 85, recipient: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" };

async function setup() {
  const relay = await import("../src/lib/relay");
  const { evmNetwork } = await import("../src/lib/chains");
  const base = evmNetwork(8453)!, op = evmNetwork(10)!;
  const asset = (network: typeof base, address: string | null, symbol: string, decimals: number) => ({ network, address, symbol, decimals });
  return { relay, base, op, asset };
}

/** The app fee in the quote is the fee shown: 0.85% of what's paid in, in dollars (a cent and 2% of rounding allowed). */
function feeIsAsShown(q: { amountInUsd: number | null; maxxingFee: { bps: number; usd: number | null } | null }) {
  assert.ok(q.maxxingFee, "the quote carries MAXXING's fee");
  assert.equal(q.maxxingFee!.bps, FEE.bps);
  if (q.maxxingFee!.usd !== null && q.amountInUsd !== null) {
    const expected = q.amountInUsd * FEE.bps / 10_000;
    assert.ok(Math.abs(q.maxxingFee!.usd - expected) <= expected * 0.02 + 0.01, `fee $${q.maxxingFee!.usd} vs shown $${expected.toFixed(4)}`);
  }
}

test("(a) ETH → USDC on Base with the fee: coins sent are exactly the amount, the fee comes out of it", { skip, timeout: 60_000 }, async () => {
  const { relay, base, asset } = await setup();
  const pay = asset(base, null, "ETH", 18), amountRaw = 10n ** 16n; // 0.01 ETH
  const q = await relay.quote({ from: pay, to: asset(base, BASE_USDC, "USDC", 6), amountRaw, user: USER, recipient: USER, fee: FEE });
  feeIsAsShown(q);
  const prepared = await relay.prepare(q, USER, pay);
  const sent = prepared.steps.reduce((s, step) => s + (step.kind === "transaction" ? BigInt(step.transaction.value ?? 0n) : 0n), 0n);
  assert.equal(sent, amountRaw, "value == amount: no fee added on top");
  console.log(`(a) fee $${q.maxxingFee?.usd} on $${q.amountInUsd}; ${prepared.steps.length} step(s); value ${sent}`);
});

test("(b) USDC → WETH on Base with the fee: no coins sent, any approval for exactly the amount", { skip, timeout: 60_000 }, async () => {
  const { relay, base, asset } = await setup();
  const pay = asset(base, BASE_USDC, "USDC", 6), amountRaw = 25_000_000n; // 25 USDC
  const q = await relay.quote({ from: pay, to: asset(base, BASE_WETH, "WETH", 18), amountRaw, user: USER, recipient: USER, fee: FEE });
  feeIsAsShown(q);
  const prepared = await relay.prepare(q, USER, pay);
  for (const step of prepared.steps) {
    assert.equal(step.kind, "transaction");
    if (step.kind !== "transaction") continue;
    assert.equal(BigInt(step.transaction.value ?? 0n), 0n, "no coins sent with a token swap");
    const data = String(step.transaction.data ?? "").toLowerCase();
    if (data.startsWith("0x095ea7b3")) assert.ok(BigInt(`0x${data.slice(74, 138)}`) <= amountRaw, "approval: at most the amount");
  }
  console.log(`(b) fee $${q.maxxingFee?.usd} on $${q.amountInUsd}; ${prepared.steps.length} step(s)`);
});

test("(c) gasless USDC on Base → USDC on Optimism with the fee: the EIP-3009 authorization is for exactly the amount", { skip, timeout: 60_000 }, async () => {
  const { relay, base, op, asset } = await setup();
  const pay = asset(base, BASE_USDC, "USDC", 6), amountRaw = 25_000_000n;
  assert.ok(await relay.gaslessAvailable(pay), "USDC on Base pays the network fee from the swap");
  const q = await relay.quote({ from: pay, to: asset(op, OP_USDC, "USDC", 6), amountRaw, user: USER, recipient: USER, gasless: true, fee: FEE });
  feeIsAsShown(q);
  const prepared = await relay.prepare(q, USER, pay);
  assert.ok(prepared.gasless, "only an authorization to sign");
  const auth = prepared.steps.find(s => s.kind === "signature");
  assert.ok(auth && auth.kind === "signature");
  assert.equal(BigInt(String((auth.typedData.message as { value: unknown }).value)), amountRaw, "authorization value == amount: no fee added on top");
  console.log(`(c) fee $${q.maxxingFee?.usd} on $${q.amountInUsd}; authorization for ${amountRaw}`);
});
