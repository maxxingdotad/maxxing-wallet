import type { WalletConnection } from "./protocol";

type Saved = { connection: WalletConnection | null; chainId: number | null };
type Listener = (connection: WalletConnection | null) => void;

/**
 * The connected wallet's public addresses, remembered on this site so the app reopens connected after a refresh.
 * Only addresses are kept here; the wallet itself stays on wallet.maxxing.ad.
 */
export class ConnectionStore {
  private saved: Saved;
  private listeners = new Set<Listener>();
  private readonly key: string;

  constructor(appId: string, private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = safeStorage()) {
    this.key = `maxxing-wallet:${appId}`;
    this.saved = this.load();
  }

  get connection() { return this.saved.connection; }
  get chainId() { return this.saved.chainId; }

  set(connection: WalletConnection | null) {
    const before = JSON.stringify(this.saved.connection);
    this.saved = { ...this.saved, connection };
    this.persist();
    if (JSON.stringify(connection) !== before) for (const listener of this.listeners) listener(connection);
  }
  setChain(chainId: number) { this.saved = { ...this.saved, chainId }; this.persist(); }
  subscribe(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private load(): Saved {
    try {
      const saved = JSON.parse(this.storage?.getItem(this.key) ?? "null") as Saved | null;
      const c = saved?.connection;
      const valid = c && /^0x[0-9a-fA-F]{40}$/.test(c.evm) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.solana);
      return { connection: valid ? { evm: c.evm, solana: c.solana } : null, chainId: Number.isSafeInteger(saved?.chainId) ? saved!.chainId : null };
    } catch { return { connection: null, chainId: null }; }
  }
  private persist() {
    try { this.storage?.setItem(this.key, JSON.stringify(this.saved)); } catch { /* storage full or blocked */ }
  }
}

function safeStorage() {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}
