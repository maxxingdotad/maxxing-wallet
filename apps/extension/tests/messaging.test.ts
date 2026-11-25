import { alarmFired, alarmsCreated, chromeData, localData, pageMessages, runtimeMessage, startup, tabSends, windowsCreated } from "./env";
import { test } from "node:test";
import { strict as assert } from "node:assert";

/**
 * The whole path a site's request takes, run with the chrome mocks: content script → background → approval window → the page.
 * Checks who gets answered (the asking document only, with its origin), what the background refuses (phishing, a second request,
 * floods, oversized requests, another account), the auto-lock, and that nothing on the way carries a secret.
 */
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  if (url.endsWith("phishing/hosts.txt")) return new Response("evil.example\ndrainer.example\n");
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const PIN = "246810";
const wallet = await import("../src/lib/wallet");
const store = await import("../src/lib/store");
const approval = await import("../src/lib/approval");
const { encode } = await import("../src/lib/codec");
const { derivePlatformAccount, bytesToHex } = await import("@maxxing/wallet-core/derive");
const { default: bs58 } = await import("bs58");
await import("../src/background");
const backgroundListener = runtimeMessage.list.at(-1)!;
await import("../src/content");
const contentListener = runtimeMessage.list.at(-1)!;

const SITE = "https://app.example";
const sender = (tab: number, origin = SITE, documentId = `doc-${tab}`) => ({ id: "test", tab: { id: tab }, frameId: 0, origin, url: `${origin}/`, documentId });
const ask = (message: unknown, from: ReturnType<typeof sender>) => new Promise<any>(resolve => { backgroundListener(message, from, resolve); });
let n = 0;
const request = (method: string, params?: unknown) => ({ type: "site-request", id: `r${++n}`, method, params: encode(params) });
const pendingOf = async (tab: number) => { const id = (await chrome.storage.session.get(`tab:${tab}`))[`tab:${tab}`] as string; return (await approval.loadPending(id))!; };

test("a request goes background → approval → the page that asked, and only there", async () => {
  await wallet.create(PIN);
  const open = wallet.snapshot().public!;

  // Connect: the background opens the approval window and keeps the request for this tab.
  assert.deepEqual(await ask(request("connect"), sender(7)), { done: false });
  assert.match(windowsCreated.at(-1)!.url!, /approve\.html\?id=7%3Ar\d+$/);
  // While it waits, the same tab can't stack another window.
  assert.deepEqual((await ask(request("connect"), sender(7))).error.code, 4001);
  assert.equal(windowsCreated.length, 1);

  await approval.approveConnect(await pendingOf(7));
  const connected = tabSends.at(-1)!;
  assert.equal(connected.tabId, 7);
  assert.deepEqual(connected.options, { documentId: "doc-7" }, "addressed to the document that asked");
  assert.equal((connected.message as any).origin, SITE);

  // Sign: reviewed and signed as shown, answered to the same document.
  assert.deepEqual(await ask(request("evm.signMessage", { address: open.evm, message: "hello" }), sender(7)), { done: false });
  const pending = await pendingOf(7);
  const { reviewed, refused } = await approval.reviewSign(pending);
  assert.equal(refused, "");
  await approval.approveSign(pending, reviewed!);
  const signed = tabSends.at(-1)!;
  assert.deepEqual(signed.options, { documentId: "doc-7" });
  assert.match(String((signed.message as any).result), /^0x[0-9a-f]{130}$/);

  // The content script hands it to its page only if the page is still the one that asked.
  pageMessages.length = 0;
  contentListener(signed.message, { id: "test" });
  assert.equal(pageMessages.length, 1);
  contentListener({ ...(signed.message as object), origin: "https://elsewhere.example" }, { id: "test" });
  assert.equal(pageMessages.length, 1, "an answer for another origin is dropped");
  contentListener(signed.message, { id: "someone-else" });
  assert.equal(pageMessages.length, 1, "only the extension itself can answer");

  // A closed approval window declines, to the asking document.
  await ask(request("evm.signMessage", { address: open.evm, message: "again" }), sender(7));
  const waiting = await pendingOf(7);
  await chrome.windows.remove(waiting.windowId!);
  assert.equal((tabSends.at(-1)!.message as any).error.code, 4001);
  assert.equal((await chrome.storage.session.get("tab:7"))["tab:7"], undefined, "the tab can ask again");
});

