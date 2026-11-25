/** JSON-RPC over the chain's public endpoints, each in turn until one answers. Chain errors are not retried elsewhere. */
export class RpcError extends Error { constructor(message: string, readonly code?: number) { super(message); } }

export async function rpc<T>(urls: readonly string[], method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
  let last: unknown = new RpcError("No public endpoint for this network.");
  for (const url of urls) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (!response.ok) { last = new RpcError(`HTTP ${response.status}`); continue; }
      const body = await response.json() as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new RpcError(body.error.message, body.error.code);
      return body.result as T;
    } catch (error) {
      if (error instanceof RpcError && error.code !== undefined) throw error;
      last = error;
    } finally { clearTimeout(timer); }
  }
  throw last instanceof Error ? last : new RpcError("The network didn't answer.");
}
