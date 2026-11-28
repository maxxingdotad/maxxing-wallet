import bs58 from "bs58";
import nacl from "tweetnacl";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { bytesToHex, createMnemonic, derivePlatformAccount, MAX_ACCOUNT_INDEX, mnemonicIsValid, normalizeMnemonic, type PlatformAccount } from "./derive";
import { forgetAllDeviceSessions, forgetDeviceSession, readDeviceSession, rememberDeviceSession } from "./device-session";

/**
 * The MAXXING wallet on this device.
 *
 * Each saved wallet's recovery phrase is sealed with its own random data key. The data key is kept up to three ways:
 * wrapped by the user's 6-digit PIN (stored here); optionally by a passkey (Face ID, Touch ID, Windows Hello, a security key),
 * through the passkey's PRF output, which the authenticator gives only after the user is verified; and, while signed in, by a
 * device key the browser will not reveal (see device-session.ts). So the wallet stays open until sign-out, and after sign-out
 * the passkey or the PIN opens it again. The PIN always works; the passkey is a quicker way in, never the only one.
 * Wrong PINs make the user wait longer and longer, never locking them out.
 */
const COLLECTION_KEY = "maxxing.wallet.v3";
const ATTEMPTS_PREFIX = "maxxing.wallet.attempts.";
const SIGNED_OUT_KEY = "maxxing.wallet.signedOut";
const SIGNED_IN_KEY = "maxxing.wallet.signedIn";
const WALLET_KEY = "maxxing.wallet", SOLANA_KEY = "maxxing.solana";
const PIN_ITERATIONS = 600_000, BACKUP_ITERATIONS = 600_000;
const MAX_WALLETS = 20;
/** Free tries before the first wait, the first wait, and the longest wait. */
const FREE_TRIES = 5, FIRST_WAIT_MS = 30_000, MAX_WAIT_MS = 60 * 60_000;

type PublicRecord = { evm: `0x${string}`; solana: string };
type Sealed = { iv: string; cipher: string };
type PinWrap = { salt: string; iv: string; cipher: string; iterations: number };
/** The data key wrapped by a passkey: its credential id, the PRF input, and the wrapped key. */
type PasskeyWrap = Sealed & { credential: string; salt: string };
/**
 * More accounts from the same recovery phrase (index 1 and up; index 0 is the wallet's own addresses above). Optional, so a wallet
 * record written before accounts existed, and the wallet window, which never adds any, are unchanged.
 */
type ExtraAccount = PublicRecord & { index: number; label: string; hidden?: boolean };
/**
 * `pin`: the data key wrapped by this wallet's own PIN (the web wallet, and wallets made before the keyring).
 * `ring`: the data key wrapped by the keyring's master key (keyring mode: one password for every wallet). A record has one or the
 * other; adoption into the keyring writes `ring` and removes `pin` only after checking the new wrap opens the same wallet.
 */
type SavedAccount = PublicRecord & { id: string; label: string; backedUp: boolean; seal: Sealed; pin?: PinWrap; ring?: Sealed; passkey?: PasskeyWrap; extra?: ExtraAccount[]; selected?: number };
/** The keyring: one random master key, wrapped by the one password (PBKDF2, like a wallet PIN). */
type Keyring = { version: 1; salt: string; iv: string; cipher: string; iterations: number };
type Collection = { version: 3; activeId: string | null; accounts: SavedAccount[] };
type Attempts = { failures: number; waitUntil: number };
/** One account of a wallet: index 0 is the wallet's own. */
export type AccountSummary = PublicRecord & { index: number; label: string; hidden: boolean };
/** `evm`/`solana`: the selected account's addresses. `accounts`: every account of this recovery phrase on this device. */
export type WalletSummary = PublicRecord & { id: string; label: string; backedUp: boolean; legacy: false; passkey: boolean; selected: number; accounts: AccountSummary[] };

let unlocked: PlatformAccount | null = null;
let epoch = 0;
/** Grows each time the frame ends the app's signed-in session, so the app can clear its own. */
let sessionEpoch = 0;
/** Grows each time this wallet signs the app in or out, so the app mirrors exactly those moments. */
let publishSeq = 0;

export function walletSessionEpoch() { return sessionEpoch; }
export function walletPublishSeq() { return publishSeq; }
export function walletOperationRevision() { return epoch; }

const store = () => { if (typeof window === "undefined") throw new Error("WALLET_STORAGE_UNAVAILABLE"); return window.localStorage; };
const emit = () => window.dispatchEvent(new Event("maxxing:wallet"));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const text = (value: string) => new TextEncoder().encode(value);
const publicValid = (p: unknown): p is PublicRecord => !!p && typeof p === "object"
  && /^0x[\da-f]{40}$/i.test(String((p as PublicRecord).evm)) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String((p as PublicRecord).solana));
const sealValid = (s: Sealed) => !!s && typeof s.iv === "string" && typeof s.cipher === "string" && s.iv.length === 16 && s.cipher.length >= 32 && s.cipher.length < 2048;
const pinValid = (p: PinWrap) => !!p && sealValid(p) && typeof p.salt === "string" && p.salt.length === 24 && p.iterations === PIN_ITERATIONS;
const passkeyValid = (p: PasskeyWrap | undefined) => p === undefined || (!!p && sealValid(p) && typeof p.salt === "string" && p.salt.length === 44
  && typeof p.credential === "string" && /^[A-Za-z0-9_-]{16,1400}$/.test(p.credential));
const extraValid = (a: SavedAccount) => {
  if (a.extra === undefined) return a.selected === undefined || a.selected === 0;
  if (!Array.isArray(a.extra) || a.extra.length > MAX_ACCOUNT_INDEX) return false;
  const ok = a.extra.every(x => publicValid(x) && Number.isSafeInteger(x.index) && x.index >= 1 && x.index <= MAX_ACCOUNT_INDEX && typeof x.label === "string" && (x.hidden === undefined || typeof x.hidden === "boolean"));
  return ok && new Set(a.extra.map(x => x.index)).size === a.extra.length && (a.selected === undefined || a.selected === 0 || a.extra.some(x => x.index === a.selected));
};
/** The wallet's accounts in index order, index 0 first. */
const accountsOf = (a: SavedAccount): AccountSummary[] => [{ index: 0, label: a.label, evm: a.evm, solana: a.solana, hidden: false }, ...(a.extra ?? []).map(x => ({ index: x.index, label: x.label, evm: x.evm, solana: x.solana, hidden: !!x.hidden })).sort((x, y) => x.index - y.index)];
/** The selected account's record: its index and public addresses. */
const selectedOf = (a: SavedAccount): AccountSummary => accountsOf(a).find(x => x.index === (a.selected ?? 0)) ?? accountsOf(a)[0]!;

