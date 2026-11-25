/**
 * How the wallet window's sign-in looks for an app: theme, accent, corners, font, logo, title and welcome text, which
 * sign-in buttons come first, and links to the app's terms. Set in the dashboard (developers.maxxing.ad, "Wallet window")
 * and, for one page, in code with `createMaxxingWallet({ appearance })`. Code wins over the dashboard field by field.
 *
 * Shared by the SDK, the wallet window and the dashboard preview; no dependencies. The wallet window cleans every value
 * again before it uses it. Screens that approve or sign keep the wallet's own words and the "Secured by MAXXING" footer.
 */
export type AppearanceTheme = "dark" | "light" | "auto";
export type AppearanceRadius = "none" | "small" | "medium" | "large" | "full";
export type AppearanceFont = "system" | "rounded" | "serif" | "mono";
export type AppearanceLogo = "card" | "centered" | "hidden";
export type AppearanceButtons = "list" | "grid";
export type AppearanceWallet = "after" | "before" | "hidden";

export type WindowAppearance = {
  theme: AppearanceTheme;
  /** Buttons and highlights, #rrggbb. */
  accent: string;
  /** Page colour, #rrggbb; null for the theme's own. Text turns light or dark to stay readable. */
  background: string | null;
  radius: AppearanceRadius;
  font: AppearanceFont;
  /** The app's logo and name at the top: a card with the website, large and centred, or left out (the website still shows). */
  logo: AppearanceLogo;
  /** Sign-in buttons: the first wide and the others as logo squares ("list"), or two per row with names ("grid"). */
  buttons: AppearanceButtons;
  /** Heading; null for "Sign in". */
  title: string | null;
  /** A line under the heading; null for "to {app name}, with one wallet for every network." */
  subtitle: string | null;
  /** Sign-in methods in the order to show them (provider ids). Ones not listed follow in the dashboard's order. */
  order: string[];
  /** "Use a MAXXING wallet": below the sign-in buttons, above them, or not offered. */
  wallet: AppearanceWallet;
  /** Your terms and privacy pages (https). With either set, the window says "By continuing you agree to …". */
  termsUrl: string | null;
  privacyUrl: string | null;
};

/** Code-side overrides: any subset. */
export type WindowAppearanceInput = Partial<WindowAppearance>;

export const DEFAULT_APPEARANCE: WindowAppearance = {
  theme: "dark", accent: "#E8E4DC", background: null, radius: "medium", font: "system", logo: "card", buttons: "list",
  title: null, subtitle: null, order: [], wallet: "after", termsUrl: null, privacyUrl: null,
};

export const APPEARANCE_LIMITS = { title: 48, subtitle: 140, order: 30, url: 300 } as const;

const THEMES: readonly AppearanceTheme[] = ["dark", "light", "auto"];
const RADII: readonly AppearanceRadius[] = ["none", "small", "medium", "large", "full"];
const FONTS: readonly AppearanceFont[] = ["system", "rounded", "serif", "mono"];
const LOGOS: readonly AppearanceLogo[] = ["card", "centered", "hidden"];
const BUTTONS: readonly AppearanceButtons[] = ["list", "grid"];
const WALLETS: readonly AppearanceWallet[] = ["after", "before", "hidden"];

const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (allowed as readonly unknown[]).includes(value) ? value as T : undefined;
const hex = (value: unknown) => typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? value.trim().toUpperCase() : undefined;

/** Plain words only: no control characters, links or markup, single spaces, at most `max` characters. */
export function cleanText(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/[<>]|https?:|www\.|\b[a-z0-9-]+\.(?:com|io|xyz|app|ad|net|org)\b/i.test(text)) return undefined;
  return text.slice(0, max);
}

/** An https page (or http://localhost while developing), at most 300 characters. */
export function cleanUrl(value: unknown): string | null | undefined {
  if (value === null || value === "") return null;
  if (typeof value !== "string" || value.length > APPEARANCE_LIMITS.url) return undefined;
  try {
    const url = new URL(value.trim());
    const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((url.protocol !== "https:" && !local) || url.username || url.password) return undefined;
    return url.toString();
  } catch { return undefined; }
}

/**
 * A complete appearance from untrusted input: each field that is missing or invalid keeps `base`'s value. Use with the
 * dashboard's saved appearance as `base` and code overrides as `input`.
 */
