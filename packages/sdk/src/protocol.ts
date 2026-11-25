/**
 * The wallet's message format, shared with the wallet window at wallet.maxxing.ad (`maxxing-wallet` v1).
 * Written out here rather than imported, so this MIT package stands alone when published and never includes the wallet's own code.
 */
export const WALLET_PROTOCOL = "maxxing-wallet";
export const WALLET_PROTOCOL_VERSION = 1;

export type WindowMethod = "connect" | "evm.signMessage" | "evm.signTypedData" | "evm.signTransaction" | "solana.signMessage" | "solana.signTransaction";
export type WalletConnection = { evm: `0x${string}`; solana: string };
/** A social account the person signed in with, verified by MAXXING for this app. */
export type LinkedAccount = { provider: string; subject: string; username: string | null; name: string | null; avatar: string | null; profile: string | null };
/** Who signed in to your app: an id for your app only, their wallet, and their verified accounts. */
export type MaxxingUser = { id: string; wallet: { evm: string; solana: string }; accounts: LinkedAccount[] };
/** What the wallet window answers a connect with. `user` and `identityToken` come when the wallet is open (always after signIn()). */
export type ConnectResult = WalletConnection & { user?: MaxxingUser; identityToken?: string };
export type WalletError = { message: string; code?: number };

export type WalletRequest = { protocol: typeof WALLET_PROTOCOL; v: number; id: string; app: string; method: WindowMethod; params?: unknown };
export type WalletResponse =
  | { protocol: typeof WALLET_PROTOCOL; v: number; id: string; ok: true; result: unknown }
  | { protocol: typeof WALLET_PROTOCOL; v: number; id: string; ok: false; error: WalletError };
export type WalletEvent = { protocol: typeof WALLET_PROTOCOL; v: number; event: string };

/** EIP-1193 error codes. */
export const ERROR_CODES = { userRejected: 4001, unauthorized: 4100, unsupported: 4200, disconnected: 4900, chainDisconnected: 4901, unknownChain: 4902, invalidParams: -32602, internal: -32603 } as const;

export class ProviderRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    this.data = data;
  }
}