function read(): Collection {
  const raw = store().getItem(COLLECTION_KEY);
  if (!raw) return { version: 3, activeId: null, accounts: [] };
  try {
    const c = JSON.parse(raw) as Collection;
    const ok = c.version === 3 && Array.isArray(c.accounts) && c.accounts.length <= MAX_WALLETS
      && c.accounts.every(a => publicValid(a) && typeof a.id === "string" && typeof a.label === "string" && typeof a.backedUp === "boolean" && sealValid(a.seal)
        && (a.pin === undefined || pinValid(a.pin)) && (a.ring === undefined || sealValid(a.ring)) && (a.pin !== undefined || a.ring !== undefined)
        && passkeyValid(a.passkey) && extraValid(a))
      && new Set(c.accounts.map(a => a.id)).size === c.accounts.length
      && (c.activeId === null || c.accounts.some(a => a.id === c.activeId));
    if (!ok) throw new Error();
    return c;
  } catch { throw new Error("WALLET_STORAGE_DAMAGED_RESTORE_BACKUP"); }
}
function persist(c: Collection) { store().setItem(COLLECTION_KEY, JSON.stringify(c)); }
function current() { const c = read(), a = c.accounts.find(x => x.id === c.activeId); if (!a) throw new Error("NO_PLATFORM_WALLET"); return a; }
function byId(id: string) { const a = read().accounts.find(x => x.id === id); if (!a) throw new Error("WALLET_NOT_FOUND"); return a; }

/** Serializes wallet list changes across tabs. */
async function mutate<T>(action: () => T | Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) throw new Error("This browser cannot safely keep a wallet. Use a current browser.");
  return navigator.locks.request("maxxing-wallet-registry-v3", action);
}

/**
 * The secret as the vault uses it. The web wallet (keyring off): a 6-digit PIN. Keyring mode (the extension's one password): any
 * 6–128 characters, letters allowed, in Unicode NFC so the same password typed on another keyboard matches. An older wallet's
 * 6-digit PIN passes either way, so migration is unchanged. How strong a new password must be is the setting screen's rule.
 */
export function checkedPin(pin: string) {
  if (keyringMode) {
    const secret = typeof pin === "string" ? pin.normalize("NFC") : "";
    if ([...secret].length < 6 || [...secret].length > 128) throw new Error("Enter your password.");
    return secret;
  }
  if (!/^\d{6}$/.test(pin)) throw new Error("Enter 6 digits.");
  return pin;
}


async function pbkdf2(secret: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey("raw", text(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: new Uint8Array(salt), iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const sealAad = (a: PublicRecord & { id: string }) => text(`MAXXING wallet v3:${a.id}:${a.evm.toLowerCase()}:${a.solana}`);
const pinAad = (id: string) => text(`MAXXING wallet v3 pin:${id}`);

async function sealPhrase(mnemonic: string, dataKey: Uint8Array, owner: PublicRecord & { id: string }): Promise<Sealed> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(dataKey), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12)), plain = text(mnemonic);
  try { return { iv: b64(iv), cipher: b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: sealAad(owner) }, key, plain))) }; }
  finally { plain.fill(0); }
}
async function openPhrase(a: SavedAccount, dataKey: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(dataKey), "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(a.seal.iv), additionalData: sealAad(a) }, key, unb64(a.seal.cipher)));
  try { return new TextDecoder().decode(plain); } finally { plain.fill(0); }
}
async function wrapWithPin(dataKey: Uint8Array, pin: string, id: string): Promise<PinWrap> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pbkdf2(checkedPin(pin), salt, PIN_ITERATIONS);
  return { salt: b64(salt), iv: b64(iv), iterations: PIN_ITERATIONS, cipher: b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: pinAad(id) }, key, new Uint8Array(dataKey)))) };
}

// ---- wrong-PIN waits -------------------------------------------------------------------------------------------

function attempts(id: string): Attempts {
  try {
    const saved = JSON.parse(store().getItem(ATTEMPTS_PREFIX + id) ?? "null") as Attempts | null;
    if (saved && Number.isInteger(saved.failures) && Number.isFinite(saved.waitUntil)) return saved;
  } catch { /* treat as none */ }
  return { failures: 0, waitUntil: 0 };
}
/**
 * Whether wrong tries make the next one wait. On for a short PIN (the web wallet's six digits). A surface whose secret is a
 * full password under strength rules (the extension) turns it off, as browser wallets do: every try already costs the key
 * derivation, and someone who can script tries on this device can copy the sealed wallet and guess without any wait.
 */
let wrongTryWaits = true;
export function useWrongTryWaits(on: boolean) { wrongTryWaits = on; }
/** When the next PIN try is allowed for this wallet (0 when now). */
export function pinWaitUntil(id?: string) {
  if (!wrongTryWaits) return 0;
  try { const w = attempts(id ?? (keyringMode && readKeyring() ? KEYRING_ID : current().id)).waitUntil; return w > Date.now() ? w : 0; } catch { return 0; }
}
/** 30 seconds after the 5th wrong PIN, then twice as long each time, up to an hour. */
export function waitAfter(failures: number) {
  if (failures < FREE_TRIES) return 0;
  return Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (failures - FREE_TRIES));
}
function assertMayTry(id: string) {
  if (!wrongTryWaits) return;
  const wait = attempts(id).waitUntil - Date.now();
  if (wait > 0) throw Object.assign(new Error(`Too many wrong PINs. Try again in ${formatWait(wait)}.`), { code: "PIN_WAIT", waitUntil: Date.now() + wait });
}
function formatWait(ms: number) {
  const s = Math.ceil(ms / 1000);
  return s < 60 ? `${s} seconds` : `${Math.ceil(s / 60)} minute${Math.ceil(s / 60) === 1 ? "" : "s"}`;
}

// ---- the keyring: one password for every wallet (opt-in; the extension uses it, the web wallet doesn't) ----------------------

const KEYRING_KEY = "maxxing.wallet.keyring.v1", KEYRING_ID = "keyring", KEYRING_SESSION = "keyring";
const keyringAad = text("MAXXING keyring v1");
const ringAad = (id: string) => text(`MAXXING keyring v1 wallet:${id}`);
let keyringMode = false;
/** Turns keyring mode on for this page (call before the vault is used): one password unlocks every wallet. */
export function useKeyring(on: boolean) { keyringMode = on; }
export function keyringModeOn() { return keyringMode; }

