import bs58 from "bs58";
import type { IdentifierString, Wallet, WalletAccount } from "@wallet-standard/base";
import type { StandardConnectFeature, StandardDisconnectFeature, StandardEventsFeature, StandardEventsListeners, StandardEventsNames } from "@wallet-standard/features";
import type { SolanaSignMessageFeature, SolanaSignMessageInput, SolanaSignMessageOutput, SolanaSignTransactionFeature, SolanaSignTransactionInput, SolanaSignTransactionOutput } from "@solana/wallet-standard-features";
import type { ConnectionStore } from "./connection";
import { ERROR_CODES, ProviderRpcError, type WalletConnection } from "./protocol";
import type { WalletWindow } from "./transport";
import { WALLET_ICON } from "./dialog";

type Features = StandardConnectFeature & StandardDisconnectFeature & StandardEventsFeature & SolanaSignMessageFeature & SolanaSignTransactionFeature;

/**
 * The MAXXING wallet as a Solana Wallet Standard wallet, so @solana/wallet-adapter and other standard apps list it.
 * Apps send signed transactions themselves (the adapter falls back to signTransaction + sendRawTransaction).
 */
export class MaxxingSolanaWallet implements Wallet {
  readonly version = "1.0.0" as const;
  readonly name = "MAXXING Wallet";
  readonly icon = WALLET_ICON as Wallet["icon"];
  readonly chains: IdentifierString[];
  private listeners: { [E in StandardEventsNames]?: Set<StandardEventsListeners[E]> } = {};
  private current: WalletAccount | null = null;

  constructor(private readonly wallet: WalletWindow, private readonly store: ConnectionStore, chains: string[]) {
    this.chains = chains as IdentifierString[];
    this.current = this.accountFor(store.connection);
    store.subscribe(connection => {
      const next = this.accountFor(connection);
      if (next?.address === this.current?.address) return;
      this.current = next;
      for (const listener of this.listeners.change ?? []) listener({ accounts: this.accounts });
    });
  }

  get accounts(): readonly WalletAccount[] { return this.current ? [this.current] : []; }

  get features(): Features {
    return {
      "standard:connect": { version: "1.0.0", connect: async input => {
        if (!this.store.connection && input?.silent) return { accounts: [] };
        if (!this.store.connection) { const result = await this.wallet.request<WalletConnection>("connect"); this.store.set({ evm: result.evm, solana: result.solana }); }
        return { accounts: this.accounts };
      } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { this.store.set(null); } },
      "standard:events": { version: "1.0.0", on: (event, listener) => {
        const set = (this.listeners[event] ??= new Set()) as Set<typeof listener>;
        set.add(listener);
        return () => { set.delete(listener); };
      } },
      "solana:signMessage": { version: "1.1.0", signMessage: (...inputs) => this.sequence(inputs, input => this.signMessage(input)) },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: (...inputs) => this.sequence(inputs, input => this.signTransaction(input)) },
    };
  }

  private accountFor(connection: WalletConnection | null): WalletAccount | null {
    if (!connection) return null;
    return Object.freeze({
      address: connection.solana,
      publicKey: bs58.decode(connection.solana),
      chains: this.chains,
      features: ["solana:signMessage", "solana:signTransaction"] as IdentifierString[],
    });
  }

  /** One wallet window request at a time, in order. */
  private async sequence<I, O>(inputs: readonly I[], each: (input: I) => Promise<O>): Promise<O[]> {
    const out: O[] = [];
    for (const input of inputs) out.push(await each(input));
    return out;
  }

  private address(account: WalletAccount) {
    if (!this.current || account.address !== this.current.address) throw new ProviderRpcError(ERROR_CODES.unauthorized, "This account isn't connected.");
    return account.address;
  }

  private async ask<T>(method: "solana.signMessage" | "solana.signTransaction", params: unknown) {
    try { return await this.wallet.request<T>(method, params); }
    catch (error) {
      if ((error as Error).message === "WALLET_CHANGED") this.store.set(null);
      throw error;
    }
  }

  private async signMessage(input: SolanaSignMessageInput): Promise<SolanaSignMessageOutput> {
    const signature = await this.ask<Uint8Array>("solana.signMessage", { address: this.address(input.account), bytes: new Uint8Array(input.message) });
    return { signedMessage: input.message, signature, signatureType: "ed25519" };
  }

  private async signTransaction(input: SolanaSignTransactionInput): Promise<SolanaSignTransactionOutput> {
    if (input.chain && !this.chains.includes(input.chain)) throw new ProviderRpcError(ERROR_CODES.unknownChain, `MAXXING Wallet doesn't support ${input.chain}.`);
    const signedTransaction = await this.ask<Uint8Array>("solana.signTransaction", { address: this.address(input.account), bytes: new Uint8Array(input.transaction) });
    return { signedTransaction };
  }
}

/** The Wallet Standard handshake: announce now, and again to any app that loads later. */
export function registerWallet(wallet: Wallet, target: Pick<Window, "dispatchEvent" | "addEventListener"> = window) {
  const callback = ({ register }: { register: (...wallets: Wallet[]) => unknown }) => register(wallet);
  class RegisterWalletEvent extends Event {
    readonly #detail = callback;
    get detail() { return this.#detail; }
    get type() { return "wallet-standard:register-wallet"; }
    constructor() { super("wallet-standard:register-wallet", { bubbles: false, cancelable: false, composed: false }); }
  }
  try { target.dispatchEvent(new RegisterWalletEvent()); } catch { /* no app yet */ }
  try { target.addEventListener("wallet-standard:app-ready", ((event: CustomEvent) => callback(event.detail)) as EventListener); } catch { /* no app yet */ }
}
