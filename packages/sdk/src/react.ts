/**
 * React for the MAXXING wallet and Data API: one provider at the root, hooks below it.
 *
 *   <MaxxingProvider appId="app_…" appearance={{ theme: "light", accent: "#7C3AED" }}>
 *     <App />
 *   </MaxxingProvider>
 *
 *   const { ready, connected, user, signIn, disconnect } = useMaxxing();
 *   const { data: token } = useToken("eip155:8453:0x…");
 *   const { prices } = usePrices(ids);            // refreshes every 15 s
 *   <ConnectButton signIn showBalance />
 *
 *   const { signMessage } = useSignMessage();
 *   const { sendTransaction, data: hash } = useSendTransaction();
 *   const { data: receipt } = useTransactionReceipt(hash);
 *   const { data: balance } = useBalance();             // native coin; { token: "0x…" } for an ERC-20
 *
 * Safe with server rendering: the wallet starts in the browser only, and `ready` turns true once it has.
 */
import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createMaxxingWallet, type MaxxingWallet, type MaxxingWalletOptions } from "./index";
import { createMaxxingData, type LivePrice, type MaxxingData, type Price, type TokenDetail, type TokenRef, type Trade } from "./data";
import type { ConnectButton as ConnectButtonHandle, ConnectButtonOptions } from "./widget";
import { mountTradeWidget, type TradeWidget as TradeWidgetHandle, type TradeWidgetOptions } from "./trade-widget";
import type { MaxxingUser, WalletConnection } from "./protocol";
import type { EvmNetwork } from "./ethereum";
import * as actions from "./actions";
import type { Balance, Receipt, TransactionRequest } from "./actions";

type Context = { wallet: MaxxingWallet | null; data: MaxxingData; version: number; bump: () => void };
const MaxxingContext = createContext<Context | null>(null);

export type MaxxingProviderProps = MaxxingWalletOptions & {
  children?: ReactNode;
  /** The Data API's address. Leave out for https://api.maxxing.ad. */
  apiUrl?: string;
};

export function MaxxingProvider({ children, apiUrl, ...options }: MaxxingProviderProps) {
  const [wallet, setWallet] = useState<MaxxingWallet | null>(null);
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion(v => v + 1), []);
  // The wallet is made once per app id; options are read at that time.
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const made = createMaxxingWallet({ ...latest.current, apiUrl });
    setWallet(made);
    const stop = made.onChange(bump);
    made.ethereum.on("chainChanged", bump);
    return () => { stop(); made.ethereum.removeListener("chainChanged", bump); made.destroy(); setWallet(null); };
  }, [options.appId, options.walletUrl, apiUrl, bump]);
  const data = useMemo(() => createMaxxingData({ appId: options.appId, baseUrl: apiUrl }), [options.appId, apiUrl]);
  const value = useMemo(() => ({ wallet, data, version, bump }), [wallet, data, version, bump]);
  return createElement(MaxxingContext.Provider, { value }, children);
}

function useContextOrThrow() {
  const context = useContext(MaxxingContext);
  if (!context) throw new Error("MAXXING_PROVIDER_MISSING: wrap your app in <MaxxingProvider appId=\"…\">.");
  return context;
}

export type UseMaxxing = {
  /** True once the wallet has started in the browser. */
  ready: boolean;
  connected: boolean;
  connection: WalletConnection | null;
  /** Who signed in, after signIn() (id, wallet, verified social accounts). */
  user: MaxxingUser | null;
  /** For your server: check it with verifyIdentityToken from "@maxxing/wallet-sdk/server". */
  identityToken: string | null;
  connect(): Promise<WalletConnection>;
  signIn(): Promise<{ connection: WalletConnection; user: MaxxingUser | null; identityToken: string | null }>;
  disconnect(): void;
  /** The EVM network the wallet is on, and the ones your app offers. */
  chainId: number | null;
  network: EvmNetwork | null;
  networks: readonly EvmNetwork[];
  switchChain(chainId: number): Promise<void>;
  wallet: MaxxingWallet | null;
};