/**
 * A stored keyring's iteration count: at least today's (a later version may raise it, and the stored value is what unlocks), and
 * under a ceiling so a tampered record can't make unlocking hang.
 */
const KEYRING_MAX_ITERATIONS = 10_000_000;
const keyringIterationsValid = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= PIN_ITERATIONS && (n as number) <= KEYRING_MAX_ITERATIONS;

function readKeyring(): Keyring | null {
  const raw = store().getItem(KEYRING_KEY);
  if (!raw) return null;
  const k = JSON.parse(raw) as Keyring;
  if (k?.version !== 1 || typeof k.salt !== "string" || k.salt.length !== 24 || !sealValid(k) || !keyringIterationsValid(k.iterations)) throw new Error("WALLET_STORAGE_DAMAGED_RESTORE_BACKUP");
  return k;
}
/** Whether this device has a keyring (one password for every wallet). */
export function keyringExists() { try { return readKeyring() !== null; } catch { return true; } }
/** Whether the keyring is open in this session (the password was entered and the extension isn't locked). */
export async function keyringOpen() { const m = await readDeviceSession(KEYRING_SESSION); if (m) { m.fill(0); return true; } return false; }

async function wrapMaster(master: Uint8Array, pin: string): Promise<Keyring> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await pbkdf2(checkedPin(pin), salt, PIN_ITERATIONS);
  return { version: 1, salt: b64(salt), iv: b64(iv), iterations: PIN_ITERATIONS, cipher: b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: keyringAad }, key, new Uint8Array(master)))) };
}
/** The master key from the password, counting wrong tries (one count for the whole keyring). */
async function masterFromPin(pin: string) {
  const k = readKeyring();
  if (!k) throw new Error("NO_KEYRING");
  assertMayTry(KEYRING_ID);
  try {
    const key = await pbkdf2(checkedPin(pin), unb64(k.salt), k.iterations);
    const master = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(k.iv), additionalData: keyringAad }, key, unb64(k.cipher)));
    store().removeItem(ATTEMPTS_PREFIX + KEYRING_ID);
    return master;
  } catch (error) {
    if (error instanceof Error && error.message === "Enter 6 digits.") throw error;
    throw countWrongTry(KEYRING_ID);
  }
}
async function masterFromSession() { return readDeviceSession(KEYRING_SESSION); }
async function wrapWithRing(dataKey: Uint8Array, master: Uint8Array, id: string): Promise<Sealed> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(master), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv: b64(iv), cipher: b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: ringAad(id) }, key, new Uint8Array(dataKey)))) };
}
async function unwrapRing(a: SavedAccount, master: Uint8Array) {
  if (!a.ring) throw new Error("WALLET_NEEDS_OLD_PIN");
  const key = await crypto.subtle.importKey("raw", new Uint8Array(master), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(a.ring.iv), additionalData: ringAad(a.id) }, key, unb64(a.ring.cipher)));
}
/** The data key from the open keyring session, or null (keyring closed, or this wallet not in the keyring yet). */
async function dataKeyFromRingSession(a: SavedAccount) {
  if (!a.ring) return null;
  const master = await masterFromSession();
  if (!master) return null;
  try { return await unwrapRing(a, master); } catch { return null; } finally { master.fill(0); }
}
function countWrongTry(id: string) {
  const failures = attempts(id).failures + 1, wait = wrongTryWaits ? waitAfter(failures) : 0;
  store().setItem(ATTEMPTS_PREFIX + id, JSON.stringify({ failures, waitUntil: wait ? Date.now() + wait : 0 } satisfies Attempts));
  return Object.assign(new Error(wait ? `Wrong PIN. Try again in ${formatWait(wait)}.` : "Wrong PIN."), { code: wait ? "PIN_WAIT" : "PIN_WRONG", waitUntil: wait ? Date.now() + wait : 0 });
}

/** The wallet's data key from its own PIN wrap, without counting a wrong try (used only to adopt wallets that share the password). */
async function dataKeyFromOwnPinQuietly(a: SavedAccount, pin: string) {
  if (!a.pin) return null;
  try {
    const key = await pbkdf2(checkedPin(pin), unb64(a.pin.salt), a.pin.iterations);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(a.pin.iv), additionalData: pinAad(a.id) }, key, unb64(a.pin.cipher)));
  } catch { return null; }
}

/**
 * Moves one wallet into the keyring, keeping every key: its data key (from its own PIN) is checked by deriving its saved
 * addresses, wrapped by the master key, the new wrap is opened again and compared, and only then is the PIN wrap replaced. If any
 * step fails, the record is left exactly as it was.
 */
async function adopt(a: SavedAccount, dataKey: Uint8Array, master: Uint8Array) {
  const account = await accountFor(a, dataKey, 0); // throws if the key doesn't open this wallet's own addresses
  dispose(account);
  const ring = await wrapWithRing(dataKey, master, a.id);
  const back = await unwrapRing({ ...a, ring }, master);
  try { if (back.length !== dataKey.length || back.some((b, i) => b !== dataKey[i])) throw new Error("KEYRING_CHECK_FAILED"); } finally { back.fill(0); }
  await mutate(() => {
    const c = read(), x = c.accounts.find(y => y.id === a.id);
    if (!x) throw new Error("WALLET_NOT_FOUND");
    if (x.ring) return;
    x.ring = ring; delete x.pin; persist(c);
    store().removeItem(ATTEMPTS_PREFIX + a.id);
  });
}

/** Wallets still behind their own PIN (made before the keyring); each asks for its old PIN once, then joins the keyring. */
export function walletsNeedingOldPin(): { id: string; label: string; evm: string }[] {
  if (!keyringMode) return [];
  return read().accounts.filter(a => !a.ring).map(a => ({ id: a.id, label: a.label, evm: a.evm }));
}
/** Moves a wallet made before the keyring into it, after its old PIN (wrong tries count for that wallet). The keyring must be open. */
export async function adoptPlatformWallet(id: string, oldPin: string) {
  const a = byId(id);
  if (a.ring) return;
  const master = await masterFromSession();
  if (!master) throw Object.assign(new Error("Enter your password first."), { code: "PIN_NEEDED" });
  try {
    const dataKey = await dataKeyFromPin(a, oldPin);
    try { await adopt(a, dataKey, master); } finally { dataKey.fill(0); }
  } finally { master.fill(0); }
  emit();
}
/** Tries the password on every wallet still behind its own PIN, quietly (no wrong-try count): those that share it join the keyring. */
async function adoptSharingPassword(pin: string, master: Uint8Array) {
  for (const a of read().accounts.filter(x => !x.ring)) {
    const dataKey = await dataKeyFromOwnPinQuietly(a, pin);
    if (!dataKey) continue;
    try { await adopt(a, dataKey, master); } catch { /* left as it was; it will ask for its old PIN */ } finally { dataKey.fill(0); }
  }
}

