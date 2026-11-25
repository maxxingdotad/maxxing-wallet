/**
 * The Data API's live stream: one shared connection per client, token subscriptions counted, reconnects by itself (1 s, 2 s …
 * up to 30 s) and subscribes again. Each token's listeners get `price` messages as its numbers move and `trades` when it has
 * new trades (read the list with data.trades).
 */
export type LivePrice = {
  id: string; priceUsd: string | null; change24hPct: string | null; marketCapUsd: string | null;
  volume24hUsd: string | null; liquidityUsd: string | null; asOf: string;
};
export type StreamHandlers = {
  onPrice?: (price: LivePrice) => void;
  /** New trades for this token: read them with data.trades(id). */
  onTrades?: (id: string) => void;
  /** "live" while connected, "offline" while reconnecting. */
  onStatus?: (status: "live" | "offline") => void;
};
type Socket = { readyState: number; send(data: string): void; close(): void; onopen: ((e: unknown) => void) | null; onclose: ((e: unknown) => void) | null; onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: unknown) => void) | null };
export type SocketFactory = (url: string) => Socket;
export const STREAM_MAX_TOKENS = 50;

export function createStream(url: string, open: SocketFactory, timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout }) {
  const listeners = new Set<{ ids: Set<string>; handlers: StreamHandlers }>();
  let socket: Socket | null = null, retry = 0, timer: ReturnType<typeof setTimeout> | undefined, live = false;

  const wanted = () => { const all = new Set<string>(); for (const l of listeners) for (const id of l.ids) all.add(id); return [...all].slice(0, STREAM_MAX_TOKENS); };
  const status = (next: boolean) => {
    if (live === next) return;
    live = next;
    for (const l of listeners) l.handlers.onStatus?.(next ? "live" : "offline");
  };
  const subscribe = () => {
    const ids = wanted();
    if (socket?.readyState === 1 && ids.length) socket.send(JSON.stringify({ op: "subscribe", tokens: ids }));
  };
  function connect() {
    if (socket || !listeners.size) return;
    let opened: Socket;
    try { opened = open(url); } catch { schedule(); return; }
    socket = opened;
    opened.onopen = () => { retry = 0; status(true); subscribe(); };
    opened.onmessage = event => {
      let message: { type?: string; id?: string } & Record<string, unknown>;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if ((message.type !== "price" && message.type !== "trades") || typeof message.id !== "string") return;
      for (const l of listeners) {
        if (!l.ids.has(message.id)) continue;
        try {
          if (message.type === "price") l.handlers.onPrice?.(message as unknown as LivePrice);
          else l.handlers.onTrades?.(message.id);
        } catch { /* a listener's error is its own */ }
      }
    };
    opened.onclose = () => { if (socket === opened) { socket = null; status(false); schedule(); } };
    opened.onerror = () => { /* onclose follows */ };
  }
  function schedule() {
    if (timer || !listeners.size) return;
    const wait = Math.min(30_000, 1000 * 2 ** retry++);
    timer = timers.set(() => { timer = undefined; connect(); }, wait);
  }

  return {
    /** Follows these tokens until the returned function is called. */
    subscribe(ids: string[], handlers: StreamHandlers) {
      const entry = { ids: new Set(ids), handlers };
      listeners.add(entry);
      if (socket) subscribe(); else connect();
      if (live) handlers.onStatus?.("live");
      return () => {
        if (!listeners.delete(entry)) return;
        const still = new Set(wanted());
        const gone = ids.filter(id => !still.has(id));
        if (gone.length && socket?.readyState === 1) socket.send(JSON.stringify({ op: "unsubscribe", tokens: gone }));
        if (!listeners.size) {
          if (timer) { timers.clear(timer); timer = undefined; }
          const closing = socket; socket = null; live = false;
          try { closing?.close(); } catch { /* already closed */ }
        }
      };
    },
    get live() { return live; },
  };
}