test("the background refuses what it must: unconnected, another account, floods, oversized, frames", async () => {
  const open = wallet.snapshot().public!;
  assert.equal((await ask(request("evm.signMessage", { address: open.evm, message: "x" }), sender(8, "https://other.example"))).error.code, 4100, "not connected");
  assert.equal((await ask({ type: "site-request", id: "big", method: "evm.signMessage", params: { message: "x".repeat(300_000) } }, sender(9))).error.message, "This request is too large to show.");
  assert.equal((await ask(request("connect"), { ...sender(9), frameId: 3 })).error.code, 4200, "only the top frame");

  // A site may ask again and again while the user approves; turned down three times in a minute, it waits out the minute.
  for (let tab = 20; tab < 23; tab++) {
    assert.deepEqual(await ask(request("connect"), sender(tab, "https://busy.example")), { done: false });
    await approval.decline(await pendingOf(tab));
  }
  assert.match((await ask(request("connect"), sender(23, "https://busy.example"))).error.message, /Too many requests/);
  // And a backstop of twenty windows a minute, approved or not.
  for (let tab = 40; tab < 60; tab++) assert.deepEqual(await ask(request("connect"), sender(tab, "https://many.example")), { done: false });
  assert.match((await ask(request("connect"), sender(60, "https://many.example"))).error.message, /Too many requests/);

  // Switching account: the site connected with account 1 can't sign for account 2 (4100), and isn't told the new addresses.
  await wallet.addAccount("Second");
  assert.equal((await ask(request("evm.signMessage", { address: wallet.snapshot().public!.evm, message: "x" }), sender(7))).error.code, 4100);
  assert.equal(await new Promise(r => backgroundListener({ type: "site-status" }, sender(7), r)), null);
  await wallet.selectAccount(0);
  assert.deepEqual(await new Promise(r => backgroundListener({ type: "site-status" }, sender(7), r)), open);
});

test("phishing sites get one block screen per tab, and no addresses even if connected before", async () => {
  const before = windowsCreated.length;
  assert.equal((await ask(request("connect"), sender(30, "https://evil.example"))).error.message, "MAXXING blocked this site: it's on the phishing list.");
  assert.equal((await ask(request("connect"), sender(30, "https://evil.example"))).error.code, 4001);
  assert.equal(windowsCreated.length, before + 1, "one block screen, not one per request");
  assert.equal((await ask(request("connect"), sender(31, "https://rnaxxing.ad"))).error.code, 4001, "look-alikes too");
  await store.sites.grant("https://drainer.example", wallet.snapshot().public!);
  assert.equal(await new Promise(r => backgroundListener({ type: "site-status" }, sender(32, "https://drainer.example"), r)), null);
});

test("auto-lock: counts from the user's own input, forgets the session, stops telling sites, survives worker restarts", async () => {
  assert.equal(alarmsCreated.filter(a => a === "auto-lock").length, 1);
  assert.equal((await wallet.start()).unlocked, true, "a page opened while the user is active finds the wallet open");
  // A page opening (the approval window a site opened) doesn't count as activity.
  await chrome.storage.session.set({ lastActive: Date.now() - 20 * 60_000 });
  window.dispatchEvent(new Event("pagehide")); // this page's keys leave memory, as when the popup closes
  const snap = await wallet.start();
  assert.equal(snap.unlocked, false, "a stale session isn't reopened");
  assert.equal(Object.keys(Object.fromEntries(chromeData.session)).some(k => k.startsWith("device-session:")), false);
  assert.equal(await store.account.read(), null, "sites aren't told the addresses while locked");
  // The PIN opens it again; recent activity keeps it open; then the alarm locks it after the idle time.
  await wallet.unlock(PIN);
  for (const f of alarmFired.list) await f({ name: "auto-lock" });
  assert.notEqual(await store.account.read(), null, "still open: the user was just active");
  await chrome.storage.session.set({ lastActive: Date.now() - 16 * 60_000 });
  window.dispatchEvent(new Event("keydown")); // made by script, not the user: doesn't count
  for (const f of alarmFired.list) await f({ name: "auto-lock" });
  assert.equal(await store.account.read(), null);
  assert.equal(Object.keys(Object.fromEntries(chromeData.session)).some(k => k.startsWith("device-session:")), false);
  assert.equal(wallet.snapshot().unlocked, false, "open pages drop their keys when the lock is recorded");
  // A new browser session starts locked.
  await wallet.unlock(PIN);
  for (const f of startup.list) await f();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(await store.account.read(), null);
  // Restarting the worker (its code runs again) doesn't push the alarm back.
  await import("../src/background?again" as string);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(alarmsCreated.filter(a => a === "auto-lock").length, 1);
});

test("nothing on the way carries a secret: storage, tab and page messages, windows opened", async () => {
  await wallet.unlock(PIN);
  const phrase = await wallet.vault.revealPlatformMnemonic(PIN);
  const secrets = [0, 1].flatMap(index => { const a = derivePlatformAccount(phrase, index); return [bytesToHex(a.evm.privateKeyBytes), bytesToHex(a.solana.secretKey), bs58.encode(a.solana.secretKey)]; });
  const words = phrase.split(" ");
  secrets.push(phrase, `${words[0]} ${words[1]} ${words[2]}`, PIN);
  const everything = JSON.stringify([[...chromeData.local], [...chromeData.session], tabSends, pageMessages, windowsCreated, await store.activity.all(), await store.sites.all()]);
  for (const secret of secrets) assert.ok(!everything.includes(secret));
  const pageStorage = [...localData.values()].join("\n");
  for (const secret of secrets.slice(0, -1)) assert.ok(!pageStorage.includes(secret));
});