/**
 * Unlocks the keyring with the password. On a device that had wallets before the keyring, the first unlock creates it: the
 * password must open the active wallet (its old PIN, wrong tries counted as usual), becomes the one password, and every wallet
 * with the same PIN joins at once. Wallets with another PIN join later, each after its old PIN (adoptPlatformWallet).
 */
async function unlockKeyring(pin: string) {
  let master: Uint8Array;
  if (readKeyring()) master = await masterFromPin(pin);
  else {
    const a = current();
    (await dataKeyFromPin(a, pin)).fill(0); // the old PIN of the active wallet, counted like any try
    master = crypto.getRandomValues(new Uint8Array(32));
    const ring = await wrapMaster(master, pin);
    await mutate(() => { if (!readKeyring()) store().setItem(KEYRING_KEY, JSON.stringify(ring)); });
    const saved = await masterFromPin(pin); // the stored keyring opens with the password, before anything relies on it
    master.fill(0); master = saved;
  }
  try {
    await rememberDeviceSession(KEYRING_SESSION, master);
    await adoptSharingPassword(pin, master);
  } catch (error) { master.fill(0); throw error; }
  return master;
}

/** Opens the data key with the PIN, counting wrong tries. In the keyring, the PIN is the one password. */
async function dataKeyFromPin(a: SavedAccount, pin: string) {
  if (a.ring) {
    const master = await masterFromPin(pin);
    try { return await unwrapRing(a, master); } finally { master.fill(0); }
  }
  if (!a.pin) throw new Error("WALLET_NEEDS_OLD_PIN");
  assertMayTry(a.id);
  try {
    const key = await pbkdf2(checkedPin(pin), unb64(a.pin.salt), a.pin.iterations);
    const dataKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(a.pin.iv), additionalData: pinAad(a.id) }, key, unb64(a.pin.cipher)));
    store().removeItem(ATTEMPTS_PREFIX + a.id);
    return dataKey;
  } catch (error) {
    if (error instanceof Error && error.message === "Enter 6 digits.") throw error;
    throw countWrongTry(a.id);
  }
}

// ---- keys in memory --------------------------------------------------------------------------------------------

function dispose(a: PlatformAccount | null) { if (!a) return; a.evm.privateKeyBytes.fill(0); a.solana.secretKey.fill(0); a.mnemonic = ""; }
function keysOnly(a: PlatformAccount) { a.mnemonic = ""; return a; }
function matches(account: PlatformAccount, a: PublicRecord) { return account.evm.address.toLowerCase() === a.evm.toLowerCase() && account.solana.address === a.solana; }
/** The keys of the wallet's selected account (or `index`), checked against the addresses saved for it. */
async function accountFor(a: SavedAccount, dataKey: Uint8Array, index = a.selected ?? 0) {
  const expected = accountsOf(a).find(x => x.index === index);
  if (!expected) throw new Error("ACCOUNT_NOT_FOUND");
  const account = derivePlatformAccount(await openPhrase(a, dataKey), index);
  if (!matches(account, expected)) { dispose(account); throw new Error("WALLET_STORAGE_DAMAGED_RESTORE_BACKUP"); }
  return account;
}
function assertCurrent(start: number, id: string) { if (epoch !== start || read().activeId !== id) throw new Error("WALLET_OPERATION_CANCELLED"); }

/**
 * MAXXING's own sign-in follows the wallet through the records written here. The wallet window that partner websites
 * open turns this off, so using the wallet on another site never signs MAXXING in or out.
 */
let publishing = true;
export function setWalletPublishing(on: boolean) { publishing = on; }
/** Tells the app which wallet is signed in. */
function publish(a: PublicRecord) {
  if (!publishing) { emit(); return; }
  if (store().getItem(WALLET_KEY) !== a.evm.toLowerCase()) sessionEpoch++;
  store().setItem(SOLANA_KEY, a.solana);
  store().setItem(WALLET_KEY, a.evm.toLowerCase());
  publishSeq++; emit();
}
function unpublish(a: PublicRecord) {
  if (!publishing) { emit(); return; }
  if (store().getItem(WALLET_KEY) === a.evm.toLowerCase()) { store().removeItem(WALLET_KEY); store().removeItem(SOLANA_KEY); }
  publishSeq++; emit();
}
/** Opens the wallet in memory and on this device until sign-out. */
async function open(a: SavedAccount, account: PlatformAccount, dataKey: Uint8Array, start: number) {
  try {
    await rememberDeviceSession(a.id, dataKey);
    assertCurrent(start, a.id);
    dispose(unlocked); unlocked = keysOnly(account);
    store().setItem(SIGNED_IN_KEY, `${a.id}:${Date.now()}`);
    publish(selectedOf(a));
  } catch (error) { if (unlocked !== account) dispose(account); throw error; }
}

// ---- public reads ----------------------------------------------------------------------------------------------

/** The selected account's public addresses. */
export function platformWalletPublic(): PublicRecord | null { try { const s = selectedOf(current()); return { evm: s.evm, solana: s.solana }; } catch { return null; } }
export function savedPlatformWallets(): WalletSummary[] {
  return read().accounts.map(a => { const s = selectedOf(a); return { id: a.id, label: a.label, evm: s.evm, solana: s.solana, backedUp: a.backedUp, legacy: false, passkey: !!a.passkey, selected: s.index, accounts: accountsOf(a) }; });
}
export function activePlatformWalletId() { return read().activeId; }
export function platformWalletUnlocked() { return unlocked != null; }
export function platformSolanaAddress() { return platformWalletPublic()?.solana ?? null; }
/** Signs bytes with the open wallet's Solana key. The key itself never leaves this module. */
export function platformSolanaSign(bytes: Uint8Array): Uint8Array {
  if (!unlocked || unlocked.solana.secretKey.every(b => b === 0)) throw new Error("WALLET_LOCKED");
  return nacl.sign.detached(bytes, unlocked.solana.secretKey);
}
export function platformEvmAccount(): PrivateKeyAccount | null {
  if (!unlocked || unlocked.evm.privateKeyBytes.every(b => b === 0)) return null;
  const id = current().id, start = epoch, account = privateKeyToAccount(`0x${bytesToHex(unlocked.evm.privateKeyBytes)}`);
  // A signer captured earlier stops working after sign-out or a wallet switch.
  return new Proxy(account, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof property === "string" && property.startsWith("sign") && typeof value === "function") return (...args: unknown[]) => {
      assertCurrent(start, id);
      if (!unlocked || unlocked.evm.privateKeyBytes.every(b => b === 0)) throw new Error("WALLET_LOCKED");
      return Reflect.apply(value, target, args);
    };
    return value;
  } });
}

