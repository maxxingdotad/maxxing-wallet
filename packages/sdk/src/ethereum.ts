import type { ConnectionStore } from "./connection";
import { ERROR_CODES, ProviderRpcError, type ConnectResult, type MaxxingUser, type WalletConnection } from "./protocol";
import { READ_METHODS, quantity, rpcCall, toQuantity } from "./rpc";
import type { WalletWindow } from "./transport";
import { WALLET_ICON } from "./dialog";

export type EvmNetwork = { chainId: number; name: string; nativeSymbol: string; rpcUrls: readonly string[]; testnet?: boolean; explorerUrl?: string };
type RequestArguments = { method: string; params?: unknown[] | Record<string, unknown> };
type Listener = (...args: unknown[]) => void;

const hexChain = (chainId: number) => `0x${chainId.toString(16)}`;
const isAddress = (value: unknown): value is `0x${string}` => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
const isHexData = (value: unknown): value is `0x${string}` => typeof value === "string" && /^0x([0-9a-fA-F]{2})*$/.test(value);

/**
 * An EIP-1193 provider for the MAXXING wallet. Reads go to the network; connecting and every signature open the wallet
 * window. Transactions are filled here (nonce, gas, fees) and the wallet shows exactly those values before signing.
 */
export class MaxxingEthereumProvider {
  readonly isMaxxing = true;
  private listeners = new Map<string, Set<Listener>>();
  private chainId: number;

