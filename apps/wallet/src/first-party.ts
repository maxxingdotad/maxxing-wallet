/**
 * The first-party app list (VITE_WALLET_APPS), read the same way by the frame (registry.ts) and by the build (vite.config.ts,
 * for frame-ancestors), so the two can never disagree. First-party apps sign without prompts: outside development every
 * origin must be https.
 */
export type WalletApp = { id: string; name: string; origins: string[] };

/**
 * The home site, built in. A build can replace this list with VITE_WALLET_APPS; every build publishes the list it uses
 * (first-party-apps.json). hosting.ts lets exactly the production origins embed the frame (frame-ancestors in vercel.json).
 */
export const BUILT_IN_APPS: { production: WalletApp[]; development: WalletApp[] } = {
  production: [{ id: "maxxing", name: "MAXXING", origins: ["https://maxxing.ad", "https://www.maxxing.ad"] }],
  development: [{ id: "maxxing", name: "MAXXING", origins: ["http://localhost:5173", "http://127.0.0.1:5173"] }],
};

/** The apps in `raw`, or null when it is not a valid list for this kind of build. */
export function parseFirstPartyApps(raw: string, development: boolean): WalletApp[] | null {
  const origin = development ? /^https?:\/\/[^/]+$/ : /^https:\/\/[^/]+$/;
  try {
    const parsed = JSON.parse(raw) as WalletApp[];
    const ok = Array.isArray(parsed) && parsed.length > 0 && parsed.every(app => app && typeof app.id === "string" && typeof app.name === "string"
      && Array.isArray(app.origins) && app.origins.length > 0 && app.origins.every(o => typeof o === "string" && origin.test(o)));
    return ok ? parsed : null;
  } catch { return null; }
}
