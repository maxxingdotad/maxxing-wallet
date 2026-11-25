/** How the wallet's on-page pieces (connect button, account menu, waiting dialog) look on a partner's site. */
export type WalletTheme = {
  /** Starting palette. Every value below overrides it. "auto" follows the visitor's light or dark setting. Default "dark". */
  mode?: "dark" | "light" | "auto";
  /** Connect button and highlights. */
  accent?: string;
  /** Text on the accent colour. */
  accentText?: string;
  /** Account button, menu and dialog background. */
  background?: string;
  /** Hover and chip background inside the menu. */
  surface?: string;
  text?: string;
  muted?: string;
  border?: string;
  /** Corner radius in px, 0 to 28. */
  radius?: number;
  /** A CSS font-family list. "inherit" uses your page's font. */
  font?: string;
};
export type ResolvedTheme = Required<Omit<WalletTheme, "mode">> & { mode: "dark" | "light" };

const FONT = `Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
/** MAXXING's own palette (the web app's graphite and cream). */
export const THEMES: Record<"dark" | "light", ResolvedTheme> = {
  dark: { mode: "dark", accent: "#E8E4DC", accentText: "#141518", background: "#141518", surface: "#1C1E22", text: "#F4F4F5", muted: "#8E919A", border: "rgba(244,244,245,.12)", radius: 12, font: FONT },
  light: { mode: "light", accent: "#141518", accentText: "#FFFFFF", background: "#FFFFFF", surface: "#F2F2F3", text: "#141518", muted: "#6A6E76", border: "rgba(20,21,24,.12)", radius: 12, font: FONT },
};

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|color-mix)\([0-9a-z\s.,%/#-]+\)|[a-z]{3,20})$/i;
const color = (value: unknown, fallback: string) => typeof value === "string" && COLOR.test(value.trim()) ? value.trim() : fallback;

/** The theme with every value filled in. Values that aren't plain CSS colours, sizes or font names fall back to the palette's. */
export function resolveTheme(theme: WalletTheme = {}, prefersLight = systemPrefersLight()): ResolvedTheme {
  const base = THEMES[theme.mode === "light" || (theme.mode === "auto" && prefersLight) ? "light" : "dark"];
  const radius = Number(theme.radius);
  const font = typeof theme.font === "string" && theme.font.trim() && !/[;{}<>\\]/.test(theme.font) ? theme.font.trim().slice(0, 200) : base.font;
  return {
    mode: base.mode,
    accent: color(theme.accent, base.accent),
    accentText: color(theme.accentText, base.accentText),
    background: color(theme.background, base.background),
    surface: color(theme.surface, base.surface),
    text: color(theme.text, base.text),
    muted: color(theme.muted, base.muted),
    border: color(theme.border, base.border),
    radius: Number.isFinite(radius) ? Math.min(28, Math.max(0, Math.round(radius))) : base.radius,
    font,
  };
}

/** The visitor's light or dark setting, for mode "auto". Dark where it can't be read. */
export function systemPrefersLight() {
  try { return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches; } catch { return false; }
}

/** Calls `listener` when the visitor's light or dark setting changes. Returns a function that stops listening. */
export function onSystemThemeChange(listener: () => void): () => void {
  try {
    if (typeof matchMedia !== "function") return () => {};
    const query = matchMedia("(prefers-color-scheme: light)");
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  } catch { return () => {}; }
}

/** Sets the theme as CSS variables on a shadow host; the widget's styles read only these. */
export function applyTheme(host: HTMLElement, theme: ResolvedTheme) {
  const vars: Record<string, string> = {
    "--mxw-accent": theme.accent, "--mxw-accent-text": theme.accentText, "--mxw-bg": theme.background, "--mxw-surface": theme.surface,
    "--mxw-text": theme.text, "--mxw-muted": theme.muted, "--mxw-border": theme.border, "--mxw-radius": `${theme.radius}px`, "--mxw-font": theme.font,
    "--mxw-shadow": theme.mode === "light" ? "0 18px 48px rgba(20,21,24,.16)" : "0 24px 64px rgba(0,0,0,.5)",
  };
  for (const [name, value] of Object.entries(vars)) host.style.setProperty(name, value);
}

/** 0x1234…abcd */
export const shortAddress = (address: string, head = 6, tail = 4) => address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`;

/** Two hues from the address, so each wallet gets its own avatar without loading anything. */
export function avatarGradient(address: string) {
  const hex = address.replace(/^0x/i, "").padEnd(12, "0");
  const a = parseInt(hex.slice(0, 6), 16) % 360, b = (a + 40 + (parseInt(hex.slice(6, 12), 16) % 140)) % 360;
  return `linear-gradient(135deg, hsl(${a} 70% 62%), hsl(${b} 65% 45%))`;
}
