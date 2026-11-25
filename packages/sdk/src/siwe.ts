/**
 * Sign-In with Ethereum (EIP-4361) messages, and the same shape for Solana ("…with your Solana account:"). No crypto here:
 * this file builds and reads the text, so both servers and the wallet window can use it.
 */
export type SignInFamily = "evm" | "solana";

export type SignInMessage = {
  family: SignInFamily;
  /** The site asking, as a host (with port if any), e.g. "app.example.com". */
  domain: string;
  address: string;
  statement: string | null;
  uri: string;
  version: "1";
  chainId: number | null;
  nonce: string;
  issuedAt: string;
  expirationTime: string | null;
  notBefore: string | null;
  requestId: string | null;
  resources: string[];
};

const HEADER = / wants you to sign in with your (Ethereum|Solana) account:$/;
const FIELDS: Record<string, keyof SignInMessage> = {
  "URI": "uri", "Version": "version", "Chain ID": "chainId", "Nonce": "nonce", "Issued At": "issuedAt",
  "Expiration Time": "expirationTime", "Not Before": "notBefore", "Request ID": "requestId",
};

/** Reads a sign-in message, or returns null when the text isn't one. */
export function parseSignInMessage(text: string): SignInMessage | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const header = lines[0]?.match(HEADER);
  if (!header) return null;
  const domain = lines[0]!.slice(0, header.index);
  if (!domain || /\s/.test(domain)) return null;
  const family: SignInFamily = header[1] === "Ethereum" ? "evm" : "solana";
  const address = lines[1]?.trim() ?? "";
  if (family === "evm" ? !/^0x[0-9a-fA-F]{40}$/.test(address) : !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  if (lines[2] !== "") return null;
  let i = 3;
  let statement: string | null = null;
  // EIP-4361: an optional statement line and a blank line come before "URI:". Some writers add a second blank line instead.
  if (lines[i] === "") i += 1;
  else if (lines[i] !== undefined && !lines[i]!.startsWith("URI: ")) {
    if (lines[i + 1] !== "") return null;
    statement = lines[i]!;
    i += 2;
  }
  const message: SignInMessage = { family, domain, address, statement, uri: "", version: "1", chainId: null, nonce: "", issuedAt: "", expirationTime: null, notBefore: null, requestId: null, resources: [] };
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "Resources:") { message.resources = lines.slice(i + 1).filter(l => l.startsWith("- ")).map(l => l.slice(2)); break; }
    const sep = line.indexOf(": ");
    if (sep < 0) { if (line === "") continue; return null; }
    const key = FIELDS[line.slice(0, sep)];
    if (!key) return null;
    const value = line.slice(sep + 2);
    if (key === "chainId") { const n = Number(value); if (!Number.isSafeInteger(n) || n <= 0) return null; message.chainId = n; }
    else (message as Record<string, unknown>)[key] = value;
  }
  if (!message.uri || message.version !== "1" || !/^[A-Za-z0-9]{8,}$/.test(message.nonce) || Number.isNaN(Date.parse(message.issuedAt))) return null;
  if (family === "evm" && message.chainId === null) return null;
  for (const t of [message.expirationTime, message.notBefore]) if (t !== null && Number.isNaN(Date.parse(t))) return null;
  return message;
}

/** Writes a sign-in message in the standard layout. */
export function formatSignInMessage(m: Omit<SignInMessage, "version"> & { version?: "1" }): string {
  const lines = [`${m.domain} wants you to sign in with your ${m.family === "evm" ? "Ethereum" : "Solana"} account:`, m.address, ""];
  if (m.statement) lines.push(m.statement, "");
  lines.push(`URI: ${m.uri}`, "Version: 1");
  if (m.family === "evm") lines.push(`Chain ID: ${m.chainId}`);
  lines.push(`Nonce: ${m.nonce}`, `Issued At: ${m.issuedAt}`);
  if (m.expirationTime) lines.push(`Expiration Time: ${m.expirationTime}`);
  if (m.notBefore) lines.push(`Not Before: ${m.notBefore}`);
  if (m.requestId) lines.push(`Request ID: ${m.requestId}`);
  if (m.resources.length) lines.push("Resources:", ...m.resources.map(r => `- ${r}`));
  return lines.join("\n");
}

/** Whether a message's domain is the site that asked for it (its host, with port). */
export function signInDomainMatches(message: Pick<SignInMessage, "domain">, origin: string): boolean {
  try { return new URL(origin).host.toLowerCase() === message.domain.toLowerCase(); } catch { return false; }
}
