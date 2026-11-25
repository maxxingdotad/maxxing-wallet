import { WALLET_ICON } from "./dialog";
import type { EvmNetwork, MaxxingEthereumProvider } from "./ethereum";
import { ERROR_CODES, type MaxxingUser, type WalletConnection } from "./protocol";
import { applyTheme, avatarGradient, onSystemThemeChange, resolveTheme, shortAddress, type WalletTheme } from "./theme";

/** A link or action of your own in the account menu (Profile, Settings, Docs…). */
export type ConnectMenuItem = { label: string; href?: string; onClick?: () => void; newTab?: boolean };

export type ConnectButtonOptions = {
  /** Button text before connecting. Default "Connect wallet". */
  label?: string;
  /** Colours, radius and font. Defaults to the wallet's `theme`, then MAXXING's dark palette. */
  theme?: WalletTheme;
  size?: "sm" | "md" | "lg";
  /**
   * "full" (default): avatar, address, network and arrow. "compact": avatar and address. "icon": the avatar alone (and the
   * MAXXING mark before connecting), for tight headers and phones.
   */
  variant?: "full" | "compact" | "icon";
  /** Which edge the account menu lines up with. Default "end" (right). */
  align?: "start" | "end";
  /** Show the current network on the account button and let people switch in the menu. Default true. */
  showNetwork?: boolean;
  /** Show the balance of the network's coin on the account button and in the menu. Default false. */
  showBalance?: boolean;
  /** Show the Solana address in the menu. Default true. */
  showSolana?: boolean;
  /** Show the MAXXING mark on the connect button. Default true. */
  showMark?: boolean;
  /** A "View on explorer" link in the menu. Default true. */
  showExplorer?: boolean;
  /** Your own links in the menu, above Disconnect. */
  menuItems?: ConnectMenuItem[];
  /** Use wallet.signIn() instead of connect(), so your app gets the user and an identity token. Default false. */
  signIn?: boolean;
  onConnect?: (connection: WalletConnection) => void;
  onDisconnect?: () => void;
  onNetworkChange?: (network: { chainId: number; name: string }) => void;
  /** Errors other than the user cancelling. */
  onError?: (error: unknown) => void;
};
export type ConnectButton = {
  /** The shadow host the widget lives in. */
  readonly element: HTMLElement;
  /** Changes options in place, for live theming. */
  update(options: ConnectButtonOptions): void;
  /** Opens or closes the account menu (when connected). */
  setMenuOpen(open: boolean): void;
  destroy(): void;
};
/** What the widget needs from `createMaxxingWallet`'s result. */
export type WidgetWallet = {
  ethereum: MaxxingEthereumProvider;
  connect(): Promise<WalletConnection>;
  signIn?(): Promise<{ connection: WalletConnection }>;
  disconnect(): void;
  readonly connection: WalletConnection | null;
  /** The signed-in user, when the app has social sign-in. */
  readonly user?: MaxxingUser | null;
  onChange(listener: (connection: WalletConnection | null) => void): () => void;
};

const SIZES = { sm: { h: 32, fs: 13, px: 12 }, md: { h: 40, fs: 14, px: 16 }, lg: { h: 48, fs: 15.5, px: 20 } } as const;
const BALANCE_REFRESH_MS = 30_000;

