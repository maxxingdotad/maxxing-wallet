import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, ExternalLink, Globe, KeyRound, Lock, LogOut, Maximize2, PanelRight, Plus, RefreshCw, ShieldCheck, Trash2, Download } from "lucide-react";
import { Avatar, ChainDot, Dock, Orbit, TokenMark, short, usd, type Account, type DockTab, type Holding } from "../ui/parts";
import { Busy, PageHead, PinPad, copy, message, useToast } from "./kit";
import { Onboarding } from "./Onboarding";
import { ExportFlow } from "./Export";
import { SendView } from "./Send";
import { SwapView } from "./Swap";
import * as wallet from "../lib/wallet";
import { loadPortfolio, type Portfolio } from "../lib/balances";
import { activity as activityLog, AUTO_LOCK_CHOICES, settings as settingsStore, sites as siteStore, type Activity, type Settings, type SitePermission } from "../lib/store";

const COLORS = ["#E8E4DC", "#A36AFF", "#3CB07A", "#D4B15A", "#4FB4F7", "#E15D55", "#C4C6CC"];
const colorFor = (id: string) => COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]!;
type WalletSummary = wallet.WalletSnapshot["accounts"][number];
/** The wallet's open account, as the header and lists show it: its own name and color. */
const selectedAccount = (w: WalletSummary) => w.accounts.find(x => x.index === w.selected) ?? w.accounts[0]!;
const asAccount = (w: WalletSummary, index = w.selected, value = 0): Account => {
  const x = w.accounts.find(a => a.index === index) ?? selectedAccount(w);
  return { id: `${w.id}:${x.index}`, name: x.label, color: colorFor(`${w.id}:${x.index}`), evm: x.evm, solana: x.solana, usd: value };
};

type View = { name: "home" } | { name: "send"; holding?: Holding } | { name: "receive" } | { name: "swap" } | { name: "activity" } | { name: "settings" } | { name: "export"; kind: "phrase" | "keys" } | { name: "add"; kind: "create" | "import" } | { name: "remove" };

export function App({ mode }: { mode: "popup" | "panel" | "tab" }) {
  const [snap, setSnap] = useState<wallet.WalletSnapshot | null>(null);
  const [view, setView] = useState<View>({ name: "home" });
  // Onboarding stays on screen until the user finishes it (backup included), even though the wallet exists from its second step.
  const [onboarding, setOnboarding] = useState(false);
  const [toast, showToast] = useToast();
  const refresh = useCallback(() => setSnap(wallet.snapshot()), []);
  useEffect(() => {
    void wallet.start().then(s => { setOnboarding(s.accounts.length === 0 && !s.storageError); setSnap(s); });
    window.addEventListener("maxxing:wallet", refresh);
    return () => window.removeEventListener("maxxing:wallet", refresh);
  }, [refresh]);
  const frame = (child: React.ReactNode) => <div className={mode === "popup" ? "" : "fill-frame"}>{child}{toast}</div>;

  if (!snap) return frame(<div className="popup"><div className="backdrop" /><Busy text="Opening your wallet…" /></div>);
  if (snap.storageError) return frame(<div className="popup"><div className="backdrop" /><div className="scroll" style={{ paddingTop: 40 }}><div className="alert danger"><AlertTriangle size={17} /><span>{message(new Error(snap.storageError))}</span></div></div></div>);
  if (onboarding || !snap.accounts.length) return frame(<Onboarding onDone={() => { setOnboarding(false); refresh(); }} />);
  if (view.name === "add") return frame(<Onboarding addOnly={view.kind} onCancel={() => setView({ name: "home" })} onDone={() => { refresh(); setView({ name: "home" }); }} />);
  if (!snap.unlocked) return frame(<Unlock snap={snap} onOpen={refresh} onImport={() => setView({ name: "add", kind: "import" })} />);
  const active = snap.accounts.find(a => a.id === snap.activeId)!;
  const go = (next: View) => setView(next);
  const onTab = (tab: DockTab) => go(tab === "home" ? { name: "home" } : tab === "swap" ? { name: "swap" } : tab === "activity" ? { name: "activity" } : { name: "settings" });

  switch (view.name) {
    case "send": return frame(<SendView holding={view.holding} account={active} onBack={() => go({ name: "home" })} toast={showToast} />);
    case "receive": return frame(<Receive account={active} onBack={() => go({ name: "home" })} toast={showToast} />);
    case "swap": return frame(<SwapView account={active} onTab={onTab} toast={showToast} />);
    case "activity": return frame(<ActivityView onTab={onTab} />);
    case "settings": return frame(<SettingsView snap={snap} mode={mode} go={go} onTab={onTab} toast={showToast} onChanged={refresh} />);
    case "export": return frame(<ExportFlow kind={view.kind} onClose={() => go({ name: "settings" })} />);
    case "remove": return frame(<RemoveWallet backedUp={active.backedUp} onClose={() => go({ name: "settings" })} onRemoved={() => { refresh(); go({ name: "home" }); }} />);
    default: return frame(<HomeView snap={snap} active={active} go={go} onTab={onTab} onChanged={refresh} />);
  }
}

