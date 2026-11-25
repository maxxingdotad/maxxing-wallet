/**
 * The phishing blocklist as the background uses it: the copy shipped with the extension, joined with the latest refresh (kept in
 * the extension's IndexedDB). Refreshed twice a day from the same public list the shipped copy comes from. A refresh can only
 * add hosts, never drop the shipped ones, and an entry that is itself a public suffix ("vercel.app", "co.uk") is left out, since it
 * would block every site under it.
 */
import { parseList } from "./phishing";
import { publicSuffix, suffixRules, type SuffixRules } from "./psl";
import { kept } from "./store";

export const BLOCKLIST_SOURCE = "https://polkadot.js.org/phishing/all.json";
const MIN_HOSTS = 1000; // a list much shorter than the real one is a broken download, not good news

let cache: Set<string> | null = null;

/** Hosts that are a public suffix themselves are dropped: listing one would block every site under it. */
export function withoutSuffixes(hosts: Iterable<string>, rules: SuffixRules): Set<string> {
  const out = new Set<string>();
  for (const h of hosts) if (publicSuffix(h, rules) !== h) out.add(h);
  return out;
}

const shipped = () => fetch(chrome.runtime.getURL("phishing/hosts.txt")).then(r => r.text()).then(parseList).catch(() => new Set<string>());

export async function blocklist(): Promise<Set<string>> {
  if (cache) return cache;
  const [base, saved, rules] = await Promise.all([shipped(), kept.get<{ at: number; text: string } | null>("phishing-list", null).catch(() => null), suffixRules()]);
  cache = withoutSuffixes([...base, ...(saved ? parseList(saved.text) : [])], rules);
  return cache;
}

/** Downloads the latest list and joins it with the shipped one; keeps the current list when the download fails or looks wrong. */
export async function refreshBlocklist(): Promise<number> {
  const response = await fetch(BLOCKLIST_SOURCE, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!response.ok) throw new Error(`Blocklist refresh failed (${response.status}).`);
  const fresh = parseList(await response.text());
  if (fresh.size < MIN_HOSTS) throw new Error("Blocklist refresh looked wrong; kept the current list.");
  const [base, rules] = await Promise.all([shipped(), suffixRules()]);
  const hosts = withoutSuffixes([...base, ...fresh], rules);
  await kept.set("phishing-list", { at: Date.now(), text: [...fresh].join("\n") });
  cache = hosts;
  return hosts.size;
}
