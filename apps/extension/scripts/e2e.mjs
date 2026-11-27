#!/usr/bin/env node
/**
 * End-to-end: the built extension (dist/chrome) in a real Chrome, driven over the DevTools protocol the way a person would use it.
 * Onboards a new wallet (password, recovery phrase behind hold-to-reveal, two-word check), adds an account, then a local test site
 * connects over EVM (EIP-6963) and Solana (Wallet Standard) and asks for signatures: a message and a Base Sepolia transaction, a
 * Solana message and a Solana transaction. Every signature is verified here. Screenshots of each screen go to the folder given.
 *
 *   node scripts/e2e.mjs [screenshots folder]
 *
 * Chrome 137+ loads unpacked extensions only through the DevTools protocol (Extensions.loadUnpacked over a debugging pipe), so
 * that is what this uses. Set CHROME to the browser's path if it isn't the default.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverMessageAddress, recoverTransactionAddress } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The built extension, copied with one change: clipboardRead, which the real one asks for (optional) the first time a secret is
// copied, is granted up front, because a headless browser can't click the permission prompt. Nothing else differs.
const dist = mkdtempSync(join(tmpdir(), "maxxing-e2e-ext-"));
cpSync(resolve(here, "dist/chrome"), dist, { recursive: true });
{
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  manifest.permissions = [...manifest.permissions, ...manifest.optional_permissions];
  delete manifest.optional_permissions;
  writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));
}
const shots = resolve(process.argv[2] ?? join(tmpdir(), "maxxing-extension-e2e"));
mkdirSync(shots, { recursive: true });
const CHROME = process.env.CHROME ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const PORT = 8086, PASSWORD = "Orbit-Hat-2046"; // letters and digits: the one password isn't limited to a PIN
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
/** A check that can't run here (named, with why); counted apart, never as a pass. */
const skip = (name, why) => { results.push({ name, ok: true, skipped: true }); console.log(`SKIP  ${name}  (${why})`); };
/** In CI (the public repo's workflow) the run must not depend on MAXXING's production API; locally it checks it live. */
const IN_CI = !!process.env.CI;

// ── The test site ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const dapp = readFileSync(resolve(here, "tests/e2e/dapp.html"));
// The test site, and (POST) a tiny JSON-RPC endpoint for the custom-RPC steps: /rpc-base answers as Base, /rpc-local as chain 31337.
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url?.startsWith("/rpc-")) {
    let text = ""; req.on("data", chunk => { text += chunk; }).on("end", () => {
      const { id, method } = JSON.parse(text || "{}");
      const result = method === "eth_chainId" ? (req.url === "/rpc-base" ? "0x2105" : "0x7a69") : method === "eth_blockNumber" ? "0x2a" : null;
      res.setHeader("content-type", "application/json"); res.setHeader("access-control-allow-origin", "*");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
    return;
  }
  if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" }); res.end(); return; }
  res.setHeader("content-type", "text/html"); res.end(dapp);
}).listen(PORT, "127.0.0.1");

