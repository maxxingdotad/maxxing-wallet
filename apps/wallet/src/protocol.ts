/**
 * Messages between an app and the wallet frame. Versioned from day one so apps keep working when it grows.
 * Values travel by structured clone, so bigint and Uint8Array arrive intact.
 */
export const WALLET_PROTOCOL = "maxxing-wallet";
export const WALLET_PROTOCOL_VERSION = 1;

export type WalletPublic = { evm: `0x${string}`; solana: string };
/** `passkey`: a passkey (Face ID, Touch ID, Windows Hello, a security key) can open this wallet as well as its PIN. */
export type WalletAccountSummary = WalletPublic & { id: string; label: string; backedUp: boolean; legacy: boolean; passkey?: boolean };

/** Everything an app may know about the wallet: public addresses and status, never keys. */
export type WalletState = {
  accounts: WalletAccountSummary[];
  activeId: string | null;
  public: WalletPublic | null;
  unlocked: boolean;
  storageError: string | null;
  /** The address this wallet last signed the app in with, or null once it is removed. */
  published: { wallet: string | null; solana: string | null; seq: number };
  /** Grows each time the frame ends the app's signed-in session (sign-out, switch, removal). */
  sessionEpoch: number;
  /** One-tap trading: the home site's requests are signed without a prompt. Off unless the user turned it on for this wallet. */
  oneTap?: boolean;
};

/**
 * Wallet screens the frame shows itself. The app opens one; the PIN, the recovery phrase and backup files
 * are handled only inside the frame and never reach the app.
 */
export type WalletScreen = "create" | "unlock" | "restore" | "backup" | "reveal" | "change-pin" | "remove" | "passkey" | "one-tap";
export type WalletScreenResult = { done: boolean };

export type WalletRequest = { protocol: typeof WALLET_PROTOCOL; v: number; id: string; app: string; method: string; params?: unknown };
export type WalletResponse =
  | { protocol: typeof WALLET_PROTOCOL; v: number; id: string; ok: true; result: unknown }
  | { protocol: typeof WALLET_PROTOCOL; v: number; id: string; ok: false; error: WalletError };
/** `code` follows EIP-1193 where one fits, so providers can pass it straight on. */
export type WalletError = { message: string; code?: number };
export const WALLET_ERROR_CODES = { userRejected: 4001, unauthorized: 4100, unsupported: 4200, disconnected: 4900, invalidParams: -32602, internal: -32603 } as const;
export type WalletEvent =
  | { protocol: typeof WALLET_PROTOCOL; v: number; event: "ready" }
  | { protocol: typeof WALLET_PROTOCOL; v: number; event: "state"; state: WalletState }
  /** The frame wants to be shown (one of its screens is open) or hidden again. */
  | { protocol: typeof WALLET_PROTOCOL; v: number; event: "visible"; visible: boolean };

/**
 * Partner websites open the wallet window (`/connect.html?app=<id>`) and talk to it the same way. Every request is shown
 * to the user there: connecting once, then each signature.
 */
export const WINDOW_METHODS = ["connect", "evm.signMessage", "evm.signTypedData", "evm.signTransaction", "solana.signMessage", "solana.signTransaction"] as const;
export type WindowMethod = (typeof WINDOW_METHODS)[number];
/** What a connected app learns: the active wallet's public addresses. */
export type WalletConnection = { evm: `0x${string}`; solana: string };