/** The wallet's state and actions. Re-renders when the connection or the signed-in user changes. */
export function useMaxxing(): UseMaxxing {
  const { wallet, bump } = useContextOrThrow();
  const need = () => { if (!wallet) throw new Error("MAXXING_WALLET_NOT_READY"); return wallet; };
  return {
    ready: wallet !== null,
    connected: Boolean(wallet?.connection),
    connection: wallet?.connection ?? null,
    user: wallet?.user ?? null,
    identityToken: wallet?.identityToken ?? null,
    connect: () => need().connect(),
    signIn: async () => { const result = await need().signIn(); bump(); return result; },
    disconnect: () => { wallet?.disconnect(); bump(); },
    chainId: wallet?.ethereum.network.chainId ?? null,
    network: wallet?.ethereum.network ?? null,
    networks: wallet?.ethereum.availableNetworks ?? [],
    switchChain: async chainId => { await actions.switchChain(need(), chainId); bump(); },
    wallet,
  };
}

/** The typed Data API client, set up with your app id. */
export function useMaxxingData(): MaxxingData {
  return useContextOrThrow().data;
}

export type Query<T> = { data: T | undefined; error: unknown; loading: boolean; refresh: () => void };

/** Runs `load` when `key` changes (and every `intervalMs` if given), keeping the last answer while the next one loads. */
export function useMaxxingQuery<T>(key: string | null, load: (data: MaxxingData) => Promise<T>, intervalMs?: number): Query<T> {
  const { data: client } = useContextOrThrow();
  return useQueryCore(key === null ? null : key, () => load(client), intervalMs, 5000);
}

/** The query engine: polling waits while the tab is hidden and catches up when it is shown again. */
function useQueryCore<T>(key: string | null, load: () => Promise<T>, intervalMs: number | undefined, minInterval: number): Query<T> {
  const [state, setState] = useState<{ key: string | null; data: T | undefined; error: unknown; loading: boolean }>({ key, data: undefined, error: undefined, loading: key !== null });
  const [tick, setTick] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    if (key === null) { setState({ key, data: undefined, error: undefined, loading: false }); return; }
    if (tick > 0 && typeof document !== "undefined" && document.visibilityState === "hidden") {
      const wake = () => { if (document.visibilityState === "visible") setTick(t => t + 1); };
      document.addEventListener("visibilitychange", wake);
      return () => document.removeEventListener("visibilitychange", wake);
    }
    let live = true;
    setState(s => ({ key, data: s.key === key ? s.data : undefined, error: undefined, loading: true }));
    loader.current().then(
      data => { if (live) setState({ key, data, error: undefined, loading: false }); },
      error => { if (live) setState(s => ({ key, data: s.key === key ? s.data : undefined, error, loading: false })); },
    );
    const timer = intervalMs ? setTimeout(() => setTick(t => t + 1), Math.max(minInterval, intervalMs)) : undefined;
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [key, tick, intervalMs, minInterval]);
  return { data: state.key === key ? state.data : undefined, error: state.error, loading: state.loading, refresh: () => setTick(t => t + 1) };
}

const refKey = (ref: TokenRef) => typeof ref === "string" ? ref : `${ref.chainId}:${ref.address}`;

/** One token's details and market numbers, MAXXING or outside. Pass null to wait. */
export function useToken(ref: TokenRef | null, options: { refreshMs?: number } = {}): Query<TokenDetail> {
  return useMaxxingQuery(ref ? `token:${refKey(ref)}` : null, data => data.token(ref!), options.refreshMs);
}