// ---- sign in and out -------------------------------------------------------------------------------------------

/** Reopens the active wallet if it was not signed out on this device. */
export async function restoreDeviceSession() {
  const start = epoch;
  let a: SavedAccount;
  try { a = current(); } catch { return false; }
  // This wallet's own open session, else (keyring mode) the open keyring, which opens every wallet in it.
  const dataKey = await readDeviceSession(a.id) ?? await dataKeyFromRingSession(a);
  if (!dataKey) return false;
  try {
    const account = await accountFor(a, dataKey);
    if (epoch !== start || read().activeId !== a.id) { dispose(account); return false; }
    dispose(unlocked); unlocked = keysOnly(account); publish(selectedOf(a));
    return true;
  } catch { await forgetDeviceSession(a.id); return false; }
  finally { dataKey.fill(0); }
}

export async function unlockPlatformWallet(pin: string) {
  if (keyringMode) {
    // One password: it opens the keyring (creating it on a device that had wallets before), then the active wallet through it.
    (await unlockKeyring(pin)).fill(0);
    const start = epoch, a = current();
    const fromRing = await dataKeyFromRingSession(a);
    if (!fromRing) throw Object.assign(new Error("This wallet still has its own PIN from before. Enter it once to add it to your password."), { code: "WALLET_NEEDS_OLD_PIN", walletId: a.id });
    try {
      const account = await accountFor(a, fromRing);
      await open(a, account, fromRing, start);
      return { evm: a.evm, solana: a.solana };
    } finally { fromRing.fill(0); }
  }
  const a = current(), start = epoch;
  const dataKey = await dataKeyFromPin(a, pin);
  try {
    const account = await accountFor(a, dataKey);
    await open(a, account, dataKey, start);
    return { evm: a.evm, solana: a.solana };
  } finally { dataKey.fill(0); }
}

/** Signs out on this device: keys leave memory and only the PIN opens the wallet again. Every tab follows. */
export async function signOutPlatformWallet() {
  epoch++; sessionEpoch++;
  dispose(unlocked); unlocked = null;
  await forgetAllDeviceSessions();
  try { store().setItem(SIGNED_OUT_KEY, String(Date.now())); } catch { /* storage blocked */ }
  emit();
}
/** Stops any wallet work in progress without signing out. */
export function cancelPlatformWalletOperation() { epoch++; }

// ---- create and restore ----------------------------------------------------------------------------------------

/**
 * In keyring mode, the master key a new wallet is wrapped with: the open keyring's, else the password's. On a fresh device the
 * first wallet's password creates the keyring.
 */
async function masterForNewWallet(pin: string | undefined) {
  const open = await masterFromSession();
  if (open) return open;
  if (pin == null) throw Object.assign(new Error("Enter your password."), { code: "PIN_NEEDED" });
  checkedPin(pin);
  if (readKeyring() || read().accounts.length) return unlockKeyring(pin);
  const master = crypto.getRandomValues(new Uint8Array(32));
  const ring = await wrapMaster(master, pin);
  await mutate(() => { if (readKeyring()) throw new Error("WALLET_OPERATION_CANCELLED"); store().setItem(KEYRING_KEY, JSON.stringify(ring)); });
  await rememberDeviceSession(KEYRING_SESSION, master);
  return master;
}

async function saveNew(account: PlatformAccount, pin: string | undefined, label: string, backedUp: boolean) {
  const start = epoch;
  let master: Uint8Array | null = null;
  try {
    if (keyringMode) master = await masterForNewWallet(pin);
    else if (pin == null) throw new Error("Enter 6 digits.");
    return await mutate(async () => {
      if (start !== epoch) throw new Error("WALLET_OPERATION_CANCELLED");
      const c = read();
      if (c.accounts.length >= MAX_WALLETS) throw new Error(`You can keep up to ${MAX_WALLETS} wallets on this device.`);
      if (c.accounts.some(a => a.evm.toLowerCase() === account.evm.address.toLowerCase())) throw new Error("This wallet is already on this device.");
      const id = crypto.randomUUID(), owner = { id, evm: account.evm.address, solana: account.solana.address };
      const dataKey = crypto.getRandomValues(new Uint8Array(32));
      try {
        const wrap = master ? { ring: await wrapWithRing(dataKey, master, id) } : { pin: await wrapWithPin(dataKey, pin!, id) };
        const a: SavedAccount = { ...owner, label: label.trim().slice(0, 32) || "My wallet", backedUp, seal: await sealPhrase(account.mnemonic, dataKey, owner), ...wrap };
        if (start !== epoch) throw new Error("WALLET_OPERATION_CANCELLED");
        const fresh = read();
        fresh.accounts.push(a); fresh.activeId = a.id; persist(fresh);
        epoch++;
        await open(a, account, dataKey, epoch);
        return { evm: a.evm, solana: a.solana };
      } finally { dataKey.fill(0); }
    });
  } catch (error) { if (unlocked !== account) dispose(account); throw error; }
  finally { master?.fill(0); }
}

/**
 * A new wallet, ready to use at once. Backing up the recovery phrase is offered right after. In keyring mode the PIN is the one
 * password: needed only for the very first wallet (it creates the keyring) or when the keyring is locked; never a new one.
 */
export async function createPlatformWallet(pin?: string, label = "My wallet") {
  if (pin != null || !keyringMode) checkedPin(pin ?? "");
  return saveNew(derivePlatformAccount(createMnemonic()), pin, label, false);
}
export async function importPlatformWallet(mnemonic: string, pin?: string, label = "Imported wallet") {
  if (pin != null || !keyringMode) checkedPin(pin ?? "");
  if (!mnemonicIsValid(mnemonic)) throw new Error("Check the words and their order.");
  return saveNew(derivePlatformAccount(normalizeMnemonic(mnemonic)), pin, label, true);
}
/**
 * Starting over after a forgotten password (keyring mode): every wallet on this device is erased, the given recovery phrase is
 * restored as the only wallet, and `newPin` becomes the one password. No password is asked, because none is known; removing
 * the app from the browser does the same erasing. The phrase and the new password are checked BEFORE anything is erased, so a
 * mistyped phrase never costs the wallets that are here. Wallets not restored by this phrase are gone from this device: the
 * screen warns about them first.
 */