  constructor(private readonly wallet: WalletWindow, private readonly store: ConnectionStore, private readonly networks: EvmNetwork[], defaultChainId: number, private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {
    if (!networks.length) throw new Error("MAXXING_WALLET_NO_NETWORKS");
    const saved = store.chainId;
    this.chainId = saved && networks.some(n => n.chainId === saved) ? saved : defaultChainId;
    if (!networks.some(n => n.chainId === this.chainId)) this.chainId = networks[0]!.chainId;
    store.subscribe(connection => this.emit("accountsChanged", connection ? [connection.evm] : []));
  }

  get network() { return this.networks.find(n => n.chainId === this.chainId)!; }
  /** The networks this app offers, in the order it listed them. */
  get availableNetworks(): readonly EvmNetwork[] { return this.networks; }

  on(event: string, listener: Listener) { (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(listener); return this; }
  removeListener(event: string, listener: Listener) { this.listeners.get(event)?.delete(listener); return this; }
  off(event: string, listener: Listener) { return this.removeListener(event, listener); }
  private emit(event: string, ...args: unknown[]) { for (const listener of this.listeners.get(event) ?? []) { try { listener(...args); } catch { /* a listener's error is its own */ } } }

  async request(args: RequestArguments): Promise<unknown> {
    if (!args || typeof args.method !== "string") throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid request");
    const params = Array.isArray(args.params) ? args.params : args.params === undefined ? [] : [args.params];
    switch (args.method) {
      case "eth_chainId": return hexChain(this.chainId);
      case "net_version": return String(this.chainId);
      case "eth_accounts": return this.store.connection ? [this.store.connection.evm] : [];
      case "eth_requestAccounts": return [(await this.connect()).evm];
      case "wallet_requestPermissions": await this.connect(); return [{ parentCapability: "eth_accounts" }];
      case "wallet_getPermissions": return this.store.connection ? [{ parentCapability: "eth_accounts" }] : [];
      case "wallet_revokePermissions": this.disconnect(); return null;
      case "wallet_switchEthereumChain": return this.switchChain(params[0]);
      case "wallet_addEthereumChain": return this.switchChain(params[0]);
      case "personal_sign": return this.personalSign(params);
      case "eth_signTypedData_v4": return this.signTypedData(params);
      case "eth_sendTransaction": return this.sendTransaction(params[0]);
      case "eth_signTransaction": return this.signTransaction(params[0]);
      case "eth_sign": throw new ProviderRpcError(ERROR_CODES.unsupported, "eth_sign is not supported. Use personal_sign.");
    }
    if (READ_METHODS.has(args.method)) return rpcCall(this.network.rpcUrls, args.method, params, this.fetcher);
    throw new ProviderRpcError(ERROR_CODES.unsupported, `${args.method} is not supported`);
  }

  /** The signed-in user and their identity token, from the last connect or signIn (kept in memory only). */
  session: { user: MaxxingUser; identityToken: string } | null = null;

  async connect(): Promise<WalletConnection> {
    if (this.store.connection) return this.store.connection;
    return (await this.signIn(false)).connection;
  }

  /**
   * Opens the wallet window to sign in: social sign-in if the app turned it on, or the MAXXING wallet. With `identity`
   * (the default) the wallet opens if needed so the app always gets a fresh identity token for its server.
   */
  async signIn(identity = true): Promise<{ connection: WalletConnection; user: MaxxingUser | null; identityToken: string | null }> {
    const result = await this.wallet.request<ConnectResult>("connect", identity ? { identity: true } : undefined);
    const connection: WalletConnection = { evm: result.evm, solana: result.solana };
    // Set before the connection changes, so listeners already see the user.
    this.session = result.user && typeof result.identityToken === "string" ? { user: result.user, identityToken: result.identityToken } : this.session && this.store.connection?.evm.toLowerCase() === connection.evm.toLowerCase() ? this.session : null;
    const fresh = !this.store.connection;
    this.store.set(connection);
    if (fresh) this.emit("connect", { chainId: hexChain(this.chainId) });
    return { connection, user: this.session?.user ?? null, identityToken: this.session?.identityToken ?? null };
  }

  disconnect() {
    this.session = null;
    if (!this.store.connection) return;
    this.store.set(null);
    this.emit("disconnect", new ProviderRpcError(ERROR_CODES.disconnected, "Disconnected"));
  }

  private account(requested?: unknown): `0x${string}` {
    const connection = this.store.connection;
    if (!connection) throw new ProviderRpcError(ERROR_CODES.unauthorized, "Connect the wallet first.");
    if (requested !== undefined && (!isAddress(requested) || requested.toLowerCase() !== connection.evm.toLowerCase()))
      throw new ProviderRpcError(ERROR_CODES.unauthorized, "This address isn't connected.");
    return connection.evm;
  }

  /** The wallet refuses requests made for another wallet (switched since connecting): forget it so the app reconnects. */
  private async ask<T>(method: Parameters<WalletWindow["request"]>[0], params: unknown): Promise<T> {
    try { return await this.wallet.request<T>(method, params); }
    catch (error) {
      if ((error as Error).message === "WALLET_CHANGED") this.disconnect();
      throw error;
    }
  }

  private switchChain(param: unknown) {
    const chainId = Number(quantity((param as { chainId?: unknown })?.chainId, "chainId"));
    const network = this.networks.find(n => n.chainId === chainId);
    if (!network) throw new ProviderRpcError(ERROR_CODES.unknownChain, `MAXXING Wallet doesn't support chain ${chainId}.`);
    if (chainId !== this.chainId) {
      this.chainId = chainId;
      this.store.setChain(chainId);
      this.emit("chainChanged", hexChain(chainId));
    }
    return null;
  }

  private personalSign(params: unknown[]) {
    // Wallets disagree on the order; the address is whichever parameter is one.
    const [first, second] = params;
    const [message, address] = isAddress(first) && !isAddress(second) ? [second, first] : [first, second];
    if (typeof message !== "string") throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid message");
    return this.ask<string>("evm.signMessage", { address: this.account(address), message: isHexData(message) ? { raw: message } : message });
  }

  private signTypedData(params: unknown[]) {
    const [address, payload] = params;
    let typedData: unknown;
    try { typedData = typeof payload === "string" ? JSON.parse(payload) : payload; }
    catch { throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid typed data"); }
    if (!typedData || typeof typedData !== "object") throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid typed data");
    const domainChain = (typedData as { domain?: { chainId?: unknown } }).domain?.chainId;
    if (domainChain !== undefined && Number(quantity(domainChain, "domain.chainId")) !== this.chainId)
      throw new ProviderRpcError(ERROR_CODES.invalidParams, "Typed data is for another network. Switch networks first.");
    return this.ask<string>("evm.signTypedData", { address: this.account(address), typedData });
  }

  /** Fills what the app left out, the way the network expects it now. */
  async prepareTransaction(input: unknown) {
    const tx = (input ?? {}) as Record<string, unknown>;
    const from = this.account(tx.from ?? undefined);
    if (tx.chainId !== undefined && Number(quantity(tx.chainId, "chainId")) !== this.chainId)
      throw new ProviderRpcError(ERROR_CODES.invalidParams, "Transaction is for another network. Switch networks first.");
    if (tx.to !== undefined && tx.to !== null && !isAddress(tx.to)) throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid to");
    const data = tx.data ?? tx.input;
    if (data !== undefined && !isHexData(data)) throw new ProviderRpcError(ERROR_CODES.invalidParams, "Invalid data");
    const urls = this.network.rpcUrls, call = <T>(method: string, params: unknown[]) => rpcCall<T>(urls, method, params, this.fetcher);
    const value = quantity(tx.value, "value") ?? 0n;
    const base = { from, ...(tx.to ? { to: tx.to } : {}), value: toQuantity(value), ...(data ? { data } : {}) };
    const [nonce, gas, block] = await Promise.all([
      tx.nonce !== undefined ? Promise.resolve(Number(quantity(tx.nonce, "nonce"))) : call<string>("eth_getTransactionCount", [from, "pending"]).then(Number),
      tx.gas !== undefined ? Promise.resolve(quantity(tx.gas, "gas")!) : call<string>("eth_estimateGas", [base]).then(estimate => BigInt(estimate) * 12n / 10n),
      call<{ baseFeePerGas?: string } | null>("eth_getBlockByNumber", ["latest", false]),
    ]);
    const common = { chainId: this.chainId, nonce, gas, value, ...(tx.to ? { to: tx.to as `0x${string}` } : {}), ...(data ? { data: data as `0x${string}` } : {}) };
    const legacyPrice = quantity(tx.gasPrice, "gasPrice");
    if (block?.baseFeePerGas && legacyPrice === undefined) {
      const priority = quantity(tx.maxPriorityFeePerGas, "maxPriorityFeePerGas") ?? await call<string>("eth_maxPriorityFeePerGas", []).then(BigInt).catch(() => 1_000_000n);
      const maxFee = quantity(tx.maxFeePerGas, "maxFeePerGas") ?? BigInt(block.baseFeePerGas) * 2n + priority;
      return { ...common, type: "eip1559" as const, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority > maxFee ? maxFee : priority };
    }
    return { ...common, type: "legacy" as const, gasPrice: legacyPrice ?? BigInt(await call<string>("eth_gasPrice", [])) };
  }

  private async signTransaction(input: unknown) {
    const transaction = await this.prepareTransaction(input);
    return this.ask<`0x${string}`>("evm.signTransaction", { address: this.account(), transaction });
  }

  private async sendTransaction(input: unknown) {
    const signed = await this.signTransaction(input);
    return rpcCall<string>(this.network.rpcUrls, "eth_sendRawTransaction", [signed], this.fetcher);
  }
}

/** EIP-6963: lets apps and libraries (wagmi, RainbowKit, Web3Modal…) find the wallet without window.ethereum. */
export const PROVIDER_INFO = { uuid: "", name: "MAXXING Wallet", icon: WALLET_ICON, rdns: "ad.maxxing.wallet" };
export function announceProvider(provider: MaxxingEthereumProvider, target: Pick<Window, "dispatchEvent" | "addEventListener"> = window) {
  const info = Object.freeze({ ...PROVIDER_INFO, uuid: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}` });
  const announce = () => target.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  announce();
  target.addEventListener("eip6963:requestProvider", announce);
  return info;
}
