/**
 * What the approval window does with a site's request, apart from drawing it: read the pending request, answer the page that asked
 * (that document only, naming its origin), and connect or sign for the account the site was connected with. Kept out of the React
 * file so the whole path, background → approval → content script, runs in the tests.
 */
import * as wallet from "./wallet";
import { encode, decode } from "./codec";
import { ERRORS, type Pending, type TabAnswer } from "./protocol";
import { activity, declines, grantedTo, sites, trustedLookalikes } from "./store";
import { evmNetwork, registryHasChain } from "./chains";
import { addCustomNetwork, parseAddChain } from "./user-networks";
import { approvalsInPermit, approvalInTransaction, approvals } from "./approvals";

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

/**
 * The user says they know this look-alike site: turn the warning into the request it was holding. Nothing is remembered yet; the
 * site is trusted only if the user then approves (approveConnect / approveSign). Declining or closing forgets it.
 */
export async function continueLookalike(pending: Pending): Promise<Pending> {
  if (pending.kind !== "lookalike" || !pending.next) throw new Error("Nothing to continue.");
  const next: Pending = { ...pending, kind: pending.next, passedLookalikeWarning: true };
  delete next.next;
  await chrome.storage.session.set({ [`pending:${pending.id}`]: next });
  return next;
}

/** Connects the site to the open account. */
export async function approveConnect(pending: Pending) {
  const open = wallet.snapshot().public;
  if (!open || !wallet.snapshot().unlocked) throw new Error("WALLET_LOCKED");
  if (pending.passedLookalikeWarning) await trustedLookalikes.add(pending.origin);
  await sites.grant(pending.origin, open);
  await activity.add({ kind: "connect", text: "Connected a site", site: pending.origin });
  await answer(pending, { ok: true, result: { evm: open.evm, solana: open.solana } });
}

/** The network a switch request asks for, from the registry; null if it isn't one. */
export function switchTarget(pending: Pending) {
  const chainId = Number((decode(pending.params) as { chainId?: unknown } | null)?.chainId);
  return Number.isSafeInteger(chainId) ? evmNetwork(chainId) : null;
}

/** Moves the site to the network it asked for, and keeps that for the site. */
export async function approveSwitch(pending: Pending) {
  const network = switchTarget(pending);
  if (!network?.evmChainId) { await answer(pending, { ok: false, error: ERRORS.unknownChain }); return; }
  if (!(await sites.get(pending.origin))) { await answer(pending, { ok: false, error: ERRORS.unauthorized }); return; }
  await sites.setChain(pending.origin, network.evmChainId);
  await activity.add({ kind: "connect", text: `Switched the site to ${network.name}`, site: pending.origin, networkId: network.networkId });
  await answer(pending, { ok: true, result: null });
}

/** The network a site asks to add (EIP-3085), read strictly; null if the request isn't a valid one. */
export const addNetworkRequest = (pending: Pending) => parseAddChain(decode(pending.params));

/**
 * Adds the network the site asked for, after the user approved: its first endpoint must answer with the chain id the site gave
 * (checked now, in addCustomNetwork). It is kept as added by this site, never verified; a connected site is moved to it.
 */
export async function approveAddNetwork(pending: Pending) {
  const asked = addNetworkRequest(pending);
  if (!asked) { await answer(pending, { ok: false, error: ERRORS.badNetwork }); return; }
  const network = await addCustomNetwork({ name: asked.name, rpcUrl: asked.rpcUrls[0]!, chainId: asked.chainId, symbol: asked.symbol, explorerUrl: asked.explorerUrl, source: "site", origin: pending.origin, registryHas: registryHasChain });
  if (await sites.get(pending.origin)) await sites.setChain(pending.origin, asked.chainId);
  await activity.add({ kind: "connect", text: `Added a network at the site's request: ${network.name} (chain ${network.evmChainId})`, site: pending.origin, networkId: network.networkId });
  await answer(pending, { ok: true, result: null });
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
  const params = decode(pending.params) as any;
  const result = await wallet.sign(method, params, reviewed.signed);
  // An approval (a token allowance, a permit, access to a collection) is noted so the Approvals screen can show and revoke it.
  const given = method === "evm.signTransaction" ? [approvalInTransaction(Number(params?.transaction?.chainId), params?.transaction ?? {})].filter(x => !!x)
    : method === "evm.signTypedData" ? approvalsInPermit(params?.typedData) : [];
  for (const g of given) await approvals.note({ ...g!, origin: pending.origin });
  if (pending.passedLookalikeWarning) await trustedLookalikes.add(pending.origin);
  await sites.touch(pending.origin);
  await activity.add({ kind: "sign", text: reviewed.view.title, site: pending.origin });
  await answer(pending, { ok: true, result });
}