function Unlock({ snap, onOpen, onImport }: { snap: wallet.WalletSnapshot; onOpen: () => void; onImport: () => void }) {
  const active = snap.accounts.find(a => a.id === snap.activeId) ?? snap.accounts[0]!;
  const [error, setError] = useState(""), [waitUntil, setWaitUntil] = useState(wallet.pinWaitUntil());
  return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 22 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <img src="/brand/cap.webp" alt="" style={{ width: 92, filter: "drop-shadow(0 10px 18px rgb(0 0 0 / .5))" }} />
        <span className="chip"><Avatar account={asAccount(active)} />{selectedAccount(active).label} · {short(active.evm)}</span>
      </div>
      <PinPad title="Enter your PIN" error={error} waitUntil={waitUntil} onComplete={async pin => {
        try { setError(""); await wallet.unlock(pin); onOpen(); } catch (e) { setError(message(e)); setWaitUntil(wallet.pinWaitUntil()); }
      }} />
      <div style={{ textAlign: "center", marginTop: 14 }}><button type="button" className="link-btn" onClick={onImport}>Forgot your PIN? Restore with your recovery phrase</button></div>
    </div>
  </div>;
}

function HomeView({ snap, active, go, onTab, onChanged }: { snap: wallet.WalletSnapshot; active: wallet.WalletSnapshot["accounts"][number]; go: (v: View) => void; onTab: (t: DockTab) => void; onChanged: () => void }) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [prefs, setPrefs] = useState<Settings | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    const s = await settingsStore.read(); setPrefs(s);
    try { setPortfolio(await loadPortfolio({ evm: active.evm, solana: active.solana }, s.showTestnets)); } finally { setLoading(false); }
  }, [active.evm, active.solana]);
  useEffect(() => { setPortfolio(null); void load(); }, [load]);
  const holdings = portfolio?.holdings ?? [];
  const byChain = new Map<string, { chain: Holding["chain"]; usd: number }>();
  for (const h of holdings) byChain.set(h.chain.id, { chain: h.chain, usd: (byChain.get(h.chain.id)?.usd ?? 0) + h.usd });
  return <div className="popup">
    <div className="backdrop" />
    <header className="top">
      <button type="button" className="account-pill" onClick={() => setSheet(true)} aria-label="Switch account"><Avatar account={asAccount(active)} /><b>{selectedAccount(active).label}</b><ChevronDown size={16} /></button>
      <div className="top-right">
        <button type="button" className="chip" onClick={async () => { await settingsStore.write({ showTestnets: !prefs?.showTestnets }); void load(); }} title="Show or hide test networks">
          <span className="dot" style={{ background: "conic-gradient(#A36AFF, #3FD5F5, #E8E4DC, #A36AFF)" }} />{prefs?.showTestnets ? "All + testnets" : "All chains"}
        </button>
        <button type="button" className="icon-btn" aria-label="Refresh" onClick={() => void load()}><RefreshCw size={17} strokeWidth={1.7} className={loading ? "spinning" : ""} /></button>
      </div>
    </header>
    <div className="scroll">
      <Orbit total={portfolio?.totalUsd ?? 0} change={null} shares={[...byChain.values()]} note={!portfolio ? "Reading your balances…" : portfolio.source === "chain" ? "USD shown for stablecoins" : undefined} />
      <div className="actions">
        <button type="button" className="action" onClick={() => go({ name: "send" })}><i><ArrowUpRight size={18} /></i>Send</button>
        <button type="button" className="action" onClick={() => go({ name: "receive" })}><i><ArrowDownLeft size={18} /></i>Receive</button>
        <button type="button" className="action" onClick={() => go({ name: "swap" })}><i><ArrowLeftRight size={18} /></i>Swap</button>
        <button type="button" className="action" onClick={() => void chrome.tabs.create({ url: "https://maxxing.ad" })}><i><Plus size={18} /></i>Buy</button>
      </div>
      {!active.backedUp && <div className="alert warn" style={{ marginBottom: 10 }}><ShieldCheck size={16} /><span><b>Back up your recovery phrase.</b> It's the only way back in if you lose this device. <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => go({ name: "export", kind: "phrase" })}>Back up now</button></span></div>}
      <div className="section-head"><h2>Tokens</h2>{portfolio && <button type="button" onClick={() => void load()}>{portfolio.source === "api" ? "Live from MAXXING" : "Read from the networks"}</button>}</div>
      {!portfolio ? <Busy text="Reading balances on every chain…" /> : holdings.length === 0
        ? <div className="card empty">Nothing here yet.<br />Receive tokens on any chain to see them in one balance.<div style={{ marginTop: 12 }}><button type="button" className="btn secondary" onClick={() => go({ name: "receive" })}><ArrowDownLeft size={16} />Receive</button></div></div>
        : <div className="card rows">{holdings.map(h => <button type="button" key={`${h.chain.id}:${h.address ?? h.symbol}`} className="row" style={{ width: "100%", textAlign: "left" }} onClick={() => go({ name: "send", holding: h })}>
          <TokenMark holding={h} />
          <div className="main"><b>{h.name}</b><small className="num">{h.amount} {h.symbol} · {h.chain.name}</small></div>
          <div className="end"><b className="num">{h.priced === false ? "—" : usd(h.usd)}</b><small>{h.priced === false ? "no price yet" : ""}</small></div>
        </button>)}</div>}
      {portfolio?.errors.length ? <p style={{ fontSize: 11.5, color: "var(--dim)", margin: "8px 4px" }}>Couldn't reach: {portfolio.errors.slice(0, 4).join(", ")}{portfolio.errors.length > 4 ? ` and ${portfolio.errors.length - 4} more` : ""}.</p> : null}
    </div>
    <Dock tab="home" onTab={onTab} />
    {sheet && <AccountsSheet snap={snap} onClose={() => setSheet(false)} onChanged={onChanged} onAdd={kind => { setSheet(false); go({ name: "add", kind }); }} />}
  </div>;
}

/**
 * Switching from the header: the open wallet's accounts (all from one recovery phrase: add, switch, rename, hide), then the other
 * wallets on this device, then a new wallet or an imported phrase.
 */
function AccountsSheet({ snap, onClose, onChanged, onAdd }: { snap: wallet.WalletSnapshot; onClose: () => void; onChanged: () => void; onAdd: (kind: "create" | "import") => void }) {
  const active = snap.accounts.find(a => a.id === snap.activeId)!;
  const [editing, setEditing] = useState(false), [showHidden, setShowHidden] = useState(false);
  const [names, setNames] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const run = async (text: string, action: () => Promise<unknown>, close = true) => {
    setBusy(text); setError("");
    try { await action(); onChanged(); if (close) onClose(); } catch (e) { setError(message(e)); } finally { setBusy(""); }
  };
  const visible = active.accounts.filter(a => showHidden || !a.hidden || a.index === active.selected);
  const hiddenCount = active.accounts.filter(a => a.hidden).length;
  const others = snap.accounts.filter(w => w.id !== active.id);
  return <>
    <div className="scrim" onClick={onClose} />
    <section className="sheet" role="dialog" aria-label="Accounts">
      <div className="grab" />
      <div className="sheet-head"><h2>{active.label}</h2><button type="button" className="chip" onClick={() => setEditing(e => !e)}>{editing ? "Done" : "Edit"}</button></div>
      <div style={{ overflowY: "auto", padding: "0 12px" }}>
        {busy && <Busy text={busy} />}
        {error && <div className="alert danger" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
        <div className="card rows">{visible.map(a => editing
          ? <div key={a.index} className="row">
            <Avatar account={asAccount(active, a.index)} />
            <input className="main" style={{ background: "var(--surface-2)", border: "1px solid var(--line-strong)", borderRadius: 10, padding: "8px 10px", fontSize: 14, fontWeight: 600 }} value={names[a.index] ?? a.label} maxLength={32} aria-label="Account name"
              onChange={e => setNames(n => ({ ...n, [a.index]: e.target.value }))} onBlur={() => { const next = names[a.index]; if (next !== undefined && next !== a.label) void run("Saving…", () => wallet.renameAccount(a.index, next), false); }} />
            {a.index !== 0 && a.index !== active.selected && <button type="button" className="chip" onClick={() => void run("Saving…", () => wallet.hideAccount(a.index, !a.hidden), false)}>{a.hidden ? "Show" : "Hide"}</button>}
          </div>
          : <button type="button" key={a.index} className="row" style={{ width: "100%", textAlign: "left", opacity: a.hidden ? .55 : 1 }} onClick={() => a.index === active.selected ? onClose() : void run("Opening account…", () => wallet.selectAccount(a.index))}>
            <Avatar account={asAccount(active, a.index)} large />
            <div className="main"><b>{a.label}</b><small className="num">{short(a.evm)} · {short(a.solana)}</small></div>
            <div className="end">{a.index === active.selected ? <small style={{ color: "var(--positive)" }}><Check size={13} style={{ verticalAlign: -2 }} /> Open</small> : a.hidden ? <small>Hidden</small> : null}</div>
          </button>)}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 2px" }}>
          <button type="button" className="link-btn" style={{ fontSize: 12 }} disabled={!!busy} onClick={() => void run("Adding an account…", () => wallet.addAccount())}>+ New account from this phrase</button>
          {hiddenCount > 0 && <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => setShowHidden(s => !s)}>{showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}</button>}
        </div>
        {others.length > 0 && <><div className="section-head"><h2>Other wallets on this device</h2></div>
          <div className="card rows">{others.map(w => <button type="button" key={w.id} className="row" style={{ width: "100%", textAlign: "left" }} onClick={() => void run("Opening wallet…", () => wallet.select(w.id))}>
            <Avatar account={asAccount(w)} large />
            <div className="main"><b>{w.label}</b><small className="num">{w.accounts.length} account{w.accounts.length === 1 ? "" : "s"} · {short(w.evm)}</small></div>
            <div className="end"><small>{w.backedUp ? "" : "Not backed up"}</small></div>
          </button>)}</div></>}
      </div>
      <div className="footer" style={{ flexDirection: "row" }}>
        <button type="button" className="btn secondary" onClick={() => onAdd("create")}><Plus size={17} />New wallet</button>
        <button type="button" className="btn secondary" onClick={() => onAdd("import")}><Download size={17} />Import</button>
      </div>
    </section>
  </>;
}

function Receive({ account, onBack, toast }: { account: wallet.WalletSnapshot["accounts"][number]; onBack: () => void; toast: (t: string) => void }) {
  const rows = [{ label: "EVM (Ethereum, Base, Arbitrum and every EVM chain)", value: account.evm }, { label: "Solana", value: account.solana }];
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Receive" onBack={onBack} />
    <div className="scroll stack">
      <p className="ask-sub" style={{ margin: "0 2px" }}>Send only to the matching network. One EVM address works on every EVM chain.</p>
      {rows.map(r => <div key={r.label} className="card" style={{ padding: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", marginBottom: 6 }}>{r.label}</div>
        <div className="addr" style={{ fontSize: 14 }}>{r.value}</div>
        <button type="button" className="btn secondary" style={{ marginTop: 10, height: 40 }} onClick={async () => { await copy(r.value); toast("Address copied"); }}><Copy size={15} />Copy address</button>
      </div>)}
    </div>
  </div>;
}

function ActivityView({ onTab }: { onTab: (t: DockTab) => void }) {
  const [items, setItems] = useState<Activity[] | null>(null);
  useEffect(() => { void activityLog.all().then(setItems); }, []);
  const icon = (kind: Activity["kind"]) => kind === "export" ? <KeyRound size={16} /> : kind === "blocked" ? <AlertTriangle size={16} /> : kind === "lock" ? <Lock size={16} /> : kind === "send" ? <ArrowUpRight size={16} /> : <Globe size={16} />;
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Activity" />
    <div className="scroll">
      {!items ? <Busy text="Loading…" /> : !items.length ? <div className="card empty">Connections, signatures, sends, locks and exports show up here. They stay on this device.</div>
        : <div className="card rows">{items.map((a, i) => <div key={i} className="row">
          <span className="token"><span className="logo" style={{ background: a.kind === "export" || a.kind === "blocked" ? "var(--negative-soft)" : "var(--surface-3)", color: a.kind === "export" || a.kind === "blocked" ? "var(--negative)" : "var(--text-2)" }}>{icon(a.kind)}</span></span>
          <div className="main"><b>{a.text}</b><small>{a.site ? `${a.site.replace(/^https?:\/\//, "")} · ` : ""}{new Date(a.at).toLocaleString()}</small></div>
        </div>)}</div>}
    </div>
    <Dock tab="activity" onTab={onTab} />
  </div>;
}

function SettingsView({ snap, mode, go, onTab, toast, onChanged }: { snap: wallet.WalletSnapshot; mode: "popup" | "panel" | "tab"; go: (v: View) => void; onTab: (t: DockTab) => void; toast: (t: string) => void; onChanged: () => void }) {
  const [prefs, setPrefs] = useState<Settings | null>(null);
  const [connected, setConnected] = useState<SitePermission[]>([]);
  useEffect(() => { void settingsStore.read().then(setPrefs); void siteStore.all().then(setConnected); }, []);
  const save = async (patch: Partial<Settings>) => { await settingsStore.write(patch); setPrefs(await settingsStore.read()); };
  const item = (icon: React.ReactNode, label: string, onClick: () => void, danger = false) => <button type="button" className="row" style={{ width: "100%", textAlign: "left", minHeight: 52 }} onClick={onClick}>
    <span style={{ color: danger ? "var(--negative)" : "var(--text-2)", display: "grid" }}>{icon}</span><div className="main"><b style={{ color: danger ? "var(--negative)" : undefined }}>{label}</b></div><ChevronRight size={16} style={{ color: "var(--dim)" }} />
  </button>;
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Settings" />
    <div className="scroll">
      <div className="section-head" style={{ marginTop: 4 }}><h2>View</h2></div>
      <div className="card rows">
        {mode !== "panel" && item(<PanelRight size={18} />, "Open in the side panel", async () => {
          try { const win = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: win.id! }); if (mode === "popup") window.close(); }
          catch { toast("This browser has no side panel. Use the full tab instead."); }
        })}
        {mode !== "tab" && item(<Maximize2 size={18} />, "Open in a full tab", () => { void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=tab") }); if (mode === "popup") window.close(); })}
      </div>
      <div className="section-head"><h2>Security</h2></div>
      <div className="card" style={{ padding: "12px 12px 14px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Lock automatically after</div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 10 }}>Without use, the wallet locks and only your PIN opens it again.</div>
        <div className="seg">{AUTO_LOCK_CHOICES.map(m => <button key={m} type="button" className={prefs?.autoLockMinutes === m ? "on" : ""} onClick={() => void save({ autoLockMinutes: m })}>{m < 60 ? `${m} min` : `${m / 60} h`}</button>)}</div>
      </div>
      <div className="card rows" style={{ marginTop: 8 }}>
        {item(<KeyRound size={18} />, "Show recovery phrase", () => go({ name: "export", kind: "phrase" }))}
        {item(<KeyRound size={18} />, "Export private keys", () => go({ name: "export", kind: "keys" }))}
        {item(<Lock size={18} />, "Lock now", async () => { await wallet.lock(); onChanged(); })}
      </div>
      <div className="section-head"><h2>Networks</h2></div>
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: 12 }}>
        <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600 }}>Show test networks</div><div style={{ fontSize: 12, color: "var(--muted)" }}>Sepolia, Base Sepolia, Solana Devnet and others.</div></div>
        <button type="button" role="switch" aria-checked={!!prefs?.showTestnets} className={`toggle${prefs?.showTestnets ? " on" : ""}`} onClick={() => void save({ showTestnets: !prefs?.showTestnets })} />
      </div>
      <div className="section-head"><h2>Connected sites</h2><span style={{ fontSize: 12, color: "var(--muted)" }}>{connected.length}</span></div>
      {connected.length === 0 ? <div className="card empty" style={{ padding: 16 }}>No site is connected. Sites ask first, and you choose.</div>
        : <div className="card rows">{connected.map(s => <div key={s.origin} className="row">
          <span className="favicon" style={{ width: 32, height: 32, borderRadius: 9, background: "var(--surface-3)", display: "grid", placeItems: "center", fontWeight: 700 }}>{new URL(s.origin).hostname[0]!.toUpperCase()}</span>
          <div className="main"><b>{new URL(s.origin).host}</b><small className="num">{short(s.evm)} · since {new Date(s.connectedAt).toLocaleDateString()}</small></div>
          <button type="button" className="chip" onClick={async () => { await siteStore.revoke(s.origin); await activityLog.add({ kind: "revoke", text: "Disconnected a site", site: s.origin }); await wallet.announce(); setConnected(await siteStore.all()); toast("Disconnected"); }}>Disconnect</button>
        </div>)}</div>}
      <div className="section-head"><h2>Wallet</h2></div>
      <div className="card rows">
        {item(<LogOut size={18} />, "Remove this wallet from this device", () => go({ name: "remove" }), true)}
      </div>
      <p style={{ fontSize: 11.5, color: "var(--dim)", textAlign: "center", margin: "16px 0 4px", lineHeight: 1.5 }}>MAXXING Wallet {chrome.runtime.getManifest().version} · {snap.accounts.length} wallet{snap.accounts.length === 1 ? "" : "s"} on this device<br />Your keys stay on this device. MAXXING never has them.</p>
    </div>
    <Dock tab="settings" onTab={onTab} />
  </div>;
}

/** Removing a wallet: only once it's backed up, after the same warning and the PIN. */
function RemoveWallet({ backedUp, onClose, onRemoved }: { backedUp: boolean; onClose: () => void; onRemoved: () => void }) {
  const [sure, setSure] = useState(false);
  const [error, setError] = useState(""), [waitUntil, setWaitUntil] = useState(wallet.pinWaitUntil());
  return <div className="popup"><div className="backdrop" style={{ background: "radial-gradient(120% 50% at 50% -10%, rgb(225 93 85 / .14), transparent 60%)" }} />
    <PageHead title="Remove wallet" onBack={onClose} />
    <div className="scroll" style={{ paddingBottom: 130 }}>
      {!backedUp ? <><div className="danger-mark"><Trash2 size={28} /></div><h2 className="center-title">Back up first</h2><p className="center-sub">This wallet isn't backed up. Removing it now would lose it for good. Show your recovery phrase and write it down first.</p></>
        : !sure ? <><div className="danger-mark"><Trash2 size={28} /></div><h2 className="center-title">Remove from this device?</h2><p className="center-sub">Its keys are deleted from this browser. You can restore it any time with your recovery phrase, on any device. Without the phrase, it's gone.</p>
          <div className="checks"><button type="button" className="check" onClick={() => setSure(true)}><span className="box" /><span>I have my recovery phrase written down, and I understand this removes the wallet here.</span></button></div></>
          : <PinPad title="Enter your PIN" subtitle="To remove this wallet from this device." error={error} waitUntil={waitUntil} onComplete={async pin => {
            try { await wallet.remove(pin); onRemoved(); } catch (e) { setError(message(e)); setWaitUntil(wallet.pinWaitUntil()); }
          }} />}
    </div>
    {!sure && <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><button type="button" className="btn secondary" onClick={onClose}>Keep it</button></div>}
  </div>;
}
