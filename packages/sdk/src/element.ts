import { createMaxxingWallet, type MaxxingWallet } from "./index";
import type { WalletTheme } from "./theme";
import type { ConnectButton, ConnectButtonOptions } from "./widget";

/** One wallet per app on a page, however many tags use it (each wallet announces itself to other libraries once). */
const wallets = new Map<string, MaxxingWallet>();
function walletFor(appId: string, walletUrl: string | undefined, chains: number[] | undefined, theme: WalletTheme | undefined) {
  const key = JSON.stringify([appId, walletUrl ?? "", chains ?? []]);
  let wallet = wallets.get(key);
  if (!wallet) { wallet = createMaxxingWallet({ appId, walletUrl, chains, theme }); wallets.set(key, wallet); }
  return wallet;
}

const THEME_ATTRIBUTES = { mode: "mode", accent: "accent", "accent-text": "accentText", background: "background", surface: "surface", text: "text", muted: "muted", border: "border", radius: "radius", font: "font" } as const;
const BUTTON_ATTRIBUTES = ["label", "size", "align", "variant", "show-network", "show-balance", "show-solana", "show-mark", "show-explorer", "sign-in"] as const;
const WALLET_ATTRIBUTES = ["app-id", "chains", "wallet-url"] as const;

const flag = (value: string | null) => value === null ? undefined : !/^(false|0|no|off)$/i.test(value.trim());

/** Reads the tag's attributes into a theme. */
export function themeFromAttributes(get: (name: string) => string | null): WalletTheme {
  const theme: WalletTheme = {};
  for (const [attribute, key] of Object.entries(THEME_ATTRIBUTES)) {
    const value = get(attribute);
    if (value === null || value === "") continue;
    if (key === "radius") theme.radius = Number(value);
    else if (key === "mode") { if (value === "light" || value === "dark" || value === "auto") theme.mode = value; }
    else (theme as Record<string, string>)[key] = value;
  }
  return theme;
}

/** Reads `chains="8453, 1"` into chain ids. */
export function chainsFromAttribute(value: string | null): number[] | undefined {
  const ids = (value ?? "").split(/[\s,]+/).filter(Boolean).map(Number).filter(n => Number.isSafeInteger(n) && n > 0);
  return ids.length ? ids : undefined;
}

/**
 * `<maxxing-connect app-id="app_…">` — the connect button as an HTML tag, for sites without a build step.
 * Attributes: app-id (required), chains, wallet-url, label, size, align, variant (full, compact, icon), show-network,
 * show-balance, show-solana, show-mark, show-explorer, sign-in,
 * and theme values mode, accent, accent-text, background, surface, text, muted, border, radius, font.
 * Events: `maxxing:connect` (detail: { evm, solana }), `maxxing:disconnect`, `maxxing:error` (detail: the error).
 * The `wallet` property is the wallet behind it, for signing (`el.wallet.ethereum.request(...)`).
 */
export function defineConnectElement(tag = "maxxing-connect") {
  if (typeof customElements === "undefined" || customElements.get(tag)) return;
  class MaxxingConnectElement extends HTMLElement {
    static observedAttributes = [...WALLET_ATTRIBUTES, ...BUTTON_ATTRIBUTES, ...Object.keys(THEME_ATTRIBUTES)];
    private button: ConnectButton | null = null;
    private walletKey = "";
    wallet: MaxxingWallet | null = null;

    connectedCallback() { this.render(); }
    disconnectedCallback() { this.button?.destroy(); this.button = null; }
    attributeChangedCallback() { if (this.isConnected) this.render(); }

    private options(): ConnectButtonOptions {
      const size = this.getAttribute("size"), align = this.getAttribute("align");
      return {
        label: this.getAttribute("label") ?? undefined,
        size: size === "sm" || size === "lg" ? size : "md",
        align: align === "start" ? "start" : "end",
        showNetwork: flag(this.getAttribute("show-network")),
        showSolana: flag(this.getAttribute("show-solana")),
        showMark: flag(this.getAttribute("show-mark")),
        showBalance: flag(this.getAttribute("show-balance")),
        showExplorer: flag(this.getAttribute("show-explorer")),
        signIn: flag(this.getAttribute("sign-in")),
        variant: (["full", "compact", "icon"] as const).find(v => v === this.getAttribute("variant")),
        theme: themeFromAttributes(name => this.getAttribute(name)),
        onConnect: connection => this.dispatchEvent(new CustomEvent("maxxing:connect", { detail: connection, bubbles: true, composed: true })),
        onDisconnect: () => this.dispatchEvent(new CustomEvent("maxxing:disconnect", { bubbles: true, composed: true })),
        onError: error => this.dispatchEvent(new CustomEvent("maxxing:error", { detail: error, bubbles: true, composed: true })),
      };
    }

    private render() {
      const appId = this.getAttribute("app-id")?.trim();
      if (!appId) { console.warn(`<${tag}> needs an app-id attribute. Get one at https://developers.maxxing.ad`); return; }
      const walletUrl = this.getAttribute("wallet-url") ?? undefined;
      const chains = chainsFromAttribute(this.getAttribute("chains"));
      const key = JSON.stringify([appId, walletUrl ?? "", chains ?? []]);
      const options = this.options();
      if (this.button && key === this.walletKey) { this.button.update(options); return; }
      this.button?.destroy();
      this.walletKey = key;
      this.wallet = walletFor(appId, walletUrl, chains, options.theme);
      this.button = this.wallet.mountConnectButton(this, options);
    }
  }
  customElements.define(tag, MaxxingConnectElement);
}