/** Live prices for a list of tokens (default every 15 s). `prices` is keyed by token id. */
export function usePrices(refs: TokenRef[], options: { refreshMs?: number } = {}): Query<Price[]> & { prices: Record<string, Price> } {
  const { data: client } = useContextOrThrow();
  const ids = refs.map(refKey);
  const key = ids.join(",");
  // Live over the stream as prices move; a slower check (every minute by default) fills in anything it missed.
  const query = useMaxxingQuery(ids.length ? `prices:${key}` : null, data => data.prices(ids), options.refreshMs ?? 60_000);
  const [live, setLive] = useState<Record<string, LivePrice>>({});
  useEffect(() => {
    setLive({});
    if (!key) return;
    return client.subscribe(key.split(","), { onPrice: price => setLive(prev => ({ ...prev, [price.id]: price })) });
  }, [client, key]);
  const prices = useMemo(() => Object.fromEntries((query.data ?? []).map(p => {
    const fresh = live[p.id];
    return [p.id, fresh && (!p.asOf || fresh.asOf >= p.asOf) ? { ...p, priceUsd: fresh.priceUsd, change24hPct: fresh.change24hPct, marketCapUsd: fresh.marketCapUsd, liquidityUsd: fresh.liquidityUsd, asOf: fresh.asOf } : p];
  })), [query.data, live]);
  return { ...query, prices };
}

/** A token's latest trades (outside tokens: MAXXING users' trades), reloaded as soon as the stream says new ones landed. */
export function useTrades(ref: TokenRef | null, options: { limit?: number } = {}): Query<Trade[]> {
  const { data: client } = useContextOrThrow();
  const id = ref ? refKey(ref) : null;
  const query = useMaxxingQuery(id ? `trades:${id}:${options.limit ?? 20}` : null, data => data.trades(id!, { limit: options.limit ?? 20 }).then(page => page.items), 60_000);
  const refresh = query.refresh;
  useEffect(() => {
    if (!id) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A burst of trades reloads once.
    const stop = client.subscribe([id], { onTrades: () => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, 400); } });
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [client, id]);
  return query;
}

export type Action<T> = {
  /** The last result, the last error, and whether a call is running. */
  data: T | undefined; error: unknown; pending: boolean; reset(): void;
};

/** Runs a wallet action (from a click) and tracks its state; the returned promise also resolves or rejects. */
function useAction<A extends unknown[], T>(run: (wallet: MaxxingWallet, ...args: A) => Promise<T>): Action<T> & { run: (...args: A) => Promise<T> } {
  const { wallet, bump } = useContextOrThrow();
  const [state, setState] = useState<{ data: T | undefined; error: unknown; pending: boolean }>({ data: undefined, error: undefined, pending: false });
  const latest = useRef(run);
  latest.current = run;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const call = useCallback(async (...args: A) => {
    if (!wallet) throw new Error("MAXXING_WALLET_NOT_READY");
    setState({ data: undefined, error: undefined, pending: true });
    try {
      const data = await latest.current(wallet, ...args);
      if (mounted.current) setState({ data, error: undefined, pending: false });
      return data;
    } catch (error) {
      if (mounted.current) setState({ data: undefined, error, pending: false });
      throw error;
    } finally { bump(); }
  }, [wallet, bump]);
  const reset = useCallback(() => setState({ data: undefined, error: undefined, pending: false }), []);
  return { ...state, run: call, reset };
}

/** Signs a message with the user's wallet (connects first if needed). `data` is the signature. */
export function useSignMessage(): Action<`0x${string}`> & { signMessage: (message: string | Uint8Array) => Promise<`0x${string}`> } {
  const { run, ...state } = useAction((wallet, message: string | Uint8Array) => actions.signMessage(wallet, message));
  return { ...state, signMessage: run };
}

/** Signs EIP-712 typed data (bigint values are fine). `data` is the signature. */
export function useSignTypedData(): Action<`0x${string}`> & { signTypedData: (typedData: Parameters<typeof actions.signTypedData>[1]) => Promise<`0x${string}`> } {
  const { run, ...state } = useAction((wallet, typedData: Parameters<typeof actions.signTypedData>[1]) => actions.signTypedData(wallet, typedData));
  return { ...state, signTypedData: run };
}

