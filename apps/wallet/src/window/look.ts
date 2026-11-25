import { appearanceVars, cleanAppearance, DEFAULT_APPEARANCE, luminance, resolveMode, type WindowAppearance } from "@maxxing/wallet-sdk/appearance";

/**
 * Puts an app's look on the wallet window: theme, colours, corners and font as CSS variables on the page (set through the
 * style API, which the page's CSP allows; no inline styles). "auto" follows the device and changes with it.
 */
let current: WindowAppearance = DEFAULT_APPEARANCE;
let media: MediaQueryList | null = null;
const onChange = () => paint();

function paint() {
  const mode = resolveMode(current.theme, Boolean(media?.matches));
  const vars = appearanceVars(current, mode);
  // On the window's own pages only (#app): the wallet's PIN and recovery screens (#wallet-ui) keep MAXXING's look.
  const page = document.getElementById("app");
  if (page) {
    for (const [name, value] of Object.entries(vars)) page.style.setProperty(name, value);
    page.style.setProperty("color-scheme", luminance(vars["--bg"]!) > 0.4 ? "light" : "dark");
    page.dataset.mode = mode;
  }
  document.documentElement.style.setProperty("--page-bg", vars["--bg"]!);
}

export function applyLook(appearance: WindowAppearance) {
  current = appearance;
  if (!media && typeof matchMedia === "function") { media = matchMedia("(prefers-color-scheme: light)"); media.addEventListener("change", onChange); }
  paint();
}

/** The dashboard's look for the app, with what the site's code asked for (connect's `appearance`) on top. */
export function lookFor(saved: unknown, fromCode: unknown): WindowAppearance {
  return cleanAppearance(fromCode, cleanAppearance(saved));
}

export const currentLook = () => current;
