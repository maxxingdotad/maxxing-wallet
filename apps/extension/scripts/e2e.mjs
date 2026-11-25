#!/usr/bin/env node
/**
 * End-to-end: the built extension (dist/chrome) in a real Chrome, driven over the DevTools protocol the way a person would use it.
 * Onboards a new wallet (PIN, recovery phrase behind hold-to-reveal, two-word check), adds an account, then a local test site
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recoverMessageAddress, recoverTransactionAddress } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(here, "dist/chrome");
const shots = resolve(process.argv[2] ?? join(tmpdir(), "maxxing-extension-e2e"));
mkdirSync(shots, { recursive: true });
const CHROME = process.env.CHROME ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const PORT = 8086, PIN = "246810";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

// ── The test site ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const dapp = readFileSync(resolve(here, "tests/e2e/dapp.html"));
const server = createServer((_, res) => { res.setHeader("content-type", "text/html"); res.end(dapp); }).listen(PORT, "127.0.0.1");

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
  const shot = async (name) => { await sleep(500); const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId); writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64")); };
  const click = (text) => evaluate(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled); if (!b) return false; b.click(); return true; })()`);
  const clickWhenReady = async (text, timeout) => { await waitFor(`[...document.querySelectorAll("button")].some(b => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled)`, timeout); await click(text); };
  const typePin = async (pin) => { for (const d of pin) { await clickWhenReady(d); await sleep(40); } };
  const setInput = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; setter.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  return { sessionId, evaluate, waitFor, shot, click, clickWhenReady, typePin, setInput };
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
  await popup.waitFor(`document.body.innerText.includes("Create a new wallet")`);
  await sleep(1800); // let the welcome animation settle
  await popup.shot("01-welcome");
  await popup.click("Create a new wallet");
  await popup.waitFor(`document.body.innerText.includes("Create a PIN")`);
  await popup.shot("02-create-pin");
  await popup.typePin(PIN);
  await popup.waitFor(`document.body.innerText.includes("Enter it again")`);
  await popup.typePin(PIN);
  await popup.waitFor(`document.body.innerText.includes("Your wallet is ready")`, 60000);
  await popup.shot("03-wallet-ready");
  await popup.click("Back up now");
  await popup.waitFor(`document.body.innerText.includes("Press and hold to reveal")`);
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
  await popup.waitFor(`!document.body.innerText.includes("Reading balances")`, 60000).catch(() => {});
  await popup.shot("08-home");

  // ── Accounts ────────────────────────────────────────────────────────────────────────────────────────────────────────
  await popup.evaluate(`document.querySelector(".account-pill").click()`);
  await popup.waitFor(`document.body.innerText.includes("New account from this phrase")`);
  await popup.click("+ New account from this phrase");
  await popup.waitFor(`!document.querySelector(".sheet")`, 30000);
  const pill = await popup.evaluate(`document.querySelector(".account-pill b").textContent`);
  check("a second account from the same phrase opens", pill === "Account 2", pill);
  await popup.evaluate(`document.querySelector(".account-pill").click()`);
  await popup.waitFor(`document.querySelectorAll(".sheet .row").length >= 2`);
  await popup.shot("09-accounts");
  await popup.evaluate(`[...document.querySelectorAll(".sheet .row")][0].click()`);
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
  check("the Connect button starts disabled for a moment (no click-through)", await approval.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Connect")?.disabled === true`));
  check("the site's domain is shown in full", await approval.evaluate(`document.querySelector("[data-testid=site-domain]")?.textContent === "localhost" && !getComputedStyle(document.querySelector("[data-testid=site-domain]")).textOverflow.includes("ellipsis")`));
  // While one request waits, the site can't open another window.
  await site.evaluate(`run("second", window.found.evm.request({ method: "eth_requestAccounts" }))`);
  const second = await site.waitFor(`window.results.second && !window.results.second.pending && window.results.second`);
  check("a second request while one waits is refused (4001)", !second.ok && second.code === 4001, second.error);
  await approval.shot("10-approve-connect");
  await approval.clickWhenReady("Connect");
  const connected = await site.waitFor(`window.results.connect && !window.results.connect.pending && window.results.connect`);
  check("EVM connect", connected.ok && /^0x[0-9a-fA-F]{40}$/.test(connected.value?.[0]), connected.value?.[0]);
  const evm = connected.value[0];

  await site.evaluate(`run("sign", window.found.evm.request({ method: "personal_sign", params: ["Hello from the test dapp", ${JSON.stringify(evm)}] }))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Sign a message")`);
  await approval.shot("11-approve-message");
  await approval.clickWhenReady("Approve");
  const signed = await site.waitFor(`window.results.sign && !window.results.sign.pending && window.results.sign`);
  check("EVM message signed by the connected address", signed.ok && (await recoverMessageAddress({ message: "Hello from the test dapp", signature: signed.value })).toLowerCase() === evm.toLowerCase());

  await site.evaluate(`run("switch", window.found.evm.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] }))`);
  await site.waitFor(`window.results.switch && !window.results.switch.pending`);
  await site.evaluate(`run("tx", window.found.evm.request({ method: "eth_signTransaction", params: [{ from: ${JSON.stringify(evm)}, to: ${JSON.stringify(evm)}, value: "0x0" }] }))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Base Sepolia")`, 30000);
  await approval.shot("12-approve-transaction");
  await approval.clickWhenReady("Approve");
  const tx = await site.waitFor(`window.results.tx && !window.results.tx.pending && window.results.tx`, 30000);
  check("Base Sepolia transaction signed by the connected address", tx.ok && (await recoverTransactionAddress({ serializedTransaction: tx.value })).toLowerCase() === evm.toLowerCase(), tx.ok ? "" : tx.error);

  await site.evaluate(`run("solConnect", window.found.solana.features["standard:connect"].connect().then(r => r.accounts[0].address))`);
  const solConnect = await site.waitFor(`window.results.solConnect && !window.results.solConnect.pending && window.results.solConnect`);
  check("Solana connect (the site is already connected)", solConnect.ok, solConnect.value);
  const solana = solConnect.value;
  await site.evaluate(`run("solMsg", window.found.solana.features["solana:signMessage"].signMessage({ account: window.found.solana.accounts[0], message: new TextEncoder().encode("Hello Solana") }).then(([r]) => Array.from(r.signature)))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Sign a message")`);
  await approval.shot("13-approve-solana-message");
  await approval.clickWhenReady("Approve");
  const solMsg = await site.waitFor(`window.results.solMsg && !window.results.solMsg.pending && window.results.solMsg`);
  check("Solana message signed by the connected address", solMsg.ok && nacl.sign.detached.verify(new TextEncoder().encode("Hello Solana"), Uint8Array.from(solMsg.value), bs58.decode(solana)));
  await site.evaluate(`run("solTx", window.found.solana.features["solana:signTransaction"].signTransaction({ account: window.found.solana.accounts[0], transaction: solTransfer(${JSON.stringify(solana)}, ${JSON.stringify(solana)}), chain: "solana:devnet" }).then(([r]) => Array.from(r.signedTransaction)))`);
  approval = await nextApproval(seen);
  await approval.waitFor(`document.body.innerText.includes("Solana transaction")`);
  await approval.shot("14-approve-solana-transaction");
  await approval.clickWhenReady("Approve");
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
  await popup.evaluate(`location.reload()`);
  await popup.waitFor(`document.body.innerText.includes("Tokens")`, 30000);
  await popup.evaluate(`document.querySelector('[aria-label="Settings"]').click()`);
  await popup.waitFor(`document.body.innerText.includes("Connected sites")`);
  await popup.shot("15-settings");
  check("the connected site is listed with a disconnect button", await popup.evaluate(`document.body.innerText.includes("localhost:${PORT}")`));
  await popup.click("Export private keys");
  await popup.waitFor(`document.querySelectorAll(".check").length === 3`);
  await popup.evaluate(`[...document.querySelectorAll(".check")].forEach(c => c.click())`);
  await popup.shot("16-export-warning");
  await popup.clickWhenReady("Continue to PIN");
  await popup.typePin(PIN);
  await popup.waitFor(`document.body.innerText.includes("Press and hold to reveal")`, 30000);
  await popup.evaluate(`document.querySelector(".hold").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
  await sleep(1800);
  await popup.waitFor(`document.body.innerText.includes("Hides again in")`);
  await popup.shot("17-export-keys-shown");
  check("private key export: ticks, PIN, hold to reveal, auto-hide timer", true);

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
} catch (error) {
  check("run", false, error.message);
} finally {
  try { await send("Browser.close"); } catch { /* already gone */ }
  chrome.kill();
  server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed. Screenshots: ${shots}`);
  process.exit(failed.length ? 1 : 0);
}
