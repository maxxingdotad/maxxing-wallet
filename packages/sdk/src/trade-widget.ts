/**
 * A trade card for any token, for partner sites: price, a live sparkline, buy and sell. The user trades from their own MAXXING
 * wallet (an approval when needed, then the trade, both shown in the wallet first). A live app's earnings wallet becomes the
 * inviter of a trader who has none once their first buy through it lands (off chain), and then earns the inviter share of the
 * fee on their trades. Tokens that trade through MAXXING Cash open the MAXXING token page instead, with your app as the inviter.
 *
 *   wallet.mountTradeWidget("#trade", { token: "<chainId>:<address>" });
 *
 * Drawn in its own shadow root; style it with `theme` (the same theme as the connect button).
 */
import type { MaxxingWallet } from "./index";
import { MaxxingDataError, formatUsd, parseTokenId, tokenId, type MaxxingData, type Price, type TokenDetail, type TokenRef, type TradeQuote } from "./data";
import { networkFor, readBalance, sendTransaction, waitForReceipt } from "./actions";
import { applyTheme, onSystemThemeChange, resolveTheme, type WalletTheme } from "./theme";
import { WALLET_ICON } from "./dialog";

export type TradeWidgetOptions = {
  /** The token: its id (`<chainId>:<address>`, as the Data API gives it) or { chainId, address }. */
  token: TokenRef;
  theme?: WalletTheme;
  /** Buy amounts offered as chips, in USD. Default [10, 25, 50, 100]. */
  amounts?: number[];
  /** Which side opens first. Default "BUY". */
  side?: "BUY" | "SELL";
  /** Allowed price movement, in basis points. Default 300 (3%). */
  slippageBps?: number;
  /** Hide the price chart. */
  hideChart?: boolean;
  /** After a trade lands. */
  onTrade?: (trade: { side: "BUY" | "SELL"; hash: string; chainId: number; token: string }) => void;
  /** Errors other than the user cancelling. */
  onError?: (error: unknown) => void;
};
export type TradeWidget = { update(options: Partial<TradeWidgetOptions>): void; destroy(): void };

