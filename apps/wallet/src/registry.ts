/**
 * Apps allowed to use this wallet, and the websites each may use it from.
 *
 * MAXXING is built in: it embeds this site in a hidden frame, which shows the user every signature request for approval
 * (unless the user turned on one-tap trading for the wallet; see consent.ts). Every other app is registered by its developer
 * in the developer dashboard, reviewed by MAXXING, and read here from the API. Those apps never embed the frame; they open
 * the wallet window, where the user approves them and confirms each signature.
 * VITE_WALLET_APPS (JSON array of {id,name,origins}) replaces the built-in first-party list at build time; every build
 * publishes the list it uses at /first-party-apps.json (vite.config.ts), so a changed list can't go unseen.
 */
import { BUILT_IN_APPS, parseFirstPartyApps, type WalletApp } from "./first-party";
export type { WalletApp };
export type WalletAppStatus = "pending" | "live" | "suspended";
export type PartnerApp = WalletApp & { status: WalletAppStatus; logoUrl: string | null; builtIn: boolean };

const env = import.meta.env ?? ({} as ImportMetaEnv);

const PRODUCTION = BUILT_IN_APPS.production;
const DEVELOPMENT = BUILT_IN_APPS.development;

function configured(): WalletApp[] {
  const raw = env.VITE_WALLET_APPS as string | undefined;
  if (raw) {
    const parsed = parseFirstPartyApps(raw, Boolean(env.DEV));
    if (parsed) return parsed;
    // The build refuses such a list (vite.config.ts); this only shows if one got past it.
    console.error("MAXXING wallet: VITE_WALLET_APPS is not a valid list of https apps; using the built-in list.");
  }
  return env.DEV ? DEVELOPMENT : PRODUCTION;
}

/** First-party apps: they embed the frame. Their requests are shown for approval unless the user turned on one-tap trading. */
export const WALLET_APPS = configured();

export function appForOrigin(origin: string): WalletApp | null {
  return WALLET_APPS.find(app => app.origins.includes(origin)) ?? null;
}

const csvOrigins = (value: string | undefined) => (value ?? "").split(",").map(v => { try { return new URL(v.trim()).origin; } catch { return ""; } }).filter(Boolean);

/** MAXXING's own sites that use the wallet window like any partner: the developer dashboard. */
const BUILT_IN_WINDOW_APPS: PartnerApp[] = [{
  id: "maxxing-developers", name: "MAXXING Developers", status: "live", logoUrl: null, builtIn: true,
  origins: csvOrigins(env.VITE_DEVELOPERS_URL as string | undefined).length ? csvOrigins(env.VITE_DEVELOPERS_URL as string | undefined)
    : env.DEV ? ["http://localhost:5177", "http://127.0.0.1:5177"] : ["https://developers.maxxing.ad"],
}];

export const API_URL = String(env.VITE_API_URL || (env.DEV ? "http://localhost:4000" : "https://api.maxxing.ad")).replace(/\/$/, "");
/**
 * Development builds answer every registered origin of an app in review. Production builds answer an app in review only from
 * `http(s)://localhost[:port]` / `http(s)://127.0.0.1[:port]` (test mode, so its developer can try it before it goes live), and a
 * live app only from its public sites. Same rule as the API's `servingOrigins`.
 */
export const ALLOW_APPS_IN_REVIEW = env.VITE_WALLET_ALLOW_APPS_IN_REVIEW ? env.VITE_WALLET_ALLOW_APPS_IN_REVIEW === "true" : Boolean(env.DEV);

/** A developer's own computer. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch { return false; }
}

const cache = new Map<string, { at: number; app: Promise<PartnerApp | null> }>();
const CACHE_MS = 60_000;

function parseApp(id: string, body: unknown): PartnerApp | null {
  const app = body as Partial<PartnerApp>;
  if (!app || app.id !== id || typeof app.name !== "string" || !Array.isArray(app.origins) || !app.origins.every(o => typeof o === "string" && /^https?:\/\/[^/]+$/.test(o))) return null;
  if (app.status !== "pending" && app.status !== "live" && app.status !== "suspended") return null;
  const logoUrl = typeof app.logoUrl === "string" && app.logoUrl.startsWith(`/v1/wallet-apps/${id}/logo`) ? `${API_URL}${app.logoUrl}` : null;
  return { id, name: app.name.slice(0, 40), origins: app.origins, status: app.status, logoUrl, builtIn: false };
}

/** A partner app's public record from the API, cached briefly. Null when it does not exist. */
export function loadPartnerApp(id: string, fetcher: typeof fetch = fetch): Promise<PartnerApp | null> {
  const builtIn = BUILT_IN_WINDOW_APPS.find(app => app.id === id);
  if (builtIn) return Promise.resolve(builtIn);
  if (!/^app_[0-9a-f]{20}$/.test(id)) return Promise.resolve(null);
  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.app;
  const app = fetcher(`${API_URL}/v1/wallet-apps/${id}`, { credentials: "omit", referrerPolicy: "no-referrer" })
    .then(async response => {
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("WALLET_APP_LOOKUP_FAILED");
      return parseApp(id, await response.json());
    });
  cache.set(id, { at: Date.now(), app });
  app.catch(() => cache.delete(id));
  return app;
}

export type AppCheck = { ok: true; app: PartnerApp; inReview: boolean } | { ok: false; reason: "unknown" | "suspended" | "in_review" | "wrong_site" };
/** Whether a request from `origin` may speak for app `id`. `allowAllInReview`: development builds (tests pass it). */
export function checkPartnerApp(app: PartnerApp | null, origin: string, allowAllInReview = ALLOW_APPS_IN_REVIEW): AppCheck {
  if (!app) return { ok: false, reason: "unknown" };
  if (app.status === "suspended") return { ok: false, reason: "suspended" };
  if (!app.origins.includes(origin)) return { ok: false, reason: "wrong_site" };
  if (!allowAllInReview && !app.builtIn) {
    const local = isLocalOrigin(origin);
    // In review: test mode, from the developer's own computer only. Live: never from localhost, where anyone could pose as the app.
    if (app.status === "pending" && !local) return { ok: false, reason: "in_review" };
    if (app.status === "live" && local) return { ok: false, reason: "wrong_site" };
  }
  return { ok: true, app, inReview: app.status === "pending" };
}

/** Counts a connection or a signature for the developer's dashboard. Nothing about the user is sent. */
export function reportUsage(app: PartnerApp, kind: "connect" | "sign") {
  if (app.builtIn) return;
  void fetch(`${API_URL}/v1/wallet-apps/${app.id}/usage`, { method: "POST", credentials: "omit", keepalive: true, referrerPolicy: "no-referrer", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind }) }).catch(() => {});
}
