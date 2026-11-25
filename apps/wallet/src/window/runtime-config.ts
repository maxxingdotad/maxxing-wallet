/**
 * Admin-managed values the wallet window reads (docs/54): the public settings from GET /v1/config, so they change without a
 * rebuild. Only display values come from here (today the website address behind "Open MAXXING"); nothing that decides what the
 * wallet trusts or signs: app origins, the API address and the security policy stay in the build.
 */
import { DEFAULT_WEBSITE, websiteLink } from "@maxxing/wallet-core/app-links";

let values: Record<string, unknown> = {};
let loading: Promise<void> | null = null;

/** Fetches the values once (later calls reuse it). Never throws: the built-in values stay. */
export function loadRuntimeConfig(apiUrl: string, send: typeof fetch = globalThis.fetch): Promise<void> {
  return loading ??= send(`${apiUrl.replace(/\/$/, "")}/v1/config`, { credentials: "omit", referrerPolicy: "no-referrer", headers: { accept: "application/json" } })
    .then(response => response.ok ? response.json() : null)
    .then((result: { values?: unknown } | null) => {
      if (result?.values && typeof result.values === "object") values = result.values as Record<string, unknown>;
    })
    .catch(() => undefined);
}

/**
 * The MAXXING website: Settings → Apps → "Website address" (`links.website`, https only). A development build keeps its local site;
 * otherwise the build's VITE_PUBLIC_WEB_URL (or https://maxxing.ad) until the admin value has loaded.
 */
export function websiteUrl(env: { DEV?: boolean; VITE_PUBLIC_WEB_URL?: string } = import.meta.env ?? {}): string {
  const built = String(env.VITE_PUBLIC_WEB_URL || (env.DEV ? "http://localhost:5173" : DEFAULT_WEBSITE)).replace(/\/$/, "");
  return env.DEV ? built : websiteLink(values, built);
}

/** Test hook. */
export function resetRuntimeConfigForTest() { values = {}; loading = null; }
