/**
 * JSON-RPC over a chain's public endpoints (from the chain registry). An endpoint that is down, slow or rate-limited is skipped
 * for the next one (a slow one is overtaken after a couple of seconds, not waited out); when every endpoint fails, the whole list is tried again after a short wait (twice, waiting longer each time).
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
/** How long a read waits on one endpoint before also asking the next (the first keeps running; the first answer wins). */
export const HEDGE_MS = 1500;
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
  const sending = method === "eth_sendRawTransaction" || method === "sendTransaction";
  let last: unknown = new RpcError("The network didn't answer.");
  /** One endpoint's answer: the result, or its error (`final` when it is the chain's own, which no other endpoint would change). */
  const ask = async (url: string, controller: AbortController): Promise<{ value: T } | { error: unknown; final?: boolean }> => {
    if (guard && !(await guard(url).catch(() => true))) return { error: new RpcError("An endpoint no longer serves this network.") };
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", signal: controller.signal, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const body = await response.json().catch(() => null) as { result?: T; error?: { code: number; message: string } } | null;
      if (body?.error) {
        const error = new RpcError(String(body.error.message ?? "RPC error"), body.error.code);
        return { error, final: chainError(body.error.code, error.message) }; // not final: the endpoint's own limit or gap
      }
      if (!response.ok || !body || !("result" in body)) return { error: new RpcError(`HTTP ${response.status}`) };
      return { value: body.result as T };
    } catch (error) { return { error }; } finally { clearTimeout(timer); }
  };
  /**
   * One pass over the endpoints, in order. The next is asked when the one before fails, and, for a read, also when it hasn't
   * answered within HEDGE_MS (it keeps running; whichever answers first wins and the rest are dropped). So one slow endpoint
   * costs a couple of seconds, not its whole timeout. A send is never hedged: one endpoint at a time.
   */
  const pass = () => new Promise<{ value: T } | { error: unknown; final?: boolean }>(resolve => {
    const controllers: AbortController[] = [];
    let next = 0, running = 0, settled = false, hedge: ReturnType<typeof setTimeout> | undefined;
    const finish = (answer: { value: T } | { error: unknown; final?: boolean }) => {
      if (settled) return;
      settled = true; clearTimeout(hedge);
      for (const c of controllers) c.abort();
      resolve(answer);
    };
    const launch = () => {
      if (settled || next >= order.length) return;
      const url = order[next++]!, controller = new AbortController();
      controllers.push(controller); running++;
      clearTimeout(hedge);
      if (!sending && next < order.length) hedge = setTimeout(launch, HEDGE_MS);
      void ask(url, controller).then(answer => {
        running--;
        if (settled) return;
        if ("value" in answer) { preferred.set(key, url); finish(answer); }
        else if (answer.final) finish(answer);
        else { last = answer.error; if (next < order.length) launch(); else if (!running) finish({ error: last }); }
      });
    };
    launch();
  });
  for (let round = 0; round <= RETRY_WAITS_MS.length; round++) {
    if (round > 0) await new Promise(r => setTimeout(r, RETRY_WAITS_MS[round - 1]));
    const answer = await pass();
    if ("value" in answer) return answer.value;
    if (answer.final) throw Object.assign(answer.error instanceof Error ? answer.error : new RpcError(String(answer.error)), { final: true });
    last = answer.error;
    // A sent transaction isn't retried in later rounds: an endpoint may have taken it and failed to answer.
    if (sending) break;
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