/** 1590774811277326759900173n, 18 → "1.59M"; small amounts keep a few significant digits. */
export function amountText(raw: string | bigint, decimals: number) {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  if (!Number.isFinite(value) || value === 0) return "0";
  if (value >= 1000) return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return value.toPrecision(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** An SVG path through the closing prices, scaled to the box (line and area). Null with fewer than two points. */
export function sparkline(values: number[], width: number, height: number) {
  const points = values.filter(Number.isFinite);
  if (points.length < 2) return null;
  const min = Math.min(...points), max = Math.max(...points), span = max - min || 1, pad = 2;
  const xy = points.map((v, i) => [i / (points.length - 1) * width, pad + (1 - (v - min) / span) * (height - pad * 2)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return { line, area: `${line} L${width} ${height} L0 ${height} Z`, up: points[points.length - 1]! >= points[0]! };
}

/** Plain words for why a trade can't go ahead. */
export function reasonText(code: string, context: { pay?: string | null; token?: string; chain?: string; minBuyUsd?: number | null; holdsNone?: boolean }) {
  if (code === "INSUFFICIENT_QUOTE_BALANCE") return `Not enough ${context.pay ?? "funds"} on ${context.chain ?? "this network"}.`;
  if (code === "SELL_AMOUNT_EXCEEDS_POSITION") return context.holdsNone ? `You don't hold any ${context.token ?? "of this token"} yet.` : `You don't hold that much ${context.token ?? ""}.`.replace(" .", ".");
  if (code === "BELOW_MIN_BUY") return context.minBuyUsd ? `The smallest buy is ${formatUsd(context.minBuyUsd)}.` : "That amount is too small.";
  if (code === "AMOUNT_TOO_SMALL") return "That amount is too small.";
  if (code === "TRADING_PAUSED") return "Trading on this network is paused for now.";
  if (code === "TRADING_MARKET_NOT_READY") return "This token can't be traded yet.";
  if (code.startsWith("TRADE_REFUSED")) return "The market refused this trade right now. Try a smaller amount.";
  if (code === "RECEIPT_TIMEOUT") return "Still waiting for the network. Check the explorer.";
  if (code === "RATE_LIMITED") return "Too many requests. Try again in a moment.";
  return "Something went wrong. Try again.";
}

const ARROW = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7M8 7h9v9"/></svg>';
const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const STYLE = `
:host { all: initial; display: block; }
* { box-sizing: border-box; }
.card { width: 100%; max-width: 380px; font-family: var(--mxw-font); color: var(--mxw-text); background: var(--mxw-bg); border: 1px solid var(--mxw-border); border-radius: calc(var(--mxw-radius) + 6px); padding: 16px; display: flex; flex-direction: column; gap: 14px; -webkit-font-smoothing: antialiased; box-shadow: var(--mxw-shadow); }
button, a, input { font: inherit; color: inherit; }
button { border: 0; background: none; cursor: pointer; margin: 0; }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--mxw-accent); outline-offset: 2px; }
.head { display: flex; align-items: center; gap: 12px; min-width: 0; }
.logo { width: 40px; height: 40px; border-radius: 50%; background: var(--mxw-surface); object-fit: cover; flex: none; }
.who { min-width: 0; flex: 1; }
.sym { font-weight: 700; font-size: 16px; letter-spacing: -.01em; }
.name { color: var(--mxw-muted); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.px { text-align: right; }
.price { font-weight: 700; font-size: 16px; font-variant-numeric: tabular-nums; }
.chg { font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.up { color: #22c55e; } .down { color: #f43f5e; }
.chart { height: 64px; margin: 0 -4px; }
.chart svg { width: 100%; height: 100%; display: block; overflow: visible; }
.chart .ln { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.tabs { display: grid; grid-template-columns: 1fr 1fr; background: var(--mxw-surface); border-radius: var(--mxw-radius); padding: 3px; position: relative; }
.tab { height: 34px; border-radius: calc(var(--mxw-radius) - 3px); font-weight: 600; font-size: 14px; color: var(--mxw-muted); transition: color .15s ease, background .15s ease; }
.tab.on { background: var(--mxw-bg); color: var(--mxw-text); box-shadow: 0 1px 3px rgba(0,0,0,.18); }
.field { display: flex; align-items: center; gap: 6px; background: var(--mxw-surface); border: 1px solid transparent; border-radius: var(--mxw-radius); padding: 10px 14px; transition: border-color .15s ease; }
.field:focus-within { border-color: var(--mxw-accent); }
.field .unit { color: var(--mxw-muted); font-size: 22px; font-weight: 600; }
.field input { flex: 1; min-width: 0; background: none; border: 0; outline: none; font-size: 26px; font-weight: 700; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.field .bal { color: var(--mxw-muted); font-size: 12px; white-space: nowrap; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { flex: 1; min-width: 56px; height: 32px; border-radius: calc(var(--mxw-radius) - 2px); border: 1px solid var(--mxw-border); font-size: 13px; font-weight: 600; transition: background .12s ease, border-color .12s ease; }
.chip:hover { background: var(--mxw-surface); }
.chip.on { border-color: var(--mxw-accent); }
.quote { display: flex; flex-direction: column; gap: 6px; font-size: 13px; min-height: 40px; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.row span:first-child { color: var(--mxw-muted); }
.row b { font-weight: 600; font-variant-numeric: tabular-nums; }
.go { height: 48px; border-radius: var(--mxw-radius); background: var(--mxw-accent); color: var(--mxw-accent-text); font-weight: 700; font-size: 15px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; transition: filter .12s ease, transform .12s ease, opacity .12s ease; text-decoration: none; }
.go:hover:not(:disabled) { filter: brightness(1.07); }
.go:active:not(:disabled) { transform: translateY(1px); }
.go:disabled { opacity: .55; cursor: default; }
.go.sell { background: #f43f5e; color: #fff; }
.note { font-size: 12.5px; color: var(--mxw-muted); text-align: center; line-height: 1.45; }
.note a { color: var(--mxw-text); text-decoration: underline; text-underline-offset: 2px; }
.err { color: #f43f5e; font-size: 13px; line-height: 1.4; }
.ok { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 600; color: #22c55e; }
.ok a { margin-left: auto; color: var(--mxw-text); font-weight: 500; display: inline-flex; gap: 4px; align-items: center; text-decoration: none; }
.spin { width: 15px; height: 15px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.foot { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 11.5px; color: var(--mxw-muted); }
.foot img { width: 14px; height: 14px; border-radius: 4px; }
.skel { background: linear-gradient(90deg, var(--mxw-surface), var(--mxw-border), var(--mxw-surface)); background-size: 200% 100%; animation: sh 1.2s linear infinite; border-radius: 6px; color: transparent !important; }
@keyframes sh { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | undefined> = {}, ...children: (Node | string | null | false)[]) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined) key === "text" ? (node.textContent = value) : node.setAttribute(key, value);
  node.append(...children.filter((c): c is Node | string => c !== null && c !== false));
  return node;
}
const html = (markup: string) => { const span = document.createElement("span"); span.innerHTML = markup; return span.firstElementChild!; };
const svgEl = (tag: string, attrs: Record<string, string>) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
const cancelled = (error: unknown) => (error as { code?: number })?.code === 4001 || /reject|cancel|denied|closed/i.test(String((error as Error)?.message ?? ""));

export function mountTradeWidget(wallet: MaxxingWallet, data: MaxxingData, target: Element | string, initial: TradeWidgetOptions, walletTheme?: WalletTheme): TradeWidget {
  if (typeof document === "undefined") throw new Error("MAXXING_WALLET_NO_DOCUMENT");
  const parent = typeof target === "string" ? document.querySelector(target) : target;
  if (!parent) throw new Error(`MAXXING_WALLET_TARGET_NOT_FOUND:${String(target)}`);
  let options: TradeWidgetOptions = { ...initial };
  const ref = () => { const id = typeof options.token === "string" ? options.token : tokenId(options.token.chainId, options.token.address); if (!parseTokenId(id)) throw new Error("MAXXING_TRADE_INVALID_TOKEN"); return id; };
  ref();

  const host = el("div", { "data-maxxing-trade": "" });
  const shadow = host.attachShadow({ mode: "open" });
  const card = el("div", { class: "card", part: "card" });
  shadow.append(el("style", { text: STYLE }), card);
  parent.append(host);

  type Step = { kind: "idle" } | { kind: "quoting" } | { kind: "sending"; label: string } | { kind: "done"; hash: string; chainId: number; side: "BUY" | "SELL" } | { kind: "error"; text: string };
  const state = {
    side: options.side ?? "BUY" as "BUY" | "SELL",
    usd: String(options.amounts?.[1] ?? 25),
    percent: 100,
    token: null as TokenDetail | null,
    price: null as Price | null,
    closes: [] as number[],
    holding: null as { raw: bigint; decimals: number } | null,
    quote: null as TradeQuote | null,
    step: { kind: "idle" } as Step,
    minBuyUsd: null as number | null,
  };
  let destroyed = false, quoteTimer: ReturnType<typeof setTimeout> | undefined, quoteSeq = 0;

  const chainIdNumber = () => Number(ref().split(":")[1]);
  const isEvm = () => ref().startsWith("eip155:");
  const network = () => { try { return networkFor(wallet, chainIdNumber()); } catch { return null; } };
  const amounts = () => (options.amounts?.length ? options.amounts : [10, 25, 50, 100]).filter(n => n > 0).slice(0, 5);

  async function loadToken() {
    const id = ref();
    try {
      const [token, prices, candles] = await Promise.all([
        data.token(id), data.prices([id]).catch(() => []),
        options.hideChart ? Promise.resolve({ items: [] }) : data.candles(id, { interval: "1h", limit: 48 }).catch(() => ({ items: [] })),
      ]);
      if (destroyed || id !== ref()) return;
      state.token = token; state.price = prices[0] ?? null;
      state.closes = candles.items.map(c => Number(c.close));
    } catch (error) { if (!destroyed) { state.step = { kind: "error", text: error instanceof MaxxingDataError && error.code === "NOT_FOUND" ? "Token not found." : reasonText(String((error as MaxxingDataError)?.code ?? ""), {}) }; options.onError?.(error); } }
    render();
  }

  async function loadHolding() {
    const connection = wallet.connection, net = network();
    if (!connection || !net || !isEvm()) { state.holding = null; return; }
    try {
      const balance = await readBalance(net, connection.evm, parseTokenId(ref())!.address);
      if (!destroyed) { state.holding = { raw: balance.value, decimals: balance.decimals }; render(); }
    } catch { /* keep the last value */ }
  }

  /** Asks for a fresh quote shortly after the amount stops changing (connected wallets only). */
  function requote(delay = 350) {
    if (quoteTimer) clearTimeout(quoteTimer);
    state.quote = null; state.minBuyUsd = null;
    if (state.step.kind === "error" || state.step.kind === "done") state.step = { kind: "idle" };
    const connection = wallet.connection;
    if (!connection) { render(); return; }
    const usd = Number(state.usd);
    if (state.side === "BUY" && !(usd > 0)) { render(); return; }
    state.step = { kind: "quoting" }; render();
    const seq = ++quoteSeq;
    quoteTimer = setTimeout(async () => {
      try {
        // Nothing held (or a token whose balance isn't read here): a nominal sell, so the answer says how this token trades.
        const held = state.side === "SELL" && state.holding ? state.holding.raw * BigInt(state.percent) / 100n : 0n;
        const quote = await data.tradeQuote({ token: ref(), side: state.side, wallet: connection.evm, amountUsd: state.side === "BUY" ? usd : held > 0n ? undefined : 1, sellAmountRaw: held > 0n ? held.toString() : undefined, slippageBps: options.slippageBps });
        if (seq !== quoteSeq || destroyed) return;
        state.quote = quote; state.step = { kind: "idle" };
      } catch (error) {
        if (seq !== quoteSeq || destroyed) return;
        const code = String((error as MaxxingDataError)?.code ?? "");
        state.minBuyUsd = (error as MaxxingDataError)?.minBuyUsd ?? null;
        state.step = { kind: "error", text: reasonText(code, { minBuyUsd: state.minBuyUsd }) };
      }
      render();
    }, delay);
  }

  async function trade() {
    const quote = state.quote;
    if (!quote) return;
    if (quote.mode === "page") { window.open(quote.tradeUrl, "_blank", "noopener"); return; }
    if (quote.blockingReason || !quote.transactions?.length) return;
    const net = network();
    if (!net) return;
    if (!wallet.ethereum.availableNetworks.some(n => n.chainId === net.chainId)) {
      state.step = { kind: "error", text: `${net.name} isn't one of this site's wallet networks.` }; render(); return;
    }
    if (quote.expiresAt && quote.expiresAt * 1000 < Date.now() + 20_000) { requote(0); return; }
    try {
      const total = quote.transactions.length;
      let hash = "";
      for (const [index, tx] of quote.transactions.entries()) {
        const last = index === total - 1;
        state.step = { kind: "sending", label: last ? `Confirm ${state.side === "BUY" ? "buy" : "sell"} in wallet${total > 1 ? ` (${index + 1}/${total})` : ""}` : `Approve ${quote.pay?.symbol ?? ""} in wallet (${index + 1}/${total})` }; render();
        hash = await sendTransaction(wallet, { to: tx.to, data: tx.data, value: BigInt(tx.value), chainId: tx.chainId });
        state.step = { kind: "sending", label: last ? "Confirming on chain…" : "Waiting for the approval…" }; render();
        const receipt = await waitForReceipt(net, hash);
        if (receipt.status !== "success") throw new Error("TRADE_REVERTED");
      }
      state.step = { kind: "done", hash, chainId: net.chainId, side: state.side };
      options.onTrade?.({ side: state.side, hash, chainId: net.chainId, token: ref() });
      void loadHolding();
    } catch (error) {
      if (cancelled(error)) state.step = { kind: "idle" };
      else { state.step = { kind: "error", text: (error as Error)?.message === "TRADE_REVERTED" ? "The trade didn't go through (price moved). Nothing was spent but gas." : reasonText(String((error as Error)?.message ?? ""), {}) }; options.onError?.(error); }
    }
    render();
  }

  function chart() {
    const shape = options.hideChart ? null : sparkline(state.closes, 340, 64);
    if (!shape) return null;
    const color = shape.up ? "#22c55e" : "#f43f5e";
    const svg = svgEl("svg", { viewBox: "0 0 340 64", preserveAspectRatio: "none", "aria-hidden": "true" });
    const gradient = svgEl("linearGradient", { id: "mxg", x1: "0", y1: "0", x2: "0", y2: "1" });
    gradient.append(svgEl("stop", { offset: "0", "stop-color": color, "stop-opacity": ".28" }), svgEl("stop", { offset: "1", "stop-color": color, "stop-opacity": "0" }));
    const defs = svgEl("defs", {}); defs.append(gradient);
    svg.append(defs, svgEl("path", { d: shape.area, fill: "url(#mxg)" }), svgEl("path", { d: shape.line, class: "ln", stroke: color }));
    return el("div", { class: "chart" }, svg);
  }

  function render() {
    if (destroyed) return;
    applyTheme(host, resolveTheme(options.theme ?? walletTheme));
    const token = state.token, price = state.price, net = network();
    const symbol = token?.symbol ?? "…";
    const change = Number(price?.change24hPct ?? token?.change24hPct ?? NaN);
    const head = el("div", { class: "head" },
      token?.imageUrl ? el("img", { class: "logo", src: token.imageUrl, alt: "" }) : el("span", { class: "logo" }),
      el("div", { class: "who" }, el("div", { class: `sym${token ? "" : " skel"}`, text: token ? symbol : "TOKEN" }), el("div", { class: "name", text: token ? `${token.name}${net ? ` · ${net.name}` : ""}` : "" })),
      el("div", { class: "px" },
        el("div", { class: `price${token ? "" : " skel"}`, text: formatUsd(price?.priceUsd ?? token?.priceUsd ?? null) }),
        Number.isFinite(change) ? el("div", { class: `chg ${change >= 0 ? "up" : "down"}`, text: `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` }) : null));

    const tabs = el("div", { class: "tabs", role: "tablist" });
    for (const side of ["BUY", "SELL"] as const) {
      const tab = el("button", { class: `tab${state.side === side ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(state.side === side), text: side === "BUY" ? "Buy" : "Sell" });
      tab.addEventListener("click", () => { if (state.side !== side) { state.side = side; requote(0); } });
      tabs.append(tab);
    }

    let field: HTMLElement, chips: HTMLElement;
    if (state.side === "BUY") {
      const input = el("input", { inputmode: "decimal", value: state.usd, "aria-label": "Amount in USD", autocomplete: "off", "data-k": "usd" }) as HTMLInputElement;
      input.addEventListener("input", () => { state.usd = input.value.replace(/[^\d.]/g, ""); if (input.value !== state.usd) input.value = state.usd; requote(); });
      field = el("label", { class: "field" }, el("span", { class: "unit", text: "$" }), input);
      chips = el("div", { class: "chips" });
      for (const usd of amounts()) {
        const chip = el("button", { class: `chip${Number(state.usd) === usd ? " on" : ""}`, type: "button", text: `$${usd}` });
        chip.addEventListener("click", () => { state.usd = String(usd); requote(0); });
        chips.append(chip);
      }
    } else {
      const holding = state.holding;
      const amount = holding ? holding.raw * BigInt(state.percent) / 100n : 0n;
      field = el("div", { class: "field" },
        el("input", { value: holding ? amountText(amount, holding.decimals) : "0", readonly: "", "aria-label": `Amount of ${symbol}` }),
        el("span", { class: "bal", text: wallet.connection ? `of ${holding ? amountText(holding.raw, holding.decimals) : "0"} ${symbol}` : symbol }));
      chips = el("div", { class: "chips" });
      for (const percent of [25, 50, 75, 100]) {
        const chip = el("button", { class: `chip${state.percent === percent ? " on" : ""}`, type: "button", text: percent === 100 ? "Max" : `${percent}%` });
        chip.addEventListener("click", () => { state.percent = percent; requote(0); });
        chips.append(chip);
      }
    }

    const quote = state.quote, rows = el("div", { class: "quote" });
    const priceUsd = Number(price?.priceUsd ?? token?.priceUsd ?? NaN);
    if (quote?.mode === "wallet" && quote.receive && !quote.blockingReason) {
      rows.append(
        el("div", { class: "row" }, el("span", { text: "You receive" }), el("b", { text: `≈ ${amountText(quote.receive.expectedRaw, quote.receive.decimals)} ${quote.receive.symbol}` })),
        el("div", { class: "row" }, el("span", { text: "At least" }), el("b", { text: `${amountText(quote.receive.minimumRaw, quote.receive.decimals)} ${quote.receive.symbol}` })),
      );
      if (quote.pay?.symbol) rows.append(el("div", { class: "row" }, el("span", { text: "You pay" }), el("b", { text: `${amountText(quote.pay.amountRaw, quote.pay.decimals)} ${quote.pay.symbol}` })));
    } else if (state.side === "BUY" && Number(state.usd) > 0 && priceUsd > 0) {
      rows.append(el("div", { class: "row" }, el("span", { text: "Estimated" }), el("b", { text: `≈ ${amountText(BigInt(Math.floor(Number(state.usd) / priceUsd * 1e6)), 6)} ${symbol}` })));
    }
    if (quote?.blockingReason) {
      rows.append(el("div", { class: "err", text: reasonText(quote.blockingReason, { pay: quote.pay?.symbol, token: symbol, chain: net?.name, holdsNone: !state.holding || state.holding.raw === 0n }) }));
      if (quote.blockingReason === "INSUFFICIENT_QUOTE_BALANCE") rows.append(el("div", { class: "note" }, "Or ", el("a", { href: quote.tradeUrl, target: "_blank", rel: "noopener", text: "pay with MAXXING Cash" }), "."));
    }
    if (state.step.kind === "error") rows.append(el("div", { class: "err", role: "alert", text: state.step.text }));
    if (state.step.kind === "done") {
      const explorer = net?.explorerUrl ? `${net.explorerUrl.replace(/\/$/, "")}/tx/${state.step.hash}` : null;
      rows.append(el("div", { class: "ok", role: "status" }, html(CHECK), el("span", { text: state.step.side === "BUY" ? `Bought ${symbol}` : `Sold ${symbol}` }), explorer ? el("a", { href: explorer, target: "_blank", rel: "noopener" }, "View", html(ARROW)) : null));
    }

    const go = el("button", { class: `go${state.side === "SELL" ? " sell" : ""}`, type: "button" });
    const busy = state.step.kind === "sending" || state.step.kind === "quoting";
    if (!wallet.connection) {
      go.textContent = "Connect wallet";
      go.addEventListener("click", async () => {
        try { await wallet.connect(); await loadHolding(); requote(0); }
        catch (error) { if (!cancelled(error)) { state.step = { kind: "error", text: reasonText("", {}) }; options.onError?.(error); render(); } }
      });
    } else if (quote?.mode === "page") {
      go.append(`Trade ${symbol} on MAXXING`, html(ARROW));
      go.addEventListener("click", () => window.open(quote.tradeUrl, "_blank", "noopener"));
    } else {
      if (busy) go.append(el("span", { class: "spin" }), state.step.kind === "sending" ? state.step.label : "Getting a price…");
      else go.textContent = `${state.side === "BUY" ? "Buy" : "Sell"} ${symbol}`;
      go.toggleAttribute("disabled", busy || !quote || Boolean(quote.blockingReason) || !quote.transactions?.length);
      go.addEventListener("click", () => void trade());
    }

    const foot = el("div", { class: "foot" }, el("img", { src: WALLET_ICON, alt: "" }), "Trades with MAXXING Wallet");
    const note = (quote?.referral === "pending" || quote?.referral === "app") && state.side === "BUY" && !quote.blockingReason ?el("div", { class: "note", text: "This site earns a share of MAXXING's trading fee on your trades." }) : null;
    // Redrawing replaces the amount field: keep the caret where the user is typing.
    const active = shadow.activeElement as HTMLInputElement | null;
    const typing = active?.getAttribute("data-k") ? { key: active.getAttribute("data-k"), at: active.selectionStart } : null;
    card.replaceChildren(head, chart() ?? "", tabs, field, chips, rows, go, ...(note ? [note] : []), foot);
    if (typing) {
      const again = card.querySelector<HTMLInputElement>(`[data-k="${typing.key}"]`);
      again?.focus();
      if (again && typing.at !== null) again.setSelectionRange(typing.at, typing.at);
    }
  }

  const stopTheme = onSystemThemeChange(() => render());
  const stopConnection = wallet.onChange(() => { void loadHolding().then(() => requote(0)); });
  render();
  void loadToken();
  void loadHolding().then(() => requote(0));
  // The price moves live over the Data API's stream (or every 15 s where the stream can't open).
  let stopPrice = () => {};
  const followPrice = () => {
    stopPrice();
    stopPrice = data.subscribe([ref()], { onPrice: live => {
      if (destroyed || live.id !== ref()) return;
      state.price = { ...(state.price ?? { id: live.id, error: null }), priceUsd: live.priceUsd, change24hPct: live.change24hPct, marketCapUsd: live.marketCapUsd, liquidityUsd: live.liquidityUsd, asOf: live.asOf } as Price;
      render();
    } });
  };
  followPrice();

  return {
    update(next) {
      const tokenChanged = next.token !== undefined && (typeof next.token === "string" ? next.token : tokenId(next.token.chainId, next.token.address)) !== ref();
      options = { ...options, ...next };
      if (tokenChanged) { state.token = null; state.price = null; state.closes = []; state.holding = null; followPrice(); void loadToken(); void loadHolding(); requote(0); }
      else render();
    },
    destroy() {
      destroyed = true;
      if (quoteTimer) clearTimeout(quoteTimer);
      stopPrice(); stopTheme(); stopConnection();
      host.remove();
    },
  };
}
