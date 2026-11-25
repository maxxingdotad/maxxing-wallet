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

/** A removed wallet takes its connections with it. */
export function forgetWallet(walletId: string) {
  const saved = read();
  if (!saved.wallets[walletId]) return;
  delete saved.wallets[walletId];
  write(saved);
}
