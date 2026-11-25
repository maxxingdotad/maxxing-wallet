import { brandIcon, orderMethods, type WindowAppearance } from "@maxxing/wallet-sdk/appearance";

/**
 * The sign-in screen of the wallet window, drawn from an app's look. Shared by the real window (main.ts) and the
 * dashboard's live preview (preview.ts), so the preview is exactly what people see. No wallet code here.
 *
 * MAXXING's own sign-in, as on maxxing.ad: the app and its website at the top with a close button, "Sign in", the first
 * sign-in method as a wide button and the others as logo squares beside it, then the wallet choices (create one with a PIN
 * and Face ID, or bring one back with its recovery words; or carry on with the wallet already on this device), and
 * "Only you can open your wallet · Secured by MAXXING" at the foot.
 */
export type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    else if (key === "className") element.className = String(value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child) element.append(child);
  return element;
}

const SVG = "http://www.w3.org/2000/svg";
/** A small line icon (24×24, stroked in the text colour). */
function lineIcon(size: number, ...d: string[]) {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: String(size), height: String(size), fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const path of d) { const p = document.createElementNS(SVG, "path"); p.setAttribute("d", path); svg.append(p); }
  return svg;
}
const ICONS = {
  close: () => lineIcon(16, "M6 6l12 12", "M18 6L6 18"),
  plus: () => lineIcon(18, "M12 5v14", "M5 12h14"),
  key: () => lineIcon(18, "M15.5 7.5a3.5 3.5 0 1 1-2.2 6.2L6 21H3v-3l1.5-1.5H6V15h1.5l2.8-2.8A3.5 3.5 0 0 1 15.5 7.5Z", "M16.5 9.5h.01"),
  wallet: () => lineIcon(18, "M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16", "M4 7h15.5A.5.5 0 0 1 20 7.5V16h-4a2.5 2.5 0 0 1 0-5h4"),
  chevron: () => lineIcon(16, "M9 6l6 6-6 6"),
  lock: () => lineIcon(12, "M7 11V8a5 5 0 0 1 10 0v3", "M5 11h14v10H5z"),
};

/** The provider's logo, drawn in its own colours. */
export function providerLogo(provider: string, label: string, size = 18) {
  const icon = brandIcon(provider, label);
  if ("initial" in icon) {
    const tile = h("span", { className: "initial", "aria-hidden": "true" }, icon.initial);
    if (icon.tile) { tile.style.background = icon.tile; tile.style.color = icon.ink; }
    return tile;
  }
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", String(size)); svg.setAttribute("height", String(size)); svg.setAttribute("aria-hidden", "true");
  // Marks on a brand tile (Discord's, Twitch's…) are drawn in that colour on the dark button instead.
  const ink = icon.tile ?? icon.ink ?? "currentColor";
  for (const part of icon.paths) {
    const p = document.createElementNS(SVG, "path");
    p.setAttribute("d", part.d);
    p.setAttribute("fill", part.fill ?? (ink === "#FFFFFF" ? "currentColor" : ink));
    svg.append(p);
  }
  return svg;
}

export type ViewApp = { name: string; logoUrl: string | null };
export type ViewMethod = { provider: string; label: string };

