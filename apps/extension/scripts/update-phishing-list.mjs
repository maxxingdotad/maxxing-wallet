#!/usr/bin/env node
/**
 * Refreshes the blocklist the extension ships with: public/phishing/hosts.txt, one host per line, sorted, from the polkadot.js
 * phishing list (Apache-2.0, see public/phishing/NOTICE). The background also refreshes it at run time, so this file is the
 * starting point a fresh install uses before its first refresh. Run it before a release and commit the result:
 *
 *   node scripts/update-phishing-list.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE = "https://polkadot.js.org/phishing/all.json";
const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`${SOURCE}: ${response.status}`);
const { deny } = await response.json();
if (!Array.isArray(deny) || deny.length < 1000) throw new Error("The list looks wrong: fewer than 1000 hosts.");
const hosts = [...new Set(deny.filter(h => typeof h === "string").map(h => h.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "")).filter(h => /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(h) && h !== "maxxing.ad" && !h.endsWith(".maxxing.ad")))].sort();
writeFileSync(resolve(here, "public/phishing/hosts.txt"), hosts.join("\n") + "\n");
console.log(`${hosts.length} hosts from ${SOURCE}`);
