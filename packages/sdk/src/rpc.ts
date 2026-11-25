import { ERROR_CODES, ProviderRpcError } from "./protocol";

/** JSON-RPC over HTTP with fallback: each endpoint in turn until one answers. Errors from the chain itself are not retried. */
export async function rpcCall<T>(urls: readonly string[], method: string, params: unknown[] = [], fetcher: typeof fetch = fetch): Promise<T> {
  if (!urls.length) throw new ProviderRpcError(ERROR_CODES.chainDisconnected, "No RPC endpoint for this network.");
  let lastError: unknown;
  for (const url of urls) {
    try {
      const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!response.ok) { lastError = new Error(`RPC_HTTP_${response.status}`); continue; }
      const body = await response.json() as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (body.error) throw new ProviderRpcError(body.error.code, body.error.message, body.error.data);
      return body.result as T;
    } catch (error) {
      if (error instanceof ProviderRpcError) throw error;
      lastError = error;
    }
  }
  throw new ProviderRpcError(ERROR_CODES.chainDisconnected, lastError instanceof Error ? lastError.message : "RPC unavailable");
}

export const toQuantity = (value: bigint | number) => `0x${BigInt(value).toString(16)}`;
export function quantity(value: unknown, field: string): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new ProviderRpcError(ERROR_CODES.invalidParams, `Invalid ${field}`);
}

/** Read-only methods passed straight to the network. Anything that signs or sends goes through the wallet window. */
export const READ_METHODS = new Set([
  "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice", "eth_getBalance", "eth_getBlockByHash", "eth_getBlockByNumber",
  "eth_getBlockTransactionCountByHash", "eth_getBlockTransactionCountByNumber", "eth_getCode", "eth_getLogs", "eth_getProof", "eth_getStorageAt",
  "eth_getTransactionByBlockHashAndIndex", "eth_getTransactionByBlockNumberAndIndex", "eth_getTransactionByHash", "eth_getTransactionCount",
  "eth_getTransactionReceipt", "eth_maxPriorityFeePerGas", "eth_syncing", "eth_sendRawTransaction", "web3_clientVersion",
]);
