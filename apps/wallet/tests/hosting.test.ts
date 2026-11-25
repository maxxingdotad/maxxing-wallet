import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkVercelJson, cloudflareFile, pageFor, pageHeaders, PRODUCTION_ORIGINS, ROLLOUT, vercelHeaders } from "../hosting";

const header = (headers: { key: string; value: string }[], key: string) => headers.find(h => h.key === key)?.value;

test("vercel.json is hosting.ts: no hand edits drift from the one source", () => {
  assert.doesNotThrow(() => checkVercelJson());
  // Each page kind's rule exists and its policy reports to the API.
  for (const rule of vercelHeaders()) if (rule.source !== "/assets/(.*)") assert.match(header(rule.headers, "Reporting-Endpoints")!, /^csp="https:\/\/api\.maxxing\.ad\/v1\/csp-report\?site=wallet"$/);
});

test("the full policies: only own scripts and styles, Trusted Types, nothing inline, nothing else framed or framing", () => {
  for (const page of ["frame", "window", "preview"] as const) {
    const csp = header(pageHeaders(page, PRODUCTION_ORIGINS, "enforce"), "Content-Security-Policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src 'self';/);
    assert.match(csp, /require-trusted-types-for 'script'; trusted-types 'none'/);
    for (const directive of ["object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'"]) assert.ok(csp.includes(directive), `${page}: ${directive}`);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*|https:(?!\/\/)/);
  }
  const csp = (page: "frame" | "window" | "preview") => header(pageHeaders(page, PRODUCTION_ORIGINS, "enforce"), "Content-Security-Policy")!;
  // The key-holding frame: embedded only by maxxing.ad, talks to nothing.
  assert.match(csp("frame"), /connect-src 'self';/);
  assert.match(csp("frame"), /frame-ancestors https:\/\/maxxing\.ad https:\/\/www\.maxxing\.ad;/);
  // The wallet window: no one embeds it, it reads only the API.
  assert.match(csp("window"), /connect-src 'self' https:\/\/api\.maxxing\.ad;/);
  assert.match(csp("window"), /frame-ancestors 'none'/);
  assert.equal(header(pageHeaders("window", PRODUCTION_ORIGINS), "Cross-Origin-Opener-Policy"), "unsafe-none");
  assert.match(csp("preview"), /frame-ancestors https:\/\/developers\.maxxing\.ad;/);
});

test("while reporting, the policy enforced before stays enforced", () => {
  const headers = pageHeaders("frame", PRODUCTION_ORIGINS, "report-only");
  assert.equal(header(headers, "Content-Security-Policy"), "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://maxxing.ad https://www.maxxing.ad");
  assert.match(header(headers, "Content-Security-Policy-Report-Only")!, /trusted-types 'none'; report-uri https:\/\/api\.maxxing\.ad\/v1\/csp-report\?site=wallet; report-to csp$/);
  assert.equal(ROLLOUT === "enforce" || ROLLOUT === "report-only", true);
  for (const page of ["frame", "window", "preview"] as const) {
    const all = pageHeaders(page, PRODUCTION_ORIGINS);
    assert.equal(header(all, "Strict-Transport-Security"), "max-age=63072000; includeSubDomains; preload");
    assert.equal(header(all, "X-Content-Type-Options"), "nosniff");
    assert.equal(header(all, "Referrer-Policy"), "no-referrer");
    assert.match(header(all, "Permissions-Policy")!, /camera=\(\).*payment=\(\).*usb=\(\)/);
  }
});

test("the wallet's hosting is self-contained: it builds from the public repository, which has no packages/config", () => {
  for (const file of ["../hosting.ts", "../vite.config.ts", "../web-security.ts", "./hosting.test.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(text, /from\s+["'](\.\.\/){2,}(packages|apps)\//, file);
    // The public sync refuses any mention of the monorepo's private apps, comments included.
    assert.doesNotMatch(text, /\bapps\/(api|web|admin|worker|mobile)\//, file);
  }
});

test("paths map to their page, and Cloudflare gets the same rules", () => {
  assert.equal(pageFor("/"), "frame");
  assert.equal(pageFor("/index.html"), "frame");
  for (const path of ["/connect.html", "/connect", "/apps.html", "/login", "/window.css"]) assert.equal(pageFor(path), "window", path);
  assert.equal(pageFor("/preview"), "preview");
  assert.equal(pageFor("/connect.html.evil"), "frame");
  const cf = cloudflareFile();
  for (const rule of ["/*", "/connect.html", "/connect", "/login", "/preview.html", "/assets/*"]) assert.ok(cf.includes(`\n${rule}\n`), rule);
  assert.ok(cf.includes("  ! Content-Security-Policy\n") && cf.includes("frame-ancestors 'none'"));
});
