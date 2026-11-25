import { cleanAppearance } from "@maxxing/wallet-sdk/appearance";
import { API_URL } from "../registry";
import { applyLook } from "./look";
import { h, signInView, type ViewMethod } from "./signin-view";

/**
 * The dashboard's live preview of an app's sign-in (developers.maxxing.ad, "Wallet window"). The same screen code as the
 * real window, inside a frame only the dashboard may embed; nothing here touches a wallet, and buttons do nothing.
 */
const env = import.meta.env ?? ({} as ImportMetaEnv);
const csv = (value: string | undefined) => (value ?? "").split(",").map(v => { try { return new URL(v.trim()).origin; } catch { return ""; } }).filter(Boolean);
const DASHBOARDS = csv(env.VITE_DEVELOPERS_URL as string | undefined).length ? csv(env.VITE_DEVELOPERS_URL as string | undefined)
  : env.DEV ? ["http://localhost:5177", "http://127.0.0.1:5177"] : ["https://developers.maxxing.ad"];

export const PREVIEW_MESSAGE = "maxxing-wallet-preview";
type State = { type: typeof PREVIEW_MESSAGE; app?: { name?: unknown; logoUrl?: unknown }; origin?: unknown; methods?: unknown; appearance?: unknown; mode?: unknown };

const root = document.getElementById("app")!;
// Sized by the dashboard to the screen, so the page itself never scrolls.
document.documentElement.classList.add("preview");
let pressed = "";

function render(state: State) {
  const name = typeof state.app?.name === "string" && state.app.name.trim() ? state.app.name.trim().slice(0, 40) : "Your app";
  const logoUrl = typeof state.app?.logoUrl === "string" && state.app.logoUrl.startsWith(`${API_URL}/v1/wallet-apps/`) ? state.app.logoUrl : null;
  const origin = typeof state.origin === "string" && /^https?:\/\/[^/\s]{1,200}$/.test(state.origin) ? state.origin : "https://your-app.com";
  const methods: ViewMethod[] = Array.isArray(state.methods)
    ? state.methods.filter((m): m is ViewMethod => typeof m?.provider === "string" && /^[a-z]{1,20}$/.test(m.provider) && typeof m?.label === "string").slice(0, 30).map(m => ({ provider: m.provider, label: m.label.slice(0, 30) }))
    : [];
  const look = cleanAppearance(state.appearance);
  const mode = state.mode === "light" || state.mode === "dark" ? state.mode : null;
  applyLook(mode && look.theme === "auto" ? { ...look, theme: mode } : look);
  const status = h("p", { className: "note", role: "status" }, pressed);
  const say = (text: string) => { pressed = text; status.textContent = text; };
  root.replaceChildren(signInView({
    app: { name, logoUrl }, origin, inReview: false, methods, look, status,
    on: {
      method: m => say(`Preview: this opens ${m.label}.`), wallet: () => say("Preview: this opens the MAXXING wallet."),
      create: () => say("Preview: this makes a new wallet."), restore: () => say("Preview: this brings a wallet back with its recovery words."),
      cancel: () => say("Preview: this closes the window."),
    },
  }));
}

window.addEventListener("message", event => {
  if (event.source !== window.parent || !DASHBOARDS.includes(event.origin)) return;
  const data = event.data as State;
  if (data?.type === PREVIEW_MESSAGE) render(data);
});
render({ type: PREVIEW_MESSAGE });
// Nothing secret: tells the dashboard the preview can take a look.
if (window.parent !== window) window.parent.postMessage({ type: PREVIEW_MESSAGE, ready: true }, "*");
// The screen's height, so the dashboard can size the frame to it (as a login modal grows and shrinks). Nothing secret.
if (window.parent !== window && typeof ResizeObserver === "function") {
  let last = 0;
  const report = () => {
    const screen = root.firstElementChild as HTMLElement | null;
    const height = Math.ceil(screen?.getBoundingClientRect().height ?? 0);
    if (height && height !== last) { last = height; window.parent.postMessage({ type: PREVIEW_MESSAGE, height }, "*"); }
  };
  const sizes = new ResizeObserver(report);
  const watch = () => { const screen = root.firstElementChild; if (screen) sizes.observe(screen); report(); };
  new MutationObserver(watch).observe(root, { childList: true, subtree: true });
  watch();
}
