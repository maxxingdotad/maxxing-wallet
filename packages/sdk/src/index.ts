import { mainnetSolanaChains, networksFor } from "./networks";
import { ConnectionStore } from "./connection";
import { MaxxingEthereumProvider, announceProvider } from "./ethereum";
import { MaxxingSolanaWallet, registerWallet } from "./solana";
import { WalletWindow } from "./transport";
import type { MaxxingUser, WalletConnection } from "./protocol";
import type { WalletTheme } from "./theme";
import { mountConnectButton, type ConnectButton, type ConnectButtonOptions } from "./widget";
import type { WindowAppearanceInput } from "./appearance";
import { mountTradeWidget, type TradeWidget, type TradeWidgetOptions } from "./trade-widget";
import { createMaxxingData, type MaxxingData } from "./data";

export { MaxxingEthereumProvider, announceProvider, PROVIDER_INFO, type EvmNetwork } from "./ethereum";
export { MaxxingSolanaWallet, registerWallet } from "./solana";
export { WalletWindow } from "./transport";
export { ProviderRpcError, ERROR_CODES, type WalletConnection, type MaxxingUser, type LinkedAccount } from "./protocol";
export { WALLET_ICON } from "./dialog";
export { THEMES, resolveTheme, shortAddress, systemPrefersLight, type WalletTheme, type ResolvedTheme } from "./theme";
export { mountConnectButton, type ConnectButton, type ConnectButtonOptions, type ConnectMenuItem, type WidgetWallet } from "./widget";
export { defineConnectElement } from "./element";
export { mountTradeWidget, type TradeWidget, type TradeWidgetOptions } from "./trade-widget";
export { createMaxxingData, MaxxingDataError, formatUsd, parseTokenId, tokenId, type MaxxingData, type MaxxingDataOptions, type TokenSummary, type TokenDetail, type Price, type Candle, type Trade, type Holder, type Position, type WalletStats, type TokenRef, type WalletBalance, type WalletBalances, type TradeQuote, type TradeQuoteInput } from "./data";
export { DEFAULT_APPEARANCE, cleanAppearance, type WindowAppearance, type WindowAppearanceInput } from "./appearance";
export { formatUnits, parseUnits, readBalance, readReceipt, waitForReceipt, signMessage, signTypedData, sendTransaction, switchChain, networkFor, type Balance, type Receipt, type TransactionRequest } from "./actions";

export type MaxxingWalletOptions = {
  /** Your app's id from developers.maxxing.ad. */
  appId: string;
  /** The wallet's site. Leave out for https://wallet.maxxing.ad. */
  walletUrl?: string;
  /** EVM networks your app uses (chain ids). Defaults to every mainnet MAXXING supports; a test network only when you list it. */
  chains?: number[];
  /** The network to start on. Defaults to the first of `chains`. */
  defaultChainId?: number;
  /** Your own RPC endpoints per chain id, tried before the public ones. */
  rpcUrls?: Record<number, string[]>;
  /** Solana networks to offer (Wallet Standard ids). Defaults to every Solana network MAXXING supports. */
  solanaChains?: string[];
  /** Announce the wallet to EIP-6963 and Wallet Standard apps. On by default. */
  announce?: boolean;
  /** Show the small "continue in the wallet" dialog on your page while the wallet window is open. On by default. */
  dialog?: boolean;
  /** Colours, radius and font for the connect button and the waiting dialog, so they match your site. */
  theme?: WalletTheme;
  /**
   * How the wallet window's sign-in looks on this site: theme, accent, corners, font, logo, title, welcome text, button
   * order, the MAXXING wallet option and your terms links. Fields you leave out use what you set at developers.maxxing.ad.
   */
  appearance?: WindowAppearanceInput;
  /** The Data API's address, for the trade widget. Leave out for https://api.maxxing.ad. */
  apiUrl?: string;
};

export type MaxxingWallet = {
  /** EIP-1193 provider: use with viem, wagmi, ethers or directly. */
  ethereum: MaxxingEthereumProvider;
  /** Solana Wallet Standard wallet. */
  solana: MaxxingSolanaWallet;
  /** Opens the wallet to connect (once per user), and returns their addresses. */
  connect(): Promise<WalletConnection>;
  /**
   * Signs the person in: social sign-in (the methods you turned on at developers.maxxing.ad) or their MAXXING wallet.
   * Returns their addresses, who they are for your app, and an identity token to check on your server with
   * verifyIdentityToken from "@maxxing/wallet-sdk/server". From a click.
   */
  signIn(): Promise<{ connection: WalletConnection; user: MaxxingUser | null; identityToken: string | null }>;
  /** The signed-in user (id, wallet, verified social accounts), or null. */
  readonly user: MaxxingUser | null;
  /** The latest identity token for your server, or null. It lasts an hour; call signIn() again for a new one. */
  readonly identityToken: string | null;
  /** Forgets the connection on this site. The user can also remove your app from their wallet. */
  disconnect(): void;
  /** The connected addresses, or null. */
  readonly connection: WalletConnection | null;
  /** Called whenever the connection changes. Returns a function that stops listening. */
  onChange(listener: (connection: WalletConnection | null) => void): () => void;
  /** Puts a themed connect button (an account menu once connected) into `target`, an element or a CSS selector. */
  mountConnectButton(target: Element | string, options?: ConnectButtonOptions): ConnectButton;
  /** Puts a trade card for one token (price, chart, buy and sell) into `target`. Your app earns inside the trades it brings. */
  mountTradeWidget(target: Element | string, options: TradeWidgetOptions): TradeWidget;
  destroy(): void;
};

export { networksFor, browserRpcOrigins } from "./networks";

/** Sets up the MAXXING wallet for your site. Call once, early (before your wallet library looks for wallets). */
export function createMaxxingWallet(options: MaxxingWalletOptions): MaxxingWallet {
  if (!options?.appId || typeof options.appId !== "string") throw new Error("MAXXING_WALLET_APP_ID_REQUIRED");
  const walletUrl = options.walletUrl ?? "https://wallet.maxxing.ad";
  const transport = new WalletWindow({ appId: options.appId, walletUrl, dialog: options.dialog, theme: options.theme, appearance: options.appearance });
  const store = new ConnectionStore(options.appId);
  const networks = networksFor(options);
  const ethereum = new MaxxingEthereumProvider(transport, store, networks, options.defaultChainId ?? networks[0]!.chainId);
  const solanaChains = options.solanaChains ?? mainnetSolanaChains;
  const solana = new MaxxingSolanaWallet(transport, store, solanaChains);
  if (options.announce !== false && typeof window !== "undefined") {
    announceProvider(ethereum);
    registerWallet(solana);
  }
  let data: MaxxingData | undefined;
  const wallet: MaxxingWallet = {
    ethereum, solana,
    connect: () => ethereum.connect(),
    disconnect: () => ethereum.disconnect(),
    signIn: () => ethereum.signIn(true),
    get user() { return ethereum.session?.user ?? null; },
    get identityToken() { return ethereum.session?.identityToken ?? null; },
    get connection() { return store.connection; },
    onChange: listener => { const stop = store.subscribe(listener); return () => { stop(); }; },
    mountConnectButton: (target, buttonOptions) => mountConnectButton(wallet, target, buttonOptions, options.theme),
    mountTradeWidget: (target, tradeOptions) => mountTradeWidget(wallet, data ??= createMaxxingData({ appId: options.appId, baseUrl: options.apiUrl }), target, tradeOptions, options.theme),
    destroy: () => transport.destroy(),
  };
  return wallet;
}
