import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { baseHeaders, cloudflareHeaders, cspHeaders, cspReportUrl, type Header, type Policy, type Rollout } from "./web-security";
import { BUILT_IN_APPS } from "./src/first-party";

/**
 * How wallet.maxxing.ad is served: one source for every page's security headers (vercel.json, the Cloudflare fallback's
 * `_headers` and `vite preview`). This site holds the keys, so it is locked down hardest:
 * - nothing but its own scripts and styles; no inline code, no eval, no plugins, no `<base>`, no forms;
 * - Trusted Types: no string ever becomes HTML or script (`require-trusted-types-for 'script'`, and no policy may be created);
 * - the hidden frame (index.html) may be embedded only by the first-party apps and talks to nothing;
 * - the wallet window (connect, apps, login) may be embedded by no one and talks only to the API;
 * - the dashboard preview may be embedded only by the developer dashboard.
 * `ROLLOUT`: while "report-only", the policies the site enforced before stay enforced (`BASELINE`) and the browser reports
 * what the stricter ones would block. Switch to "enforce" when the reports are clean, then run `pnpm --filter
 * @maxxing/wallet-frame hosting:sync`.
 */
export const ROLLOUT: Rollout = "report-only";

export type Origins = { api: string; firstParty: string[]; dashboards: string[] };
export const PRODUCTION_ORIGINS: Origins = {
  api: "https://api.maxxing.ad",
  firstParty: BUILT_IN_APPS.production.flatMap(app => app.origins),
  dashboards: ["https://developers.maxxing.ad"],
};

export type Page = "frame" | "window" | "preview";
const locked = (connect: string[], img: string[], ancestors: string[]): Policy => ({
  "default-src": ["'none'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "img-src": ["'self'", "data:", ...img],
  "font-src": ["'self'"],
  "connect-src": ["'self'", ...connect],
  "frame-src": ["'none'"],
  "worker-src": ["'none'"],
  "manifest-src": ["'none'"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ancestors,
  "require-trusted-types-for": ["'script'"],
  "trusted-types": ["'none'"],
});

export function policy(page: Page, o: Origins): Policy {
  if (page === "frame") return locked([], [], o.firstParty);
  if (page === "window") return locked([o.api], [o.api], ["'none'"]);
  return locked([], [o.api], o.dashboards);
}

/** What the site enforced before this policy (kept enforced while the stricter one is only reported). */
export function baseline(page: Page, o: Origins): Policy {
  const common = { "default-src": ["'self'"], "script-src": ["'self'"], "style-src": ["'self'"] };
  const tail = { "object-src": ["'none'"], "base-uri": ["'none'"], "form-action": ["'none'"] };
  if (page === "frame") return { ...common, "connect-src": ["'self'"], "img-src": ["'self'", "data:"], ...tail, "frame-ancestors": o.firstParty };
  if (page === "window") return { ...common, "connect-src": ["'self'", o.api], "img-src": ["'self'", "data:", o.api], ...tail, "frame-ancestors": ["'none'"] };
  return { ...common, "connect-src": ["'self'"], "img-src": ["'self'", "data:", o.api], ...tail, "frame-ancestors": o.dashboards };
}

export function pageHeaders(page: Page, o: Origins, rollout: Rollout = ROLLOUT): Header[] {
  return [
    ...cspHeaders({ policy: policy(page, o), baseline: baseline(page, o), rollout, reportUrl: cspReportUrl(o.api, "wallet") }),
    // The wallet window is opened by partner sites and must keep `window.opener` to answer them.
    ...(page === "window" ? [{ key: "Cross-Origin-Opener-Policy", value: "unsafe-none" }] : []),
    // Only MAXXING's own sites may load this site's files (images, scripts) into their pages.
    { key: "Cross-Origin-Resource-Policy", value: "same-site" },
    ...baseHeaders("no-referrer"),
  ];
}

/** Which page a path is. The window's stylesheet gets the window's headers. */
export function pageFor(path: string): Page {
  if (/^\/preview(\.html)?$/.test(path)) return "preview";
  if (/^\/(connect|apps|login)(\.html)?$/.test(path) || path === "/window.css") return "window";
  return "frame";
}

const WINDOW_FILES = ["connect.html", "apps.html", "login.html", "window.css"];
/** vercel.json's `headers`. Vercel has no clean URLs here, so only the `.html` addresses exist. */
export function vercelHeaders(o: Origins = PRODUCTION_ORIGINS, rollout: Rollout = ROLLOUT) {
  return [
    { source: "/((?!connect\\.html|apps\\.html|login\\.html|preview\\.html|preview$|window\\.css).*)", headers: pageHeaders("frame", o, rollout) },
    { source: `/(${WINDOW_FILES.map(f => f.replace(".", "\\.")).join("|")})`, headers: pageHeaders("window", o, rollout) },
    { source: "/(preview\\.html|preview)", headers: pageHeaders("preview", o, rollout) },
    { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
  ];
}

/** The Cloudflare fallback's `_headers` (Cloudflare serves clean URLs, so both spellings get a rule). */
export function cloudflareFile(o: Origins = PRODUCTION_ORIGINS, rollout: Rollout = ROLLOUT) {
  const windowPaths = [...WINDOW_FILES.map(f => `/${f}`), "/connect", "/apps", "/login"];
  return cloudflareHeaders("Written at build time from apps/wallet-frame/hosting.ts. Do not edit dist/_headers by hand.", [
    { paths: ["/*"], headers: pageHeaders("frame", o, rollout) },
    { paths: windowPaths, headers: pageHeaders("window", o, rollout) },
    { paths: ["/preview", "/preview.html"], headers: pageHeaders("preview", o, rollout) },
    { paths: ["/assets/*"], headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
  ]);
}

const VERCEL_JSON = new URL("./vercel.json", import.meta.url);
/** Throws when vercel.json is not what this file produces. */
export function checkVercelJson() {
  const json = JSON.parse(readFileSync(VERCEL_JSON, "utf8")) as { headers?: unknown };
  if (JSON.stringify(json.headers) !== JSON.stringify(vercelHeaders()))
    throw new Error("apps/wallet-frame/vercel.json headers differ from hosting.ts. Run: pnpm hosting:sync (in this folder or the monorepo root)");
}
/** Rewrites vercel.json's headers from this file; true when it changed (`hosting:sync`, run by the monorepo's `pnpm preflight`). */
export function syncVercelJson(): boolean {
  const before = readFileSync(VERCEL_JSON, "utf8");
  const after = `${JSON.stringify({ ...JSON.parse(before), headers: vercelHeaders() }, null, 2)}\n`;
  if (before.replace(/\r\n/g, "\n") === after) return false;
  writeFileSync(VERCEL_JSON, after);
  return true;
}
if (process.argv.includes("--sync") && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(syncVercelJson() ? "apps/wallet-frame/vercel.json updated from hosting.ts: commit it." : "apps/wallet-frame/vercel.json is up to date.");
