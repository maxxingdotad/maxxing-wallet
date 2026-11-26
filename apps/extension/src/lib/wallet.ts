/**
 * The wallet as the extension's pages use it: the MAXXING wallet core's vault (the same code and storage format as
 * wallet.maxxing.ad), running in the extension's own pages. Keys exist only in the memory of an open extension page, never in the
 * background. The public addresses are mirrored to chrome.storage.session (memory only) so the background can answer connected
 * sites while the wallet is open.
 */
import { lockIfStale } from "./lock"; // first: the vault keeps open sessions in memory-only storage
import * as vault from "@maxxing/wallet-core/vault";
import * as signing from "@maxxing/wallet-core/signing";
import { isSolanaTransactionMessage, parseSolanaTransaction, signSolanaTransaction } from "@maxxing/wallet-core/solana-tx";
import { approvalView, type ApprovalView, type SigningMethod } from "@maxxing/wallet-core/request-view";
import { account, activity, kept, lastActive } from "./store";
import type { SiteMethod } from "./protocol";
import { loadUserNetworks } from "./user-networks";

export type WalletSnapshot = { accounts: vault.WalletSummary[]; activeId: string | null; unlocked: boolean; public: { evm: string; solana: string } | null; storageError: string | null };

export function snapshot(): WalletSnapshot {
  try {
    return { accounts: vault.savedPlatformWallets(), activeId: vault.activePlatformWalletId(), unlocked: vault.platformWalletUnlocked(), public: vault.platformWalletPublic(), storageError: null };
  } catch (error) {
    return { accounts: [], activeId: null, unlocked: false, public: null, storageError: error instanceof Error ? error.message : "WALLET_STORAGE_DAMAGED_RESTORE_BACKUP" };
  }
}

/**
 * Tells every tab's content script that the connection may have changed; each then asks the background, which answers for that
 * tab's own origin (so the extension needs no permission to read the tabs' addresses).
 */
export async function announce() {
  await account.write(vault.platformWalletUnlocked() ? vault.platformWalletPublic() : null);
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, { type: "site-connection-check" }).catch(() => {});
}

let started = false;
/**
 * Opens the wallet for this page: reopens it if it is still open in this browser session and the user hasn't been away longer
 * than the auto-lock time; follows locks from other pages and the auto-lock. Opening a page doesn't count as activity: only the
 * user's own clicks and keys do (a site can open the approval window, but it can't click in it).
 */
export async function start(): Promise<WalletSnapshot> {
  await loadUserNetworks(); // the user's own RPC endpoints and networks, before any screen lists networks
  if (!started) {
    started = true;
    vault.setWalletPublishing(false);
    vault.useKeyring(true); // one password for the whole extension: every wallet and account sits behind it
    vault.startWalletProtection();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "session" && changes.lockedAt?.newValue) void vault.signOutPlatformWallet().then(() => window.dispatchEvent(new Event("maxxing:wallet")));
    });
    for (const event of ["pointerdown", "keydown"]) window.addEventListener(event, e => { if (e.isTrusted) void lastActive.touch(); }, { passive: true, capture: true });
  }
  if (!vault.platformWalletUnlocked() && !(await lockIfStale())) await vault.restoreDeviceSession().catch(() => false);
  if (vault.platformWalletUnlocked()) await account.write(vault.platformWalletPublic());
  return snapshot();
}

async function opened(kind: "unlock" | "create" | "import") {
  await lastActive.touch();
  await announce();
  if (kind === "unlock") await activity.add({ kind: "unlock", text: "Wallet unlocked" });
}
export async function unlock(pin: string) {
  const before = vault.keyringExists();
  await vault.unlockPlatformWallet(pin);
  // This unlock turned an older wallet's PIN into the one password: Home then offers (once, optional) to choose a new one.
  if (!before && vault.keyringExists()) await kept.set("offer-new-password", true);
  await opened("unlock");
}
/** After the move to one password: whether to offer choosing a new one (the old PIN became the password). */
export const newPasswordOffered = () => kept.get<boolean>("offer-new-password", false);
export const dismissNewPasswordOffer = () => kept.set("offer-new-password", false);
/** A new wallet. The password is needed only for the first wallet on this device (it sets the password); never a new one after. */
export async function create(pin?: string, label?: string) { await vault.createPlatformWallet(pin, label); await opened("create"); }
export async function restore(phrase: string, pin?: string, label?: string) { await vault.importPlatformWallet(phrase, pin, label); await opened("import"); }
/** The password is set on this device (so adding a wallet needs no new PIN). */
export const passwordSet = () => vault.keyringExists();
/** Whether the password was entered in this browser session (the extension is unlocked). */
export const passwordOpen = () => vault.keyringOpen();
/** Wallets from before the one password, each needing its old PIN once. */
export const needingOldPin = () => vault.walletsNeedingOldPin();
/** Moves an older wallet behind the password, after its old PIN; then opens it if it's the active one. */
export async function addOldWallet(id: string, oldPin: string) {
  await vault.adoptPlatformWallet(id, oldPin);
  await activity.add({ kind: "unlock", text: "An older wallet now opens with your password" });
  if (vault.activePlatformWalletId() === id && !vault.platformWalletUnlocked()) await vault.restoreDeviceSession();
  await announce();
}
export async function lock() { await vault.signOutPlatformWallet(); await announce(); await activity.add({ kind: "lock", text: "Wallet locked" }); }
export async function select(id: string) { await vault.selectPlatformWallet(id); await announce(); }
export const rename = (id: string, label: string) => vault.renamePlatformWallet(id, label);
/** Accounts of the open wallet's recovery phrase. Switching changes what connected sites see, so they are told. */
export async function addAccount(label?: string) { const a = await vault.addPlatformAccount(label); await announce(); return a; }
export async function selectAccount(index: number) { await vault.selectPlatformAccount(index); await announce(); }
export const renameAccount = (index: number, label: string) => vault.renamePlatformAccount(index, label);
export const hideAccount = (index: number, hidden: boolean) => vault.setPlatformAccountHidden(index, hidden);
export const pinWaitUntil = () => vault.pinWaitUntil();

