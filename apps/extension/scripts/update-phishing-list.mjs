#!/usr/bin/env node
/**
 * Refreshes the lists the extension ships with; the background also refreshes both at run time, so these files are what a fresh
 * install uses before its first refresh. Run it before a release and commit the result:
 *
 *   node scripts/update-phishing-list.mjs
 *
 * - public/phishing/hosts.txt: one host per line, sorted, from a public phishing blocklist (Apache-2.0, public/phishing/NOTICE).
 * - public/psl/public_suffix_list.dat: the Public Suffix List's rules, with its license header (MPL-2.0, public/psl/NOTICE).
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BLOCKLIST = "https://polkadot.js.org/phishing/all.json";
const PSL = "https://publicsuffix.org/list/public_suffix_list.dat";
const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const get = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r; };

const { deny } = await (await get(BLOCKLIST)).json();
if (!Array.isArray(deny) || deny.length < 1000) throw new Error("The blocklist looks wrong: fewer than 1000 hosts.");
// Host names only. A label longer than DNS allows (63), or one that is 32+ hex digits (shaped like a key, so the public sync's
// secret check would rightly refuse it), is left out.
const shaped = h => /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(h) && h.split(".").every(l => l.length <= 63 && !/^[0-9a-f]{32,}$/.test(l));
const hosts = [...new Set(deny.filter(h => typeof h === "string").map(h => h.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "")).filter(h => shaped(h) && h !== "maxxing.ad" && !h.endsWith(".maxxing.ad")))].sort();
writeFileSync(resolve(here, "public/phishing/hosts.txt"), hosts.join("\n") + "\n");
console.log(`${hosts.length} hosts from ${BLOCKLIST}`);

const psl = await (await get(PSL)).text();
if (!psl.includes("// ===BEGIN ICANN DOMAINS===") || !psl.includes("\nco.uk\n")) throw new Error("The public suffix list looks wrong.");
// Shipped as rules only: the license header (first three lines, kept as published), then one rule per line, comments dropped.
const lines = psl.replace(/\r\n/g, "\n").split("\n");
const rules = lines.slice(3).map(l => l.trim().split(/\s/)[0]).filter(l => l && !l.startsWith("//"));
writeFileSync(resolve(here, "public/psl/public_suffix_list.dat"), [...lines.slice(0, 3), ...rules].join("\n") + "\n");
console.log(`public suffix list: ${psl.split("\n").filter(l => l && !l.startsWith("//")).length} rules from ${PSL}`);
