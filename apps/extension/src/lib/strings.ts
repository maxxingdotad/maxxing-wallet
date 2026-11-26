/**
 * The extension's words, in one place so another language can be added as one more table. English is the only language today;
 * screens move their text here as they change (Settings first). `t("key", { n: 3 })` fills {n}.
 */
const en = {
  "settings.title": "Settings",
  "settings.view": "View",
  "settings.security": "Security",
  "settings.autolock": "Lock automatically after",
  "settings.autolock.note": "Without use, the wallet locks and only your password opens it again. It also locks when the browser closes.",
  "settings.changePassword": "Change password",
  "settings.privacy": "Privacy",
  "settings.hideBalances": "Hide balances",
  "settings.hideBalances.note": "Totals and amounts show as dots until you turn this off.",
  "settings.networks": "Networks",
  "settings.testnets": "Show test networks",
  "settings.testnets.note": "{names}.",
  "settings.currency": "Currency",
  "settings.currency.note": "Values show in US dollars.",
  "settings.sites": "Sites and approvals",
  "settings.about": "About",
  "settings.support": "Contact support",
  "settings.source": "Public source code",
  "settings.securityPolicy": "Security policy and reports",
  "settings.version": "MAXXING Wallet {version} · {n} wallets on this device",
  "settings.keysNote": "Your keys stay on this device. MAXXING never has them.",
  "password.current": "Enter your current password",
  "password.new": "Choose a new password",
  "password.changed": "Password changed. Every wallet here opens with the new one.",
} as const;

export type StringKey = keyof typeof en;
const tables: Record<string, Partial<Record<StringKey, string>>> = { en };
let language = "en";

/** Picks the table for the browser's language when there is one; English otherwise (and for any missing string). */
export function setLanguage(lang: string) { language = tables[lang] ? lang : tables[lang.split("-")[0]!] ? lang.split("-")[0]! : "en"; }

export function t(key: StringKey, vars: Record<string, string | number> = {}): string {
  const text = tables[language]?.[key] ?? en[key];
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

/** "A, B and C" (and "A, B, C and 4 more" past `max`), for lists of names that come from the registry. */
export function listNames(names: readonly string[], max = 3): string {
  const shown = names.slice(0, max), more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** Public links shown in Settings. */
export const LINKS = {
  support: "mailto:support@maxxing.ad",
  source: "https://github.com/maxxingdotad/maxxing-wallet",
  security: "https://github.com/maxxingdotad/maxxing-wallet/blob/main/SECURITY.md",
} as const;