/** Exports, each logged locally (the Activity list shows when and what, never the secret itself). */
export async function revealPhrase(pin: string) { const phrase = await vault.revealPlatformMnemonic(pin); await activity.add({ kind: "export", text: "Recovery phrase shown" }); return phrase; }
export async function revealKeys(pin: string) { const keys = await vault.revealPlatformPrivateKeys(pin); await activity.add({ kind: "export", text: "Private keys shown" }); return keys; }
/** Checks the current password against the keyring (wrong tries count), opening nothing and logging nothing. */
export const checkPassword = (password: string) => vault.checkKeyringPassword(password);
/** Changes the one password: only the keyring's wrap changes; every wallet stays as it is. */
export async function changePassword(oldPassword: string, newPassword: string) {
  await vault.changePlatformPin(oldPassword, newPassword);
  await dismissNewPasswordOffer();
  await activity.add({ kind: "unlock", text: "Password changed" });
}
export const confirmBackup = (pin: string, checks: { index: number; word: string }[]) => vault.confirmPlatformBackup(pin, checks);
export async function remove(pin: string) { await vault.forgetPlatformWallet(pin); await announce(); }

// ── Site requests ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A site's request as the core's approval screen sees it. */
function asCoreRequest(method: Exclude<SiteMethod, "connect">, params: any): { method: SigningMethod; params: unknown } {
  switch (method) {
    case "evm.signMessage": return { method, params: { message: params?.message } };
    case "evm.signTypedData": return { method, params: params?.typedData };
    case "evm.signTransaction": return { method, params: { transaction: params?.transaction } };
    case "solana.signMessage": {
      const bytes = params?.bytes;
      if (!(bytes instanceof Uint8Array) || isSolanaTransactionMessage(bytes)) throw new Error("SOLANA_MESSAGE_IS_TRANSACTION");
      return { method: "solana.signBytes", params: { bytes } };
    }
    case "solana.signTransaction": {
      const bytes = params?.bytes;
      if (!(bytes instanceof Uint8Array)) throw new Error("SOLANA_TX_INVALID");
      return { method: "solana.signBytes", params: { bytes: bytes.subarray(parseSolanaTransaction(bytes).messageOffset) } };
    }
    case "evm.switchChain": case "evm.addChain": throw new Error("Switching or adding networks signs nothing.");
  }
}

/** The approval screen for a site's request, and what would be signed. Throws when the request can't be shown faithfully. */
export function review(method: Exclude<SiteMethod, "connect">, params: any, origin: string): { view: ApprovalView; signed: unknown } {
  const open = vault.platformWalletPublic();
  if (!open) throw new Error("WALLET_LOCKED");
  const address = method.startsWith("evm.") ? open.evm : open.solana;
  if (typeof params?.address === "string" && params.address.toLowerCase() !== address.toLowerCase()) throw new Error("WALLET_CHANGED");
  const core = asCoreRequest(method, params);
  const { view, params: shown } = approvalView(core.method, core.params, origin, open);
  return { view, signed: shown };
}

/** Signs exactly what `review` returned, with the open wallet. */
export async function sign(method: Exclude<SiteMethod, "connect">, params: any, signed: any): Promise<unknown> {
  const open = vault.platformWalletPublic();
  if (!vault.platformWalletUnlocked() || !open) throw new Error("WALLET_LOCKED");
  switch (method) {
    case "evm.signMessage": return signing.evmSignMessage({ message: signed.message });
    case "evm.signTypedData": return signing.evmSignTypedData(signed);
    case "evm.signTransaction": return signing.evmSignTransaction({ transaction: signed.transaction });
    case "solana.signMessage": return signing.solanaSignBytes({ bytes: signed.bytes });
    case "solana.signTransaction": return signSolanaTransaction(params.bytes, open.solana, bytes => signing.solanaSignBytes({ bytes }));
  }
}

export { vault };