export async function startOverWithPhrase(mnemonic: string, newPin: string, label = "My wallet") {
  if (!keyringMode) throw new Error("NO_KEYRING");
  checkedPin(newPin);
  if (!mnemonicIsValid(mnemonic)) throw new Error("Check the words and their order.");
  await mutate(async () => {
    let old: SavedAccount[] = [];
    try { old = read().accounts; } catch { /* damaged storage is erased like the rest */ }
    epoch++; sessionEpoch++;
    dispose(unlocked); unlocked = null;
    for (const a of old) {
      store().removeItem(ATTEMPTS_PREFIX + a.id);
      if (a.passkey) forgetPasskeyCredential(a.passkey.credential);
      unpublish(selectedOf(a));
    }
    await forgetAllDeviceSessions();
    persist({ version: 3, activeId: null, accounts: [] });
    store().removeItem(KEYRING_KEY);
    store().removeItem(ATTEMPTS_PREFIX + KEYRING_ID);
  });
  return importPlatformWallet(mnemonic, newPin, label);
}
/** Public addresses for a phrase, without saving or opening anything. */
export function previewPlatformPhrase(mnemonic: string): PublicRecord {
  if (!mnemonicIsValid(mnemonic)) throw new Error("Check the words and their order.");
  const account = derivePlatformAccount(normalizeMnemonic(mnemonic));
  try { return { evm: account.evm.address, solana: account.solana.address }; } finally { dispose(account); }
}

// ---- recovery phrase ---------------------------------------------------------------------------------------

/** Checks the PIN of the active wallet (wrong tries count) without opening the recovery phrase. */
export async function checkPlatformPin(pin: string) {
  (await dataKeyFromPin(current(), pin)).fill(0);
}

/** The recovery phrase, after the PIN. Only the frame's own screens call this; it never leaves the frame. */
export async function revealPlatformMnemonic(pin: string) {
  const a = current();
  const dataKey = await dataKeyFromPin(a, pin);
  try { const account = await accountFor(a, dataKey); try { return account.mnemonic; } finally { dispose(account); } }
  finally { dataKey.fill(0); }
}
/**
 * The active wallet's private keys, after the PIN: EVM as 0x hex, Solana as the base58 64-byte secret key other Solana wallets
 * import. Only the wallet's own export screens call this, behind their warnings; the key copies here are wiped once encoded.
 */
export async function revealPlatformPrivateKeys(pin: string): Promise<{ evm: `0x${string}`; solana: string }> {
  const a = current();
  const dataKey = await dataKeyFromPin(a, pin);
  try {
    const account = await accountFor(a, dataKey);
    try { return { evm: `0x${bytesToHex(account.evm.privateKeyBytes)}`, solana: bs58.encode(account.solana.secretKey) }; }
    finally { dispose(account); }
  } finally { dataKey.fill(0); }
}
export async function confirmPlatformBackup(pin: string, checks: { index: number; word: string }[]) {
  const words = (await revealPlatformMnemonic(pin)).split(" ");
  if (!checks.length || checks.some(c => words[c.index] !== c.word.trim().toLowerCase())) throw new Error("Those words don't match. Check your copy.");
  await mutate(() => { const c = read(), a = c.accounts.find(x => x.id === c.activeId); if (!a) throw new Error("NO_PLATFORM_WALLET"); a.backedUp = true; persist(c); emit(); });
}
/**
 * Checks the one password against the keyring itself, counting wrong tries and waits as unlocking does, without opening any wallet
 * or session (for "enter your current password" before a change).
 */
export async function checkKeyringPassword(pin: string) {
  if (!keyringMode || !readKeyring()) throw new Error("NO_KEYRING");
  (await masterFromPin(pin)).fill(0);
}

export async function changePlatformPin(oldPin: string, newPin: string) {
  checkedPin(newPin);
  if (keyringMode && readKeyring()) {
    // One password: only the keyring's wrap changes; every wallet in it stays wrapped by the same master key.
    const master = await masterFromPin(oldPin);
    try { const ring = await wrapMaster(master, newPin); await mutate(() => { store().setItem(KEYRING_KEY, JSON.stringify(ring)); store().removeItem(ATTEMPTS_PREFIX + KEYRING_ID); }); }
    finally { master.fill(0); }
    emit();
    return;
  }
  const a = current(), start = epoch;
  const dataKey = await dataKeyFromPin(a, oldPin);
  try {
    const pin = await wrapWithPin(dataKey, newPin, a.id);
    await mutate(() => { assertCurrent(start, a.id); const c = read(); c.accounts.find(x => x.id === a.id)!.pin = pin; persist(c); store().removeItem(ATTEMPTS_PREFIX + a.id); emit(); });
  } finally { dataKey.fill(0); }
}

/**
 * Backup files are no longer made: the recovery phrase is the way back, and the PIN and passkey open the wallet on a device. A file
 * made before keeps its own password, and still restores here.
 */
async function accountFromBackup(backup: string, filePassword: string) {
  if (backup.length > 16_384) throw new Error("This file is too large to be a MAXXING backup.");
  let value: any;
  try { value = JSON.parse(backup); } catch { throw new Error("This isn't a MAXXING backup file."); }
  const v = value?.account?.vault;
  if (value?.format !== "maxxing-encrypted-wallet" || value.version !== 2 || !publicValid(value.account) || !v || v.version !== 2 || v.iterations !== BACKUP_ITERATIONS || typeof v.salt !== "string" || !sealValid(v)) throw new Error("This isn't a MAXXING backup file.");
  let mnemonic: string;
  try {
    const key = await pbkdf2(filePassword, unb64(v.salt), BACKUP_ITERATIONS);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(v.iv), additionalData: text("MAXXING wallet v2") }, key, unb64(v.cipher)));
    try { mnemonic = new TextDecoder().decode(plain); } finally { plain.fill(0); }
  } catch { throw new Error("Wrong file password."); }
  const account = derivePlatformAccount(mnemonic);
  if (!matches(account, value.account)) { dispose(account); throw new Error("This backup file is damaged."); }
  return account;
}
export async function previewPlatformBackup(backup: string, filePassword: string): Promise<PublicRecord> {
  const account = await accountFromBackup(backup, filePassword);
  try { return { evm: account.evm.address, solana: account.solana.address }; } finally { dispose(account); }
}
export async function importPlatformBackup(backup: string, filePassword: string, pin: string, label = "Restored wallet") {
  checkedPin(pin);
  return saveNew(await accountFromBackup(backup, filePassword), pin, label, true);
}

