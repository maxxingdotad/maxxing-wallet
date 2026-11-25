import { createStream, type SocketFactory, type StreamHandlers } from "./stream";
/**
 * The MAXXING Data API, typed. MAXXING tokens and outside tokens come back in one shape (`origin` says which), and every
 * token has an `id` (`<chainId>:<address>`) you can pass back anywhere a token is asked for.
 *
 *   const data = createMaxxingData({ appId: "app_…" });           // web page (only on your app's websites)
 *   const data = createMaxxingData({ secret: process.env.MAXXING_SECRET }); // server
 *   const { items } = await data.tokens({ sort: "trending" });
 *   const prices = await data.prices(items.map(t => t.id));
 *   const stop = data.watchPrices(ids, prices => render(prices));
 *
 * No dependencies; works in browsers, Node 18+, Bun, Deno and edge runtimes.
 */
export type Origin = "maxxing" | "external";
export type TokenType = "standard" | "split" | "dividend" | "social" | "basket" | "pve";
/** A decimal number as a string (exact), or null when unknown. */
export type Decimal = string | null;

export type Chain = { id: string; key: string | null; name: string | null; family: "EVM" | "SOLANA" | string | null; nativeSymbol: string | null };
export type TokenSummary = {
  id: string; chainId: string; address: string; name: string; symbol: string; origin: Origin; type: TokenType | null; imageUrl: string | null;
  priceUsd: Decimal; marketCapUsd: Decimal; liquidityUsd: Decimal; volume24hUsd: Decimal; change24hPct: Decimal; holders: number | null;
};
type Windowed = { "5m": Decimal; "1h": Decimal; "6h": Decimal; "24h": Decimal };
export type TokenDetail = TokenSummary & {
  decimals: number | null; totalSupplyRaw: Decimal; description: string | null;
  links: { website: string | null; x: string | null; telegram: string | null; discord: string | null };
  creator: string | null; createdAt: string | null; fdvUsd: Decimal; volumeUsd: Windowed; changePct: Windowed;
  buys24h: number | null; sells24h: number | null; bondingProgressPct: Decimal; verified: boolean; asOf: string | null;
};
export type Price = { id: string; priceUsd: Decimal; change24hPct: Decimal; marketCapUsd: Decimal; liquidityUsd: Decimal; asOf: string | null; error: null | "NOT_FOUND" | "INVALID_TOKEN_ID" };
export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type Candle = { time: number; open: Decimal; high: Decimal; low: Decimal; close: Decimal; volumeUsd: Decimal };
export type Trade = { txHash: string | null; time: string | null; side: "buy" | "sell"; trader: string | null; amountUsd: Decimal; priceUsd: Decimal };
export type Holder = { wallet: string | null; balanceRaw: Decimal; valueUsd: Decimal };
export type Position = {
  token: { id: string; chainId: string | null; address: string | null; name: string; symbol: string; origin: Origin; imageUrl: string | null; decimals: number | null };
  state: "open" | "closed"; balanceRaw: Decimal; priceUsd: Decimal; valueUsd: Decimal; costBasisUsd: Decimal; averageEntryUsd: Decimal;
  realizedPnlUsd: Decimal; unrealizedPnlUsd: Decimal; boughtUsd: Decimal; soldUsd: Decimal; trades: number | null;
  firstTradeAt: string | null; lastTradeAt: string | null; closedAt: string | null;
};
export type WalletStats = {
  wallet: string; window: "1d" | "1w" | "30d"; firstTradeAt: string | null; lastTradeAt: string | null;
  volumeUsd: Decimal; boughtUsd: Decimal; soldUsd: Decimal; realizedPnlUsd: Decimal; realizedPnlPct: number | null;
  trades: number | null; buys: number | null; sells: number | null; tokens: number | null; winRate: number | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type { LivePrice, StreamHandlers } from "./stream";
export type WalletBalance = {
  id: string; chainId: string; address: string; native: boolean; symbol: string; name: string; imageUrl: string | null;
  balanceRaw: string; decimals: number | null; valueUsd: Decimal;
};
export type WalletBalances = Page<WalletBalance> & { wallet: string; totalUsd: string; complete: boolean; source: "codex" | "maxxing" };
export type TradeQuoteInput = {
  token: TokenRef; side: "BUY" | "SELL"; wallet: string;
  /** Buy: USD to spend. Sell: USD worth to sell (or use sellAmountRaw). */
  amountUsd?: number;
  /** Sell: exact token amount in base units. */
  sellAmountRaw?: string;
  /** Default 300 (3%). */
  slippageBps?: number;
};
export type TradeQuote = {
  token: string; side: "BUY" | "SELL";
  /** "wallet": send `transactions` from the user's wallet. "page": open `tradeUrl` (tokens that trade through MAXXING Cash). */
  mode: "wallet" | "page";
  /** Why it can't trade now, e.g. INSUFFICIENT_QUOTE_BALANCE, SELL_AMOUNT_EXCEEDS_POSITION, TRADE_REFUSED:<reason>. */
  blockingReason: string | null;
  pay?: { asset: string | null; symbol: string | null; decimals: number; amountRaw: string };
  receive?: { symbol: string; decimals: number; expectedRaw: string; minimumRaw: string; expectedUsd: number | null } | null;
  transactions?: { chainId: number; to: string; data: string; value: string }[];
  /** Unix seconds after which the transactions are refused: ask again. */
  expiresAt?: number | null;
  /** "app": this buy links the user to your app as referrer. "existing": they already have one. */
  /** "pending": your app becomes the trader's inviter once this buy lands; "existing": they already have one. ("app" is the old name.) */
  referral?: "pending" | "app" | "existing" | null;
  tradeUrl: string;
};

/** A token by its id, or by chain and address. */
export type TokenRef = string | { chainId: string; address: string };

export type MaxxingDataOptions = {
  /** For web pages: your app id. Works only from the websites your app lists. */
  appId?: string;
  /** For servers: your app's secret (mxsk_…). Never put it in a web page. */
  secret?: string;
  /** Leave out for https://api.maxxing.ad. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Waits and tries once more when the rate limit answers 429 with a short retry-after. On by default. */
  retry?: boolean;
  /**
   * Opens the live stream's connection. Browsers use their own WebSocket. On a server pass one that sends your secret, e.g. with
   * the "ws" package: `url => new WebSocket(url, { headers: { authorization: `Bearer ${secret}` } })`. Without either, live
   * updates fall back to asking every 15 s.
   */
  socket?: SocketFactory;
};

/** An error from the Data API: `code` is stable (for example RATE_LIMITED, NOT_FOUND, MONTHLY_QUOTA_REACHED). */
export class MaxxingDataError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfter: number | null;
  /** With BELOW_MIN_BUY: the smallest buy allowed, in USD. */
  readonly minBuyUsd: number | null;
  constructor(code: string, status: number, retryAfter: number | null = null, minBuyUsd: number | null = null) {
    super(code);
    this.name = "MaxxingDataError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.minBuyUsd = typeof minBuyUsd === "number" ? minBuyUsd : null;
  }
}

