#!/usr/bin/env node
/**
 * Packages the built extension for the stores, into store/out/:
 *   maxxing-wallet-chrome-<version>.zip   Chrome Web Store and Microsoft Edge Add-ons (dist/chrome)
 *   maxxing-wallet-firefox-<version>.zip  Firefox Add-ons (dist/firefox)
 *   maxxing-wallet-source-<version>.zip   the source AMO asks for (public repository only, see below)
 * and prints each file's SHA-256. Run after `pnpm build`.
 *
 * What is reproducible, exactly: the store zips are a fixed function of dist/ (files sorted, fixed timestamps, no extra
 * metadata), and dist/ is built from the commit with the lockfile's exact dependencies, so the same commit built with the same
 * Node and pnpm gives the same files and the same zips. CI prints the hashes for every commit to compare against.
 *
 * The source zip is `git archive` of the commit (committed files only; the working tree must be clean), made in the public
 * repository (github.com/maxxingdotad/maxxing-wallet), where the whole repository is the extension, the wallet core, the SDK and
 * the lockfile, and it installs and builds on its own with the steps in store/LISTING.md. In the private monorepo it is skipped.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(here, "store/out");
// In the public repository the source zip is the commit: refuse before writing anything if the tree has changes.
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
const isPublicRepo = (() => { try { return JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")).name === "@maxxing/wallet-core"; } catch { return false; } })();
if (isPublicRepo && execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) throw new Error("The working tree has uncommitted changes: commit them first, the source zip is the commit.");
mkdirSync(out, { recursive: true });
const version = JSON.parse(readFileSync(resolve(here, "public/manifest.json"), "utf8")).version;

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1; // 1980-01-01 00:00

/** A zip of these files (name → bytes), deflated, in name order. */
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data] of [...files].sort(([a], [b]) => a < b ? -1 : 1)) {
    const nameBytes = Buffer.from(name, "utf8"), packed = deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

function folder(dir) {
  const files = new Map();
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(relative(dir, path).split(sep).join("/"), readFileSync(path));
    }
  })(dir);
  return files;
}

const written = [];
const write = (name, files) => { const bytes = zip(files); writeFileSync(join(out, name), bytes); written.push([name, bytes]); };
for (const browser of ["chrome", "firefox"]) {
  const files = folder(resolve(here, "dist", browser));
  if (!files.has("manifest.json")) throw new Error(`dist/${browser} is missing: run the build first.`);
  write(`maxxing-wallet-${browser}-${version}.zip`, files);
}
// The source for AMO: the public repository at this commit, committed files only.
if (!isPublicRepo) console.log("Source zip skipped: make it in the public repository checkout (scripts/sync-public-wallet.mjs), where it builds on its own.");
else {
  const name = `maxxing-wallet-source-${version}.zip`;
  execFileSync("git", ["archive", "--format=zip", "-o", join(out, name), "HEAD"], { cwd: root });
  written.push([name, readFileSync(join(out, name))]);
}

for (const [name, bytes] of written) console.log(`${createHash("sha256").update(bytes).digest("hex")}  ${name}  (${(bytes.length / 1024).toFixed(0)} KB)`);
console.log(`→ ${out}`);
