#!/usr/bin/env node
/**
 * Builds the extension into dist/<browser>/, ready to load unpacked or to zip for a store.
 *
 *   tsx scripts/build.mjs            Chrome and Edge (dist/chrome)
 *   tsx scripts/build.mjs firefox    Firefox (dist/firefox)
 * (tsx, because the CSP is built from the chain registry's TypeScript sources: src/lib/csp.ts)
 *
 * The pages come from vite.config.ts. The background, the content script and the in-page script are each built as one file with
 * no imports, as browsers require for those. The same tagged commit always builds the same files: no timestamps, no random names
 * (Rollup's content hashes), and the lockfile pins every dependency.
 */
import { build } from "vite";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browser = process.argv[2] === "firefox" ? "firefox" : "chrome";
const out = resolve(here, "dist", browser);
rmSync(out, { recursive: true, force: true });

// The pages (and everything in public/: manifest, icons, fonts).
await build({ root: here, configFile: resolve(here, "vite.config.ts"), logLevel: "warn", build: { outDir: out, emptyOutDir: true } });

// The scripts: one file each.
const script = (entry, name, format) => build({
  root: here, configFile: false, logLevel: "warn", publicDir: false,
  esbuild: { jsx: "automatic" },
  build: { outDir: out, emptyOutDir: false, sourcemap: false, target: "es2022", minify: true, lib: { entry: resolve(here, entry), formats: [format], name: name.replace(/\W/g, "_"), fileName: () => `${name}.js` }, rollupOptions: { output: { inlineDynamicImports: true } } },
});
await script("src/background.ts", "background", "es");
await script("src/content.ts", "content", "iife");
await script("src/inpage.ts", "inpage", "iife");

// The pages' Content-Security-Policy: connections only to the chain registry's public RPC origins and the named services.
const manifest = JSON.parse(readFileSync(resolve(out, "manifest.json"), "utf8"));
const { extensionCsp } = await import("../src/lib/csp.ts");
manifest.content_security_policy = { extension_pages: extensionCsp() };
// Firefox: a background script instead of a service worker, its sidebar instead of the side panel, and its own extension id.
// It has no offscreen documents, so secrets get no Copy button there (src/app/kit.tsx).
if (browser === "firefox") {
  manifest.background = { scripts: ["background.js"], type: "module" };
  delete manifest.side_panel;
  manifest.sidebar_action = { default_panel: "sidepanel.html", default_title: "MAXXING Wallet", default_icon: manifest.icons };
  manifest.permissions = manifest.permissions.filter(p => p !== "sidePanel" && p !== "offscreen");
  rmSync(resolve(out, "offscreen.html"), { force: true });
  manifest.browser_specific_settings = { gecko: { id: "wallet@maxxing.ad", strict_min_version: "128.0" } };
  delete manifest.minimum_chrome_version;
}
writeFileSync(resolve(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
// The design gallery and the dev page are for development only (vite.config.ts leaves them out; this makes sure).
rmSync(resolve(out, "design.html"), { force: true });
rmSync(resolve(out, "dev.html"), { force: true });
cpSync(resolve(here, "LICENSE"), resolve(out, "LICENSE"));
console.log(`MAXXING Wallet ${manifest.version} for ${browser}: ${out}`);