const STYLE = `
:host { all: initial; display: inline-block; }
* { box-sizing: border-box; }
.root { position: relative; display: inline-block; font-family: var(--mxw-font); color: var(--mxw-text); -webkit-font-smoothing: antialiased; }
button, a { font: inherit; margin: 0; border: 0; cursor: pointer; color: inherit; background: none; text-decoration: none; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--mxw-accent); outline-offset: 2px; }
.connect { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: var(--h); padding: 0 var(--px); border-radius: var(--mxw-radius); background: var(--mxw-accent); color: var(--mxw-accent-text); font-size: var(--fs); font-weight: 600; letter-spacing: -.005em; white-space: nowrap; transition: filter .12s ease, transform .12s ease; }
.connect:hover:not(:disabled) { filter: brightness(1.07); }
.connect:active:not(:disabled) { transform: translateY(1px); }
.connect:disabled { cursor: progress; opacity: .8; }
.icon .connect { width: var(--h); padding: 0; }
.mark { width: calc(var(--h) * .5); height: calc(var(--h) * .5); border-radius: calc(var(--h) * .14); flex: none; }
.spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.account { display: inline-flex; align-items: center; gap: 8px; height: var(--h); padding: 0 10px 0 calc(var(--h) * .16); border-radius: var(--mxw-radius); background: var(--mxw-bg); border: 1px solid var(--mxw-border); font-size: var(--fs); font-weight: 600; white-space: nowrap; transition: border-color .12s ease; }
.account:hover { border-color: var(--mxw-accent); }
.icon .account { width: var(--h); padding: 0; justify-content: center; }
.avatar { width: calc(var(--h) * .64); height: calc(var(--h) * .64); border-radius: 50%; flex: none; object-fit: cover; }
.bal { color: var(--mxw-muted); font-weight: 550; font-variant-numeric: tabular-nums; }
.net { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 99px; background: var(--mxw-surface); color: var(--mxw-muted); font-size: .84em; font-weight: 550; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #3CB07A; flex: none; }
.chev { width: 14px; height: 14px; color: var(--mxw-muted); transition: transform .15s ease; }
.open .chev { transform: rotate(180deg); }
.menu { position: absolute; top: calc(100% + 8px); right: 0; z-index: 2147483000; width: 312px; max-width: calc(100vw - 24px); padding: 8px; border-radius: calc(var(--mxw-radius) + 6px); background: var(--mxw-bg); border: 1px solid var(--mxw-border); box-shadow: var(--mxw-shadow); overflow: hidden; }
.menu.enter { animation: pop .16s cubic-bezier(.2,.9,.3,1.2); }
.start .menu { left: 0; right: auto; }
@keyframes pop { from { opacity: 0; transform: translateY(-6px) scale(.97); } to { opacity: 1; transform: none; } }
@keyframes slide { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: none; } }
.view { display: flex; flex-direction: column; gap: 6px; }
.view.enter { animation: slide .16s ease-out; }
.card { position: relative; display: flex; flex-direction: column; gap: 12px; padding: 14px; border-radius: max(8px, calc(var(--mxw-radius) + 2px)); background: radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--mxw-accent) 22%, transparent), transparent 60%), var(--mxw-surface); border: 1px solid var(--mxw-border); overflow: hidden; }
.who { display: flex; align-items: center; gap: 11px; min-width: 0; }
.who .avatar { width: 44px; height: 44px; box-shadow: 0 0 0 3px var(--mxw-bg); }
.who-text { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.who-text b { font-size: 15px; font-weight: 650; letter-spacing: -.01em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.addr { display: inline-flex; align-items: center; gap: 6px; font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--mxw-muted); }
.icon-btn { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; color: var(--mxw-muted); transition: background .12s ease, color .12s ease; }
.icon-btn:hover { background: color-mix(in srgb, var(--mxw-text) 8%, transparent); color: var(--mxw-text); }
.icon-btn.done { color: #3CB07A; }
.icon-btn svg, .tile svg, .row svg { width: 15px; height: 15px; flex: none; }
.amount { display: flex; flex-direction: column; gap: 1px; font-variant-numeric: tabular-nums; }
.amount small { color: var(--mxw-muted); font-size: 11.5px; }
.amount b { font-size: 24px; font-weight: 650; letter-spacing: -.03em; line-height: 1.15; }
.amount b em { font-style: normal; font-size: 14px; font-weight: 600; color: var(--mxw-muted); margin-left: 4px; }
.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.tile { display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 10px 4px 9px; border-radius: max(6px, calc(var(--mxw-radius) * .8)); background: color-mix(in srgb, var(--mxw-bg) 55%, transparent); border: 1px solid var(--mxw-border); font-size: 11.5px; font-weight: 600; color: var(--mxw-text); transition: border-color .12s ease, transform .12s ease; }
.tile:hover { border-color: var(--mxw-accent); transform: translateY(-1px); }
.tile.done { color: #3CB07A; }
.rows { display: flex; flex-direction: column; }
.row { display: flex; width: 100%; align-items: center; gap: 10px; padding: 9px 10px; border-radius: max(4px, calc(var(--mxw-radius) * .7)); font-size: 13px; text-align: left; color: var(--mxw-text); }
.row:hover, .row:focus-visible { background: var(--mxw-surface); outline: none; }
.row .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.row small, .row .hint { color: var(--mxw-muted); font-size: 11.5px; }
.row code { font: 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
.row .lead { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; background: var(--mxw-surface); color: var(--mxw-muted); flex: none; }
.row .lead svg { width: 14px; height: 14px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 9px; border-radius: 99px; background: var(--mxw-surface); font-size: 12px; font-weight: 600; }
.tick { color: var(--mxw-accent); font-weight: 700; }
.label { padding: 8px 10px 2px; color: var(--mxw-muted); font-size: 10.5px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
.top { display: flex; align-items: center; gap: 6px; padding: 2px 2px 4px; }
.top b { font-size: 14px; }
.search { width: 100%; height: 36px; padding: 0 12px; border-radius: max(6px, calc(var(--mxw-radius) * .8)); border: 1px solid var(--mxw-border); background: var(--mxw-surface); color: var(--mxw-text); font: inherit; font-size: 13px; outline: none; }
.search:focus { border-color: var(--mxw-accent); }
.nets { max-height: 260px; overflow-y: auto; scrollbar-width: thin; display: flex; flex-direction: column; }
.nets .row[hidden] { display: none; }
.empty { padding: 14px; text-align: center; color: var(--mxw-muted); font-size: 12.5px; }
.sep { height: 1px; background: var(--mxw-border); margin: 4px 2px; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 2px 0; }
.foot .brand { display: inline-flex; align-items: center; gap: 6px; color: var(--mxw-muted); font-size: 11px; }
.foot .brand img { width: 14px; height: 14px; border-radius: 4px; }
.out { display: inline-flex; align-items: center; gap: 6px; padding: 7px 10px; border-radius: max(4px, calc(var(--mxw-radius) * .7)); color: #E15D55; font-size: 12.5px; font-weight: 600; }
.out:hover { background: color-mix(in srgb, #E15D55 12%, transparent); }
.out svg { width: 14px; height: 14px; }
@media (prefers-reduced-motion: reduce) { .menu, .spin, .view { animation: none !important; } .tile:hover { transform: none; } }
`;