// ---- passkey unlock -------------------------------------------------------------------------------------------

const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (value: string) => unb64(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
const passkeyAad = (id: string, credential: string) => text(`MAXXING wallet v3 passkey:${id}:${credential}`);
type PrfResults = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };
const prfOf = (credential: PublicKeyCredential) => credential.getClientExtensionResults() as PrfResults;
const asBytes = (value: BufferSource) => value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

/** The wrapping key from a passkey's PRF output, bound to this wallet and credential. */
async function passkeyKey(prf: BufferSource, id: string, credential: string) {
  const secret = new Uint8Array(asBytes(prf));
  try {
    if (secret.length < 32) throw new Error("PASSKEY_PRF_UNAVAILABLE");
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: passkeyAad(id, credential) }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { secret.fill(0); }
}

/** Whether this browser can unlock a wallet with a passkey: false when it surely can't, true when it may. */
export async function passkeysSupported() {
  if (typeof window === "undefined" || typeof PublicKeyCredential === "undefined" || !navigator.credentials) return false;
  const getCaps = (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }).getClientCapabilities;
  if (getCaps) { try { const caps = await getCaps.call(PublicKeyCredential); if (caps["extension:prf"] === false) return false; } catch { /* unknown: let the user try */ } }
  return true;
}

function passkeyError(error: unknown): never {
  const name = (error as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") throw new Error("PASSKEY_CANCELLED");
  if (name === "InvalidStateError") throw new Error("PASSKEY_EXISTS");
  if (name === "SecurityError" || name === "NotSupportedError") throw new Error("PASSKEY_PRF_UNAVAILABLE");
  throw error instanceof Error ? error : new Error(String(error));
}

/** Asks the authenticator for this credential's PRF output on `salt`. The user is verified first (biometrics or device PIN). */
async function prfFor(credential: string, salt: Uint8Array) {
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname, userVerification: "required", timeout: 120_000,
    allowCredentials: [{ type: "public-key", id: unb64url(credential) }],
    extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
  } }).catch(passkeyError) as PublicKeyCredential | null;
  const first = assertion ? prfOf(assertion).prf?.results?.first : undefined;
  if (!first) throw new Error("PASSKEY_PRF_UNAVAILABLE");
  return first;
}

/** The data key for the active wallet: from this device's open session, else from the PIN. */
async function dataKeyForChange(a: SavedAccount, pin?: string) {
  const session = await readDeviceSession(a.id) ?? await dataKeyFromRingSession(a);
  if (session) return session;
  if (pin == null) throw Object.assign(new Error("Enter your PIN."), { code: "PIN_NEEDED" });
  return dataKeyFromPin(a, pin);
}
/** True when turning on a passkey needs the PIN, because the wallet is not open on this device. */
export async function passkeyNeedsPin() {
  try { const key = await readDeviceSession(current().id); if (key) { key.fill(0); return false; } } catch { /* ask for it */ }
  return true;
}

/**
 * Adds a passkey that opens the active wallet; the browser asks for Face ID, Touch ID, Windows Hello or a security key.
 * Needs the PIN only when the wallet is not already open on this device. Replaces an earlier passkey for this wallet.
 */
export async function addPlatformPasskey(pin?: string) {
  const a = current(), start = epoch;
  const dataKey = await dataKeyForChange(a, pin);
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const created = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: location.hostname, name: "MAXXING wallet" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `${a.label} · ${a.evm.slice(0, 6)}…${a.evm.slice(-4)}`, displayName: a.label },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      timeout: 120_000, attestation: "none",
      excludeCredentials: a.passkey ? [{ type: "public-key", id: unb64url(a.passkey.credential) }] : [],
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    } }).catch(passkeyError) as PublicKeyCredential | null;
    if (!created) throw new Error("PASSKEY_CANCELLED");
    const credential = b64url(new Uint8Array(created.rawId)), prf = prfOf(created).prf;
    if (prf?.enabled === false) { forgetPasskeyCredential(credential); throw new Error("PASSKEY_PRF_UNAVAILABLE"); }
    // Some authenticators give the PRF output only when the passkey is used, not when it is made: ask once more.
    let first: BufferSource;
    try { first = prf?.results?.first ?? await prfFor(credential, salt); }
    catch (error) { if (error instanceof Error && error.message === "PASSKEY_PRF_UNAVAILABLE") forgetPasskeyCredential(credential); throw error; }
    const key = await passkeyKey(first, a.id, credential), iv = crypto.getRandomValues(new Uint8Array(12));
    const wrap: PasskeyWrap = { credential, salt: b64(salt), iv: b64(iv), cipher: b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: passkeyAad(a.id, credential) }, key, new Uint8Array(dataKey)))) };
    const previous = a.passkey?.credential;
    await mutate(() => { assertCurrent(start, a.id); const c = read(); c.accounts.find(x => x.id === a.id)!.passkey = wrap; persist(c); emit(); });
    if (previous && previous !== credential) forgetPasskeyCredential(previous);
  } finally { dataKey.fill(0); }
}

/** Opens the active wallet with its passkey. */
export async function unlockPlatformWalletWithPasskey() {
  const a = current(), start = epoch;
  if (!a.passkey) throw new Error("PASSKEY_NOT_SET");
  const wrap = a.passkey;
  const key = await passkeyKey(await prfFor(wrap.credential, unb64(wrap.salt)), a.id, wrap.credential);
  let dataKey: Uint8Array;
  try { dataKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(wrap.iv), additionalData: passkeyAad(a.id, wrap.credential) }, key, unb64(wrap.cipher))); }
  catch { throw new Error("PASSKEY_WRONG"); }
  try {
    const account = await accountFor(a, dataKey);
    await open(a, account, dataKey, start);
    return { evm: a.evm, solana: a.solana };
  } finally { dataKey.fill(0); }
}

/** Turns passkey unlock off for the active wallet. The PIN still opens it. */
export async function removePlatformPasskey() {
  const a = current();
  await mutate(() => { const c = read(), x = c.accounts.find(y => y.id === a.id); if (!x) throw new Error("WALLET_NOT_FOUND"); delete x.passkey; persist(c); emit(); });
  if (a.passkey) forgetPasskeyCredential(a.passkey.credential);
}

/** Tells the browser's passkey manager that a passkey no longer opens anything (where supported), so it stops offering it. */
function forgetPasskeyCredential(credential: string) {
  const signal = typeof PublicKeyCredential === "undefined" ? undefined
    : (PublicKeyCredential as unknown as { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> }).signalUnknownCredential;
  if (signal) void signal.call(PublicKeyCredential, { rpId: location.hostname, credentialId: credential }).catch(() => {});
}

