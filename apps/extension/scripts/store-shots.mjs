#!/usr/bin/env node
/**
 * Store screenshots (1280×800, the size the Chrome Web Store, Edge and AMO accept), made from the real extension: the end-to-end
 * test's captures, each framed on the wallet's dark background with one line saying what it shows.
 *
 *   STORE_DEMO=1 node scripts/e2e.mjs <shots>   the captures (real Chrome, real extension; sample balances, see e2e.mjs)
 *   node scripts/store-shots.mjs <shots>        → store/out/screenshots/
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shots = resolve(process.argv[2] ?? join(tmpdir(), "maxxing-extension-e2e"));
const out = resolve(here, "store/out/screenshots");
mkdirSync(out, { recursive: true });
// This folder holds only this script's output: an earlier run's set is replaced, not mixed with the new one.
for (const file of readdirSync(out)) if (/^\d\d-.*\.png$/.test(file)) rmSync(join(out, file));
const CHROME = process.env.CHROME ?? (process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");

// Each: the capture, the headline, one line under it, and three short points that the screen itself shows.
const FRAMES = [
  ["08-home", "Every chain,<br>one balance", "Ethereum, Base, Solana and more, in one wallet.",
    ["One recovery phrase for every network", "Live prices and your total in dollars", "Your keys never leave this device"]],
  ["08m-swap-review-fee", "Swap and bridge<br>in one step", "Across networks, with every cost shown before you sign.",
    ["The least you will receive, up front", "Fees added up, each one a tap away", "Hold to confirm, so nothing fires by accident"]],
  ["08k-send-review", "Know exactly<br>what you send", "The review checks the recipient and the fee for you.",
    ["Warns on first-time and look-alike addresses", "The most the network fee can be", "The full address, to check character by character"]],
  ["08h-token-ether", "Every token<br>at a glance", "Price, chart and what you hold, on one screen.",
    ["Live price with 24-hour and 7-day charts", "Your holdings on each network", "Send, receive or swap from there"]],
  ["08g-receive-base", "Receive on the<br>right network", "Your address as a QR code, per network.",
    ["One address for every EVM network, one for Solana", "A clear note on which network to send on", "Copy the address or scan the code"]],
]; // The Chrome Web Store shows at most five.
const CHECK = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

const cap = pathToFileURL(resolve(here, "public/brand/cap.webp")).href;
const font = pathToFileURL(resolve(here, "public/fonts")).href;
const work = mkdtempSync(join(tmpdir(), "maxxing-store-shots-"));
let made = 0;
for (const [name, title, sub, points] of FRAMES) {
  const image = join(shots, `${name}.png`);
  if (!existsSync(image)) { console.warn(`skipped ${name}: no ${image}`); continue; }
  const html = `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: Inter; src: url("${font}/Inter.var.woff2") format("woff2"); }
    html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
    body { position: relative; background: #08090b; color: #f4f2ee; font-family: Inter, system-ui, sans-serif; }
    /* The wallet's own colours (the glow around its confirm panel), soft and far behind the screen. */
    .glow { position: absolute; left: 700px; top: 110px; width: 520px; height: 600px; border-radius: 50%; filter: blur(110px); opacity: .5;
      background: conic-gradient(from 200deg, #2dd4bf, #f472b6, #8b5cf6, #2dd4bf); }
    .text { position: absolute; left: 88px; top: 0; bottom: 0; width: 540px; display: flex; flex-direction: column; justify-content: center; }
    .brand { display: flex; align-items: center; gap: 12px; font-size: 19px; font-weight: 650; letter-spacing: .01em; color: #d9d7d2; }
    .brand img { width: 52px; filter: drop-shadow(0 6px 12px rgb(0 0 0 / .6)); }
    h1 { font-size: 64px; line-height: 1.03; letter-spacing: -0.035em; margin: 30px 0 18px; font-weight: 750; }
    p { font-size: 22px; line-height: 1.4; color: #a9abb2; margin: 0 0 30px; max-width: 470px; }
    ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
    li { display: flex; align-items: center; gap: 12px; font-size: 18.5px; font-weight: 500; color: #e9e7e2; }
    li span { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: rgb(255 255 255 / .08); color: #5eead4; }
    .shot { position: absolute; left: 746px; top: 38px; height: 724px; border-radius: 30px; box-shadow: 0 40px 90px rgb(0 0 0 / .7), 0 0 0 1px rgb(255 255 255 / .1), 0 0 0 9px rgb(255 255 255 / .035); }
  </style><div class="glow"></div>
  <div class="text"><div class="brand"><img src="${cap}" alt="">MAXXING Wallet</div><h1>${title}</h1><p>${sub}</p>
    <ul>${points.map(point => `<li><span>${CHECK}</span>${point}</li>`).join("")}</ul></div>
  <img class="shot" src="${pathToFileURL(image).href}" alt="">`;
  const page = join(work, `${name}.html`);
  writeFileSync(page, html);
  const target = join(out, `${String(++made).padStart(2, "0")}-${name}.png`);
  const run = spawnSync(CHROME, ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1280,800", "--allow-file-access-from-files", `--screenshot=${target}`, pathToFileURL(page).href], { stdio: "ignore" });
  if (run.status !== 0 || !existsSync(target) || readFileSync(target).length < 1000) throw new Error(`Chrome couldn't render ${name}`);
  console.log(target);
}
rmSync(work, { recursive: true, force: true });
console.log(`${made} screenshots → ${out}`);