const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const svg = (paths: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  check: svg('<path d="M5 12.5l4.2 4.2L19 7"/>'),
  explorer: svg('<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
  network: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5M12 3.5C9.6 6 8.5 8.8 8.5 12s1.1 6 3.5 8.5"/>'),
  next: svg('<path d="M9 6l6 6-6 6"/>'),
  back: svg('<path d="M15 6l-6 6 6 6"/>'),
  power: svg('<path d="M12 3.5v8"/><path d="M6.4 6.9a8 8 0 1 0 11.2 0"/>'),
  solana: svg('<path d="M6 7h13l-2 2.5H4zM6 16.5h13l-2-2.5H4zM4 11.75h13l2 2.5H6z" fill="currentColor" stroke="none" opacity=".85"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
};
const icon = (name: keyof typeof ICONS) => { const span = document.createElement("span"); span.innerHTML = ICONS[name]; return span.firstElementChild as SVGElement; };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, string>> = {}, ...children: (Node | string | null)[]) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) if (value !== undefined) key === "text" ? (el.textContent = value) : el.setAttribute(key, value);
  el.append(...children.filter((c): c is Node | string => c !== null));
  return el;
}

/** 1.234567 → "1.2346"; tiny amounts keep a few significant digits. */
export function balanceText(wei: bigint, decimals = 18) {
  const value = Number(wei) / 10 ** decimals;
  if (value === 0) return "0";
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return value.toPrecision(3).replace(/0+$/, "").replace(/\.$/, "");
}

