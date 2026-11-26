/**
 * JSON-RPC over a chain's public endpoints (from the chain registry). An endpoint that is down, slow or rate-limited is skipped
 * for the next one; when every endpoint fails, the whole list is tried again after a short wait (twice, waiting longer each time).
 * The endpoint that answered last is tried first next time. An error from the chain itself (a reverted call, a bad transaction)
 * is final: another endpoint would give the same answer, and a transaction must not be sent twice.
 */
export class RpcError extends Error { constructor(message: string, readonly code?: number) { super(message); } }

/**
 * Whether an error came from the chain (final: a revert, a nonce or funds problem, a rejected transaction) rather than from the
 * endpoint (rate limits, a method it doesn't serve, its own outage), which another endpoint can answer instead.
 */
export function chainError(code: number | undefined, message: string) {
  if (code === 3) return true; // execution reverted
  return /revert|nonce|insufficient funds|underpriced|already known|replacement|invalid (transaction|sender|signature)|intrinsic gas|exceeds block gas|blockhash not found|custom program error/i.test(message);
}

/** Waits between rounds over the endpoints: none before the first, then these. Tests set them to zero. */
export const RETRY_WAITS_MS = [400, 1500];
const preferred = new Map<string, string>();
/**
 * A check an endpoint must pass before it is used (user-networks.ts: a user's own RPC must still serve its network's chain id the
 * first time it's used in a session). An endpoint that fails it is skipped, like one that is down.
 */
type EndpointGuard = (url: string) => Promise<boolean>;
let guard: EndpointGuard | null = null;
export const setEndpointGuard = (next: EndpointGuard | null) => { guard = next; };

export async function rpc<T>(urls: readonly string[], method: string, params: unknown[] = [], timeoutMs = 10_000): Promise<T> {
  if (!urls.length) throw new RpcError("No public endpoint for this network.");
  const key = urls.join(" ");
  const first = preferred.get(key);
  const order = first && urls.includes(first) ? [first, ...urls.filter(u => u !== first)] : [...urls];
  let last: unknown = new RpcError("The network didn't answer.");
  for (let round = 0; round <= RETRY_WAITS_MS.length; round++) {
    if (round > 0) await new Promise(r => setTimeout(r, RETRY_WAITS_MS[round - 1]));
    for (const url of order) {
      if (guard && !(await guard(url).catch(() => true))) { last = new RpcError("An endpoint no longer serves this network."); continue; }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const body = await response.json().catch(() => null) as { result?: T; error?: { code: number; message: string } } | null;
        if (body?.error) {
          const error = new RpcError(String(body.error.message ?? "RPC error"), body.error.code);
          if (chainError(body.error.code, error.message)) throw Object.assign(error, { final: true });
          last = error; continue; // the endpoint's own limit or gap: the next one may answer
        }
        if (!response.ok || !body || !("result" in body)) { last = new RpcError(`HTTP ${response.status}`); continue; }
        preferred.set(key, url);
        return body.result as T;
      } catch (error) {
        if ((error as { final?: boolean }).final) throw error;
        last = error;
      } finally { clearTimeout(timer); }
    }
    // A sent transaction isn't retried in later rounds: an endpoint may have taken it and failed to answer.
    if (method === "eth_sendRawTransaction" || method === "sendTransaction") break;
  }
  throw last instanceof Error ? last : new RpcError("The network didn't answer.");
}

/** Answers that mean the network already has this exact transaction. */
const ALREADY_HAVE = /already known|already imported|known transaction|already processed|alreadyprocessed|transaction already exists/i;
/**
 * Answers about the nonce or a replacement. Once an earlier endpoint may have taken the transaction, any of them may simply be
 * this same transaction seen again (its nonce now used, or it sitting in the pool), so the answer is "not confirmed yet", never
 * a failure: the caller then waits and asks the chain. Before any possible take they are refusals (another transaction holds the
 * nonce).
 */
const MAYBE_TAKEN = /nonce|replacement|underpriced|already been processed/i;
/** Statuses where the server may have passed the transaction on before failing: 5xx, request timeout (408), client closed (499). */
const mayHaveTaken = (status: number) => status >= 500 || status === 408 || status === 499;

/**
 * Sends a signed transaction and returns its id (EVM: the hash, keccak256 of the signed bytes; Solana: its first signature),
 * computed by the caller from the signed bytes, so it is known whatever the endpoints answer.
 * - Only an endpoint that times out, drops the connection or answers 5xx, 408 or 499 may still have taken the transaction. One
 *   that answers another 4xx (400, 401, 403, 429) or a page that isn't JSON refused it before taking it. After a possible take, a
 *   later endpoint's answer about the nonce, a replacement or an underpriced fee means "not confirmed yet": the id is returned,
 *   not an error, and the caller asks the chain. If no endpoint answered at all after one may have taken it, the same.
 * - "already known" from any endpoint means the network has it.
 * - Any other refusal from the chain (bad signature, insufficient funds) is final, and nothing was sent.
 * The transaction is never signed or built again here: a retry can't make a second deposit.
 */
export async function sendSigned(urls: readonly string[], method: "eth_sendRawTransaction" | "sendTransaction", params: unknown[], id: string, timeoutMs = 15_000): Promise<{ id: string; certain: boolean }> {
  if (!urls.length) throw new RpcError("No public endpoint for this network.");
  let maybeTaken = false, last: unknown = new RpcError("The network didn't answer.");
  for (const url of urls) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const body = await response.json().catch(() => null) as { result?: string; error?: { code: number; message: string } } | null;
      if (body?.error) {
        const message = String(body.error.message ?? "");
        if (ALREADY_HAVE.test(message)) return { id, certain: true };
        if (maybeTaken && MAYBE_TAKEN.test(message)) return { id, certain: false };
        if (chainError(body.error.code, message)) throw Object.assign(new RpcError(message, body.error.code), { final: true });
        if (mayHaveTaken(response.status)) maybeTaken = true; // the server failed while handling it
        last = new RpcError(message, body.error.code); continue; // the endpoint's own error: the next may answer
      }
      if (body && typeof body.result === "string") return { id: body.result, certain: true };
      // 5xx, 408, 499: the server failed or timed out, perhaps after passing it on. Other 4xx or a page that isn't JSON: refused.
      if (mayHaveTaken(response.status)) maybeTaken = true;
      last = new RpcError(`HTTP ${response.status}`);
    } catch (error) {
      if ((error as { final?: boolean }).final) throw error;
      maybeTaken = true; last = error; // timed out or dropped: it may have been taken
    } finally { clearTimeout(timer); }
  }
  if (maybeTaken) return { id, certain: false };
  throw last instanceof Error ? last : new RpcError("The network didn't answer.");
}
