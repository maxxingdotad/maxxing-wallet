/**
 * A site's address as the approval window shows it. The part that says who the site is (the registrable domain from the Public
 * Suffix List: "example.co.uk", or the tenant on shared hosting, "drainer.vercel.app") is shown whole and large; the full address
 * is shown under it, wrapped, never cut short, because the end of a host name is the part a look-alike changes.
 */
import { unicodeHost } from "./phishing";
import { registrableDomain, type SuffixRules } from "./psl";

export type SiteName = { domain: string; host: string; address: string; insecure: boolean; unicode: string | null };

export function siteName(origin: string, rules: SuffixRules): SiteName {
  let url: URL;
  try { url = new URL(origin); } catch { return { domain: origin, host: origin, address: origin, insecure: false, unicode: null }; }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const domain = local ? host : registrableDomain(host, rules);
  const decoded = unicodeHost(host);
  return { domain, host, address: url.origin, insecure: url.protocol !== "https:" && !local, unicode: decoded !== host ? decoded : null };
}