/** Sends a transaction; the wallet shows it before the user approves. `data` is the transaction hash. */
export function useSendTransaction(): Action<`0x${string}`> & { sendTransaction: (tx: TransactionRequest) => Promise<`0x${string}`> } {
  const { run, ...state } = useAction((wallet, tx: TransactionRequest) => actions.sendTransaction(wallet, tx));
  return { ...state, sendTransaction: run };
}

/** Waits for a transaction to land: checks every 2 s and stops once it is in a block. Pass null until you have a hash. */
export function useTransactionReceipt(hash: string | null | undefined, options: { chainId?: number } = {}): Query<Receipt | null> {
  const { wallet } = useContextOrThrow();
  const chainId = options.chainId ?? wallet?.ethereum.network.chainId;
  const key = wallet && hash && chainId ? `receipt:${chainId}:${hash}` : null;
  const [landed, setLanded] = useState<string | null>(null);
  const query = useQueryCore(key, () => actions.readReceipt(actions.networkFor(wallet!, chainId), hash!), key && landed !== key ? 2000 : undefined, 2000);
  useEffect(() => { if (key && query.data) setLanded(key); }, [key, query.data]);
  return query;
}

/**
 * A balance on one network: the native coin, or an ERC-20 with `token`. Defaults to the connected address on the
 * wallet's current network, and refreshes every 15 s while the page is visible.
 */
export function useBalance(options: { address?: string; chainId?: number; token?: string; refreshMs?: number } = {}): Query<Balance> {
  const { wallet } = useContextOrThrow();
  const address = options.address ?? wallet?.connection?.evm;
  const chainId = options.chainId ?? wallet?.ethereum.network.chainId;
  const key = wallet && address && chainId ? `balance:${chainId}:${address.toLowerCase()}:${options.token?.toLowerCase() ?? "native"}` : null;
  return useQueryCore(key, () => actions.readBalance(actions.networkFor(wallet!, chainId), address!, options.token), options.refreshMs ?? 15_000, 5000);
}

/** The connect button and account menu, styled with your theme. Props are the same as mountConnectButton's options. */
export function ConnectButton(props: ConnectButtonOptions & { className?: string }) {
  const { wallet, bump } = useContextOrThrow();
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<ConnectButtonHandle | null>(null);
  const { className, ...options } = props;
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!wallet || !host.current) return;
    const user = latest.current;
    handle.current = wallet.mountConnectButton(host.current, {
      ...user,
      onConnect: connection => { bump(); user.onConnect?.(connection); },
      onDisconnect: () => { bump(); user.onDisconnect?.(); },
    });
    return () => { handle.current?.destroy(); handle.current = null; };
  }, [wallet, bump]);
  // Later prop changes restyle the mounted button.
  const signature = JSON.stringify(options, (_key, value) => typeof value === "function" ? undefined : value);
  useEffect(() => { handle.current?.update(latest.current); }, [signature]);
  return createElement("div", { ref: host, className });
}

/** A trade card for one token (price, chart, buy and sell), styled with your theme. Props are mountTradeWidget's options. */
export function TradeWidget(props: TradeWidgetOptions & { className?: string }) {
  const { wallet, data } = useContextOrThrow();
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<TradeWidgetHandle | null>(null);
  const { className, ...options } = props;
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    if (!wallet || !host.current) return;
    // The provider's data client: one live connection for the whole app.
    handle.current = mountTradeWidget(wallet, data, host.current, latest.current);
    return () => { handle.current?.destroy(); handle.current = null; };
  }, [wallet, data]);
  const signature = JSON.stringify(options, (_key, value) => typeof value === "function" ? undefined : value);
  useEffect(() => { handle.current?.update(latest.current); }, [signature]);
  return createElement("div", { ref: host, className });
}

export { createMaxxingData, formatUsd } from "./data";
export type { TradeWidgetOptions } from "./trade-widget";
export type { LivePrice, Price, TokenDetail, TokenRef, Trade } from "./data";
export { formatUnits, parseUnits } from "./actions";
export type { Balance, Receipt, TransactionRequest } from "./actions";
