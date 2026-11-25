/**
 * What the hidden frame does before it signs a request from the home site (maxxing.ad). Every signature is shown and approved
 * first, unless the user turned on one-tap signing for the wallet (@maxxing/wallet-core/approvals). The screen comes from the wallet
 * core (@maxxing/wallet-core/request-view), the same one every MAXXING wallet uses, and the request that gets signed is the one that
 * was shown: a transaction is signed as checked, field by field.
 */
import * as vault from "@maxxing/wallet-core/vault";
import { oneTapEnabled } from "@maxxing/wallet-core/approvals";
import { approvalView, USER_REJECTED, USER_REJECTED_CODE, type ApprovalView, type SigningMethod } from "@maxxing/wallet-core/request-view";

export { approvalView, isSigningMethod, SIGNING_METHODS, USER_REJECTED, type ApprovalView, type SigningMethod } from "@maxxing/wallet-core/request-view";

/**
 * Signs only after the user approves the request on the wallet's own screen (`ask`), unless they turned on one-tap trading for the
 * active wallet. What is signed is what was shown. A locked wallet refuses before anything is shown; a wallet switched or closed
 * while the screen was open refuses after it.
 */
export async function signWithConsent(method: SigningMethod, params: unknown, origin: string, ask: (view: ApprovalView) => Promise<boolean>, sign: (params: unknown) => unknown): Promise<unknown> {
  const walletId = vault.activePlatformWalletId();
  const wallet = vault.platformWalletPublic();
  if (!vault.platformWalletUnlocked() || !wallet || !walletId) throw new Error("WALLET_LOCKED");
  if (oneTapEnabled(walletId)) return sign(params);
  const { view, params: shown } = approvalView(method, params, origin, wallet);
  if (!(await ask(view))) throw Object.assign(new Error(USER_REJECTED), { code: USER_REJECTED_CODE });
  if (vault.activePlatformWalletId() !== walletId || !vault.platformWalletUnlocked()) throw new Error("WALLET_OPERATION_CANCELLED");
  return sign(shown);
}
