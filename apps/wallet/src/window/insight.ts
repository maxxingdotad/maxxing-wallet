/**
 * The wallet window's network reads before you approve: your balance, and a preview of what a transaction moves. They go through
 * MAXXING's read-only wallet relay. Checking sign-in messages and reading the simulation are in the wallet core
 * (@maxxing/wallet-core/sign-in and /simulation), where every MAXXING wallet shares them.
 */
import { type Hex } from "viem";
import { getChain } from "@maxxing/wallet-core/chains";
import { amountText, decodeSymbol, NATIVE_PSEUDO, netChanges, type AssetChange, type Preview, type SimCall } from "@maxxing/wallet-core/simulation";
import { API_URL } from "../registry";

export { checkSignIn, untilText, type SignInCheck } from "@maxxing/wallet-core/sign-in";
export { decodeSymbol, fundsCheck, netChanges, type AssetChange, type Preview } from "@maxxing/wallet-core/simulation";

type Fetcher = typeof fetch;
/**
 * One read-only JSON-RPC call through MAXXING's wallet relay (api.maxxing.ad), which tries the network's public endpoints
 * and then its reserve. The window's strict connect-src allows only the API, so no other site is ever contacted from here.
 * An RPC error comes back as a thrown Error ("RPC_ERROR", or "RPC_UNSUPPORTED" when no endpoint offers the method) with `rpc`.
 */
export async function rpc<T>(chainId: number, method: string, params: unknown[], fetcher: Fetcher = fetch, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${API_URL}/v1/wallet-apps/rpc/${chainId}`, {
      method: "POST", credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const body = await response.json() as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw Object.assign(new Error(body.error.code === -32601 ? "RPC_UNSUPPORTED" : "RPC_ERROR"), { rpc: body.error });
    return body.result as T;
  } finally { clearTimeout(timer); }
}

export async function nativeBalance(chainId: number, address: string, fetcher?: Fetcher): Promise<bigint> {
  return BigInt(await rpc<string>(chainId, "eth_getBalance", [address, "latest"], fetcher));
}

const hex = (value: bigint | number | undefined | null) => value === undefined || value === null ? undefined : `0x${BigInt(value).toString(16)}`;

async function tokenInfo(chainId: number, token: string, fetcher?: Fetcher): Promise<{ symbol: string; decimals: number }> {
  const [symbolHex, decimalsHex] = await Promise.all([
    rpc<string>(chainId, "eth_call", [{ to: token, data: "0x95d89b41" }, "latest"], fetcher).catch(() => "0x"),
    rpc<string>(chainId, "eth_call", [{ to: token, data: "0x313ce567" }, "latest"], fetcher).catch(() => "0x"),
  ]);
  const decimals = decimalsHex.length > 2 ? Number(BigInt(decimalsHex)) : 18;
  return { symbol: decodeSymbol(symbolHex) ?? `${token.slice(0, 6)}…${token.slice(-4)}`, decimals: decimals <= 36 ? decimals : 18 };
}

/**
 * Runs the transaction against the network's current state (eth_simulateV1, nothing is sent) and returns what it would
 * move in and out of the wallet. "unavailable" when no public endpoint for the network can simulate.
 */
export async function previewTransaction(tx: { chainId: number; to?: string | null; value?: bigint; data?: string | null; gas?: bigint }, from: string, fetcher?: Fetcher): Promise<Preview> {
  let result: { calls: SimCall[] }[];
  try {
    result = await rpc<{ calls: SimCall[] }[]>(tx.chainId, "eth_simulateV1", [{
      blockStateCalls: [{ calls: [{ from, to: tx.to ?? undefined, value: hex(tx.value ?? 0n), data: tx.data ?? undefined, gas: hex(tx.gas) }] }],
      traceTransfers: true, validation: false,
    }, "latest"], fetcher, 6000);
  } catch (error) {
    const rpcError = (error as { rpc?: { message?: string } }).rpc;
    if ((error as Error).message === "RPC_ERROR" && rpcError?.message && /revert|execution/i.test(rpcError.message)) return { kind: "fails", reason: rpcError.message };
    return { kind: "unavailable" };
  }
  const call = result?.[0]?.calls?.[0];
  if (!call) return { kind: "unavailable" };
  if (call.status !== "0x1") return { kind: "fails", reason: call.error?.message ?? "The network would reject it." };
  const totals = netChanges(call.logs ?? [], from);
  const symbol = getChain(tx.chainId)?.nativeSymbol ?? "ETH";
  const changes: AssetChange[] = [];
  for (const [token, amount] of totals) {
    const native = token === NATIVE_PSEUDO;
    const info = native ? { symbol, decimals: 18 } : await tokenInfo(tx.chainId, token, fetcher);
    changes.push({ direction: amount < 0n ? "out" : "in", amount: amountText(amount, info.decimals), symbol: info.symbol, token: native ? null : token });
  }
  // What leaves first, then what arrives.
  changes.sort((a, b) => (a.direction === b.direction ? 0 : a.direction === "out" ? -1 : 1));
  return { kind: "changes", changes };
}

export type { Hex };