/** `<chainId>:<address>` for a token. */
export const tokenId = (chainId: string, address: string) => `${chainId}:${address}`;
/** The chain and address in a token id, or null when it isn't one. */
export function parseTokenId(id: string): { chainId: string; address: string } | null {
  const match = /^(eip155:\d{1,12}|solana:[a-z]+):([A-Za-z0-9]{32,64}|0x[0-9a-fA-F]{40})$/.exec(id.trim());
  return match ? { chainId: match[1]!, address: match[2]! } : null;
}
const refPath = (ref: TokenRef) => {
  const parts = typeof ref === "string" ? parseTokenId(ref) : ref;
  if (!parts) throw new MaxxingDataError("INVALID_TOKEN_ID", 400);
  return `${encodeURIComponent(parts.chainId)}/${encodeURIComponent(parts.address)}`;
};

export const MAX_PRICE_IDS = 25;

export type MaxxingData = {
  chains(): Promise<{ items: Chain[] }>;
  /** Ranked lists: trending, new or by market cap; MAXXING tokens, outside tokens or both. */
  tokens(query?: { origin?: "all" | Origin; chain?: string; sort?: "trending" | "new" | "marketcap"; limit?: number; cursor?: string }): Promise<Page<TokenSummary>>;
  search(q: string, query?: { limit?: number }): Promise<{ items: TokenSummary[] }>;
  token(ref: TokenRef): Promise<TokenDetail>;
  /** Prices for any number of tokens (sent 25 at a time), in the order given. */
  prices(refs: TokenRef[]): Promise<Price[]>;
  candles(ref: TokenRef, query?: { interval?: Interval; from?: number | Date; to?: number | Date; limit?: number }): Promise<{ interval: Interval; items: Candle[] }>;
  /** For outside tokens, MAXXING users' trades only. */
  trades(ref: TokenRef, query?: { limit?: number; before?: string }): Promise<Page<Trade>>;
  /** For outside tokens, MAXXING users only. */
  holders(ref: TokenRef, query?: { limit?: number }): Promise<{ items: Holder[] }>;
  wallet(address: string): {
    positions(query?: { state?: "open" | "closed" | "all"; limit?: number; cursor?: string }): Promise<Page<Position>>;
    stats(query?: { window?: "1d" | "1w" | "30d" }): Promise<WalletStats>;
    /** Every token the wallet holds, largest value first. `complete: false` means only MAXXING tokens are listed for now. */
    balances(query?: { chain?: string; cursor?: string }): Promise<WalletBalances>;
  };
  /**
   * A trade for the user's own wallet: the transactions to send (an approval when needed, then the trade), or, for tokens that
   * trade through MAXXING Cash, `mode: "page"` and a link to the MAXXING token page. On a buy, a live app's earnings wallet becomes
   * the inviter of a trader who has none once that buy lands (`referral: "pending"`); an app in review never earns.
   */
  tradeQuote(input: TradeQuoteInput): Promise<TradeQuote>;
  /** Every page of a list, one after another. */
  all<T>(page: (cursor?: string) => Promise<Page<T>>, max?: number): AsyncGenerator<T>;
  /**
   * Live updates for up to 50 tokens over one shared connection: `onPrice` as each token's numbers move, `onTrades` when it has new
   * trades. Reconnects by itself. Returns a function that stops.
   */
  subscribe(refs: TokenRef[], handlers: StreamHandlers): () => void;
  /** Calls `listener` with fresh prices every `intervalMs` (default 15 s, at least 5 s) while the page is visible. Returns stop. */
  watchPrices(refs: TokenRef[], listener: (prices: Price[]) => void, options?: { intervalMs?: number; onError?: (error: unknown) => void; /** Ask on a timer only, even where the live stream works. */ polling?: boolean }): () => void;
};

