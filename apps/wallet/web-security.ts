/**
 * Security headers for MAXXING's websites (maxxing.ad, admin, wallet), one source per site.
 *
 * Each site keeps a `hosting.ts` that describes its pages with these helpers. From it come:
 * - the host's headers (vercel.json, checked by the site's tests and by its build, so the file can't drift),
 * - the Cloudflare fallback's `_headers` (written at build time),
 * - the local production preview's headers (`vite preview`), so a preview behaves like the live site.
 *
 * A policy is rolled out in two steps. While `rollout` is "report-only" the site enforces its `baseline` (what it enforced before)
 * and the browser only reports what the full `policy` would block; with "enforce" the full policy is enforced. Reports go to the
 * API's `/v1/csp-report` either way, so a regression after enforcing is seen too.
 * This file is plain TypeScript with no Node or browser APIs: Cloudflare Workers, Vite and tests all import it.
 * The wallet is also published on its own (github.com/maxxingdotad/maxxing-wallet), so it keeps an identical copy of this file
 * next to its hosting.ts; the monorepo's tests fail if the two differ.
 */
export type Header = { key: string; value: string };
/** Directive → sources. A directive with no sources (`upgrade-insecure-requests`) is written alone. */
export type Policy = Record<string, readonly string[]>;
export type Rollout = "report-only" | "enforce";

export const HSTS = "max-age=63072000; includeSubDomains; preload";
/** Powerful features none of the sites use. Passkeys (publickey-credentials-*) keep the browser default (own origin). */
export const PERMISSIONS_POLICY = [
  "accelerometer", "browsing-topics", "camera", "display-capture", "geolocation", "gyroscope", "hid", "magnetometer", "microphone",
  "midi", "payment", "serial", "usb",
].map(feature => `${feature}=()`).join(", ");

/** The reporting group named in `report-to`. */
export const CSP_REPORT_GROUP = "csp";

export function serializePolicy(policy: Policy): string {
  return Object.entries(policy).map(([directive, sources]) => [directive, ...sources].join(" ")).join("; ");
}

/** Where a site's browsers send violation reports: the API, tagged with the site (no user data in the address). */
export function cspReportUrl(apiOrigin: string, site: string): string {
  return `${new URL(apiOrigin).origin}/v1/csp-report?site=${encodeURIComponent(site)}`;
}

/**
 * The Content-Security-Policy headers for one kind of page, and its Cross-Origin-Opener-Policy when it gets a new one (rolled out
 * the same way: reported first). `report-uri` serves browsers without the Reporting API; browsers with it use `report-to` and
 * ignore `report-uri`.
 */
export function cspHeaders(input: { policy: Policy; baseline: Policy; rollout: Rollout; reportUrl: string; coop?: string }): Header[] {
  const reported = `${serializePolicy(input.policy)}; report-uri ${input.reportUrl}; report-to ${CSP_REPORT_GROUP}`;
  const enforce = input.rollout === "enforce";
  const csp = enforce
    ? [{ key: "Content-Security-Policy", value: reported }]
    : [{ key: "Content-Security-Policy", value: serializePolicy(input.baseline) }, { key: "Content-Security-Policy-Report-Only", value: reported }];
  const coop = input.coop ? [{ key: enforce ? "Cross-Origin-Opener-Policy" : "Cross-Origin-Opener-Policy-Report-Only", value: `${input.coop}; report-to="${CSP_REPORT_GROUP}"` }] : [];
  return [...csp, ...coop, { key: "Reporting-Endpoints", value: `${CSP_REPORT_GROUP}="${input.reportUrl}"` }];
}

/** Headers every page of every site carries. */
export function baseHeaders(referrerPolicy: "no-referrer" | "strict-origin-when-cross-origin"): Header[] {
  return [
    { key: "Strict-Transport-Security", value: HSTS },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: referrerPolicy },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
  ];
}

/** `{ key, value }[]` as the object vercel.json's `routes[].headers` takes. */
export const headerObject = (headers: Header[]): Record<string, string> => Object.fromEntries(headers.map(h => [h.key, h.value]));

/**
 * Cloudflare's `_headers`. Cloudflare adds up the headers of every rule a path matches, so each rule after the first (`/*`)
 * first detaches the first rule's headers (`! Name`), then sets its own.
 */
export function cloudflareHeaders(comment: string, rules: { paths: string[]; headers: Header[] }[]): string {
  const [first, ...rest] = rules;
  if (!first) return "";
  const detach = first.headers.map(h => `  ! ${h.key}`);
  const block = (paths: string[], headers: Header[], detached: boolean) =>
    paths.flatMap(path => [path, ...(detached ? detach : []), ...headers.map(h => `  ${h.key}: ${h.value}`), ""]);
  return [`# ${comment}`, ...block(first.paths, first.headers, false), ...rest.flatMap(rule => block(rule.paths, rule.headers, rule.headers.some(h => first.headers.some(f => f.key === h.key))))].join("\n");
}

type Middleware = (req: { url?: string }, res: { setHeader(name: string, value: string): void }, next: () => void) => void;
type Server = { middlewares: { use(fn: Middleware): void } };

/**
 * The Vite plugin each site adds: in a production build it stops when the host config differs from hosting.ts (`check` throws
 * with what to run) and writes the Cloudflare `_headers`; `vite preview` serves the production headers.
 * MAXXING_CSP_ENFORCE=1 makes the preview enforce the full policy, to try enforcement locally before rolling it out.
 */
export function hostingPlugin(input: {
  name: string;
  /** The headers for a path, as the live site sends them (`enforce`: as after rollout). */
  headersFor: (path: string, enforce: boolean) => Header[];
  /** Throws when the checked-in host config is not what hosting.ts produces. */
  check?: () => void;
  /** Files to add to the build, such as `_headers`. */
  files?: () => Record<string, string>;
}) {
  let build = false;
  const enforce = () => (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.MAXXING_CSP_ENFORCE === "1";
  // Returns nothing: Vite would take a returned function for a middleware to add after its own.
  const serve = (server: Server): void => {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? "/").split(/[?#]/)[0] || "/";
      for (const header of input.headersFor(path, enforce())) res.setHeader(header.key, header.value);
      next();
    });
  };
  return {
    name: input.name,
    configResolved(config: { command: string }) { build = config.command === "build"; },
    buildStart() { if (build) input.check?.(); },
    configurePreviewServer: serve,
    generateBundle(this: { emitFile(file: { type: "asset"; fileName: string; source: string }): void }) {
      for (const [fileName, source] of Object.entries(input.files?.() ?? {})) this.emitFile({ type: "asset", fileName, source });
    },
  };
}
