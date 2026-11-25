/**
 * The first-party app list (VITE_WALLET_APPS), read the same way by the frame (registry.ts) and by the build (vite.config.ts,
 * for frame-ancestors), so the two can never disagree. First-party apps sign without prompts: outside development every
 * origin must be https.
 */
export type WalletApp = { id: string; name: string; origins: string[] };

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
