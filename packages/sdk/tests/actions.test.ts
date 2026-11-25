import test from "node:test";
import assert from "node:assert/strict";
import { decodeSymbol, formatUnits, parseUnits, readBalance, readReceipt } from "../src/actions";

const network = { chainId: 8453, name: "Base", nativeSymbol: "ETH", rpcUrls: ["https://rpc.test"] };
const holder = "0x1111111111111111111111111111111111111111";
const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function rpc(answer: (method: string, params: unknown[]) => unknown) {
  const calls: string[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
    calls.push(method === "eth_call" ? `eth_call:${(params[0] as { data: string }).data.slice(0, 10)}` : method);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: answer(method, params) }));
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const abiString = (text: string) => {
  const hex = Buffer.from(text).toString("hex");
  return `0x${(32).toString(16).padStart(64, "0")}${text.length.toString(16).padStart(64, "0")}${hex.padEnd(64, "0")}`;
};

test("formatUnits and parseUnits are exact and round-trip", () => {
  assert.equal(formatUnits(1_234_500_000_000_000_000n), "1.2345");
  assert.equal(formatUnits(0n), "0");
  assert.equal(formatUnits(1n, 18), "0");
  assert.equal(formatUnits(1n, 18, 18), "0.000000000000000001");
  assert.equal(formatUnits(-1_500_000n, 6), "-1.5");
  assert.equal(formatUnits(42n, 0), "42");
  assert.equal(parseUnits("1.5", 6), 1_500_000n);
  assert.equal(parseUnits(".25"), 250_000_000_000_000_000n);
  assert.equal(parseUnits("7"), 7_000_000_000_000_000_000n);
  assert.equal(parseUnits("1.50", 1), 15n);
  assert.throws(() => parseUnits("1.0000001", 6), /TOO_MANY_DECIMALS/);
  assert.throws(() => parseUnits("1e18"), /INVALID_AMOUNT/);
  assert.throws(() => parseUnits(""), /INVALID_AMOUNT/);
});

test("symbols decode from ABI strings and from bytes32", () => {
  assert.equal(decodeSymbol(abiString("USDC")), "USDC");
  assert.equal(decodeSymbol(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`), "MKR");
  assert.equal(decodeSymbol("0x"), null);
});

test("native balance uses the chain's coin; ERC-20 reads balance, decimals and symbol", async () => {
  const native = rpc(() => "0xde0b6b3a7640000");
  const eth = await readBalance(network, holder, null, native.fetcher);
  assert.deepEqual([eth.value, eth.formatted, eth.symbol, eth.decimals], [10n ** 18n, "1", "ETH", 18]);

  const erc20 = rpc((_m, params) => {
    const data = (params[0] as { data: string }).data;
    if (data.startsWith("0x70a08231")) { assert.ok(data.endsWith(holder.slice(2))); return `0x${(2_500_000n).toString(16).padStart(64, "0")}`; }
    if (data === "0x313ce567") return `0x${"6".padStart(64, "0")}`;
    return abiString("USDC");
  });
  const usdc = await readBalance(network, holder, token, erc20.fetcher);
  assert.deepEqual([usdc.value, usdc.formatted, usdc.symbol, usdc.decimals, usdc.token], [2_500_000n, "2.5", "USDC", 6, token]);
  await assert.rejects(readBalance(network, "nope", null, native.fetcher));
});

test("receipts: null while pending, typed once mined", async () => {
  const hash = `0x${"ab".repeat(32)}`;
  assert.equal(await readReceipt(network, hash, rpc(() => null).fetcher), null);
  const mined = await readReceipt(network, hash, rpc(() => ({ status: "0x1", blockNumber: "0x10", gasUsed: "0x5208", from: holder, to: token, contractAddress: null })).fetcher);
  assert.deepEqual([mined?.status, mined?.blockNumber, mined?.gasUsed], ["success", 16n, 21000n]);
  const reverted = await readReceipt(network, hash, rpc(() => ({ status: "0x0", blockNumber: "0x10", gasUsed: "0x1", from: holder })).fetcher);
  assert.equal(reverted?.status, "reverted");
  await assert.rejects(readReceipt(network, "0x12", rpc(() => null).fetcher));
});
