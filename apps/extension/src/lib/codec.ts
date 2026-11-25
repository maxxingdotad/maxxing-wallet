/**
 * Requests cross three boundaries (page → content script → background → approval window), and Chrome's runtime messaging is
 * JSON. Transactions carry bigints and Solana requests carry bytes, so both are tagged on the way out and restored on the way in.
 */
type Tagged = { $bigint: string } | { $bytes: string };

const toBase64 = (bytes: Uint8Array) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export function encode(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("REQUEST_TOO_DEEP");
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (value instanceof ArrayBuffer) return { $bytes: toBase64(new Uint8Array(value)) };
  if (Array.isArray(value)) return value.map(v => encode(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v, depth + 1)]));
  return value;
}

export function decode(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("REQUEST_TOO_DEEP");
  if (Array.isArray(value)) return value.map(v => decode(v, depth + 1));
  if (value && typeof value === "object") {
    const tagged = value as Partial<Record<"$bigint" | "$bytes", unknown>>;
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof tagged.$bigint === "string" && /^-?\d+$/.test(tagged.$bigint)) return BigInt(tagged.$bigint);
    if (keys.length === 1 && typeof tagged.$bytes === "string") return fromBase64(tagged.$bytes);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v, depth + 1)]));
  }
  return value;
}

export type { Tagged };
