/**
 * The extension's background (an MV3 service worker). It never holds a key: it decides where a site's request goes.
 * - A site on the phishing list, or made to look like MAXXING, is stopped and shown why; it gets no addresses either.
 * - `connect` from a site connected with the open account gets the public addresses at once; otherwise the approval window asks.
 * - Every signature opens the approval window, which unlocks the wallet if needed, shows the request, and answers the page.
 *   A site signs only for the account it was connected with.
 * - One request per tab at a time; a site turned down three times in a minute waits out the minute; a size limit per request.
 * It also runs the auto-lock (and locks when the browser starts), clears the clipboard after a secret was copied, and refreshes
 * the phishing blocklist.
 */
import "./lib/lock"; // first: open wallet sessions are kept in memory-only storage
import { forgetIndexedDbDeviceSessions } from "@maxxing/wallet-core/device-session";
import { lockIfStale, lockNow } from "./lib/lock";
import { blocklist, refreshBlocklist } from "./lib/blocklist";
import { checkSite } from "./lib/phishing";
import { refreshSuffixList, suffixRules } from "./lib/psl";
import { ERRORS, LIMITS, isSiteMethod, type Pending, type SiteAnswer, type SiteRequest, type TabAnswer } from "./lib/protocol";
import { account, activity, declines, grantedTo, moveOldRecords, settings, sites, trustedLookalikes } from "./lib/store";
import { decode, encode } from "./lib/codec";
import { evmNetwork } from "./lib/chains";
import { loadUserNetworks, parseAddChain } from "./lib/user-networks";

// Session storage (open sessions, the open account, pending requests) is for the extension's own pages, never content scripts.
void chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(() => {});

const APPROVAL = { width: 380, height: 640 };
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL("")).origin;
const session = {
  get: async <T>(key: string) => (await chrome.storage.session.get(key))[key] as T | undefined,
  set: (items: Record<string, unknown>) => chrome.storage.session.set(items),
};

async function windowOpen(windowId: number | undefined) {
  if (windowId === undefined) return false;
  return chrome.windows.get(windowId).then(() => true, () => false);
}

async function openApproval(pending: Pending) {
  await session.set({ [`pending:${pending.id}`]: pending, [`tab:${pending.tabId}`]: pending.id });
  const current = await chrome.windows.getLastFocused().catch(() => null);
  const left = current?.left !== undefined && current.width ? current.left + current.width - APPROVAL.width - 16 : undefined;
  const top = current?.top !== undefined ? current.top + 64 : undefined;
  const url = chrome.runtime.getURL(`approve.html?id=${encodeURIComponent(pending.id)}`);
  // Beside the browser's top right corner when that is on screen; Chrome refuses a window mostly off screen, so then it places it.
  const win = await chrome.windows.create({ url, type: "popup", focused: true, ...APPROVAL, left, top })
    .catch(() => chrome.windows.create({ url, type: "popup", focused: true, ...APPROVAL }));
  if (win?.id !== undefined) await session.set({ [`pending:${pending.id}`]: { ...pending, windowId: win.id }, [`window:${win.id}`]: pending.id });
}

/** The request already waiting in this tab, if its window is still open. A stale one is cleared. */
async function waitingIn(tabId: number): Promise<Pending | null> {
  const id = await session.get<string>(`tab:${tabId}`);
  if (!id) return null;
  const pending = await session.get<Pending>(`pending:${id}`);
  if (pending && await windowOpen(pending.windowId)) return pending;
  await chrome.storage.session.remove([`tab:${tabId}`, `pending:${id}`]);
  return null;
}

/** A site the user keeps turning down waits a minute; and no site opens more than a backstop number of windows a minute. */
async function overLimit(origin: string, now = Date.now()) {
  const key = `rate:${origin}`;
  const recent = ((await session.get<number[]>(key)) ?? []).filter(t => now - t < 60_000);
  const declined = await declines.recent(origin, now);
  if (recent.length >= LIMITS.windowsPerMinute || declined.length >= LIMITS.declinesPerMinute) return true;
  await session.set({ [key]: [...recent, now] });
  return false;
}

