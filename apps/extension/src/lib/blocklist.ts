/**
 * The phishing blocklist as the background uses it: the copy shipped with the extension until the first refresh, then the latest
 * refreshed copy (kept in the extension's IndexedDB). Refreshed twice a day from the same public list the shipped copy comes from.
 */
import { parseList } from "./phishing";
import { kept } from "./store";

export const BLOCKLIST_SOURCE = "https://polkadot.js.org/phishing/all.json";
const MIN_HOSTS = 1000; // a list much shorter than the real one is a broken download, not good news

let cache: Set<string> | null = null;

export async function blocklist(): Promise<Set<string>> {
  if (cache) return cache;
  const saved = await kept.get<{ at: number; text: string } | null>("phishing-list", null).catch(() => null);
  const text = saved?.text ?? await fetch(chrome.runtime.getURL("phishing/hosts.txt")).then(r => r.text()).catch(() => "");
  cache = parseList(text);
  return cache;
}

/** Downloads the latest list; keeps the current one when the download fails or looks wrong. */
export async function refreshBlocklist(): Promise<number> {
  const response = await fetch(BLOCKLIST_SOURCE, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!response.ok) throw new Error(`Blocklist refresh failed (${response.status}).`);
  const hosts = parseList(await response.text());
  if (hosts.size < MIN_HOSTS) throw new Error("Blocklist refresh looked wrong; kept the current list.");
  await kept.set("phishing-list", { at: Date.now(), text: [...hosts].join("\n") });
  cache = hosts;
  return hosts.size;
}
