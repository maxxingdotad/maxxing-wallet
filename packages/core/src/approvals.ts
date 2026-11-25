/**
 * Which partner apps each wallet has connected to. Kept in the wallet's own storage, per wallet: connecting one wallet
 * says nothing about another. An app without an entry here gets nothing but the connect screen.
 */
export type AppApproval = { appId: string; name: string; origins: string[]; approvedAt: number; lastUsedAt: number };
type Saved = { version: 1; wallets: Record<string, Record<string, AppApproval>> };

const KEY = "maxxing.walletApps.v1";
const MAX_APPS_PER_WALLET = 100;

const store = () => localStorage;
function valid(entry: unknown): entry is AppApproval {
  const e = entry as AppApproval;
  return !!e && typeof e.appId === "string" && typeof e.name === "string" && Array.isArray(e.origins) && e.origins.every(o => typeof o === "string")
    && Number.isFinite(e.approvedAt) && Number.isFinite(e.lastUsedAt);
}
function read(): Saved {
  try {
    const saved = JSON.parse(store().getItem(KEY) ?? "null") as Saved | null;
    if (saved?.version === 1 && saved.wallets && typeof saved.wallets === "object") {
      const wallets: Saved["wallets"] = {};
      for (const [wallet, apps] of Object.entries(saved.wallets)) {
        if (!apps || typeof apps !== "object") continue;
        wallets[wallet] = Object.fromEntries(Object.entries(apps).filter(([id, entry]) => valid(entry) && entry.appId === id));
      }
      return { version: 1, wallets };
    }
  } catch { /* a damaged record means no app is connected */ }
  return { version: 1, wallets: {} };
}
const write = (saved: Saved) => store().setItem(KEY, JSON.stringify(saved));

export function listApprovals(walletId: string): AppApproval[] {
  return Object.values(read().wallets[walletId] ?? {}).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** The app's entry, only if the request comes from one of the websites the user connected it on. */
export function approvalFor(walletId: string, appId: string, origin: string): AppApproval | null {
  const entry = read().wallets[walletId]?.[appId];
  return entry && entry.origins.includes(origin) ? entry : null;
}

export function approve(walletId: string, app: { id: string; name: string }, origin: string, now = Date.now()): AppApproval {
  const saved = read();
  const apps = saved.wallets[walletId] ??= {};
  const previous = apps[app.id];
  if (!previous && Object.keys(apps).length >= MAX_APPS_PER_WALLET) {
    const oldest = Object.values(apps).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (oldest) delete apps[oldest.appId];
  }
  const entry: AppApproval = {
    appId: app.id, name: app.name, origins: [...new Set([...(previous?.origins ?? []), origin])],
    approvedAt: previous?.approvedAt ?? now, lastUsedAt: now,
  };
  apps[app.id] = entry;
  write(saved);
  return entry;
}

export function touch(walletId: string, appId: string, now = Date.now()) {
  const saved = read(), entry = saved.wallets[walletId]?.[appId];
  if (!entry) return;
  entry.lastUsedAt = now;
  write(saved);
}

export function revoke(walletId: string, appId: string): boolean {
  const saved = read(), apps = saved.wallets[walletId];
  if (!apps?.[appId]) return false;
  delete apps[appId];
  if (!Object.keys(apps).length) delete saved.wallets[walletId];
  write(saved);
  return true;
}

/** A removed wallet takes its connections, and its one-tap choice, with it. */
export function forgetWallet(walletId: string) {
  setOneTap(walletId, false);
  const saved = read();
  if (!saved.wallets[walletId]) return;
  delete saved.wallets[walletId];
  write(saved);
}

// ── One-tap signing ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * By default every signature, including the home site's own, is shown to the user for approval first. One-tap signing lets the
 * home site's requests (trades, sign-in) be signed without a prompt. It is off unless the user turns it on for a wallet, on the
 * wallet's own screen, and can be turned off at any time. Anything that isn't exactly `{ on: true }` for the wallet counts as off.
 */
const ONE_TAP_KEY = "maxxing.walletOneTap.v1";
type OneTapSaved = { version: 1; wallets: Record<string, { on: true; since: number }> };

function readOneTap(): OneTapSaved {
  try {
    const saved = JSON.parse(store().getItem(ONE_TAP_KEY) ?? "null") as OneTapSaved | null;
    if (saved?.version === 1 && saved.wallets && typeof saved.wallets === "object") return saved;
  } catch { /* damaged: off */ }
  return { version: 1, wallets: {} };
}

/** Whether one-tap signing is on for this wallet. Off by default. */
export function oneTapEnabled(walletId: string | null | undefined): boolean {
  if (!walletId) return false;
  const entry = readOneTap().wallets[walletId];
  return entry?.on === true && Number.isFinite(entry.since);
}

/** Turns one-tap signing on or off for a wallet. Only the wallet's own settings screen calls this, after the user chooses. */
export function setOneTap(walletId: string, on: boolean, now = Date.now()) {
  const saved = readOneTap();
  if (on) saved.wallets[walletId] = { on: true, since: now };
  else if (saved.wallets[walletId]) delete saved.wallets[walletId];
  else return;
  store().setItem(ONE_TAP_KEY, JSON.stringify(saved));
}