const seconds = (value: number | Date | undefined) => value === undefined ? undefined : String(Math.floor(value instanceof Date ? value.getTime() / 1000 : value));

export function createMaxxingData(options: MaxxingDataOptions): MaxxingData {
  if (!options?.appId && !options?.secret) throw new Error("MAXXING_DATA_KEY_REQUIRED");
  const base = `${(options.baseUrl ?? "https://api.maxxing.ad").replace(/\/$/, "")}/v1/public`;
  const fetcher = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const headers: Record<string, string> = options.secret ? { authorization: `Bearer ${options.secret}` } : { "x-maxxing-app": options.appId! };

  async function get<T>(path: string, query: Record<string, string | number | undefined> = {}, retried = false, body?: unknown): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
    const url = `${base}${path}${params.size ? `?${params}` : ""}`;
    const response = await fetcher(url, body === undefined
      ? { headers, credentials: "omit" } as RequestInit
      : { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), credentials: "omit" } as RequestInit);
    if (response.ok) return response.json() as Promise<T>;
    const answer = await response.json().catch(() => ({})) as { error?: string; minBuyUsd?: number };
    const header = response.headers.get("retry-after"), retryAfter = header !== null && Number.isFinite(Number(header)) ? Number(header) : null;
    if (response.status === 429 && options.retry !== false && !retried && retryAfter !== null && retryAfter <= 5 && answer.error !== "MONTHLY_QUOTA_REACHED") {
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return get<T>(path, query, true, body);
    }
    throw new MaxxingDataError(answer.error ?? `HTTP_${response.status}`, response.status, retryAfter, answer.minBuyUsd);
  }

  const data: MaxxingData = {
    chains: () => get("/chains"),
    tokens: (query = {}) => get("/tokens", query),
    search: (q, query = {}) => get("/search", { q, ...query }),
    token: async ref => (await get<{ token: TokenDetail }>(`/tokens/${refPath(ref)}`)).token,
    async prices(refs) {
      const ids = refs.map(ref => typeof ref === "string" ? ref : tokenId(ref.chainId, ref.address));
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += MAX_PRICE_IDS) chunks.push(ids.slice(i, i + MAX_PRICE_IDS));
      const pages = await Promise.all(chunks.map(chunk => get<{ items: Price[] }>("/prices", { ids: chunk.join(",") })));
      return pages.flatMap(page => page.items);
    },
    candles: (ref, query = {}) => get(`/tokens/${refPath(ref)}/candles`, { interval: query.interval, limit: query.limit, from: seconds(query.from), to: seconds(query.to) }),
    trades: (ref, query = {}) => get(`/tokens/${refPath(ref)}/trades`, query),
    holders: (ref, query = {}) => get(`/tokens/${refPath(ref)}/holders`, query),
    wallet: address => ({
      positions: (query = {}) => get(`/wallets/${encodeURIComponent(address)}/positions`, query),
      stats: (query = {}) => get(`/wallets/${encodeURIComponent(address)}/stats`, query),
      balances: (query = {}) => get(`/wallets/${encodeURIComponent(address)}/balances`, query),
    }),
    tradeQuote: input => get("/trade/quote", {}, false, { ...input, token: typeof input.token === "string" ? input.token : tokenId(input.token.chainId, input.token.address) }),
    async *all<T>(page: (cursor?: string) => Promise<Page<T>>, max = 1000) {
      let cursor: string | undefined, sent = 0;
      do {
        const result = await page(cursor);
        for (const item of result.items) { if (sent++ >= max) return; yield item; }
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
    },
    subscribe(refs, handlers) {
      const ids = refs.map(ref => typeof ref === "string" ? ref : tokenId(ref.chainId, ref.address));
      const live = stream();
      if (live) return live.subscribe(ids, handlers);
      // No live connection here: the same callbacks, from asking every 15 s while the page is visible.
      return data.watchPrices(ids, prices => { for (const p of prices) if (!p.error) handlers.onPrice?.({ id: p.id, priceUsd: p.priceUsd, change24hPct: p.change24hPct, marketCapUsd: p.marketCapUsd, volume24hUsd: null, liquidityUsd: p.liquidityUsd, asOf: p.asOf ?? new Date().toISOString() }); }, { polling: true });
    },
    watchPrices(refs, listener, watch = {}) {
      const ids = refs.map(ref => typeof ref === "string" ? ref : tokenId(ref.chainId, ref.address));
      const live = watch.polling ? null : stream();
      // With the live stream, prices change as they move, and a slow check (every minute) catches anything it missed.
      const every = Math.max(5000, live ? Math.max(60_000, watch.intervalMs ?? 0) : watch.intervalMs ?? 15_000);
      let latest: Price[] = [];
      const stopLive = live?.subscribe(ids, { onPrice: price => {
        const at = latest.findIndex(p => p.id === price.id);
        if (at < 0) return;
        latest = latest.map((p, i) => i === at ? { ...p, priceUsd: price.priceUsd, change24hPct: price.change24hPct, marketCapUsd: price.marketCapUsd, liquidityUsd: price.liquidityUsd, asOf: price.asOf } : p);
        listener(latest);
      } });
      let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
      const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
      const tick = async () => {
        if (stopped) return;
        if (!hidden()) {
          try { latest = await data.prices(ids); listener(latest); } catch (error) { watch.onError?.(error); }
        }
        if (!stopped) timer = setTimeout(tick, every);
      };
      void tick();
      return () => { stopped = true; if (timer) clearTimeout(timer); stopLive?.(); };
    },
  };
  let shared: ReturnType<typeof createStream> | null | undefined;
  /** The shared live connection, or null where it can't open (no WebSocket, or a secret without a socket factory). */
  function stream() {
    if (shared !== undefined) return shared;
    const factory: SocketFactory | null = options.socket ?? (options.appId && typeof WebSocket !== "undefined" ? (url => new WebSocket(url) as never) : null);
    const url = `${base.replace(/^http/, "ws")}/stream${options.appId ? `?app=${encodeURIComponent(options.appId)}` : ""}`;
    return shared = factory ? createStream(url, factory) : null;
  }
  return data;
}

/** "$1.23K", "$0.00042" … for showing prices and amounts. */
export function formatUsd(value: Decimal | number, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (options.compact && Math.abs(n) >= 1000) return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n)}`;
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toPrecision(2).replace(/\.?0+(e|$)/, "$1")}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
