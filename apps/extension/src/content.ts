/**
 * The content script (the extension's isolated world on each page). It only carries messages: the page's requests to the
 * background, and the answers back. It reads nothing from the page and holds nothing.
 */
import { encode, decode } from "./lib/codec";
import { PAGE_CHANNEL, isSiteMethod, type PageEvent, type PageRequest, type PageResponse, type SiteAnswer, type SiteRequest, type TabAnswer } from "./lib/protocol";

const toPage = (message: PageResponse | PageEvent) => window.postMessage(message, window.location.origin);
const answer = (id: string, body: { ok: true; result: unknown } | { ok: false; error: { message: string; code?: number } }) =>
  toPage({ channel: PAGE_CHANNEL, dir: "to-page", id, ...body } as PageResponse);

window.addEventListener("message", event => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data as PageRequest | undefined;
  if (!data || data.channel !== PAGE_CHANNEL || data.dir !== "to-wallet" || typeof data.id !== "string" || !isSiteMethod(data.method)) return;
  const request: SiteRequest = { type: "site-request", id: data.id, method: data.method, params: encode(data.params) };
  chrome.runtime.sendMessage(request).then((reply: SiteAnswer) => {
    if (!reply) return answer(data.id, { ok: false, error: { message: "The wallet didn't answer.", code: 4900 } });
    if (!reply.done) return; // the approval window will answer this tab directly
    if (reply.ok) answer(data.id, { ok: true, result: decode(reply.result) });
    else answer(data.id, { ok: false, error: reply.error });
  }, () => answer(data.id, { ok: false, error: { message: "The wallet is unavailable. Reload the page.", code: 4900 } }));
});

/** Asks the background whether this site is connected now (it answers for this tab's own origin), and tells the page. */
let last = "";
const refresh = () => chrome.runtime.sendMessage({ type: "site-status" }).then((connection: PageEvent["connection"]) => {
  const now = JSON.stringify(connection ?? null);
  if (now === last) return;
  last = now;
  toPage({ channel: PAGE_CHANNEL, dir: "to-page", event: connection ? "accountsChanged" : "disconnect", connection: connection ?? null });
}, () => {});

// Answers from the approval window, and "check again" when the wallet's account or this site's connection changed.
chrome.runtime.onMessage.addListener((message: TabAnswer | { type: "site-connection-check" }, sender) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "site-answer") {
    // An answer meant for another page (the tab moved on since it asked) is dropped, never handed to this one.
    if (message.origin !== window.location.origin) return;
    if (message.ok) answer(message.id, { ok: true, result: decode(message.result) });
    else answer(message.id, { ok: false, error: message.error });
    void refresh();
  } else if (message?.type === "site-connection-check") void refresh();
});

// On load, the page learns whether it is already connected.
void refresh();
