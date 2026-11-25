import { applyTheme, resolveTheme, type WalletTheme } from "./theme";

export type WaitingDialog = { show(blocked: boolean): void; hide(): void };

/** MAXXING's wallet mark (graphite and cream), also used as the provider icon. */
export const WALLET_ICON = "data:image/svg+xml;base64," + btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#141518"/><path d="M14 46V18h7l11 15 11-15h7v28h-7V30L32 44 21 30v16z" fill="#E8E4DC"/></svg>`,
);

const STYLE = `
:host { all: initial; }
.backdrop { position: fixed; inset: 0; z-index: 2147483646; display: grid; place-items: center; background: rgba(0,0,0,.45); font: 15px/1.45 var(--mxw-font); -webkit-font-smoothing: antialiased; }
.card { width: min(340px, calc(100vw - 32px)); padding: 20px; border-radius: calc(var(--mxw-radius) + 6px); background: var(--mxw-bg); color: var(--mxw-text); border: 1px solid var(--mxw-border); box-shadow: var(--mxw-shadow); display: grid; gap: 12px; text-align: center; }
img { width: 44px; height: 44px; margin: 0 auto; border-radius: 12px; }
strong { font-size: 16px; }
p { margin: 0; color: var(--mxw-muted); font-size: 13.5px; }
.actions { display: grid; gap: 8px; margin-top: 4px; }
button { appearance: none; border: 0; border-radius: var(--mxw-radius); padding: 11px 14px; font: 600 14.5px/1.2 inherit; font-family: inherit; cursor: pointer; background: var(--mxw-accent); color: var(--mxw-accent-text); }
button.secondary { background: transparent; color: var(--mxw-muted); border: 1px solid var(--mxw-border); }
button:focus-visible { outline: 2px solid var(--mxw-accent); outline-offset: 2px; }
`;

/** A small dialog on the app's page while the wallet window is open, drawn in its own shadow root so page styles can't reach it. */
export function createWaitingDialog(actions: { onOpen: () => void; onCancel: () => void }, theme?: WalletTheme): WaitingDialog {
  const host = document.createElement("div");
  applyTheme(host, resolveTheme(theme));
  host.setAttribute("data-maxxing-wallet", "");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = STYLE;
  const backdrop = document.createElement("div");
  backdrop.className = "backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "MAXXING Wallet");
  const card = document.createElement("div");
  card.className = "card";
  const icon = document.createElement("img");
  icon.src = WALLET_ICON;
  icon.alt = "";
  const title = document.createElement("strong");
  const text = document.createElement("p");
  const open = document.createElement("button");
  const cancel = document.createElement("button");
  cancel.className = "secondary";
  cancel.textContent = "Cancel";
  open.addEventListener("click", () => actions.onOpen());
  cancel.addEventListener("click", () => actions.onCancel());
  const buttons = document.createElement("div");
  buttons.className = "actions";
  buttons.append(open, cancel);
  card.append(icon, title, text, buttons);
  backdrop.append(card);
  shadow.append(style, backdrop);
  return {
    show(blocked) {
      title.textContent = blocked ? "Open MAXXING Wallet" : "Continue in MAXXING Wallet";
      text.textContent = blocked ? "Your browser blocked the wallet window. Open it to continue." : "Check the MAXXING Wallet window to continue.";
      open.textContent = blocked ? "Open wallet" : "Show wallet";
      if (!host.isConnected) document.body.append(host);
      if (blocked) open.focus();
    },
    hide() { host.remove(); },
  };
}
