/**
 * The Public Suffix List (publicsuffix.org, MPL-2.0): which endings anyone can register a name under, from "com" and "co.uk" to
 * shared hosting like "vercel.app" or "github.io". The registrable domain, the name that says who a site is, is one label more
 * than the longest matching suffix. Shipped in public/psl/ and refreshed by the background with the phishing blocklist.
 */
import { kept } from "./store";

export type SuffixRules = { normal: Set<string>; wildcard: Set<string>; exception: Set<string> };

export const PSL_SOURCE = "https://publicsuffix.org/list/public_suffix_list.dat";

export function parseSuffixList(text: string): SuffixRules {
  const rules: SuffixRules = { normal: new Set(), wildcard: new Set(), exception: new Set() };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().split(/\s/)[0]!.toLowerCase();
    if (!line || line.startsWith("//")) continue;
    const rule = toAscii(line);
    if (rule.startsWith("!")) rules.exception.add(rule.slice(1));
    else if (rule.startsWith("*.")) rules.wildcard.add(rule.slice(2));
    else rules.normal.add(rule);
  }
  return rules;
}

/** Rules are written in Unicode; hosts reach us as punycode. The URL parser does the conversion. */
function toAscii(rule: string) {
  if (/^[\x00-\x7f]*$/.test(rule)) return rule;
  const bang = rule.startsWith("!") ? "!" : "", star = rule.replace(/^!/, "").startsWith("*.") ? "*." : "";
  const body = rule.replace(/^!/, "").replace(/^\*\./, "");
  try { return bang + star + new URL(`http://${body}`).hostname; } catch { return rule; }
}

/** The public suffix of a host (the longest matching rule; an unlisted ending counts as one label). */
export function publicSuffix(host: string, rules: SuffixRules): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join("."), parent = labels.slice(i + 1).join(".");
    if (rules.exception.has(candidate)) return parent;
    if (rules.normal.has(candidate) || (parent && rules.wildcard.has(parent))) return candidate;
  }
  return labels.at(-1)!;
}

/** The registrable domain ("example.co.uk", "drainer.vercel.app"), or the host itself when it is only a suffix, an IP or local. */
export function registrableDomain(host: string, rules: SuffixRules): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[")) return h;
  const suffix = publicSuffix(h, rules);
  if (suffix === h) return h;
  const rest = h.slice(0, -(suffix.length + 1)).split(".");
  return `${rest.at(-1)}.${suffix}`;
}

/** The label that names the site: "example" in "app.example.co.uk". */
export const registrableLabel = (host: string, rules: SuffixRules) => registrableDomain(host, rules).split(".")[0]!;

// ── Loading: the latest refreshed copy, else the shipped one ─────────────────────────────────────────────────────────────
let cache: Promise<SuffixRules> | null = null;
export function suffixRules(): Promise<SuffixRules> {
  cache ??= (async () => {
    const saved = await kept.get<{ at: number; text: string } | null>("psl", null).catch(() => null);
    const text = saved?.text ?? await fetch(chrome.runtime.getURL("psl/public_suffix_list.dat")).then(r => r.text()).catch(() => "");
    return parseSuffixList(text);
  })();
  return cache;
}

const ruleCount = (r: SuffixRules) => r.normal.size + r.wildcard.size + r.exception.size;

/**
 * Whether a downloaded list can replace the current one: it has rules every real list has (normal, shared-hosting, wildcard and
 * exception kinds), and its size is within 10% of the current list's, so a truncated or swapped file can't change what the
 * approval window calls a site.
 */
export function plausibleUpdate(next: SuffixRules, current: SuffixRules): boolean {
  const known = next.normal.has("com") && next.normal.has("co.uk") && next.normal.has("github.io") && next.wildcard.has("ck") && next.exception.has("www.ck");
  const before = ruleCount(current), after = ruleCount(next);
  return known && after >= 5000 && (before === 0 || Math.abs(after - before) / before <= 0.1);
}

/** Downloads the latest list; keeps the current one when the download fails or looks wrong (plausibleUpdate). */
export async function refreshSuffixList(): Promise<number> {
  const response = await fetch(PSL_SOURCE, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!response.ok) throw new Error(`Public suffix list refresh failed (${response.status}).`);
  const text = await response.text();
  const rules = parseSuffixList(text);
  if (!plausibleUpdate(rules, await suffixRules())) throw new Error("Public suffix list looked wrong; kept the current one.");
  await kept.set("psl", { at: Date.now(), text });
  cache = Promise.resolve(rules);
  return ruleCount(rules);
}
