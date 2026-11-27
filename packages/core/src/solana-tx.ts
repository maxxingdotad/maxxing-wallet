import bs58 from "bs58";

/**
 * Reads a serialized Solana transaction (legacy or v0) far enough to show what it does and to sign it in place.
 * Layout: compact-u16 signature count, the signatures, then the message that the signatures cover.
 */
export type SolanaTxSummary = {
  version: "legacy" | 0;
  feePayer: string;
  signers: string[];
  programs: string[];
  /** Plain SOL transfers out of the signer, recognised exactly; anything else is shown as "other actions". */
  transfers: { from: string; to: string; lamports: bigint }[];
  /** SPL Token and Token-2022 instructions, recognised exactly. Addresses from lookup tables are null: the transaction doesn't name them. */
  tokenActions: TokenAction[];
  otherInstructions: number;
  /** System "Assign": an account handed to another program, which then controls it and everything in it. */
  assigns: { account: string; owner: string }[];
  /** Programs behind the instructions the wallet can't read (fee settings, memos and token-account creation aside). */
  unreadPrograms: string[];
  usesLookupTables: boolean;
};
export type TokenAction =
  | { kind: "transfer"; source: string | null; destination: string | null; owner: string | null; mint: string | null; amount: bigint; decimals: number | null }
  | { kind: "approve"; source: string | null; delegate: string | null; owner: string | null; mint: string | null; amount: bigint; decimals: number | null }
  | { kind: "setAuthority"; account: string | null; currentAuthority: string | null; newAuthority: string | null; authorityType: number }
  | { kind: "close"; account: string | null; destination: string | null; owner: string | null };
type Parsed = SolanaTxSummary & { messageOffset: number; signatureCount: number; requiredSignatures: number; keys: string[] };

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];

/** Programs whose instructions can't move or hand over anything: fee settings, memos, and creating a token account. */
const HARMLESS_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
]);

/**
 * The SPL Token instructions people need to see: moving, approving, handing over and closing token accounts. Same layout in
 * Token-2022. The programs read these by their first byte and ignore bytes and accounts past what they need, so the wallet
 * reads them the same way: an instruction padded with an extra byte is still the transfer it is.
 */
function tokenAction(data: Uint8Array, account: (i: number) => string | null): TokenAction | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), tag = data[0];
  const amount = () => view.getBigUint64(1, true);
  switch (tag) {
    case 3: return data.length >= 9 ? { kind: "transfer", source: account(0), destination: account(1), owner: account(2), mint: null, amount: amount(), decimals: null } : null;
    case 12: return data.length >= 10 ? { kind: "transfer", source: account(0), mint: account(1), destination: account(2), owner: account(3), amount: amount(), decimals: data[9]! } : null;
    case 4: return data.length >= 9 ? { kind: "approve", source: account(0), delegate: account(1), owner: account(2), mint: null, amount: amount(), decimals: null } : null;
    case 13: return data.length >= 10 ? { kind: "approve", source: account(0), mint: account(1), delegate: account(2), owner: account(3), amount: amount(), decimals: data[9]! } : null;
    case 6: {
      if (data.length < 3) return null;
      const some = data[2] === 1;
      if (some && data.length < 35) return null;
      return { kind: "setAuthority", account: account(0), currentAuthority: account(1), authorityType: data[1]!, newAuthority: some ? bs58.encode(data.subarray(3, 35)) : null };
    }
    case 9: return { kind: "close", account: account(0), destination: account(1), owner: account(2) };
    default: return null;
  }
}
const MAX_TX_BYTES = 1232;

function compactU16(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[offset + i];
    if (byte === undefined) throw new Error("SOLANA_TX_INVALID");
    value |= (byte & 0x7f) << (7 * i);
    if (!(byte & 0x80)) return [value, offset + i + 1];
  }
  throw new Error("SOLANA_TX_INVALID");
}