const host = (origin: string) => origin.replace(/^https?:\/\//, "");
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function logo(app: ViewApp, size: "small" | "large") {
  return app.logoUrl
    ? h("img", { className: `app-logo ${size}`, src: app.logoUrl, alt: "", referrerpolicy: "no-referrer" })
    : h("div", { className: `app-logo letter ${size}`, "aria-hidden": "true" }, app.name.slice(0, 1).toUpperCase());
}

/** The app at the top of a screen. Whatever the look, the website asking is always shown. */
export function appHeader(app: ViewApp, origin: string, inReview: boolean, style: WindowAppearance["logo"] = "card") {
  const warn = inReview && h("p", { className: "warn" }, "This app hasn't been reviewed by MAXXING yet. Only continue if you're testing it.");
  if (style === "centered") return h("header", { className: "app centered" }, logo(app, "large"), h("span", { className: "origin pill" }, host(origin)), warn);
  if (style === "hidden") return h("header", { className: "app bare" }, h("span", { className: "origin pill" }, host(origin)), warn);
  return h("header", { className: "app" }, logo(app, "small"), h("div", {}, h("strong", {}, app.name), h("span", { className: "origin" }, host(origin))), warn);
}

/** "Secured by MAXXING": on every screen of the window, whatever the app's look. */
export function securedFooter() {
  return h("footer", { className: "secured" }, h("img", { src: "/cap.webp", alt: "", width: "14", height: "14" }), "Secured by MAXXING", h("span", {}, "·"), location.host || "wallet.maxxing.ad");
}

export type SignInHandlers = {
  method: (method: ViewMethod) => void;
  /** Carry on with the wallet on this device; or, with none, the wallet screens. */
  wallet: () => void;
  /** With no wallet on this device: make one, or bring one back. Without these, one "Use a MAXXING wallet" row shows. */
  create?: () => void;
  restore?: () => void;
  cancel: () => void;
};

export function signInView(input: { app: ViewApp; origin: string; inReview: boolean; methods: ViewMethod[]; look: WindowAppearance; status?: HTMLElement; wallet?: { address: string } | null; on: SignInHandlers }) {
  const { app, look, on } = input;
  const methods = orderMethods(input.methods, look.order);

  const choice = (icon: SVGElement, title: string, detail: string, onClick: () => void, kind = "") =>
    h("button", { type: "button", className: `choice ${kind}`.trim(), onClick }, h("span", { className: "choice-icon" }, icon),
      h("span", { className: "choice-text" }, h("b", {}, title), h("small", {}, detail)), h("span", { className: "choice-go" }, ICONS.chevron()));

  // Sign-in methods: the first one wide, the others as logo squares beside and below it; or two per row with names.
  let socials: HTMLElement | null = null;
  if (methods.length && look.buttons === "grid") {
    socials = h("div", { className: "socials grid" }, ...methods.map(m => h("button", { type: "button", className: "social", "data-provider": m.provider, onClick: () => on.method(m) }, providerLogo(m.provider, m.label), h("span", {}, m.label))));
  } else if (methods.length) {
    const [first, ...rest] = methods;
    // Up to two logos sit beside the first. With more, one logo and "+N" show; "+N" opens every logo in rows below.
    const many = rest.length > 2;
    const squares = rest.map((m, index) => h("button", { type: "button", className: "social square", "data-provider": m.provider, hidden: many && index > 0, onClick: () => on.method(m), title: `Continue with ${m.label}`, "aria-label": `Continue with ${m.label}` }, providerLogo(m.provider, m.label, 19)));
    const more = many ? h("button", { type: "button", className: "social square more", "aria-expanded": "false", "aria-label": `${rest.length - 1} more ways to sign in`, title: "More", onClick: () => {
      for (const square of squares) square.hidden = false;
      socials!.classList.add("stacked");
      more!.remove();
      squares[1]?.focus();
    } }, `+${rest.length - 1}`) : null;
    socials = h("div", { className: "socials" },
      h("button", { type: "button", className: "social wide", "data-provider": first!.provider, onClick: () => on.method(first!) }, providerLogo(first!.provider, first!.label), h("span", {}, `Continue with ${first!.label}`)),
      ...squares, more);
  }

  const walletChoices = look.wallet === "hidden" && methods.length ? null
    : h("div", { className: "choices" }, ...(input.wallet
      ? [choice(ICONS.wallet(), "Continue with your wallet", `MAXXING wallet ${short(input.wallet.address)}`, () => on.wallet(), "primary")]
      : on.create && on.restore
        ? [choice(ICONS.plus(), "Create a wallet", "A 6-digit PIN, plus Face ID or fingerprint", () => on.create!()),
          choice(ICONS.key(), "I already have a wallet", "Your 12 or 24 recovery words", () => on.restore!())]
        : [choice(ICONS.wallet(), "Use a MAXXING wallet", "Create one, or bring yours back", () => on.wallet())]));
  const divider = socials && walletChoices ? h("p", { className: "or" }, h("span", {}, "or")) : null;

  const terms = look.termsUrl || look.privacyUrl ? h("p", { className: "fine terms" }, "By continuing you agree to ", app.name, "'s ",
    look.termsUrl ? h("a", { href: look.termsUrl, target: "_blank", rel: "noopener noreferrer" }, "Terms") : null,
    look.termsUrl && look.privacyUrl ? " and " : null,
    look.privacyUrl ? h("a", { href: look.privacyUrl, target: "_blank", rel: "noopener noreferrer" }, "Privacy Policy") : null, ".") : null;

  return h("main", { className: `signin logo-${look.logo}` },
    h("div", { className: "signin-top" },
      appHeader(app, input.origin, input.inReview, look.logo),
      h("button", { type: "button", className: "close", onClick: () => on.cancel(), "aria-label": "Close" }, ICONS.close())),
    h("div", { className: "headline" },
      h("h1", {}, look.title ?? "Sign in"),
      h("p", { className: "subtitle" }, look.subtitle ?? `to ${app.name}, with one wallet for every network.`)),
    ...(look.wallet === "before" ? [walletChoices, divider, socials] : [socials, divider, walletChoices]),
    input.status,
    terms,
    h("p", { className: "privacy" }, ICONS.lock(), h("span", {}, "Only you can open your wallet")),
    securedFooter());
}