// ---- managing saved wallets ------------------------------------------------------------------------------------

/** Switches wallet. The other wallet opens without a PIN only if it is still signed in on this device. */
export async function selectPlatformWallet(id: string) {
  await mutate(() => { const c = read(); if (!c.accounts.some(a => a.id === id)) throw new Error("WALLET_NOT_FOUND"); epoch++; dispose(unlocked); unlocked = null; c.activeId = id; persist(c); });
  if (!(await restoreDeviceSession())) { sessionEpoch++; publish(selectedOf(byId(id))); }
  return { unlocked: platformWalletUnlocked() };
}
// ---- accounts of one recovery phrase ---------------------------------------------------------------------------

/**
 * Adds the next account of the active wallet's recovery phrase and opens it. The phrase is read with this device's open session,
 * or with the PIN when the wallet isn't open here; the new account's addresses are saved so it can be checked every time it opens.
 */
export async function addPlatformAccount(label?: string, pin?: string): Promise<AccountSummary> {
  const a = current(), start = epoch;
  const dataKey = await dataKeyForChange(a, pin);
  try {
    const used = accountsOf(a).map(x => x.index);
    const index = Math.max(...used) + 1;
    if (index > MAX_ACCOUNT_INDEX) throw new Error(`You can keep up to ${MAX_ACCOUNT_INDEX + 1} accounts per recovery phrase.`);
    const account = derivePlatformAccount(await openPhrase(a, dataKey), index);
    const record: ExtraAccount = { index, label: (label ?? "").trim().slice(0, 32) || `Account ${index + 1}`, evm: account.evm.address, solana: account.solana.address };
    let saved!: SavedAccount;
    try {
      await mutate(() => {
        assertCurrent(start, a.id);
        const c = read(), x = c.accounts.find(y => y.id === a.id)!;
        x.extra = [...(x.extra ?? []), record]; x.selected = index;
        persist(c); saved = x;
      });
      epoch++;
      await open(saved, account, dataKey, epoch);
    } catch (error) { if (unlocked !== account) dispose(account); throw error; }
    return { ...record, hidden: false };
  } finally { dataKey.fill(0); }
}

/** Opens another account of the active wallet's recovery phrase (the session or the PIN reads the phrase, as above). */
export async function selectPlatformAccount(index: number, pin?: string) {
  const a = current();
  if (!accountsOf(a).some(x => x.index === index)) throw new Error("ACCOUNT_NOT_FOUND");
  if ((a.selected ?? 0) === index && unlocked) return;
  const dataKey = await dataKeyForChange(a, pin);
  try {
    let saved!: SavedAccount;
    await mutate(() => { const c = read(), x = c.accounts.find(y => y.id === a.id); if (!x) throw new Error("WALLET_NOT_FOUND"); x.selected = index; persist(c); saved = x; });
    epoch++; dispose(unlocked); unlocked = null;
    const start = epoch;
    const account = await accountFor(saved, dataKey, index);
    await open(saved, account, dataKey, start);
  } finally { dataKey.fill(0); }
}

/** Renames an account. Account 0's name is the wallet's own name. */
export async function renamePlatformAccount(index: number, label: string) {
  await mutate(() => {
    const c = read(), a = c.accounts.find(x => x.id === c.activeId); if (!a) throw new Error("NO_PLATFORM_WALLET");
    const name = label.trim().slice(0, 32);
    if (index === 0) a.label = name || "My wallet";
    else { const x = a.extra?.find(y => y.index === index); if (!x) throw new Error("ACCOUNT_NOT_FOUND"); x.label = name || `Account ${index + 1}`; }
    persist(c); emit();
  });
}

/** Hides an account from the lists, or shows it again. The open account and account 0 can't be hidden. Nothing is deleted. */
export async function setPlatformAccountHidden(index: number, hidden: boolean) {
  await mutate(() => {
    const c = read(), a = c.accounts.find(x => x.id === c.activeId); if (!a) throw new Error("NO_PLATFORM_WALLET");
    if (index === 0 || (a.selected ?? 0) === index) throw new Error("Switch to another account before hiding this one.");
    const x = a.extra?.find(y => y.index === index); if (!x) throw new Error("ACCOUNT_NOT_FOUND");
    if (hidden) x.hidden = true; else delete x.hidden;
    persist(c); emit();
  });
}

export async function renamePlatformWallet(id: string, label: string) {
  await mutate(() => { const c = read(), a = c.accounts.find(x => x.id === id); if (!a) throw new Error("WALLET_NOT_FOUND"); a.label = label.trim().slice(0, 32) || "My wallet"; persist(c); emit(); });
}
/** Removes the active wallet from this device after the PIN. A wallet that was never backed up cannot be removed. */
export async function forgetPlatformWallet(pin: string) {
  const a = current();
  if (!a.backedUp) throw new Error("Back up this wallet before removing it.");
  (await dataKeyFromPin(a, pin)).fill(0);
  await mutate(async () => {
    const c = read();
    epoch++; dispose(unlocked); unlocked = null;
    c.accounts = c.accounts.filter(x => x.id !== a.id); c.activeId = c.accounts[0]?.id ?? null; persist(c);
    store().removeItem(ATTEMPTS_PREFIX + a.id);
    await forgetDeviceSession(a.id);
    if (a.passkey) forgetPasskeyCredential(a.passkey.credential);
    unpublish(selectedOf(a));
  });
}

/** Follows sign-in and sign-out from other tabs and wipes keys when the page goes away. */
export function startWalletProtection() {
  const changed = (event: StorageEvent) => {
    if (event.key === SIGNED_OUT_KEY || event.key === null) { epoch++; sessionEpoch++; dispose(unlocked); unlocked = null; emit(); }
    else if (event.key === SIGNED_IN_KEY || event.key === COLLECTION_KEY) {
      if (event.key === COLLECTION_KEY && unlocked && platformWalletPublic()?.evm.toLowerCase() !== unlocked.evm.address.toLowerCase()) { epoch++; dispose(unlocked); unlocked = null; }
      if (!unlocked) void restoreDeviceSession().then(emit);
      else emit();
    }
  };
  const wipe = () => { epoch++; dispose(unlocked); unlocked = null; };
  window.addEventListener("storage", changed);
  window.addEventListener("pagehide", wipe);
  return () => { window.removeEventListener("storage", changed); window.removeEventListener("pagehide", wipe); };
}