export function parseSolanaTransaction(bytes: Uint8Array): Parsed {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes.length > MAX_TX_BYTES) throw new Error("SOLANA_TX_INVALID");
  let [signatureCount, offset] = compactU16(bytes, 0);
  const messageOffset = offset + signatureCount * 64;
  if (messageOffset + 3 > bytes.length) throw new Error("SOLANA_TX_INVALID");
  offset = messageOffset;
  let version: "legacy" | 0 = "legacy";
  if (bytes[offset]! & 0x80) {
    if ((bytes[offset]! & 0x7f) !== 0) throw new Error("SOLANA_TX_VERSION_UNSUPPORTED");
    version = 0;
    offset++;
  }
  const requiredSignatures = bytes[offset]!;
  offset += 3;
  if (requiredSignatures !== signatureCount || requiredSignatures === 0) throw new Error("SOLANA_TX_INVALID");
  let keyCount: number;
  [keyCount, offset] = compactU16(bytes, offset);
  if (offset + keyCount * 32 + 32 > bytes.length || keyCount < requiredSignatures) throw new Error("SOLANA_TX_INVALID");
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++, offset += 32) keys.push(bs58.encode(bytes.subarray(offset, offset + 32)));
  offset += 32; // recent blockhash
  let instructionCount: number;
  [instructionCount, offset] = compactU16(bytes, offset);
  const programs = new Set<string>(), transfers: SolanaTxSummary["transfers"] = [], tokenActions: TokenAction[] = [];
  const assigns: SolanaTxSummary["assigns"] = [], unread = new Set<string>();
  let otherInstructions = 0;
  for (let i = 0; i < instructionCount; i++) {
    const programIndex = bytes[offset++];
    if (programIndex === undefined) throw new Error("SOLANA_TX_INVALID");
    let accountCount: number;
    [accountCount, offset] = compactU16(bytes, offset);
    const accounts = Array.from(bytes.subarray(offset, offset + accountCount));
    offset += accountCount;
    let dataLength: number;
    [dataLength, offset] = compactU16(bytes, offset);
    const data = bytes.subarray(offset, offset + dataLength);
    offset += dataLength;
    if (offset > bytes.length) throw new Error("SOLANA_TX_INVALID");
    // Accounts from lookup tables sit past the static keys; their addresses are not in the transaction itself.
    const program = keys[programIndex] ?? "lookup table account";
    programs.add(program);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // The System Program reads its instruction by the first four bytes and ignores what follows, and extra accounts too: a
    // transfer with a spare byte or a third account is still a transfer, and is shown as one.
    const system = program === SYSTEM_PROGRAM && data.length >= 4 ? view.getUint32(0, true) : null;
    if (system === 2 && data.length >= 12 && accounts.length >= 2 && keys[accounts[0]!] && keys[accounts[1]!])
      transfers.push({ from: keys[accounts[0]!]!, to: keys[accounts[1]!]!, lamports: view.getBigUint64(4, true) });
    else if (system === 1 && data.length >= 36 && keys[accounts[0]!])
      assigns.push({ account: keys[accounts[0]!]!, owner: bs58.encode(data.subarray(4, 36)) });
    else {
      const action = TOKEN_PROGRAMS.includes(program) && data.length ? tokenAction(data, i => accounts[i] === undefined ? null : keys[accounts[i]!] ?? null) : null;
      if (action) tokenActions.push(action);
      else { otherInstructions++; if (!HARMLESS_PROGRAMS.has(program)) unread.add(program); }
    }
  }
  let usesLookupTables = false;
  if (version === 0) {
    let lookups: number;
    [lookups, offset] = compactU16(bytes, offset);
    usesLookupTables = lookups > 0;
    for (let i = 0; i < lookups; i++) {
      offset += 32;
      let writable: number, readonly: number;
      [writable, offset] = compactU16(bytes, offset);
      offset += writable;
      [readonly, offset] = compactU16(bytes, offset);
      offset += readonly;
    }
  }
  if (offset !== bytes.length) throw new Error("SOLANA_TX_INVALID");
  return {
    version, feePayer: keys[0]!, signers: keys.slice(0, requiredSignatures), programs: [...programs], transfers, tokenActions, otherInstructions, assigns, unreadPrograms: [...unread], usesLookupTables,
    messageOffset, signatureCount, requiredSignatures, keys,
  };
}

/** Puts the signer's signature into its slot. Other signers' slots are left as they are. */
export function signSolanaTransaction(bytes: Uint8Array, signer: string, sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array>) {
  const parsed = parseSolanaTransaction(bytes);
  const slot = parsed.signers.indexOf(signer);
  if (slot < 0) throw new Error("SOLANA_SIGNER_NOT_IN_TRANSACTION");
  return Promise.resolve(sign(bytes.subarray(parsed.messageOffset))).then(signature => {
    if (signature.length !== 64) throw new Error("SOLANA_SIGNATURE_INVALID");
    const out = new Uint8Array(bytes);
    const [, start] = compactU16(bytes, 0);
    out.set(signature, start + slot * 64);
    return out;
  });
}

/** A "message" that is really a transaction must not be signed as text: that would approve the transaction unseen. */
export function isSolanaTransactionMessage(message: Uint8Array): boolean {
  const required = message[0] !== undefined && message[0] & 0x80 ? message[1] : message[0];
  if (!required || required > 16) return false;
  const tx = new Uint8Array(1 + required * 64 + message.length);
  tx[0] = required;
  tx.set(message, 1 + required * 64);
  try { parseSolanaTransaction(tx); return true; } catch { return false; }
}