async function handleSiteRequest(message: SiteRequest, sender: chrome.runtime.MessageSender): Promise<SiteAnswer> {
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
  const tabId = sender.tab?.id, frameId = sender.frameId ?? 0;
  if (!origin || origin === EXTENSION_ORIGIN || tabId === undefined || frameId !== 0 || !isSiteMethod(message.method) || typeof message.id !== "string" || message.id.length > LIMITS.idLength)
    return { done: true, ok: false, error: ERRORS.unsupported };
  if (JSON.stringify(message.params ?? null).length > LIMITS.paramsBytes) return { done: true, ok: false, error: ERRORS.tooLarge };
  const base = { id: `${tabId}:${message.id}`, requestId: message.id, method: message.method, params: message.params, origin, tabId, frameId, documentId: sender.documentId, createdAt: Date.now() };

  const waiting = await waitingIn(tabId);
  const verdict = checkSite(origin, await blocklist(), await suffixRules());
  if (verdict.kind === "scam") {
    // The site never gets past this. The block screen shows once per tab and page, a few times a minute at most, and the
    // Activity list notes it once every ten minutes, so a listed site can't flood either.
    const shownKey = `block-shown:${tabId}:${origin}`;
    if (!waiting && !(await session.get<boolean>(shownKey)) && !(await blockLimit(origin))) {
      await session.set({ [shownKey]: true });
      await activity.addUnlessRecent({ kind: "blocked", text: "Blocked a known scam site", site: origin }, 10 * 60_000);
      await openApproval({ ...base, kind: "blocked" });
    }
    return { done: true, ok: false, error: ERRORS.blocked };
  }
  if (waiting) { if (waiting.windowId !== undefined) void chrome.windows.update(waiting.windowId, { focused: true }).catch(() => {}); return { done: true, ok: false, error: ERRORS.busy }; }

  const [permission, open] = await Promise.all([sites.get(origin), account.read(), loadUserNetworks()]);
  // A network the registry lists (test networks only when they're on), or one the user added. A site that isn't connected switches
  // on its own page: nothing is at stake. A connected site's network is kept per site, and changing it asks the user.
  const switchTo = async (chainId: number, request: typeof base): Promise<SiteAnswer> => {
    const network = Number.isSafeInteger(chainId) ? evmNetwork(chainId) : null;
    if (!network) return { done: true, ok: false, error: ERRORS.unknownChain };
    if (network.testnet && !(await settings.read()).showTestnets) return { done: true, ok: false, error: ERRORS.testnetsOff };
    if (!permission || permission.chainId === chainId) return { done: true, ok: true, result: null };
    if (!permission.chainId) { await sites.setChain(origin, chainId); return { done: true, ok: true, result: null }; } // its first network: no prompt
    if (await overLimit(origin)) return { done: true, ok: false, error: ERRORS.tooMany };
    await openApproval({ ...request, method: "evm.switchChain", params: encode({ chainId }), kind: "switch" });
    return { done: false };
  };
  if (message.method === "evm.switchChain") return switchTo(Number((decode(message.params) as { chainId?: unknown } | null)?.chainId), base);
  if (message.method === "evm.addChain") {
    // wallet_addEthereumChain (EIP-3085). A network the wallet has (the registry's or one the user added): a switch with the usual
    // switch rules, and the site's endpoints are ignored (the wallet keeps its own). A new one always asks the user; the approval
    // window then checks the endpoint's chain id before keeping it.
    const asked = parseAddChain(decode(message.params));
    if (!asked) return { done: true, ok: false, error: ERRORS.badNetwork };
    if (evmNetwork(asked.chainId)) return switchTo(asked.chainId, base);
    if (await overLimit(origin)) return { done: true, ok: false, error: ERRORS.tooMany };
    await openApproval({ ...base, kind: "add-network" });
    return { done: false };
  }
  if (message.method === "connect") {
    if (grantedTo(permission, open)) { await sites.touch(origin); return { done: true, ok: true, result: { evm: open.evm, solana: open.solana } }; }
  } else {
    if (!permission) return { done: true, ok: false, error: ERRORS.unauthorized };
    // While the wallet is open, a site connected with another account is refused here; while locked, the window checks after unlock.
    if (open && !grantedTo(permission, open)) return { done: true, ok: false, error: ERRORS.otherAccount };
  }
  if (await overLimit(origin)) return { done: true, ok: false, error: ERRORS.tooMany };
  const kind = message.method === "connect" ? "connect" : "sign";
  // A name that reads as MAXXING: the window warns first, and the request goes on only if the user says they know this site.
  if (verdict.kind === "lookalike" && !(await trustedLookalikes.has(origin))) await openApproval({ ...base, kind: "lookalike", next: kind });
  else await openApproval({ ...base, kind });
  return { done: false };
}

/** At most a few block screens per site per minute (a tab that reloads, or many tabs). */
async function blockLimit(origin: string, now = Date.now()) {
  const key = `block-rate:${origin}`;
  const recent = ((await session.get<number[]>(key)) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= LIMITS.blockScreensPerMinute) return true;
  await session.set({ [key]: [...recent, now] });
  return false;
}

/** A closed approval window answers its request as declined, so the site never waits forever. */
chrome.windows.onRemoved.addListener(async windowId => {
  const id = await session.get<string>(`window:${windowId}`);
  if (!id) return;
  const pending = await session.get<Pending>(`pending:${id}`);
  const holder = pending ? await session.get<string>(`tab:${pending.tabId}`) : undefined;
  await chrome.storage.session.remove([`window:${windowId}`, `pending:${id}`, ...(pending && holder === id ? [`tab:${pending.tabId}`] : [])]);
  if (!pending || pending.kind === "blocked") return;
  await declines.note(pending.origin);
  const answer: TabAnswer = { type: "site-answer", id: pending.requestId, origin: pending.origin, ok: false, error: ERRORS.rejected };
  await chrome.tabs.sendMessage(pending.tabId, answer, pending.documentId ? { documentId: pending.documentId } : { frameId: pending.frameId }).catch(() => {});
});