// ── Chrome over a DevTools pipe ───────────────────────────────────────────────────────────────────────────────────────────
const profile = mkdtempSync(join(tmpdir(), "maxxing-e2e-profile-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-features=DialMediaRouteProvider", "--window-size=1280,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4];
let nextId = 0, buffer = "";
const waiting = new Map();
const listeners = [];
fromChrome.on("data", chunk => {
  buffer += chunk.toString();
  let at;
  while ((at = buffer.indexOf("\0")) >= 0) {
    const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
    if (message.id !== undefined && waiting.has(message.id)) { const w = waiting.get(message.id); waiting.delete(message.id); message.error ? w.reject(new Error(`${message.error.message}`)) : w.resolve(message.result); }
    else for (const l of listeners) l(message);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++nextId; waiting.set(id, { resolve, reject }); toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0"); });

async function attach(targetId, size) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId);
  // A page's uncaught errors and console errors are printed, so a failing step shows its cause.
  listeners.push(message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === "Runtime.exceptionThrown") console.log(`PAGE ERROR ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`.slice(0, 600));
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") console.log(`PAGE CONSOLE ${message.params.args.map(a => a.value ?? a.description ?? "").join(" ")}`.slice(0, 600));
  });
  if (size) await send("Emulation.setDeviceMetricsOverride", { width: size[0], height: size[1], deviceScaleFactor: 2, mobile: false }, sessionId);
  const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const waitFor = async (expression, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { try { const v = await evaluate(expression); if (v) return v; } catch { /* page still loading */ } await sleep(200); }
    // What the page shows when a step doesn't come, for whoever reads the failure.
    const text = await evaluate(`document.body.innerText.slice(0, 600)`).catch(() => "(page unreadable)");
    await send("Page.captureScreenshot", { format: "png" }, sessionId).then(({ data }) => writeFileSync(join(shots, `failed-${Date.now()}.png`), Buffer.from(data, "base64"))).catch(() => {});
    throw new Error(`Timed out waiting for: ${expression}\n--- page shows ---\n${text}`);
  };
  // Past the approve buttons' arming delay (750 ms), so screenshots show them as the user can use them.
  // The tab is brought to the front first (Chrome holds back frames in a background tab, and a capture can wait for one forever);
  // a capture that fails or takes over 15 s is tried again, and one that still fails is noted, never failing the run.
  const shot = async (name) => {
    await sleep(1000);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await send("Target.activateTarget", { targetId }).catch(() => {});
        const { data } = await Promise.race([send("Page.captureScreenshot", { format: "png" }, sessionId), sleep(15_000).then(() => { throw new Error("no frame within 15 s"); })]);
        writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64"));
        return;
      }
      catch (error) { if (attempt === 3) console.log(`NOTE  screenshot ${name} not captured: ${error.message}`); else await sleep(700); }
    }
  };
  const click = (text) => evaluate(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!b) return false; b.click(); return true; })()`);
  const clickWhenReady = async (text, timeout) => { await waitFor(`[...document.querySelectorAll("button")].some(b => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled)`, timeout); await click(text); };
  // Hold to confirm: presses the "Hold to <label>" button once it's enabled, keeps it down past the charge, then lets go.
  const holdWhenReady = async (label, timeout) => {
    const pick = `[...document.querySelectorAll('[data-testid="hold-to-confirm"]')].find(b => b.textContent.trim().toLowerCase() === ${JSON.stringify(`hold to ${label}`.toLowerCase())} && !b.disabled)`;
    await waitFor(`!!${pick}`, timeout);
    await evaluate(`${pick}.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }))`);
    await sleep(1400);
    await evaluate(`window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`).catch(() => {}); // the window may have closed already
  };
  // The password: typed (through Chrome's input) into every field of the form on screen, then Enter submits it.
  const typePassword = async (password) => {
    await waitFor(`document.querySelectorAll(".pw-form .pw-input:not(:disabled)").length > 0`);
    const fields = await evaluate(`document.querySelectorAll(".pw-form .pw-input").length`);
    for (let i = 0; i < fields; i++) {
      await evaluate(`document.querySelectorAll(".pw-form .pw-input")[${i}].focus()`);
      await send("Input.insertText", { text: password }, sessionId);
    }
    await waitFor(`!document.querySelector(".pw-form button[type=submit]").disabled`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" }, sessionId);
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }, sessionId);
  };
  const setInput = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  return { sessionId, evaluate, waitFor, shot, click, clickWhenReady, holdWhenReady, typePassword, setInput };
}

/**
 * Store screenshots only (STORE_DEMO=1, used by scripts/store-shots.mjs): the MAXXING Data API's balance answer for this run's
 * freshly made test wallet is replaced with made-up sample balances on four networks, so the listing shows a wallet in use rather
 * than $0.00. Nothing else changes: every screen is the real extension. These are sample numbers, not anyone's wallet; a normal
 * test run never does this.
 */
const STORE_DEMO = process.env.STORE_DEMO === "1";
const DEMO = {
  evm: [
    ["eip155:1", "0x0000000000000000000000000000000000000000", true, "ETH", "Ether", "420000000000000000", 18, "1302.00"],
    ["eip155:8453", "0x0000000000000000000000000000000000000000", true, "ETH", "Ether", "180000000000000000", 18, "558.00"],
    ["eip155:8453", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", false, "USDC", "USD Coin", "1250000000", 6, "1250.00"],
    ["eip155:42161", "0x0000000000000000000000000000000000000000", true, "ETH", "Ether", "50000000000000000", 18, "155.00"],
    ["eip155:42161", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", false, "USDC", "USD Coin", "340500000", 6, "340.50"],
  ],
  solana: [
    ["solana:mainnet", "So11111111111111111111111111111111111111112", true, "SOL", "Solana", "6800000000", 9, "1054.00"],
    ["solana:mainnet", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", false, "USDC", "USD Coin", "210000000", 6, "210.00"],
  ],
};
/**
 * Store screenshots only: Base's public endpoints answer a send's reads (nonce, gas, fees) with ordinary values, so the Send review
 * screen can be shown for the sample balance (which isn't on chain). Nothing is signed or sent in a store run.
 */
const DEMO_RPC = { eth_chainId: "0x2105", eth_getTransactionCount: "0x5", eth_estimateGas: "0xfde8", eth_getBlockByNumber: { baseFeePerGas: "0x989680" }, eth_maxPriorityFeePerGas: "0xf4240", eth_gasPrice: "0x1312d00", eth_blockNumber: "0x1" };
const BASE_RPCS = ["https://mainnet.base.org/*", "https://base-rpc.publicnode.com/*", "https://public.1rpc.io/base*", "https://base.drpc.org/*"];
async function demoBalances(sessionId) {
  await send("Fetch.enable", { patterns: [{ urlPattern: "https://api.maxxing.ad/v1/public/wallets/*/balances*" }, { urlPattern: "https://api.maxxing.ad/v1/config*" }, ...BASE_RPCS.map(urlPattern => ({ urlPattern, requestStage: "Request" }))] }, sessionId);
  listeners.push(message => {
    if (message.method !== "Fetch.requestPaused" || message.sessionId !== sessionId) return;
    // The swap fee as admin would set it (0.85% to a sample address), for the swap review screenshot; Relay's quote is real.
    if (message.params.request.url.startsWith("https://api.maxxing.ad/v1/config")) {
      const values = { "extension.swapFee.enabled": true, "extension.swapFee.percent": 0.85, "extension.swapFee.recipient": "0x9999999999999999999999999999999999999999" };
      void send("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }], body: Buffer.from(JSON.stringify({ values })).toString("base64") }, sessionId);
      return;
    }
    if (!message.params.request.url.startsWith("https://api.maxxing.ad/")) {
      if (message.params.request.method !== "POST") { void send("Fetch.continueRequest", { requestId: message.params.requestId }, sessionId); return; }
      const body = JSON.parse(message.params.request.postData ?? "{}");
      const answer = (one) => ({ jsonrpc: "2.0", id: one.id, result: DEMO_RPC[one.method] ?? null });
      const reply = Array.isArray(body) ? body.map(answer) : answer(body);
      void send("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }], body: Buffer.from(JSON.stringify(reply)).toString("base64") }, sessionId);
      return;
    }
    const address = decodeURIComponent(message.params.request.url.split("/wallets/")[1].split("/")[0]);
    const rows = address.startsWith("0x") ? DEMO.evm : DEMO.solana;
    const items = rows.map(([chainId, token, native, symbol, name, balanceRaw, decimals, valueUsd]) => ({ chainId, address: token, native, symbol, name, imageUrl: null, balanceRaw, decimals, valueUsd }));
    void send("Fetch.fulfillRequest", { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }, { name: "access-control-allow-origin", value: "*" }], body: Buffer.from(JSON.stringify({ items })).toString("base64") }, sessionId);
  });
}

/** The approval window the extension opens for the next site request. */
async function nextApproval(seen) {
  for (let i = 0; i < 100; i++) {
    const { targetInfos } = await send("Target.getTargets");
    const target = targetInfos.find(t => t.url.includes("/approve.html") && !seen.has(t.targetId));
    if (target) { seen.add(target.targetId); return attach(target.targetId, [380, 640]); }
    await sleep(200);
  }
  const { targetInfos } = await send("Target.getTargets");
  throw new Error(`No approval window opened. Open: ${targetInfos.map(t => `${t.type} ${t.url}`).join(" | ")}`);
}

try {
  await send("Target.setDiscoverTargets", { discover: true });
  const { id: extensionId } = await send("Extensions.loadUnpacked", { path: dist });
  check("extension loads unpacked in Chrome", Boolean(extensionId), extensionId);
  const base = `chrome-extension://${extensionId}`;

  // ── Onboarding ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const { targetId: popupTarget } = await send("Target.createTarget", { url: `${base}/popup.html` });
  const popup = await attach(popupTarget, [360, 600]);
  if (STORE_DEMO) await demoBalances(popup.sessionId);
  await popup.waitFor(`document.body.innerText.includes("Create a new wallet")`);
  await sleep(1800); // let the welcome animation settle
  await popup.shot("01-welcome");
  await popup.click("Create a new wallet");
  await popup.waitFor(`document.body.innerText.includes("Create your password")`);
  await popup.shot("02-create-pin");
  // Too easy a password is refused as you type, with the reason; the button stays off.
  await popup.waitFor(`!!document.querySelector('[aria-label="New password"]')`);
  await popup.evaluate(`document.querySelector('[aria-label="New password"]').focus()`);
  await send("Input.insertText", { text: "password" }, popup.sessionId);
  const weakShown = await popup.evaluate(`document.getElementById("pw-rule").textContent`);
  check("an easy password is refused as you type, with the reason", /most used/.test(weakShown) && await popup.evaluate(`document.querySelector(".pw-form button[type=submit]").disabled`), weakShown);
  await popup.evaluate(`(() => { const el = document.querySelector('[aria-label="New password"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ""); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await popup.shot("02b-create-password");
  await popup.typePassword(PASSWORD);
  // The new wallet is shown straight away: its addresses decode on the card, then the words and buttons come in.
  await popup.waitFor(`!!document.querySelector('[data-testid="wallet-reveal"]')`, 60000);
  await sleep(1400);
  const revealed = await popup.evaluate(`(() => { const r = document.querySelector('[data-testid="wallet-reveal"]'); return { text: r.innerText, rows: [...r.querySelectorAll(".reveal-row b")].map(b => b.textContent) }; })()`);
  check("the new wallet is shown: its EVM and Solana addresses decode on the card",revealed.text.includes("Your wallet is ready") && /^0x[0-9a-fA-F]{6}…[0-9a-fA-F]{6}$/.test(revealed.rows[0] ?? "") && /^[1-9A-HJ-NP-Za-km-z]{8}…[1-9A-HJ-NP-Za-km-z]{6}$/.test(revealed.rows[1] ?? ""), JSON.stringify(revealed.rows));
  await popup.shot("03-wallet-ready");
  await popup.click("Back up now");
  await popup.waitFor(`document.body.innerText.includes("Hold to reveal")`);
  await popup.shot("04-phrase-hidden");
  await popup.evaluate(`document.querySelector(".hold").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await sleep(1800);
  await popup.evaluate(`document.querySelector(".hold")?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`);
  await popup.waitFor(`!document.querySelector(".phrase.blurred")`);
  await popup.shot("05-phrase-shown");
  const words = await popup.evaluate(`[...document.querySelectorAll(".phrase li")].map(li => li.lastChild.textContent.trim())`);
  check("recovery phrase is 12 words behind hold-to-reveal", words.length === 12);
  await popup.click("I wrote them down");
  await popup.waitFor(`document.querySelectorAll(".word-grid input").length === 2`);
  const asked = await popup.evaluate(`[...document.querySelectorAll(".word-grid label")].map(l => Number(l.textContent.match(/#(\\d+)/)[1]) - 1)`);
  for (const [i, index] of asked.entries()) await popup.setInput(`.word-grid label:nth-child(${i + 1}) input`, words[index]);
  await popup.shot("06-backup-check");
  await popup.clickWhenReady("Confirm backup");
  await popup.waitFor(`document.body.innerText.includes("You're all set")`, 30000);
  await popup.shot("07-done");
  await popup.click("Open my wallet");
  await popup.waitFor(`document.body.innerText.includes("Tokens")`, 30000);
  check("onboarding creates a backed-up wallet and opens it", !(await popup.evaluate(`document.body.innerText.includes("Back up your recovery phrase")`)));
  // The auto-lock counts only a person's own input; this run's scripted clicks don't count, and it lasts longer than the default
  // 15 minutes. So it sets 1 hour first (a setting people use too); the 15-minute default itself is checked in the unit tests.
  await popup.evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="autolock-row"]')`);
  await popup.shot("07b-settings");
  await popup.evaluate(`document.querySelector('[data-testid="autolock-row"]').click()`);
  await popup.waitFor(`[...document.querySelectorAll(".choice-list button")].some(b => b.textContent === "1 hour")`);
  await popup.evaluate(`[...document.querySelectorAll(".choice-list button")].find(b => b.textContent === "1 hour").click()`);
  await popup.waitFor(`document.querySelector('[data-testid="autolock-row"] .set-value')?.textContent === "1 h"`);
  await popup.evaluate(`document.querySelector('[aria-label="Home"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Tokens")`, 30000);
  await popup.waitFor(`!document.body.innerText.includes("Reading balances")`, 60000).catch(() => {});
  await popup.shot("08-home");
  // Home is never empty: each network's coin and stables show at 0, verified, with logos.
  const defaultsShown = await popup.evaluate(`(() => { const rows = [...document.querySelectorAll('[data-testid="asset-list"] .asset-row')]; return { rows: rows.length, usdc: rows.some(r => r.textContent.includes("USDC")), svg: rows.filter(r => r.querySelector("svg")).length }; })()`);
  check("Home shows default assets at 0 with logos", defaultsShown.rows >= 5 && defaultsShown.usdc && defaultsShown.svg >= 5, JSON.stringify(defaultsShown));
  // The network selector: pick Base; Home follows it.
  await popup.evaluate(`document.querySelector(".network-chip").click()`);
  await popup.waitFor(`document.body.innerText.includes("All networks") && !!document.querySelector('[aria-label="Choose a network"]')`);
  await popup.shot("08d-network-picker");
  await popup.evaluate(`[...document.querySelectorAll('[aria-label="Choose a network"] .row')].find(r => r.querySelector("b")?.textContent === "Base").click()`);
  await popup.waitFor(`document.querySelector(".network-chip")?.textContent.includes("Base") && document.querySelectorAll('[data-testid="asset-list"] .asset-row').length > 0`, 30000);
  const onlyBase = await popup.evaluate(`[...document.querySelectorAll('[data-testid="asset-list"] .asset-row small')].every(s => s.textContent.endsWith("· Base"))`);
  await popup.shot("08e-base-only");
  check("the network selector filters Home to one network", onlyBase);
  // A token's screen: price (or "No price yet"), the 24h/7d chart, holdings per network, Send/Receive/Swap.
  await popup.evaluate(`[...document.querySelectorAll('[data-testid="asset-list"] .asset-row')].find(r => r.textContent.includes("USDC")).click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="token-detail"]') && !document.querySelector('[data-testid="token-detail"] .sk')`, 30000);
  await popup.shot("08h-token-detail");
  const detail = await popup.evaluate(`(() => { const d = document.querySelector('[data-testid="token-detail"]'); const t = d.innerText; return { send: t.includes("Send"), receive: t.includes("Receive"), swap: t.includes("Swap"), base: t.includes("Base"), price: /\\$[0-9]|No price yet/.test(t), chart: !!d.querySelector('[data-testid="price-chart"]') || t.includes("No chart yet") }; })()`);
  check("a token opens its screen with price, chart, holdings per network and actions", Object.values(detail).every(Boolean), JSON.stringify(detail));
  // Live: the MAXXING Data API answers the extension (its own id, from its chrome-extension:// origin) with USDC's price.
  const livePrice = await popup.evaluate(`document.querySelector('[data-testid="token-detail"] .token-price')?.textContent ?? ""`);
  // What Chrome actually sends to the API from an extension page (its Origin header), recorded from the network layer.
  await send("Network.enable", {}, popup.sessionId);
  const priceRequests = new Set(), sentHeaders = new Map();
  listeners.push(message => {
    if (message.sessionId !== popup.sessionId) return;
    if (message.method === "Network.requestWillBeSent" && message.params.request.url.includes("api.maxxing.ad/v1/public/prices")) priceRequests.add(message.params.requestId);
    if (message.method === "Network.requestWillBeSentExtraInfo") sentHeaders.set(message.params.requestId, message.params.headers);
  });
  const sentOrigin = () => { for (const id of priceRequests) { const h = sentHeaders.get(id); if (h) return h.origin ?? h.Origin ?? "(no Origin header)"; } return "(not seen)"; };
  const priceProbe = /\$(0\.9\d|1\.0\d)/.test(livePrice) ? "" : await popup.evaluate(`fetch("https://api.maxxing.ad/v1/public/prices?ids=eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", { headers: { "x-maxxing-app": "maxxing-extension" }, credentials: "omit", referrerPolicy: "no-referrer" }).then(async r => r.status + " " + (await r.text()).slice(0, 160), e => "fetch failed: " + e.message)`);
  if (IN_CI) skip("the Data API gives the extension a live price (USDC on Base about $1)", "CI: depends on MAXXING's production API; checked in local runs");
  else check("the Data API gives the extension a live price (USDC on Base about $1)", /\$(0\.9\d|1\.0\d)/.test(livePrice), `${livePrice} ${priceProbe}${priceProbe ? ` origin sent: ${sentOrigin()}` : ""}`);
  await popup.evaluate(`[...document.querySelectorAll('[role="tab"]')].find(b => b.textContent === "7d").click()`);
  await popup.waitFor(`!document.querySelector('[data-testid="token-detail"] .sk')`, 30000);
  if (STORE_DEMO) {
    // Store screenshot: the Send review for the sample USDC (reads answered by the demo endpoints; nothing is signed or sent).
    await popup.evaluate(`[...document.querySelectorAll('[data-testid="token-detail"] button.action')].find(b => b.textContent.includes("Send")).click()`);
    await popup.waitFor(`!!document.querySelector('[data-testid="send-to"]')`, 30000);
    await popup.setInput('[data-testid="send-to"]', "0x8ba1f109551bD432803012645Ac136ddd64DBA72");
    await popup.setInput(".amount-input", "250");
    await popup.clickWhenReady("Review");
    await popup.waitFor(`document.body.innerText.includes("Hold to send")`, 45000);
    await new Promise(r => setTimeout(r, 1500)); // the fee in dollars arrives a moment later
    await popup.shot("08k-send-review");
    await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
    await popup.waitFor(`!!document.querySelector('[data-testid="send-to"]')`);
    await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
    // Store screenshot: a swap of the sample ETH on Base into USDC, with Relay's real quote and MAXXING's fee on its own line.
    await popup.waitFor(`!!document.querySelector('.dock [aria-label="Swap and bridge"]')`, 30000);
    await popup.evaluate(`document.querySelector('.dock [aria-label="Swap and bridge"]').click()`);
    // The token chooser: open the chip's sheet, tap the row (its data-key is "<network>|<token>").
    const pick = async (chip, key) => {
      await popup.evaluate(`document.querySelector('[data-testid="${chip}"]').click()`);
      const row = `[...document.querySelectorAll(".asset-row")].find(r => r.dataset.key.toLowerCase() === ${JSON.stringify(key.toLowerCase())})`;
      await popup.waitFor(`!!${row}`, 30000);
      await popup.evaluate(`${row}.click()`);
      await popup.waitFor(`!document.querySelector(".asset-sheet")`);
    };
    await popup.waitFor(`!!document.querySelector('[data-testid="swap-from"]')`, 30000);
    // It opens ready: both tokens chosen, and the button says what's missing.
    await popup.waitFor(`!document.querySelector('.asset-chip.empty')`, 30000);
    const ready = await popup.evaluate(`document.querySelector('[data-testid="swap-review-btn"]').innerText`);
    await popup.shot("08k-swap-form");
    check("swap opens with both tokens chosen and asks for an amount", ready === "Enter an amount", ready);
    await pick("swap-from", "eip155:8453|");
    await popup.setInput(".swap-amount", "0.05");
    await pick("swap-to", "eip155:8453|0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    await popup.waitFor(`!!document.querySelector('[data-testid="maxxing-fee"]')`, 45000);
    await popup.shot("08l-swap-quote-fee");
    const feeLine = await popup.evaluate(`document.querySelector('[data-testid="maxxing-fee"]').innerText`);
    check("the swap quote shows MAXXING's fee on its own line (0.85% ≈ $x), from a real Relay quote", /MAXXING fee 0\.85%/.test(feeLine) && /\$/.test(feeLine), feeLine.replace(/\s+/g, " "));
    const gasLine = await popup.evaluate(`document.querySelector('[data-testid="swap-network-fee"]').innerText`);
    check("the swap form shows the network fee to expect, in the coin", /Network fee, about/.test(gasLine) && /\d.* ETH/.test(gasLine), gasLine.replace(/\s+/g, " "));
    await popup.clickWhenReady("Review swap");
    await popup.waitFor(`document.body.innerText.includes("Review swap") && !!document.querySelector('[data-testid="maxxing-fee"]')`, 45000);
    await popup.shot("08m-swap-review-fee");
    await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
    await popup.waitFor(`!!document.querySelector('.dock [aria-label="Home"]')`);
    await popup.evaluate(`document.querySelector('.dock [aria-label="Home"]').click()`);
  } else
  await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
  await popup.waitFor(`!!document.querySelector(".network-chip")`, 30000);
  await popup.evaluate(`document.querySelector(".network-chip").click()`);
  await popup.waitFor(`!!document.querySelector('[aria-label="Choose a network"]')`);
  await popup.evaluate(`[...document.querySelectorAll('[aria-label="Choose a network"] .row')][0].click()`);
  await popup.waitFor(`document.querySelector(".network-chip")?.getAttribute("aria-label").includes("All networks")`, 30000);

  // Receive: one address at a time with its QR code (a switch between EVM and Solana); per network, a "send only on" warning.
  await popup.click("Receive");
  await popup.waitFor(`document.querySelectorAll('[data-testid="address-qr"]').length === 1 && /^0x[0-9a-fA-F]{40}$/.test(document.querySelector('[data-testid="receive-address"]').textContent)`);
  await popup.shot("08f-receive-all");
  await popup.evaluate(`document.querySelector('[data-testid="receive-solana"]').click()`);
  await popup.waitFor(`/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(document.querySelector('[data-testid="receive-address"]').textContent)`);
  await popup.shot("08f2-receive-solana");
  check("Receive switches between the EVM and the Solana address", true);
  await popup.evaluate(`document.querySelector('[data-testid="receive-evm"]').click()`);
  await popup.evaluate(`document.querySelector('[data-testid="receive"]').closest(".popup").querySelector(".network-chip").click()`);
  await popup.waitFor(`!!document.querySelector('[aria-label="Choose a network"]')`);
  await popup.evaluate(`[...document.querySelectorAll('[aria-label="Choose a network"] .row')].find(r => r.querySelector("b")?.textContent === "Base").click()`);
  await popup.waitFor(`document.body.innerText.includes("Send only on Base") && document.querySelectorAll('[data-testid="address-qr"]').length === 1`);
  await popup.shot("08g-receive-base");
  const receiveAddr = await popup.evaluate(`document.querySelector('[data-testid="receive-address"]').textContent`);
  check("Receive shows the network's address with a QR code and a send-only-on warning", /^0x[0-9a-fA-F]{40}$/.test(receiveAddr), receiveAddr);
  await popup.evaluate(`document.querySelector('[data-testid="receive"]').closest(".popup").querySelector(".network-chip").click()`);
  await popup.waitFor(`!!document.querySelector('[aria-label="Choose a network"]')`);
  await popup.evaluate(`[...document.querySelectorAll('[aria-label="Choose a network"] .row')][0].click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="receive-solana"]')`);
  await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Tokens")`, 30000);

  // ── One password: a second wallet asks for no PIN; after a lock, the password opens every wallet ────────────────────────
  await popup.evaluate(`document.querySelector(".account-pill").click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="account-rail"] [aria-label="Add"]')`);
  await popup.evaluate(`document.querySelector('[data-testid="account-rail"] [aria-label="Add"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("New wallet")`);
  await popup.click("New wallet");
  await popup.waitFor(`document.body.innerText.includes("no new PIN")`);
  await popup.shot("08b-new-wallet-no-pin");
  await popup.clickWhenReady("Create wallet");
  await popup.waitFor(`document.body.innerText.includes("Your wallet is ready")`, 60000);
  check("a second wallet is created without a new password", !(await popup.evaluate(`!!document.querySelector('[aria-label="Repeat it"]')`)));
  await popup.click("Later");
  await popup.waitFor(`document.body.innerText.includes("Tokens")`, 30000);
  await popup.evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Lock now")`);
  await popup.click("Lock now");
  // The lock screen: the hat, one field (autofocused), Unlock off until there's input; a wrong password shows under the field.
  await popup.waitFor(`!!document.querySelector('[data-testid="unlock"] .pw-input')`, 30000);
  const lockScreen = await popup.evaluate(`(() => { const u = document.querySelector('[data-testid="unlock"]'); const b = u.querySelector('button[type=submit]'); return { title: u.textContent.includes("Unlock MAXXING Wallet") && !!u.querySelector(".brand-mark"), hat: !!u.querySelector(".unlock-cap"), focused: document.activeElement === u.querySelector(".pw-input"), masked: u.querySelector(".pw-input").type === "password", off: b.disabled && b.textContent === "Unlock", keypad: !!u.querySelector(".keys") }; })()`);
  check("the lock screen: hat, title, one masked autofocused field, Unlock off until typed, no keypad", lockScreen.title && lockScreen.hat && lockScreen.focused && lockScreen.masked && lockScreen.off && !lockScreen.keypad, JSON.stringify(lockScreen));
  await popup.shot("08c-unlock");
  await popup.typePassword("Wrong-Hat-0000");
  await popup.waitFor(`/Wrong password/.test(document.getElementById("pw-note")?.textContent ?? "")`, 30000);
  await popup.evaluate(`document.querySelector('.pw-eye').click()`);
  await popup.click("Forgot password?");
  await popup.waitFor(`!!document.querySelector('[data-testid="forgot-password"]')`);
  await popup.shot("08c2-unlock-wrong-and-forgot");
  const forgot = await popup.evaluate(`document.querySelector('[data-testid="forgot-password"]').innerText`);
  check("a wrong password shows under the field; Forgot explains the phrase, warning about the wallet not backed up", /only protects MAXXING Wallet on this device/.test(forgot) && /isn't backed up/.test(forgot), forgot.slice(0, 200));
  await popup.typePassword(PASSWORD);
  await popup.waitFor(`!!document.querySelector('[aria-label="Home"]')`, 30000);
  await popup.evaluate(`document.querySelector('[aria-label="Home"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Tokens")`, 30000);
  // Switch to the first wallet: it opens at once, no PIN of its own.
  await popup.evaluate(`document.querySelector(".account-pill").click()`);
  await popup.waitFor(`!!document.querySelector('[aria-label="Open wallet My wallet"]')`);
  await popup.evaluate(`document.querySelector('[aria-label="Open wallet My wallet"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Tokens") && !document.querySelector(".rail")`, 30000);
  check("one password: after a lock, every wallet opens without its own PIN", !(await popup.evaluate(`document.body.innerText.includes("Enter your password") || document.body.innerText.includes("old PIN")`)));
  // Activity: grouped by day with filters; the lock and unlock just made show under Security, and Transactions is empty.
  await popup.evaluate(`document.querySelector('[aria-label="Activity"]').click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="activity"] .day-head')`, 30000);
  await popup.shot("08i-activity");
  await popup.evaluate(`[...document.querySelectorAll('[role="tab"]')].find(b => b.textContent === "Security").click()`);
  const security = await popup.evaluate(`[...document.querySelectorAll('.activity-row')].map(r => r.dataset.kind)`);
  await popup.evaluate(`[...document.querySelectorAll('[role="tab"]')].find(b => b.textContent === "Transactions").click()`);
  const txEmpty = await popup.evaluate(`document.querySelectorAll('.activity-row').length === 0 && document.body.innerText.includes("No transactions here yet")`);
  check("Activity filters: Security shows the lock and unlock; Transactions is empty", security.includes("lock") && security.includes("unlock") && security.every(k => ["lock", "unlock", "export"].includes(k)) && txEmpty, JSON.stringify(security));
  await popup.evaluate(`document.querySelector('[aria-label="Home"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Tokens")`, 30000);
  // Send: a .eth name resolves on Ethereum (live, through the registry's endpoints) and the address is shown.
  await popup.click("Send");
  await popup.waitFor(`!!document.querySelector('[data-testid="send-to"]')`, 30000);
  await popup.setInput('[data-testid="send-to"]', "vitalik.eth");
  await popup.waitFor(`/→ 0x[0-9a-fA-F]{40}|no address/.test(document.querySelector('[data-testid="ens-result"]')?.textContent ?? "")`, 45000).catch(() => {});
  await popup.shot("08j-send-ens");
  const ensText = await popup.evaluate(`document.querySelector('[data-testid="ens-result"]')?.textContent ?? ""`);
  check("Send resolves a .eth name and shows the address", /^vitalik\.eth → 0x[0-9a-fA-F]{40}$/.test(ensText), ensText);
  await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Tokens")`, 30000);

  // ── Accounts ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await popup.evaluate(`document.querySelector(".account-pill").click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="account-rail"] [aria-label="Add"]')`);
  await popup.evaluate(`document.querySelector('[data-testid="account-rail"] [aria-label="Add"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("from this recovery phrase")`);
  await popup.click("New account");
  await popup.waitFor(`!document.querySelector(".rail")`, 30000);
  const pill = await popup.evaluate(`document.querySelector(".account-pill b").textContent`);
  check("a second account from the same phrase opens", pill === "Account 2", pill);
  // The drawer: a bubble per account, the open one marked; the pencil opens the full sheet (names, balances, copy).
  await popup.evaluate(`document.querySelector(".account-pill").click()`);
  await popup.waitFor(`document.querySelectorAll(".rail-item").length >= 2`);
  check("the account drawer shows a bubble per account, the open one marked", await popup.evaluate(`document.querySelector(".rail-item.on")?.textContent === "A2Account 2"`), await popup.evaluate(`[...document.querySelectorAll(".rail-item")].map(b => b.textContent).join(" | ")`));
  await new Promise(r => setTimeout(r, 500));
  await popup.shot("09a-account-drawer");
  await popup.evaluate(`document.querySelector('[aria-label="Edit accounts"]').click()`);
  await popup.waitFor(`document.querySelectorAll('.sheet button[aria-label^="Open "]').length >= 2`);
  // The open account's balance shows at once; another account's only when tapped (the wallet doesn't look up every address
  // together). Each account has its own copy-address button.
  const balances = `[...document.querySelectorAll('.sheet button[aria-label^="Open "] .end b')].map(b => b.textContent)`;
  await popup.waitFor(`${balances}.length === 1 && ${balances}[0] !== "…"`, 60000);
  const waitingForTap = await popup.evaluate(`document.querySelectorAll('.sheet button[aria-label^="Show "]').length`);
  await popup.evaluate(`document.querySelector('.sheet button[aria-label^="Show "]').click()`);
  await popup.waitFor(`${balances}.length === 2 && ${balances}.every(t => /^\\$|^—$/.test(t))`, 60000);
  check("account balances: the open one at once, others only when tapped; a copy button each", waitingForTap === 1 && await popup.evaluate(`document.querySelectorAll('.sheet button[aria-label^="Copy "]').length >= 2`), `${waitingForTap} waiting for a tap`);
  await popup.shot("09-accounts");
  await popup.evaluate(`document.querySelectorAll('.sheet button[aria-label^="Open "]')[0].click()`);
  await popup.waitFor(`!document.querySelector(".sheet")`, 30000);

  // ── A site: connect and sign, EVM then Solana ────────────────────────────────────────────────────────────────────────
  const seen = new Set();
  const { targetId: dappTarget } = await send("Target.createTarget", { url: `http://localhost:${PORT}/` });
  const site = await attach(dappTarget);
  await site.waitFor(`window.found && window.found.evm && window.found.solana`);
  check("the site finds MAXXING Wallet by EIP-6963 and the Wallet Standard", true);

  await site.evaluate(`run("connect", window.found.evm.request({ method: "eth_requestAccounts" }))`);
  let approval = await nextApproval(seen).catch(async error => { throw new Error(`${error.message}\nsite: ${JSON.stringify(await site.evaluate("window.results"))}`); });
  await approval.waitFor(`document.body.innerText.includes("Connect to")`);
  // The approve button waits a moment, so a click aimed at the site can't land on it; the site's name is shown whole.
  check("the Connect button starts disabled for a moment (no click-through)", await approval.evaluate(`document.querySelector('[data-testid="hold-to-confirm"]')?.disabled === true`));
  check("the site's domain is shown in full", await approval.evaluate(`document.querySelector("[data-testid=site-domain]")?.textContent === "localhost" && !getComputedStyle(document.querySelector("[data-testid=site-domain]")).textOverflow.includes("ellipsis")`));
  // While one request waits, the site can't open another window.
  await site.evaluate(`run("second", window.found.evm.request({ method: "eth_requestAccounts" }))`);
  const second = await site.waitFor(`window.results.second && !window.results.second.pending && window.results.second`);
  check("a second request while one waits is refused (4001)", !second.ok && second.code === 4001, second.error);
  await approval.shot("10-approve-connect");
  await approval.holdWhenReady("Connect");
  const connected = await site.waitFor(`window.results.connect && !window.results.connect.pending && window.results.connect`);
  check("EVM connect", connected.ok && /^0x[0-9a-fA-F]{40}$/.test(connected.value?.[0]), connected.value?.[0]);
  const evm = connected.value[0];

  await site.evaluate(`run("sign", window.found.evm.request({ method: "personal_sign", params: ["Hello from the test dapp", ${JSON.stringify(evm)}] }))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Sign a message")`);
  await approval.shot("11-approve-message");
  await approval.holdWhenReady("Approve");
  const signed = await site.waitFor(`window.results.sign && !window.results.sign.pending && window.results.sign`);
  check("EVM message signed by the connected address", signed.ok && (await recoverMessageAddress({ message: "Hello from the test dapp", signature: signed.value })).toLowerCase() === evm.toLowerCase());

  // The site's first network after connecting is taken without a prompt; the wallet keeps it for this site.
  await site.evaluate(`run("switch", window.found.evm.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] }))`);
  const firstSwitch = await site.waitFor(`window.results.switch && !window.results.switch.pending && window.results.switch`);
  check("a connected site's first network switch needs no prompt", firstSwitch.ok && await site.evaluate(`window.found.evm.request({ method: "eth_chainId" })`) === "0x2105", firstSwitch.error);
  await site.evaluate(`run("tx", window.found.evm.request({ method: "eth_signTransaction", params: [{ from: ${JSON.stringify(evm)}, to: ${JSON.stringify(evm)}, value: "0x0" }] }))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Base")`, 30000);
  await approval.shot("12-approve-transaction");
  await approval.holdWhenReady("Approve");
  const tx = await site.waitFor(`window.results.tx && !window.results.tx.pending && window.results.tx`, 30000);
  check("Base transaction signed (not sent) by the connected address", tx.ok && (await recoverTransactionAddress({ serializedTransaction: tx.value })).toLowerCase() === evm.toLowerCase(), tx.ok ? "" : tx.error);
  // A test network while they're off: refused (4902). Another network: the wallet asks first.
  await site.evaluate(`run("testnet", window.found.evm.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] }))`);
  const testnet = await site.waitFor(`window.results.testnet && !window.results.testnet.pending && window.results.testnet`);
  check("switching to a test network while they're off is refused (4902)", !testnet.ok && testnet.code === 4902, testnet.error);
  await site.evaluate(`run("switch2", window.found.evm.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] }))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`!!document.querySelector('[data-testid="switch-request"]')`);
  await approval.shot("12b-approve-switch-network");
  await approval.holdWhenReady("Switch");
  const switched = await site.waitFor(`window.results.switch2 && !window.results.switch2.pending && window.results.switch2`);
  check("a connected site's network change is asked, approved, and applied", switched.ok && await site.evaluate(`window.found.evm.request({ method: "eth_chainId" })`) === "0x1", switched.error);

  await site.evaluate(`run("solConnect", window.found.solana.features["standard:connect"].connect().then(r => r.accounts[0].address))`);
  const solConnect = await site.waitFor(`window.results.solConnect && !window.results.solConnect.pending && window.results.solConnect`);
  check("Solana connect (the site is already connected)", solConnect.ok, solConnect.value);
  const solana = solConnect.value;
  await site.evaluate(`run("solMsg", window.found.solana.features["solana:signMessage"].signMessage({ account: window.found.solana.accounts[0], message: new TextEncoder().encode("Hello Solana") }).then(([r]) => Array.from(r.signature)))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Sign a message")`);
  await approval.shot("13-approve-solana-message");
  await approval.holdWhenReady("Approve");
  const solMsg = await site.waitFor(`window.results.solMsg && !window.results.solMsg.pending && window.results.solMsg`);
  check("Solana message signed by the connected address", solMsg.ok && nacl.sign.detached.verify(new TextEncoder().encode("Hello Solana"), Uint8Array.from(solMsg.value), bs58.decode(solana)));
  await site.evaluate(`run("solTx", window.found.solana.features["solana:signTransaction"].signTransaction({ account: window.found.solana.accounts[0], transaction: solTransfer(${JSON.stringify(solana)}, ${JSON.stringify(solana)}), chain: "solana:devnet" }).then(([r]) => Array.from(r.signedTransaction)))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Solana transaction")`);
  await approval.shot("14-approve-solana-transaction");
  await approval.holdWhenReady("Approve");
  const solTx = await site.waitFor(`window.results.solTx && !window.results.solTx.pending && window.results.solTx`);
  const signedTx = Uint8Array.from(solTx.value ?? []);
  check("Solana transaction signed in its slot by the connected address", solTx.ok && nacl.sign.detached.verify(signedTx.subarray(65), signedTx.subarray(1, 65), bs58.decode(solana)));

  // Declining answers the site with the standard code.
  await site.evaluate(`run("declined", window.found.evm.request({ method: "personal_sign", params: ["Decline me", ${JSON.stringify(evm)}] }))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Decline")`);
  await approval.click("Decline");
  const declined = await site.waitFor(`window.results.declined && !window.results.declined.pending && window.results.declined`);
  check("declining answers the site with code 4001", !declined.ok && declined.code === 4001, `${declined.code}`);

  // ── Settings and export ─────────────────────────────────────────────────────────────────────────────────────────────
  await popup.evaluate(`window.__beforeReload = true; location.reload()`);
  await popup.waitFor(`!window.__beforeReload && !!document.querySelector('[aria-label="Settings"]')`, 30000);
  await popup.evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Connected sites")`);
  await popup.shot("15-settings");
  await popup.evaluate(`[...document.querySelectorAll("button.row")].find(b => b.textContent.includes("Connected sites")).click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="connected-sites"] .site-row')`);
  await popup.shot("15b-connected-sites");
  const siteRow = await popup.evaluate(`(() => { const r = document.querySelector('[data-testid="connected-sites"] .site-row'); return { host: r.innerText.includes("localhost:${PORT}"), network: r.querySelector('[data-testid="site-network"]').dataset.chain, disconnect: !!r.querySelector('[aria-label^="Disconnect"]') }; })()`);
  check("the connected site is listed with its network (kept per site) and a disconnect button", siteRow.host && siteRow.network === "1" && siteRow.disconnect, JSON.stringify(siteRow));
  await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Token approvals")`);
  await popup.evaluate(`[...document.querySelectorAll("button.row")].find(b => b.textContent.includes("Token approvals")).click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="approvals"]') && !document.body.innerText.includes("Reading approvals")`, 60000);
  await popup.shot("15c-approvals");
  check("Approvals lists what's still open (none yet for a new wallet)", await popup.evaluate(`document.body.innerText.includes("No open approvals")`));
  await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Export private keys")`);
  // About: version, support, public source and the security policy. Then hide balances: Home shows dots.
  await popup.evaluate(`document.querySelector('[data-testid="about"]').scrollIntoView()`);
  await popup.shot("15d-settings-about");
  const about = await popup.evaluate(`(() => { const t = document.querySelector('[data-testid="about"]').innerText; return { support: t.includes("Contact support"), source: t.includes("Public source code"), security: t.includes("Security policy"), version: /MAXXING Wallet \\d+\\.\\d+/.test(document.querySelector('[data-testid="version"]').textContent) }; })()`);
  check("Settings shows the version, support, public source and security policy", Object.values(about).every(Boolean), JSON.stringify(about));
  // ── Networks: endpoints with live health, the user's own RPC (checked, first, then reset), and a custom network ───────────
  await popup.evaluate(`[...document.querySelectorAll("button.row")].find(b => b.textContent.includes("Networks and RPC endpoints")).click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="networks"] [data-network="eip155:8453"]')`);
  await popup.shot("15f-networks");
  await popup.evaluate(`document.querySelector('[data-network="eip155:8453"]').click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="rpc-list"]') && !document.querySelector('[data-testid="rpc-list"]').innerText.includes("Checking")`, 30000);
  const health = await popup.evaluate(`[...document.querySelectorAll('[data-testid="rpc-list"] .rpc-row')].map(r => r.querySelector("small").textContent)`);
  check("each Base endpoint shows its health (latency and block, or not answering)", health.length >= 3 && health.every(t => /ms · block|Not answering/.test(t)) && health.some(t => /ms · block/.test(t)), `${health.length} endpoints`);
  await popup.setInput('[data-testid="rpc-url"]', `http://localhost:${PORT}/rpc-local`);
  await popup.clickWhenReady("Check and add");
  await popup.waitFor(`/serves chain 31337, not 8453/.test(document.querySelector('[data-testid="network-detail"]').innerText)`, 30000);
  check("an RPC for another chain is refused (eth_chainId must match)", true);
  await popup.setInput('[data-testid="rpc-url"]', `http://localhost:${PORT}/rpc-base`);
  await popup.clickWhenReady("Check and add");
  await popup.waitFor(`document.querySelector('[data-testid="rpc-list"] .rpc-row')?.dataset.rpc === "localhost:${PORT}"`, 30000);
  await popup.waitFor(`!document.querySelector('[data-testid="rpc-list"]').innerText.includes("Checking")`, 30000);
  await popup.shot("15g-network-base-own-rpc");
  check("the user's own RPC is checked, then tried first", await popup.evaluate(`document.querySelector('[data-testid="rpc-list"] .rpc-row').innerText.includes("Yours")`));
  await popup.clickWhenReady("Reset to default");
  await popup.waitFor(`document.querySelector('[data-testid="rpc-list"] .rpc-row')?.dataset.rpc !== "localhost:${PORT}"`);
  check("reset to default drops the user's RPC", !(await popup.evaluate(`[...document.querySelectorAll('[data-testid="rpc-list"] .rpc-row')].some(r => r.dataset.rpc === "localhost:${PORT}")`)));
  await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="networks"]')`);
  await popup.click("Add a network");
  await popup.waitFor(`!!document.querySelector('[data-testid="add-network"]')`);
  const fields = { "Network name": "Local Test", "RPC URL": `http://localhost:${PORT}/rpc-local`, "Chain ID": "31337", "Coin symbol": "TEST" };
  for (const [label, value] of Object.entries(fields)) await popup.evaluate(`(() => { const l = [...document.querySelectorAll('[data-testid="add-network"] label')].find(x => x.textContent.startsWith(${JSON.stringify(label)})); const el = l.querySelector("input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await popup.shot("15h-add-network");
  await popup.clickWhenReady("Add network");
  await popup.waitFor(`!!document.querySelector('[data-testid="network-detail"]') && document.body.innerText.includes("Added by you")`, 30000);
  await popup.shot("15i-custom-network");
  check("a custom network is added after its chain id is checked, marked Added by you", await popup.evaluate(`document.body.innerText.includes("Chain ID 31337")`));
  await popup.clickWhenReady("Remove this network");
  await popup.waitFor(`!!document.querySelector('[data-testid="networks"]') && !document.querySelector('[data-network="eip155:31337"]')`);
  await popup.evaluate(`document.querySelector('[aria-label="Back"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Export private keys")`);
  await popup.evaluate(`document.querySelector('[role="switch"][aria-label="Hide balances"]').click()`);
  await popup.evaluate(`document.querySelector('[aria-label="Home"]').click()`);
  await popup.waitFor(`!!document.querySelector('[data-testid="total"]')`, 30000);
  await popup.shot("15e-home-hidden");
  check("hide balances: the total shows as dots", await popup.evaluate(`document.querySelector('[data-testid="total"]').textContent === "$••••"`));
  await popup.evaluate(`document.querySelector('[aria-label="Show balances"]').click()`);
  await popup.evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Export private keys")`);
  await popup.click("Export private keys");
  await popup.waitFor(`document.querySelectorAll(".check").length === 3`);
  await popup.evaluate(`[...document.querySelectorAll(".check")].forEach(c => c.click())`);
  await popup.shot("16-export-warning");
  await popup.clickWhenReady("Continue");
  await popup.waitFor(`!!document.querySelector(".pw-form .pw-input")`);
  await popup.shot("16b-export-password");
  await popup.typePassword(PASSWORD);
  await popup.waitFor(`document.body.innerText.includes("Hold to reveal")`, 30000);
  await popup.evaluate(`document.querySelector(".hold").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await sleep(1800);
  await popup.waitFor(`document.body.innerText.includes("Hides again in")`);
  await popup.shot("17-export-keys-shown");
  check("private key export: ticks, password, hold to reveal, auto-hide timer", true);

  // Copying a key: the background empties the clipboard later, even with the popup closed (alarm + offscreen document).
  await send("Browser.grantPermissions", { origin: base, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  // A headless page never has focus, and the clipboard wants a focused page: emulate it.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, popup.sessionId);
  await popup.evaluate(`navigator.clipboard.writeText("something else")`);
  await popup.clickWhenReady("Copy");
  await sleep(300);
  const copied = await popup.evaluate(`navigator.clipboard.readText().catch(e => "unreadable: " + e.message)`);
  // The real alarm fires after 60 s; an unpacked extension may set a sooner one, which runs the same clear.
  await popup.evaluate(`chrome.alarms.create("clipboard-clear", { when: Date.now() + 300 })`);
  await popup.evaluate(`location.href = "about:blank"`).catch(() => {});
  await sleep(3000);
  const { targetId: probeTarget } = await send("Target.createTarget", { url: `${base}/popup.html` });
  const probe = await attach(probeTarget, [360, 600]);
  await probe.waitFor(`document.readyState === "complete"`);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, probe.sessionId);
  const after = await probe.evaluate(`navigator.clipboard.readText().catch(e => "unreadable: " + e.message)`);
  const copiedKey = /^0x[0-9a-f]{64}$/.test(copied) || /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(copied);
  check("a copied private key is cleared from the clipboard by the background", copiedKey && after === "", copiedKey ? `then ${JSON.stringify(after.slice(0, 40))}` : `copy didn't land: ${copied.slice(0, 60)}`);

  // Something the user copied after the secret is left alone: the background clears only what still matches the secret's hash.
  await probe.evaluate(`location.href = ${JSON.stringify(`${base}/popup.html`)}`).catch(() => {});
  await probe.waitFor(`document.body.innerText.includes("Tokens") || document.body.innerText.includes("Unlock")`, 30000);
  await probe.evaluate(`chrome.runtime.sendMessage({ type: "clear-clipboard-later", seconds: 60, hash: "${"0".repeat(64)}" })`);
  await probe.evaluate(`navigator.clipboard.writeText("the user's own text")`);
  await probe.evaluate(`chrome.alarms.create("clipboard-clear", { when: Date.now() + 300 })`);
  await sleep(3000);
  const kept = await probe.evaluate(`navigator.clipboard.readText().catch(e => "unreadable: " + e.message)`);
  check("text copied after the secret stays in the clipboard", kept === "the user's own text", JSON.stringify(kept.slice(0, 40)));
} catch (error) {
  check("run", false, error.message);
} finally {
  try { await send("Browser.close"); } catch { /* already gone */ }
  chrome.kill();
  server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  rmSync(dist, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok), skipped = results.filter(r => r.skipped);
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} passed${skipped.length ? `, ${skipped.length} skipped` : ""}. Screenshots: ${shots}`);
  process.exit(failed.length ? 1 : 0);
}
