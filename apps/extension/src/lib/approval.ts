/**
 * What the approval window does with a site's request, apart from drawing it: read the pending request, answer the page that asked
 * (that document only, naming its origin), and connect or sign for the account the site was connected with. Kept out of the React
 * file so the whole path, background → approval → content script, runs in the tests.
 */
import * as wallet from "./wallet";
import { encode, decode } from "./codec";
import { ERRORS, type Pending, type TabAnswer } from "./protocol";
import { activity, declines, grantedTo, sites } from "./store";

export async function loadPending(id: string): Promise<Pending | null> {
  return ((await chrome.storage.session.get(`pending:${id}`))[`pending:${id}`] as Pending | undefined) ?? null;
}

/** Forgets a request: its record, its window's link, and the tab's "one request at a time" slot. */
export async function clearPending(pending: Pending) {
  const tabKey = `tab:${pending.tabId}`;
  const holder = (await chrome.storage.session.get(tabKey))[tabKey];
  await chrome.storage.session.remove([`pending:${pending.id}`, ...(pending.windowId !== undefined ? [`window:${pending.windowId}`] : []), ...(holder === pending.id ? [tabKey] : [])]);
}

/** Sends the answer to the page that asked, and only to it. */
export async function sendAnswer(pending: Pending, body: { ok: true; result: unknown } | { ok: false; error: { message: string; code?: number } }) {
  const message: TabAnswer = body.ok
    ? { type: "site-answer", id: pending.requestId, origin: pending.origin, ok: true, result: encode(body.result) }
    : { type: "site-answer", id: pending.requestId, origin: pending.origin, ok: false, error: body.error };
  const target = pending.documentId ? { documentId: pending.documentId } : { frameId: pending.frameId };
  await chrome.tabs.sendMessage(pending.tabId, message, target).catch(() => {});
}

export async function answer(pending: Pending, body: Parameters<typeof sendAnswer>[1]) {
  await sendAnswer(pending, body);
  await clearPending(pending);
}

export async function decline(pending: Pending) {
  await declines.note(pending.origin);
  await answer(pending, { ok: false, error: ERRORS.rejected });
}

/** Connects the site to the open account. */
export async function approveConnect(pending: Pending) {
  const open = wallet.snapshot().public;
  if (!open || !wallet.snapshot().unlocked) throw new Error("WALLET_LOCKED");
  await sites.grant(pending.origin, open);
  await activity.add({ kind: "connect", text: "Connected a site", site: pending.origin });
  await answer(pending, { ok: true, result: { evm: open.evm, solana: open.solana } });
}

/** The review of a signing request, or why it can't be signed. A site signs only for the account it was connected with. */
export async function reviewSign(pending: Pending) {
  const open = wallet.snapshot().public;
  if (!grantedTo(await sites.get(pending.origin), open)) return { refused: ERRORS.otherAccount.message, reviewed: null };
  const method = pending.method as Exclude<Pending["method"], "connect">;
  try { return { refused: "", reviewed: wallet.review(method, decode(pending.params) as any, pending.origin) }; }
  catch (e) { return { refused: e instanceof Error ? e.message : String(e), reviewed: null }; }
}

/** Signs exactly what the review showed, after checking again that the site may sign for the open account. */
export async function approveSign(pending: Pending, reviewed: { view: { title: string }; signed: unknown }) {
  if (!grantedTo(await sites.get(pending.origin), wallet.snapshot().public)) { await answer(pending, { ok: false, error: ERRORS.otherAccount }); return; }
  const method = pending.method as Exclude<Pending["method"], "connect">;
  const result = await wallet.sign(method, decode(pending.params) as any, reviewed.signed);
  await sites.touch(pending.origin);
  await activity.add({ kind: "sign", text: reviewed.view.title, site: pending.origin });
  await answer(pending, { ok: true, result });
}