const safeHref = (href: string) => /^(https?:\/\/|\/|#)/i.test(href) ? href : null;

/**
 * A connect button that becomes an account button once connected, with a menu for the balance, addresses, networks, your
 * own links and disconnecting. Drawn in its own shadow root, so your page's CSS can't break it; style it with `theme`.
 */
export function mountConnectButton(wallet: WidgetWallet, target: Element | string, initial: ConnectButtonOptions = {}, walletTheme?: WalletTheme): ConnectButton {
  if (typeof document === "undefined") throw new Error("MAXXING_WALLET_NO_DOCUMENT");
  const parent = typeof target === "string" ? document.querySelector(target) : target;
  if (!parent) throw new Error(`MAXXING_WALLET_TARGET_NOT_FOUND:${String(target)}`);
  const host = node("span", { "data-maxxing-connect": "" });
  const shadow = host.attachShadow({ mode: "open" });
  const style = node("style", { text: STYLE });
  const root = node("div", { class: "root" });
  shadow.append(style, root);
  parent.append(host);

  let options = initial;
  let busy = false;
  let open = false;
  let copied: string | null = null;
  let justOpened = false;
  /** The menu's screen: the account, or the network list. */
  let view: "main" | "networks" = "main";
  let viewChanged = false;
  let balance: { key: string; wei: bigint } | null = null;
  let balanceTimer: ReturnType<typeof setInterval> | null = null;

  const close = () => { if (open) { open = false; view = "main"; render(); } };
  const onOutside = (event: Event) => { if (open && !event.composedPath().includes(host)) close(); };
  const onKey = (event: KeyboardEvent) => { if (open && event.key === "Escape") { close(); (root.querySelector(".account") as HTMLElement | null)?.focus(); } };
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey);

  const connect = async () => {
    busy = true; render();
    try {
      const connection = options.signIn && wallet.signIn ? (await wallet.signIn()).connection : await wallet.connect();
      options.onConnect?.(connection);
    } catch (error) { if ((error as { code?: number })?.code !== ERROR_CODES.userRejected) options.onError?.(error); }
    finally { busy = false; render(); }
  };
  const copy = (value: string, id: string) => {
    void navigator.clipboard?.writeText(value).then(() => { copied = id; render(); setTimeout(() => { copied = null; render(); }, 1200); }).catch(() => {});
  };
  const switchTo = async (network: EvmNetwork) => {
    try { await wallet.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${network.chainId.toString(16)}` }] }); }
    catch (error) { options.onError?.(error); }
    render();
  };

  /** Reads the balance for the connected address on the current network, when asked for. */
  const loadBalance = async () => {
    const connection = wallet.connection;
    if (!options.showBalance || !connection) return;
    const key = `${connection.evm}:${wallet.ethereum.network.chainId}`;
    try {
      const hex = await wallet.ethereum.request({ method: "eth_getBalance", params: [connection.evm, "latest"] }) as string;
      if (wallet.connection?.evm === connection.evm) { balance = { key, wei: BigInt(hex) }; render(); }
    } catch { /* keep the last value */ }
  };
  const watchBalance = () => {
    if (balanceTimer) clearInterval(balanceTimer);
    balanceTimer = null;
    if (!options.showBalance || !wallet.connection) return;
    void loadBalance();
    balanceTimer = setInterval(() => { if (typeof document === "undefined" || document.visibilityState !== "hidden") void loadBalance(); }, BALANCE_REFRESH_MS);
  };

  /** Moves the menu back inside the window when the button sits near an edge (phones, narrow headers). */
  function keepOnScreen(menu: HTMLElement) {
    const rect = menu.getBoundingClientRect(), width = document.documentElement.clientWidth || window.innerWidth;
    if (!rect.width) return;
    const shift = rect.right > width - 8 ? rect.right - (width - 8) : rect.left < 8 ? rect.left - 8 : 0;
    if (shift) menu.style.translate = `${-shift}px 0`;
  }

  function avatarFor(connection: WalletConnection) {
    const social = wallet.user?.accounts[0];
    return social?.avatar && /^https:\/\//.test(social.avatar)
      ? node("img", { class: "avatar", src: social.avatar, alt: "", referrerpolicy: "no-referrer" })
      : node("span", { class: "avatar", style: `background:${avatarGradient(connection.evm)}` });
  }

  function render() {
    const theme = resolveTheme(options.theme ?? walletTheme);
    applyTheme(host, theme);
    const size = SIZES[options.size ?? "md"] ?? SIZES.md;
    const variant = options.variant ?? "full";
    root.style.setProperty("--h", `${size.h}px`);
    root.style.setProperty("--fs", `${size.fs}px`);
    root.style.setProperty("--px", `${size.px}px`);
    root.className = `root ${variant}${options.align === "start" ? " start" : ""}${open ? " open" : ""}`;
    const connection = wallet.connection;
    const showNetwork = options.showNetwork !== false;
    const network = wallet.ethereum.network;
    const balanceHere = balance && connection && balance.key === `${connection.evm}:${network.chainId}` ? `${balanceText(balance.wei)} ${network.nativeSymbol}` : null;
    root.replaceChildren();

    if (!connection) {
      const label = options.label?.trim() || "Connect wallet";
      const button = node("button", { class: "connect", type: "button", "aria-label": variant === "icon" ? label : undefined, title: variant === "icon" ? label : undefined });
      if (busy) { button.disabled = true; button.append(node("span", { class: "spin", "aria-hidden": "true" }), variant === "icon" ? "" : "Check your wallet…"); }
      else {
        if (options.showMark !== false || variant === "icon") button.append(node("img", { class: "mark", src: WALLET_ICON, alt: "" }));
        if (variant !== "icon") button.append(label);
      }
      button.addEventListener("click", () => void connect());
      root.append(button);
      return;
    }

    const account = node("button", { class: "account", type: "button", "aria-haspopup": "menu", "aria-expanded": String(open), title: connection.evm, "aria-label": `Wallet ${shortAddress(connection.evm)}` });
    account.append(avatarFor(connection));
    if (variant !== "icon") {
      account.append(shortAddress(connection.evm));
      if (options.showBalance && balanceHere && variant === "full") account.append(node("span", { class: "bal", text: balanceHere }));
      if (showNetwork && variant === "full") account.append(node("span", { class: "net" }, node("i", { class: "dot" }), network.name));
      if (variant === "full") account.insertAdjacentHTML("beforeend", CHEVRON);
    }
    account.addEventListener("click", () => { open = !open; justOpened = open; render(); if (!open) view = "main"; if (open) (root.querySelector(".menu .tile, .menu .row") as HTMLElement | null)?.focus(); });
    root.append(account);
    if (!open) return;

    const menu = node("div", { class: justOpened ? "menu enter" : "menu", role: "menu", "aria-label": "Wallet" });
    justOpened = false;
    const page = node("div", { class: viewChanged ? "view enter" : "view" });
    viewChanged = false;
    menu.append(page);
    const go = (next: typeof view) => { view = next; viewChanged = true; render(); (root.querySelector(".menu .search, .menu .row, .menu .tile") as HTMLElement | null)?.focus(); };
    const networks = wallet.ethereum.availableNetworks;

    if (view === "networks" && showNetwork && networks.length > 1) {
      const back = node("button", { class: "icon-btn", type: "button", "aria-label": "Back" }, icon("back"));
      back.addEventListener("click", () => go("main"));
      const search = node("input", { class: "search", type: "search", placeholder: "Search networks", "aria-label": "Search networks", autocomplete: "off" });
      const list = node("div", { class: "nets", role: "group", "aria-label": "Networks" });
      const empty = node("div", { class: "empty", text: "No network matches." });
      empty.hidden = true;
      for (const n of networks) {
        const current = n.chainId === network.chainId;
        const item = node("button", { class: "row", type: "button", role: "menuitemradio", "aria-checked": String(current), "data-name": `${n.name} ${n.nativeSymbol} ${n.chainId}`.toLowerCase() },
          node("span", { class: "lead" }, icon("network")), node("span", { class: "grow", text: n.name }),
          current ? node("span", { class: "tick", text: "✓" }) : node("small", { text: n.nativeSymbol }));
        item.addEventListener("click", () => { view = "main"; void switchTo(n); });
        list.append(item);
      }
      // Filtered in place, so typing keeps focus.
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        for (const item of Array.from(list.children) as HTMLElement[]) { const hit = !q || (item.dataset.name ?? "").includes(q); item.hidden = !hit; if (hit) shown++; }
        empty.hidden = shown > 0;
      });
      page.append(node("div", { class: "top" }, back, node("b", { text: "Network" })), search, list, empty);
      root.append(menu);
      keepOnScreen(menu);
      return;
    }

    // Account card: who, address, balance, quick actions.
    const social = wallet.user?.accounts[0];
    const providerName = social ? (social.provider === "x" || social.provider === "twitter" ? "X" : social.provider.charAt(0).toUpperCase() + social.provider.slice(1)) : "";
    const copyButton = node("button", { class: copied === "evm" ? "icon-btn done" : "icon-btn", type: "button", "aria-label": "Copy address" }, icon(copied === "evm" ? "check" : "copy"));
    copyButton.addEventListener("click", () => copy(connection.evm, "evm"));
    const card = node("div", { class: "card" },
      node("div", { class: "who" }, avatarFor(connection), node("span", { class: "who-text" },
        node("b", { text: social ? (social.name || (social.username ? `@${social.username}` : shortAddress(connection.evm))) : shortAddress(connection.evm) }),
        node("span", { class: "addr" }, social ? `${providerName} · ${shortAddress(connection.evm)}` : shortAddress(connection.evm, 6, 4), copyButton))));
    if (options.showBalance) {
      const [whole, symbol] = balanceHere ? [balanceHere.slice(0, balanceHere.lastIndexOf(" ")), network.nativeSymbol] : ["…", ""];
      card.append(node("div", { class: "amount" }, node("small", { text: `Balance on ${network.name}` }), node("b", {}, whole, symbol ? node("em", { text: symbol }) : null)));
    }
    const tiles = node("div", { class: "tiles" });
    const copyTile = node("button", { class: copied === "evm-tile" ? "tile done" : "tile", type: "button", role: "menuitem" }, icon(copied === "evm-tile" ? "check" : "copy"), copied === "evm-tile" ? "Copied" : "Copy");
    copyTile.addEventListener("click", () => copy(connection.evm, "evm-tile"));
    tiles.append(copyTile);
    if (options.showExplorer !== false && network.explorerUrl) {
      tiles.append(node("a", { class: "tile", role: "menuitem", href: `${network.explorerUrl.replace(/\/$/, "")}/address/${connection.evm}`, target: "_blank", rel: "noopener noreferrer" }, icon("explorer"), "Explorer"));
    }
    tiles.style.gridTemplateColumns = `repeat(${tiles.children.length}, 1fr)`;
    card.append(tiles);
    page.append(card);

    const rows = node("div", { class: "rows" });
    if (showNetwork && networks.length > 1) {
      const pick = node("button", { class: "row", type: "button", role: "menuitem", "aria-label": `Network: ${network.name}. Change` },
        node("span", { class: "lead" }, icon("network")), node("span", { class: "grow" }, node("small", { text: "Network" }), network.name), node("span", { class: "chip" }, node("i", { class: "dot" }), network.nativeSymbol), icon("next"));
      pick.addEventListener("click", () => go("networks"));
      rows.append(pick);
    }
    if (options.showSolana !== false) {
      const sol = node("button", { class: "row", type: "button", role: "menuitem", "aria-label": "Copy Solana address" },
        node("span", { class: "lead" }, icon("solana")), node("span", { class: "grow" }, node("small", { text: "Solana address" }), node("code", { text: shortAddress(connection.solana, 6, 6) })),
        node("span", { class: "hint", text: copied === "solana" ? "Copied" : "" }), icon(copied === "solana" ? "check" : "copy"));
      sol.addEventListener("click", () => copy(connection.solana, "solana"));
      rows.append(sol);
    }
    const custom = (options.menuItems ?? []).filter(i => i && typeof i.label === "string" && i.label.trim());
    for (const entry of custom.slice(0, 8)) {
      const href = entry.href ? safeHref(entry.href) : null;
      const inner = [node("span", { class: "lead" }, icon("link")), node("span", { class: "grow", text: entry.label.slice(0, 40) }), icon("next")];
      const item = href
        ? node("a", { class: "row", role: "menuitem", href, ...(entry.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, ...inner)
        : node("button", { class: "row", type: "button", role: "menuitem" }, ...inner);
      item.addEventListener("click", () => { open = false; render(); entry.onClick?.(); });
      rows.append(item);
    }
    if (rows.children.length) page.append(rows);

    const out = node("button", { class: "out", type: "button", role: "menuitem" }, icon("power"), "Disconnect");
    out.addEventListener("click", () => { open = false; view = "main"; wallet.disconnect(); options.onDisconnect?.(); render(); });
    page.append(node("div", { class: "sep" }), node("div", { class: "foot" }, node("span", { class: "brand" }, node("img", { src: WALLET_ICON, alt: "" }), "MAXXING Wallet"), out));
    root.append(menu);
    keepOnScreen(menu);
  }

  const stop = wallet.onChange(() => { if (!wallet.connection) { open = false; balance = null; } watchBalance(); render(); });
  const onChain = () => {
    const n = wallet.ethereum.network;
    options.onNetworkChange?.({ chainId: n.chainId, name: n.name });
    void loadBalance();
    render();
  };
  wallet.ethereum.on("chainChanged", onChain);
  // Mode "auto" follows the visitor's light or dark setting as it changes.
  const stopSystemTheme = onSystemThemeChange(() => { if ((options.theme ?? walletTheme)?.mode === "auto") render(); });
  render();
  watchBalance();

  return {
    element: host,
    update(next) {
      const balanceWas = options.showBalance;
      options = { ...options, ...next };
      if (Boolean(options.showBalance) !== Boolean(balanceWas)) watchBalance();
      render();
    },
    setMenuOpen(next) { if (wallet.connection && open !== next) { open = next; justOpened = next; render(); } },
    destroy() {
      stop();
      stopSystemTheme();
      if (balanceTimer) clearInterval(balanceTimer);
      wallet.ethereum.off("chainChanged", onChain);
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey);
      host.remove();
    },
  };
}