/** A closed tab takes its waiting request (and that request's window) with it. */
chrome.tabs.onRemoved.addListener(async tabId => {
  const id = await session.get<string>(`tab:${tabId}`);
  if (!id) return;
  const pending = await session.get<Pending>(`pending:${id}`);
  await chrome.storage.session.remove(`tab:${tabId}`);
  if (pending?.windowId !== undefined && pending.kind !== "blocked") void chrome.windows.remove(pending.windowId).catch(() => {});
});

const fromExtensionPage = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && (sender.url ?? "").startsWith(EXTENSION_ORIGIN + "/");

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === "site-request") {
    handleSiteRequest(message as SiteRequest, sender).then(reply, (error: unknown) => reply({ done: true, ok: false, error: { message: `The wallet couldn't take this request: ${error instanceof Error ? error.message : String(error)}`, code: 4900 } }));
    return true;
  }
  if (message?.type === "site-status") {
    const origin = sender.origin ?? "";
    // A connected site learns the addresses; a listed one never does (a look-alike only got connected by passing the warning).
    Promise.all([sites.get(origin), account.read(), blocklist(), suffixRules()])
      .then(async ([permission, open, listed, rules]) => {
        if (checkSite(origin, listed, rules).kind === "scam" || !grantedTo(permission, open)) return reply(null);
        // Networks this site added earlier come back to its page, with the endpoints the site itself gave (never the user's own).
        const networks = (await loadUserNetworks()).custom.filter(c => c.source === "site" && c.origin === origin)
          .map(c => ({ chainId: c.evmChainId, name: c.name, nativeSymbol: c.nativeSymbol, rpcUrls: c.rpcUrls, ...(c.explorerUrl ? { explorerUrl: c.explorerUrl } : {}) }));
        reply({ evm: open.evm, solana: open.solana, ...(permission.chainId ? { chainId: permission.chainId } : {}), ...(networks.length ? { networks } : {}) });
      }, () => reply(null));
    return true;
  }
  if (message?.type === "clear-clipboard-later" && fromExtensionPage(sender) && typeof message.hash === "string" && /^[0-9a-f]{64}$/.test(message.hash)) {
    // Only the secret's hash is kept, to recognise it later. Alarms survive the service worker stopping; the shortest is 30 seconds.
    void chrome.storage.session.set({ "clipboard-hash": message.hash })
      .then(() => chrome.alarms.create("clipboard-clear", { delayInMinutes: Math.max(0.5, Number(message.seconds) / 60 || 1) }));
    return false;
  }
  return false;
});

// ── Clipboard: cleared from an offscreen document (Chrome), since the popup that copied may be closed by then ──────────────────
async function clearClipboard() {
  const hash = await session.get<string>("clipboard-hash");
  await chrome.storage.session.remove("clipboard-hash");
  if (!chrome.offscreen || !hash) return;
  if (!(await chrome.offscreen.hasDocument?.().catch(() => false)))
    await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.CLIPBOARD], justification: "Clear a copied recovery phrase or private key from the clipboard, if it is still there." });
  await chrome.runtime.sendMessage({ type: "offscreen-clear-clipboard", hash }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
}

// ── Alarms: the auto-lock every minute, the blocklist twice a day. Created once, never pushed back by a restart ───────────────
async function ensureAlarms() {
  if (!(await chrome.alarms.get("auto-lock"))) await chrome.alarms.create("auto-lock", { periodInMinutes: 1 });
  if (!(await chrome.alarms.get("blocklist"))) await chrome.alarms.create("blocklist", { delayInMinutes: 1, periodInMinutes: 720 });
}
void ensureAlarms();

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === "auto-lock") await lockIfStale();
  else if (alarm.name === "blocklist") { await refreshBlocklist().catch(() => {}); await refreshSuffixList().catch(() => {}); }
  else if (alarm.name === "clipboard-clear") await clearClipboard().catch(() => {});
});

// A new browser session starts locked, whatever was open before.
chrome.runtime.onStartup.addListener(() => { void lockNow(); void ensureAlarms(); });

chrome.runtime.onInstalled.addListener(() => {
  void moveOldRecords();
  // The first version kept open sessions in IndexedDB; they are gone now, so the wallet asks for the PIN once.
  void forgetIndexedDbDeviceSessions().catch(() => {});
  void ensureAlarms();
  // Side panel: the toolbar button opens the popup; the side panel is offered from inside it.
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
});
