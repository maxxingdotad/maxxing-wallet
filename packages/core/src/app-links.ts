/**
 * The one rule for MAXXING's public links: the website, the support address and the status page. MAXXING's settings are checked
 * with these same patterns when they are saved, and every MAXXING app reads the saved values through these helpers, so a link is
 * shown only if it is a valid https page or email address. No imports, so the wallet builds on its own.
 */
export const DEFAULT_WEBSITE = "https://maxxing.ad";
export const DEFAULT_SUPPORT = "support@maxxing.ad";

/** An email address (no scheme, no path) or an https page. */
export const SUPPORT_LINK_PATTERN = "[^\\s@/:]+@[^\\s@/]+\\.[^\\s@/]+|https://\\S+";
/** An https page. */
export const HTTPS_LINK_PATTERN = "https://\\S+";

const EMAIL = /^[^\s@/:]+@[^\s@/]+\.[^\s@/]+$/;

/** A trimmed https address without credentials, or null for anything else (http, javascript:, relative, not text). */
export function httpsLink(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^https:\/\/\S+$/i.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? text : null;
  } catch {
    return null;
  }
}

/** Where Support goes: an email address becomes `mailto:` (with an optional subject), an https page stays; else no link. */
export function supportHref(value: unknown, subject?: string): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (EMAIL.test(text)) return `mailto:${text}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
  return httpsLink(text);
}

/**
 * Support (`links.support`, default support@maxxing.ad) and status page (`links.status`, default none) from the public settings.
 * A value admin cleared (empty) hides the link.
 */
export function helpLinks(values: Record<string, unknown>, subject?: string): { support: string | null; status: string | null } {
  const support = values["links.support"];
  return { support: supportHref(support === undefined || support === null ? DEFAULT_SUPPORT : support, subject), status: httpsLink(values["links.status"]) };
}

/** The website (`links.website`) without a trailing slash, or `fallback` while it is unknown or not an https address. */
export function websiteLink(values: Record<string, unknown>, fallback: string): string {
  return (httpsLink(values["links.website"]) ?? fallback).replace(/\/+$/, "");
}
