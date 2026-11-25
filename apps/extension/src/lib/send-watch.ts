/**
 * After a send: asks the chain where the transaction stands until it is settled, and decides what the Send screen may say.
 * The rule that matters: "not sent" (so the user may send again) only when all of these hold —
 * - the send itself wasn't certain (no node said it took the transaction);
 * - no check ever saw it (in a block or in a node's pool);
 * - the last checks were real answers from the chain saying "unknown", not errors (an endpoint that's down tells nothing).
 * Anything else that doesn't end in a block is "unsettled": not confirmed yet, check again; never "wasn't sent".
 */
import type { SendState } from "./send";

export type WatchUpdate = "checking" | "seen" | "confirmed" | "failed";
export type WatchOutcome = "confirmed" | "failed" | "not-sent" | "unsettled" | "stopped";

export async function watchSend(opts: {
  check: () => Promise<SendState>;
  certain: boolean;
  /** Checks to make (default 75: five minutes every 4 seconds). */
  ticks?: number;
  waitMs?: number;
  /** Clean "unknown" answers in a row needed at the end to say "not sent" (default 10, the last 40 seconds). */
  settleUnknowns?: number;
  sleep?: (ms: number) => Promise<void>;
  onUpdate?: (state: WatchUpdate) => void;
  alive?: () => boolean;
}): Promise<WatchOutcome> {
  const { check, certain, ticks = 75, waitMs = 4000, settleUnknowns = 10, onUpdate = () => {}, alive = () => true } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  let seen = certain, unknownsInARow = 0;
  for (let tick = 0; tick < ticks; tick++) {
    if (!alive()) return "stopped";
    const state = await check().catch(() => "error" as const);
    if (!alive()) return "stopped";
    if (state === "confirmed" || state === "failed") { onUpdate(state); return state; }
    if (state === "seen") { seen = true; unknownsInARow = 0; }
    else if (state === "unknown") unknownsInARow++;
    else unknownsInARow = 0; // an error is no answer
    onUpdate(seen ? "seen" : "checking");
    if (tick < ticks - 1) await sleep(waitMs);
  }
  return !certain && !seen && unknownsInARow >= Math.min(settleUnknowns, ticks) ? "not-sent" : "unsettled";
}
