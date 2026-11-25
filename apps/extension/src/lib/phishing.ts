/**
 * Which sites the wallet stops before they can ask for anything. Both checks run on this device:
 * - a blocklist of known crypto phishing hosts and their subdomains: shipped with the extension (public/phishing/hosts.txt, from
 *   the polkadot.js phishing list, Apache-2.0) and refreshed by the background twice a day;
 * - sites made to look like MAXXING: the host is decoded from punycode, letters that look alike (Cyrillic and Greek letters,
 *   digits, "rn" for "m") are folded to one spelling, and anything that then reads "maxxing", or one letter away from it, is
 *   stopped unless it is on maxxing.ad itself.
 */
const OFFICIAL_DOMAIN = "maxxing.ad";
const TARGET = "maxxing";

export type SiteVerdict = { kind: "ok" } | { kind: "phishing"; reason: "listed" | "lookalike"; looksLike?: string };

// ── Punycode (RFC 3492), to read a host's xn-- labels as the letters a person sees ──────────────────────────────────────────
function punycodeDecode(input: string): string {
  const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
  const out: number[] = [];
  const basic = input.lastIndexOf("-");
  for (let j = 0; j < Math.max(basic, 0); j++) out.push(input.charCodeAt(j));
  let i = 0, n = 128, bias = 72;
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / damp) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    return Math.floor(k + ((base - tMin + 1) * delta) / (delta + skew));
  };
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const old = i;
    for (let w = 1, k = base; ; k += base) {
      if (index >= input.length) throw new Error("bad punycode");
      const c = input.charCodeAt(index++);
      const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
      if (digit >= base) throw new Error("bad punycode");
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    bias = adapt(i - old, out.length + 1, old === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}
export const unicodeHost = (host: string) => host.split(".").map(label => { try { return label.startsWith("xn--") ? punycodeDecode(label.slice(4)) : label; } catch { return label; } }).join(".");

// ── Look-alike letters folded to one spelling ──────────────────────────────────────────────────────────────────────────────
const CONFUSABLE: Record<string, string> = {
  // Cyrillic
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "ѕ": "s",
  "і": "i", "ї": "i", "ј": "j", "һ": "h", "ԁ": "d", "ӏ": "i", "ԛ": "q", "ԝ": "w", "п": "n", "г": "r",
  // Greek
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "μ": "m", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w",
  // Armenian and others that pass for Latin
  "ո": "n", "ս": "u", "օ": "o", "ı": "i", "ɩ": "i", "ł": "i", "ɡ": "g", "ɑ": "a", "ℓ": "i", "ⅰ": "i", "ⅼ": "i", "ⅿ": "m", "ⅹ": "x",
  // Digits and symbols
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "!": "i", "|": "i", "l": "i",
};
/** One spelling for everything that looks the same: accents dropped, look-alike letters folded, "rn" read as "m". */
export function skeleton(text: string): string {
  const plain = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let out = "";
  for (const ch of plain) out += CONFUSABLE[ch] ?? ch;
  return out.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[^a-z]/g, "");
}

function oneEditAway(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const TARGET_SKELETON = skeleton(TARGET);
/** True when a host reads as MAXXING to a person: "maxxing" anywhere, or a word one letter away from it. */
export function looksLikeMaxxing(host: string): boolean {
  const unicode = unicodeHost(host);
  if (skeleton(unicode).includes(TARGET_SKELETON)) return true;
  return unicode.split(/[.\-_]/).some(word => { const s = skeleton(word); return s.length >= 5 && oneEditAway(s, TARGET_SKELETON); });
}

/** Normalises a list entry or a host: lower case, no trailing dot, no wildcard. */
export const normalHost = (entry: string) => entry.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");

export function checkSite(origin: string, listed: ReadonlySet<string> = new Set()): SiteVerdict {
  let host: string;
  try { host = normalHost(new URL(origin).hostname); } catch { return { kind: "ok" }; }
  if (host === OFFICIAL_DOMAIN || host.endsWith(`.${OFFICIAL_DOMAIN}`) || host === "localhost" || host === "127.0.0.1") return { kind: "ok" };
  const parts = host.split(".");
  for (let i = 0; i < parts.length - 1; i++) if (listed.has(parts.slice(i).join("."))) return { kind: "phishing", reason: "listed" };
  if (looksLikeMaxxing(host)) return { kind: "phishing", reason: "lookalike", looksLike: OFFICIAL_DOMAIN };
  return { kind: "ok" };
}

/** Reads a blocklist: one host per line (the shipped file) or the upstream JSON ({ deny: [...] }). */
export function parseList(text: string): Set<string> {
  const trimmed = text.trim();
  const entries: unknown[] = trimmed.startsWith("{") ? (JSON.parse(trimmed).deny ?? []) : trimmed.split(/\r?\n/);
  const out = new Set<string>();
  for (const e of entries) if (typeof e === "string") { const h = normalHost(e); if (h.includes(".") && !h.startsWith("#") && h !== OFFICIAL_DOMAIN && !h.endsWith(`.${OFFICIAL_DOMAIN}`)) out.add(h); }
  return out;
}
