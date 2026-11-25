import type { WalletState } from "./protocol";
import { activePlatformWalletId, platformWalletPublic, platformWalletUnlocked, savedPlatformWallets, walletPublishSeq, walletSessionEpoch } from "@maxxing/wallet-core/vault";

/** Public status for the app: addresses, labels and flags. Never a key, a phrase or a ciphertext. */
export function walletState(): WalletState {
  let accounts: WalletState["accounts"] = [], activeId: string | null = null, storageError: string | null = null;
  try { accounts = savedPlatformWallets(); activeId = activePlatformWalletId(); }
  catch (error) { storageError = error instanceof Error ? error.message : "WALLET_STORAGE_DAMAGED_RESTORE_BACKUP"; }
  let wallet: string | null = null, solana: string | null = null;
  try { wallet = localStorage.getItem("maxxing.wallet"); solana = localStorage.getItem("maxxing.solana"); } catch { /* storage blocked */ }
  return { accounts, activeId, public: platformWalletPublic(), unlocked: platformWalletUnlocked(), storageError, published: { wallet, solana, seq: walletPublishSeq() }, sessionEpoch: walletSessionEpoch() };
}
