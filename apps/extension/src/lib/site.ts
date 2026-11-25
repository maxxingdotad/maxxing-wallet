/**
 * A site's address as the approval window shows it. The part that says who the site is (the registrable domain, such as
 * "example.co.uk" or "app.vercel.app") is shown whole and large; the full address is shown under it, wrapped, never cut short,
 * because the end of a host name is the part a look-alike changes.
 */
import { unicodeHost } from "./phishing";

/** Suffixes under which anyone can register a name, so the name one label further left is the site's own. */
const SHARED_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk", "com.au", "net.au", "org.au", "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp",
  "co.kr", "or.kr", "com.br", "net.br", "com.cn", "net.cn", "com.hk", "com.sg", "com.tw", "com.tr", "com.mx", "com.ar", "com.co", "co.in",
  "net.in", "co.za", "co.id", "com.my", "com.ph", "com.vn", "com.ua", "com.pl", "co.il", "com.sa", "com.eg", "com.ng", "co.ke",
  // Hosting where every customer gets a subdomain
  "github.io", "gitlab.io", "vercel.app", "netlify.app", "pages.dev", "workers.dev", "web.app", "firebaseapp.com", "herokuapp.com",
  "onrender.com", "fly.dev", "azurewebsites.net", "cloudfront.net", "appspot.com", "blogspot.com",
  "replit.app", "glitch.me", "surge.sh", "ipfs.io", "fleek.co", "on.fleek.co", "webflow.io", "framer.app", "wixsite.com", "myshopify.com",
]);

export type SiteName = { domain: string; host: string; address: string; insecure: boolean; unicode: string | null };

export function siteName(origin: string): SiteName {
  let url: URL;
  try { url = new URL(origin); } catch { return { domain: origin, host: origin, address: origin, insecure: false, unicode: null }; }
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[");
  let domain = host;
  if (!local && !ip) {
    const labels = host.split(".");
    let take = 2;
    for (let n = labels.length - 1; n >= 2; n--) if (SHARED_SUFFIXES.has(labels.slice(-n).join("."))) { take = n + 1; break; }
    domain = labels.slice(-take).join(".");
  }
  const decoded = unicodeHost(host);
  return { domain, host, address: url.origin, insecure: url.protocol !== "https:" && !local, unicode: decoded !== host ? decoded : null };
}
