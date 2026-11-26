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

const FRAMES = [
  ["08-home", "Every chain, one balance", "Ethereum, Base, Solana and every network in MAXXING's list."],
  ["08d-network-picker", "All networks, or just one", "Pick a network and every screen follows it."],
  ["08h-token-detail", "Every token at a glance", "Price, 24h and 7-day chart, and what you hold on each network."],
  ["08k-send-review", "Know exactly what you send", "Recipient checks, the most the fee can be, and its value in dollars."],
  ["08g-receive-base", "Receive on the right network", "Your address with a QR code, and a warning to send only on that network."],
]; // The Chrome Web Store shows at most five.

const cap = pathToFileURL(resolve(here, "public/brand/cap.webp")).href;
const font = pathToFileURL(resolve(here, "public/fonts")).href;
const work = mkdtempSync(join(tmpdir(), "maxxing-store-shots-"));
let made = 0;
for (const [name, title, sub] of FRAMES) {
  const image = join(shots, `${name}.png`);
  if (!existsSync(image)) { console.warn(`skipped ${name}: no ${image}`); continue; }
  const html = `<!doctype html><meta charset="utf-8"><style>
    @font-face { font-family: Inter; src: url("${font}/Inter.var.woff2") format("woff2"); }
    html, body { margin: 0; width: 1280px; height: 800px; overflow: hidden; }
    body { background: radial-gradient(1000px 700px at 75% 20%, #1d1f25 0%, #0b0c0f 60%); color: #f4f2ee; font-family: Inter, system-ui, sans-serif; display: flex; align-items: center; }
    .text { width: 560px; padding-left: 96px; }
    .text img { width: 72px; filter: drop-shadow(0 8px 16px rgb(0 0 0 / .6)); }
    h1 { font-size: 46px; line-height: 1.08; letter-spacing: -0.02em; margin: 24px 0 14px; font-weight: 700; }
    p { font-size: 20px; line-height: 1.45; color: #a9abb2; margin: 0; }
    .shot { margin-left: 70px; height: 680px; border-radius: 22px; box-shadow: 0 30px 80px rgb(0 0 0 / .6), 0 0 0 1px rgb(255 255 255 / .06); }
  </style><div class="text"><img src="${cap}" alt=""><h1>${title}</h1><p>${sub}</p></div><img class="shot" src="${pathToFileURL(image).href}" alt="">`;
  const page = join(work, `${name}.html`);
  writeFileSync(page, html);
  const target = join(out, `${String(++made).padStart(2, "0")}-${name}.png`);
  const run = spawnSync(CHROME, ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=1280,800", "--allow-file-access-from-files", `--screenshot=${target}`, pathToFileURL(page).href], { stdio: "ignore" });
  if (run.status !== 0 || !existsSync(target) || readFileSync(target).length < 1000) throw new Error(`Chrome couldn't render ${name}`);
  console.log(target);
}
rmSync(work, { recursive: true, force: true });
console.log(`${made} screenshots → ${out}`);