export function cleanAppearance(input: unknown, base: WindowAppearance = DEFAULT_APPEARANCE): WindowAppearance {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const order = Array.isArray(value.order)
    ? [...new Set(value.order.filter((id): id is string => typeof id === "string" && /^[a-z]{2,20}$/.test(id)))].slice(0, APPEARANCE_LIMITS.order)
    : undefined;
  const background = value.background === null ? null : hex(value.background);
  const title = cleanText(value.title, APPEARANCE_LIMITS.title), subtitle = cleanText(value.subtitle, APPEARANCE_LIMITS.subtitle);
  const termsUrl = cleanUrl(value.termsUrl), privacyUrl = cleanUrl(value.privacyUrl);
  return {
    theme: pick(value.theme, THEMES) ?? base.theme,
    accent: hex(value.accent) ?? base.accent,
    background: background === undefined ? base.background : background,
    radius: pick(value.radius, RADII) ?? base.radius,
    font: pick(value.font, FONTS) ?? base.font,
    logo: pick(value.logo, LOGOS) ?? base.logo,
    buttons: pick(value.buttons, BUTTONS) ?? base.buttons,
    title: title === undefined ? base.title : title,
    subtitle: subtitle === undefined ? base.subtitle : subtitle,
    order: order ?? base.order,
    wallet: pick(value.wallet, WALLETS) ?? base.wallet,
    termsUrl: termsUrl === undefined ? base.termsUrl : termsUrl,
    privacyUrl: privacyUrl === undefined ? base.privacyUrl : privacyUrl,
  };
}

/** Methods in the appearance's order; the rest keep their order after them. */
export function orderMethods<T extends { provider: string }>(methods: T[], order: string[]): T[] {
  const rank = (provider: string) => { const at = order.indexOf(provider); return at < 0 ? order.length : at; };
  return methods.map((method, index) => ({ method, index })).sort((a, b) => rank(a.method.provider) - rank(b.method.provider) || a.index - b.index).map(x => x.method);
}

// ── Colours ─────────────────────────────────────────────────────────────────────
function channels(color: string): [number, number, number] {
  const n = Number.parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(color: string): number {
  const [r, g, b] = channels(color).map(c => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** Readable text on `color`: near-black or white. */
export const inkOn = (color: string) => contrast(color, "#141518") >= contrast(color, "#FFFFFF") ? "#141518" : "#FFFFFF";
const rgb = (color: string) => channels(color).join(" ");

const PALETTES = {
  dark: { bg: "#0C0D0F", text: "#F4F4F5" },
  light: { bg: "#FFFFFF", text: "#141518" },
} as const;
const RADIUS_PX: Record<AppearanceRadius, [number, number, number]> = { none: [0, 0, 0], small: [6, 8, 10], medium: [10, 12, 16], large: [14, 18, 24], full: [14, 999, 24] };
export const FONT_STACKS: Record<AppearanceFont, string> = {
  system: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", ui-sans-serif, system-ui, sans-serif',
  serif: 'ui-serif, "Iowan Old Style", "Palatino Linotype", Georgia, Cambria, serif',
  mono: 'ui-monospace, "SF Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace',
};

/**
 * CSS custom properties for one resolved mode. `--bg`, `--text`, the surfaces and lines derive from the background, so
 * any background stays readable; `--lime` (the accent) and `--accent-ink` (text on it) carry the brand.
 */
export function appearanceVars(appearance: WindowAppearance, mode: "dark" | "light"): Record<string, string> {
  const bg = appearance.background ?? PALETTES[mode].bg;
  const text = appearance.background ? (luminance(bg) > 0.4 ? PALETTES.light.text : PALETTES.dark.text) : PALETTES[mode].text;
  const [sm, md, lg] = RADIUS_PX[appearance.radius];
  const accentOnBg = contrast(appearance.accent, bg);
  return {
    "--bg": bg,
    "--text": text,
    "--muted": `rgb(${rgb(text)} / .62)`,
    "--line": `rgb(${rgb(text)} / .09)`,
    "--line-strong": `rgb(${rgb(text)} / .15)`,
    "--bg-elevated": `color-mix(in srgb, ${bg} 94%, ${text})`,
    "--bg-elevated-2": `color-mix(in srgb, ${bg} 89%, ${text})`,
    "--lime": appearance.accent,
    "--lime-soft": `rgb(${rgb(appearance.accent)} / .12)`,
    "--accent-ink": inkOn(appearance.accent),
    // A pale accent on a pale page (or dark on dark) still needs a visible edge.
    "--accent-edge": accentOnBg < 1.6 ? `rgb(${rgb(text)} / .25)` : "transparent",
    "--radius-sm": `${sm}px`, "--radius-md": `${md}px`, "--radius-lg": `${lg}px`,
    "--font": FONT_STACKS[appearance.font],
  };
}

/** The mode a theme shows in now: "auto" follows the device. */
export function resolveMode(theme: AppearanceTheme, prefersLight: boolean): "dark" | "light" {
  return theme === "auto" ? (prefersLight ? "light" : "dark") : theme;
}
export { BRAND_ICONS, brandIcon, type BrandIcon } from "./brand-icons";
