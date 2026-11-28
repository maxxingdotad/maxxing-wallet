import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, DollarSign, FlaskConical, KeySquare, Pencil, ScrollText, Settings as SettingsIcon, Timer, UserPlus } from "lucide-react";
import { AlertTriangle, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, Code2, ExternalLink, Eye, EyeOff, Globe, KeyRound, LifeBuoy, Lock, LogOut, Maximize2, PanelRight, Plus, RefreshCw, ShieldCheck, Trash2, Download } from "lucide-react";
import { ActionDisc, Avatar, ChainDot, Dock, Orbit, TokenMark, short, usd, type Account, type DockTab, type Holding } from "../ui/parts";
import { Busy, PageHead, PasswordForm, copy, message, useEscape, useToast } from "./kit";
import { Onboarding } from "./Onboarding";
import { StartOver } from "./StartOver";
import { BrandCap, BrandMark } from "../ui/screens/Welcome";
import { Metal } from "../ui/metal";
import { ExportFlow } from "./Export";
import { SendView } from "./Send";
import { SwapView } from "./Swap";
import * as wallet from "../lib/wallet";
import { lastPortfolio, portfolio as readPortfolio, shownNetworks, type Portfolio } from "../lib/balances";
import { AssetList, ManageAssets, NetworkButton, NetworkSheet } from "./Assets";
import { ReceiveView } from "./Receive";
import { TokenDetail } from "./TokenDetail";
import { ActivityView } from "./Activity";
import { ConnectedSites } from "./Sites";
import { ApprovalsView } from "./Approvals";
import { ChangePassword } from "./Security";
import { AddNetwork, NetworkDetail, NetworksView } from "./Networks";
import { Network as NetworkIcon } from "lucide-react";
import { LINKS, listNames, t } from "../lib/strings";
import { networks } from "../lib/chains";
import { NO_PREFS, type AssetPrefs } from "../lib/assets";
import { assetPrefs as assetPrefsStore, AUTO_LOCK_CHOICES, settings as settingsStore, sites as siteStore, type Settings, type SitePermission } from "../lib/store";

const COLORS = ["#E8E4DC", "#A36AFF", "#3CB07A", "#D4B15A", "#4FB4F7", "#E15D55", "#C4C6CC"];
const colorFor = (id: string) => COLORS[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length]!;
type WalletSummary = wallet.WalletSnapshot["accounts"][number];
/** The wallet's open account, as the header and lists show it: its own name and color. */
const selectedAccount = (w: WalletSummary) => w.accounts.find(x => x.index === w.selected) ?? w.accounts[0]!;
const asAccount = (w: WalletSummary, index = w.selected, value = 0): Account => {
  const x = w.accounts.find(a => a.index === index) ?? selectedAccount(w);
  return { id: `${w.id}:${x.index}`, name: x.label, color: colorFor(`${w.id}:${x.index}`), evm: x.evm, solana: x.solana, usd: value };
};
/** A bubble's short mark: "Account 176" → "A176", "Main" → "M", "Trading Desk" → "TD" (so many accounts stay tellable apart). */
const bubbleMark = (label: string) => {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const digits = label.match(/\d+$/)?.[0] ?? "";
  const letters = words.filter(w => !/^\d+$/.test(w)).slice(0, digits ? 1 : 2).map(w => [...w][0]!.toUpperCase()).join("");
  return (letters + digits).slice(0, 4) || "?";
};
function Bubble({ w, index }: { w: WalletSummary; index?: number }) {
  const a = asAccount(w, index);
  const mark = bubbleMark(a.name);
  return <span className={`rail-bubble${mark.length > 3 ? " small" : ""}`} style={{ ["--c" as string]: a.color }}><Metal />{mark}</span>;
}

type View = { name: "home" } | { name: "old-wallets" } | { name: "manage-assets" } | { name: "token"; holding: Holding; all: Holding[] } | { name: "send"; holding?: Holding } | { name: "receive" } | { name: "swap" } | { name: "activity" } | { name: "settings" } | { name: "export"; kind: "phrase" | "keys" } | { name: "add"; kind: "create" | "import" } | { name: "remove" } | { name: "sites" } | { name: "approvals" } | { name: "change-password" } | { name: "networks" } | { name: "network"; networkId: string } | { name: "add-network" };

export function App({ mode }: { mode: "popup" | "panel" | "tab" }) {
  const [snap, setSnap] = useState<wallet.WalletSnapshot | null>(null);
  const [view, setView] = useState<View>({ name: "home" });
  // Onboarding stays on screen until the user finishes it (backup included), even though the wallet exists from its second step.
  const [onboarding, setOnboarding] = useState(false);
  // "Forgot password?" on the lock screen leads here: starting over with a recovery phrase.
  const [startingOver, setStartingOver] = useState(false);
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
  // A wallet from before the one password: its old PIN once (after the password, if the extension is locked), then never again.
  const oldOnes = wallet.needingOldPin();
  if (!snap.unlocked && oldOnes.some(w => w.id === snap.activeId)) return frame(<OldWallet wallet={oldOnes.find(w => w.id === snap.activeId)!} others={oldOnes.length - 1} onDone={refresh} />);
  if (view.name === "old-wallets" && oldOnes.length) return frame(<OldWallet wallet={oldOnes[0]!} others={oldOnes.length - 1} onDone={() => { refresh(); if (oldOnes.length <= 1) setView({ name: "home" }); }} onBack={() => setView({ name: "home" })} />);
  if (!snap.unlocked && startingOver) return frame(<StartOver snap={snap} onBack={() => setStartingOver(false)} onDone={() => { setStartingOver(false); setView({ name: "home" }); refresh(); }} />);
  if (!snap.unlocked) return frame(<Unlock snap={snap} onOpen={refresh} onImport={() => setView({ name: "add", kind: "import" })} onStartOver={() => setStartingOver(true)} />);
  const active = snap.accounts.find(a => a.id === snap.activeId)!;
  const go = (next: View) => setView(next);
  const onTab = (tab: DockTab) => go(tab === "home" ? { name: "home" } : tab === "swap" ? { name: "swap" } : tab === "activity" ? { name: "activity" } : { name: "settings" });

  switch (view.name) {
    case "manage-assets": return frame(<ManageAssetsLoader account={active} onBack={() => go({ name: "home" })} />);
    case "token": return frame(<TokenDetail holding={view.holding} all={view.all} onBack={() => go({ name: "home" })} onSend={h => go({ name: "send", holding: h })} onReceive={() => go({ name: "receive" })} onSwap={() => go({ name: "swap" })} />);
    case "send": return frame(<SendView holding={view.holding} account={active} onBack={() => go({ name: "home" })} toast={showToast} />);
    case "receive": return frame(<ReceiveView account={active} onBack={() => go({ name: "home" })} toast={showToast} />);
    case "swap": return frame(<SwapView account={active} onTab={onTab} toast={showToast} />);
    case "activity": return frame(<ActivityView account={{ evm: active.evm, solana: active.solana }} onTab={onTab} />);
    case "settings": return frame(<SettingsView snap={snap} mode={mode} go={go} onTab={onTab} toast={showToast} onChanged={refresh} />);
    case "export": return frame(<ExportFlow kind={view.kind} onClose={() => go({ name: "settings" })} />);
    case "networks": return frame(<NetworksView onBack={() => go({ name: "settings" })} onOpen={networkId => go({ name: "network", networkId })} onAdd={() => go({ name: "add-network" })} />);
    case "network": return frame(<NetworkDetail networkId={view.networkId} onBack={() => go({ name: "networks" })} toast={showToast} />);
    case "add-network": return frame(<AddNetwork onBack={() => go({ name: "networks" })} onAdded={networkId => go({ name: "network", networkId })} toast={showToast} />);
    case "change-password": return frame(<ChangePassword onDone={() => go({ name: "settings" })} toast={showToast} />);
    case "sites": return frame(<ConnectedSites snap={snap} onBack={() => go({ name: "settings" })} toast={showToast} />);
    case "approvals": return frame(<ApprovalsView account={{ evm: active.evm }} onBack={() => go({ name: "settings" })} toast={showToast} />);
    case "remove": return frame(<RemoveWallet backedUp={active.backedUp} onClose={() => go({ name: "settings" })} onRemoved={() => { refresh(); go({ name: "home" }); }} />);
    default: return frame(<HomeView snap={snap} active={active} go={go} onTab={onTab} onChanged={refresh} toast={showToast} />);
  }
}

/** Manage assets for the networks shown now, with what's held there. */
function ManageAssetsLoader({ account, onBack }: { account: WalletSummary; onBack: () => void }) {
  const [data, setData] = useState<{ shown: ReturnType<typeof shownNetworks>; holdings: Holding[] } | null>(null);
  useEffect(() => { void settingsStore.read().then(async s => setData({ shown: shownNetworks(s.showTestnets, s.network), holdings: (await readPortfolio({ evm: account.evm, solana: account.solana }, s.showTestnets, s.network)).holdings })); }, [account.evm]);
  if (!data) return <div className="popup"><div className="backdrop" /><PageHead title="Manage assets" onBack={onBack} /><SkeletonRows count={5} /></div>;
  return <ManageAssets shown={data.shown} holdings={data.holdings} onBack={onBack} />;
}

/** Placeholder rows while balances load: the list's shape, gently pulsing. */
function SkeletonRows({ count }: { count: number }) {
  return <div className="card rows" aria-busy="true" aria-label="Loading">{Array.from({ length: count }, (_, i) => <div key={i} className="row skeleton-row"><span className="sk sk-circle" /><div className="main"><span className="sk sk-line" /><span className="sk sk-line short" /></div><span className="sk sk-amount" /></div>)}</div>;
}

/**
 * The lock screen: the MAXXING hat, one password field, Unlock. A wrong try shows under the field and the next can be made at once.
 * "Forgot password" explains that the password only protects this device and that starting over means restoring with the
 * recovery phrase, warning first about any wallet that isn't backed up.
 */
function Unlock({ snap, onOpen, onImport, onStartOver }: { snap: wallet.WalletSnapshot; onOpen: () => void; onImport: () => void; onStartOver: () => void }) {
  const [error, setError] = useState(""), [waitUntil, setWaitUntil] = useState(wallet.pinWaitUntil());
  const [forgot, setForgot] = useState(false);
  const notBackedUp = snap.accounts.filter(a => !a.backedUp);
  return <div className="popup unlock brand-screen" data-testid="unlock">
    <BrandCap className="unlock-cap" />
    <div className="scroll">
      <BrandMark />
      <h2 className="sr-only">Unlock MAXXING Wallet</h2>
      <PasswordForm submitLabel="Unlock" error={error} waitUntil={waitUntil} onComplete={async password => {
        try { setError(""); await wallet.unlock(password); onOpen(); }
        catch (e) { if ((e as { code?: string }).code === "WALLET_NEEDS_OLD_PIN") { onOpen(); return; } setError(message(e)); setWaitUntil(wallet.pinWaitUntil()); }
      }} />
      <div className="unlock-foot"><button type="button" className="link-btn" aria-expanded={forgot} onClick={() => setForgot(f => !f)}>Forgot password?</button></div>
      {forgot && <div className="card unlock-forgot" data-testid="forgot-password">
        {notBackedUp.length > 0 && <div className="alert danger" style={{ marginBottom: 10 }}><AlertTriangle size={16} /><span>
          <b>{notBackedUp.length === 1 ? `${notBackedUp[0]!.label} isn't backed up.` : `${notBackedUp.length} wallets aren't backed up.`}</b> Starting over without {notBackedUp.length === 1 ? "its" : "their"} recovery phrase loses {notBackedUp.length === 1 ? "it" : "them"} for good. Keep trying to remember your password first.</span></div>}
        <p>Your password only protects MAXXING Wallet on this device. MAXXING never has it, so it can't be reset or sent to you.</p>
        <p>To get back in, start over with your recovery phrase: the wallets on this device are erased, the phrase brings its wallet back, and you choose a new password. Your funds stay on the blockchain.</p>
        {wallet.passwordSet()
          ? <button type="button" className="btn secondary" data-testid="start-over-open" onClick={onStartOver}>Start over with recovery phrase</button>
          : <button type="button" className="link-btn" style={{ fontSize: 12.5 }} onClick={onImport}>Restore with a recovery phrase</button>}
      </div>}
    </div>
  </div>;
}

/**
 * A wallet from before the one password: it still has its own PIN. Entered once, the wallet moves behind the password (its key is
 * checked against its addresses before anything changes) and never asks for it again.
 */
function OldWallet({ wallet: w, others, onDone, onBack }: { wallet: { id: string; label: string; evm: string }; others: number; onDone: () => void; onBack?: () => void }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { void wallet.passwordOpen().then(setOpen); }, [w.id]);
  if (open === null || busy) return <div className="popup"><div className="backdrop" /><Busy text={busy ? "Adding it to your password…" : "Opening…"} /></div>;
  return <div className="popup"><div className="backdrop" />
    {onBack && <PageHead title="Older wallets" onBack={onBack} />}
    <div className="scroll" style={{ paddingTop: onBack ? 4 : 22 }}>
      <div className="card" style={{ padding: 12, marginBottom: 6, fontSize: 12.5, lineHeight: 1.5 }} data-testid="old-wallet">
        <b style={{ display: "block", fontSize: 13.5, marginBottom: 2 }}>{w.label} · {short(w.evm)}</b>
        {open ? `This wallet was made before MAXXING Wallet used one password. Enter its old PIN once; after that your password opens it.${others ? ` ${others} more wallet${others === 1 ? "" : "s"} like it.` : ""}` : "Enter your password first."}
      </div>
      {open
        ? <PasswordForm key="old" title="Its old PIN" label="Old PIN" submitLabel="Add to my password" error={error} waitUntil={wallet.vault.pinWaitUntil(w.id)} onComplete={async pin => {
            setBusy(true); setError("");
            try { await wallet.addOldWallet(w.id, pin); onDone(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } // here it really is the old PIN
          }} />
        : <PasswordForm key="password" title="Enter your password" submitLabel="Unlock" error={error} waitUntil={wallet.pinWaitUntil()} onComplete={async pin => {
            try { setError(""); await wallet.unlock(pin); onDone(); setOpen(true); }
            catch (e) { if ((e as { code?: string }).code === "WALLET_NEEDS_OLD_PIN") { setOpen(true); return; } setError(message(e)); }
          }} />}
    </div>
  </div>;
}

function HomeView({ snap, active, go, onTab, onChanged, toast }: { snap: wallet.WalletSnapshot; active: wallet.WalletSnapshot["accounts"][number]; go: (v: View) => void; onTab: (t: DockTab) => void; onChanged: () => void; toast: (t: string) => void }) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [sheet, setSheet] = useState(false), [rail, setRail] = useState(false);
  const [prefs, setPrefs] = useState<Settings | null>(null);
  const [assetChoices, setAssetChoices] = useState<AssetPrefs>(NO_PREFS);
  const [picking, setPicking] = useState(false);
  const [offerPassword, setOfferPassword] = useState(false);
  useEffect(() => { void wallet.newPasswordOffered().then(setOfferPassword); }, []);
  /**
   * The last reading shows at once (even an old one), and the networks are read again behind it unless it is fresh. `force`
   * (the refresh button) always reads. The request counter drops an answer that belongs to an account or network left since.
   */
  const asked = useRef(0);
  const load = useCallback(async (force = false) => {
    const mine = ++asked.current;
    setLoading(true);
    try {
      const s = await settingsStore.read(); setPrefs(s);
      setAssetChoices(await assetPrefsStore.read());
      const who = { evm: active.evm, solana: active.solana };
      const last = await lastPortfolio(who, s.showTestnets, s.network);
      if (mine !== asked.current) return;
      setPortfolio(last?.portfolio ?? null);
      const fresh = await readPortfolio(who, s.showTestnets, s.network, force);
      if (mine === asked.current) setPortfolio(fresh);
    } finally { if (mine === asked.current) setLoading(false); }
  }, [active.evm, active.solana]);
  useEffect(() => { void load(); }, [load]);
  const shown = prefs ? shownNetworks(prefs.showTestnets, prefs.network) : [];
  const holdings = portfolio?.holdings ?? [];
  const byChain = new Map<string, { chain: Holding["chain"]; usd: number }>();
  for (const h of holdings) byChain.set(h.chain.id, { chain: h.chain, usd: (byChain.get(h.chain.id)?.usd ?? 0) + h.usd });
  return <div className="popup">
    <div className="backdrop" />
    <header className="top">
      <button type="button" className="account-pill" onClick={() => setRail(true)} aria-label={`Switch account (now ${selectedAccount(active).label})`} title={selectedAccount(active).label}><Avatar account={asAccount(active)} /><b>{selectedAccount(active).label}</b><ChevronDown size={16} /></button>
      <div className="top-right">
        <NetworkButton selected={prefs?.network ?? "all"} onOpen={() => setPicking(true)} />
        <button type="button" className="icon-btn" aria-label={prefs?.hideBalances ? "Show balances" : "Hide balances"} aria-pressed={!!prefs?.hideBalances}
          onClick={async () => { await settingsStore.write({ hideBalances: !prefs?.hideBalances }); setPrefs(await settingsStore.read()); }}>{prefs?.hideBalances ? <EyeOff size={17} strokeWidth={1.7} /> : <Eye size={17} strokeWidth={1.7} />}</button>
        <button type="button" className="icon-btn" aria-label="Refresh" onClick={() => void load(true)}><RefreshCw size={17} strokeWidth={1.7} className={loading ? "spinning" : ""} /></button>
      </div>
    </header>
    <div className="scroll">
      <Orbit hidden={!!prefs?.hideBalances} total={portfolio?.totalUsd ?? 0} change={null} shares={[...byChain.values()]} note={!portfolio ? "Reading your balances…" : portfolio.source === "chain" ? "USD shown for stablecoins" : undefined} />
      <div className="actions">
        <button type="button" className="action" onClick={() => go({ name: "send" })}><ActionDisc><ArrowUpRight size={18} /></ActionDisc>Send</button>
        <button type="button" className="action" onClick={() => go({ name: "receive" })}><ActionDisc><ArrowDownLeft size={18} /></ActionDisc>Receive</button>
        <button type="button" className="action" onClick={() => go({ name: "swap" })}><ActionDisc><ArrowLeftRight size={18} /></ActionDisc>Swap</button>
        <button type="button" className="action" onClick={() => void chrome.tabs.create({ url: "https://maxxing.ad" })}><ActionDisc><Plus size={18} /></ActionDisc>Buy</button>
      </div>
      {wallet.needingOldPin().length > 0 && <div className="alert warn" style={{ marginBottom: 10 }}><KeyRound size={16} /><span><b>{wallet.needingOldPin().length === 1 ? "An older wallet still has" : `${wallet.needingOldPin().length} older wallets still have`} its own PIN.</b> Enter it once and your password opens it from then on. <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => go({ name: "old-wallets" })}>Add to my password</button></span></div>}
      {offerPassword && <div className="alert" style={{ marginBottom: 10, background: "var(--surface-2)", border: "1px solid var(--line)" }} data-testid="offer-new-password"><KeyRound size={16} /><span>
        <b>Use one password for everything.</b> Your wallets now open with one password: the PIN you just entered. You can choose a new one now (optional). <span style={{ display: "inline-flex", gap: 12 }}>
          <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => go({ name: "change-password" })}>Choose a new password</button>
          <button type="button" className="link-btn" style={{ fontSize: 12, color: "var(--muted)" }} onClick={async () => { await wallet.dismissNewPasswordOffer(); setOfferPassword(false); }}>Keep it</button></span></span></div>}
      {!active.backedUp && <button type="button" className="nudge" onClick={() => go({ name: "export", kind: "phrase" })}><ShieldCheck size={17} /><span><b>Back up your recovery phrase</b>Your only way back in.</span><i>Back up</i></button>}
      <div className="section-head"><h2>Tokens</h2>{portfolio && <button type="button" onClick={() => void load(true)}>{portfolio.source === "api" ? "Live from MAXXING" : "Read from the networks"}</button>}</div>
      {/* Only when every endpoint of some network failed after retries: one quiet line, never a list of network names. */}
      {portfolio?.errors.length ? <div className="stale-note" role="status" data-testid="stale-note">
        <span>Some balances may be out of date</span>
        <button type="button" className="link-btn" disabled={loading} onClick={() => void load(true)}>{loading ? "Retrying…" : "Retry"}</button>
      </div> : null}
      {!prefs ? <SkeletonRows count={4} /> : <AssetList shown={shown} holdings={holdings} prefs={assetChoices} pending={!portfolio} hideBalances={!!prefs?.hideBalances}
        onOpen={h => go({ name: "token", holding: h, all: holdings })} onManage={() => go({ name: "manage-assets" })}
        onShowSpam={async () => { await assetPrefsStore.update(p => ({ ...p, showSpam: true })); setAssetChoices(await assetPrefsStore.read()); }} />}
      {portfolio && holdings.length === 0 && <p className="empty-hint">Nothing held yet. <button type="button" className="link-btn" onClick={() => go({ name: "receive" })}>Receive</button> on any network to see it here.</p>}
    </div>
    {picking && prefs && <NetworkSheet selected={prefs.network} showTestnets={prefs.showTestnets} onClose={() => setPicking(false)}
      onPick={async networkId => { setPicking(false); await settingsStore.write({ network: networkId }); void load(); }} />}
    <Dock tab="home" onTab={onTab} />
    {rail && <AccountRail snap={snap} onClose={() => setRail(false)} onChanged={onChanged} onManage={() => { setRail(false); setSheet(true); }} onSettings={() => { setRail(false); onTab("settings"); }}
      onAdd={kind => { setRail(false); go({ name: "add", kind }); }}
      onSwitched={(label, evm) => void siteStore.all().then(all => { const others = all.filter(s => s.evm.toLowerCase() !== evm.toLowerCase()).length; toast(others ? `${label} is open. ${others} connected site${others === 1 ? "" : "s"} still use${others === 1 ? "s" : ""} another account until you connect again.` : `${label} is open.`); })} />}
    {sheet && <AccountsSheet snap={snap} onClose={() => setSheet(false)} onChanged={onChanged} onAdd={kind => { setSheet(false); go({ name: "add", kind }); }}
      onSwitched={(label, evm) => void siteStore.all().then(all => { const others = all.filter(s => s.evm.toLowerCase() !== evm.toLowerCase()).length; toast(others ? `${label} is open. ${others} connected site${others === 1 ? "" : "s"} still use${others === 1 ? "s" : ""} another account until you connect again.` : `${label} is open.`); })} />}
  </div>;
}

/**
 * The account drawer, from the left: every account of the open wallet as a bubble you tap to open, then the other wallets on
 * this device, and at the bottom add (an account, a wallet, an import), edit (names, hiding, balances, copying: the full sheet)
 * and settings. On liquid glass, so the home screen stays in view behind it.
 */
function AccountRail({ snap, onClose, onChanged, onManage, onSettings, onAdd, onSwitched }: {
  snap: wallet.WalletSnapshot; onClose: () => void; onChanged: () => void; onManage: () => void; onSettings: () => void;
  onAdd: (kind: "create" | "import") => void; onSwitched: (label: string, evm: string) => void;
}) {
  const active = snap.accounts.find(a => a.id === snap.activeId)!;
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const close = () => { setLeaving(true); setTimeout(onClose, 180); };
  useEscape(close);
  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError("");
    try { await action(); onChanged(); after?.(); close(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  const visible = active.accounts.filter(a => !a.hidden || a.index === active.selected);
  const others = snap.accounts.filter(w => w.id !== active.id);
  // The open account is scrolled into view when the drawer opens (a wallet can hold many).
  const openRef = useCallback((el: HTMLButtonElement | null) => { el?.scrollIntoView({ block: "nearest" }); }, []);
  return <>
    <div className={`scrim rail-scrim${leaving ? " leaving" : ""}`} onClick={close} />
    <nav className={`rail glass${leaving ? " leaving" : ""}`} aria-label="Accounts" data-testid="account-rail">
      <button type="button" className="rail-back" aria-label="Close accounts" onClick={close}><ArrowLeft size={20} /></button>
      <div className="rail-list">
        {visible.map(a => {
          const open = a.index === active.selected;
          return <button key={a.index} type="button" ref={open ? openRef : undefined} className={`rail-item${open ? " on" : ""}`} disabled={busy} aria-current={open ? "true" : undefined}
            aria-label={open ? `${a.label} (open)` : `Open ${a.label}`} title={`${a.label} · ${short(a.evm)}`}
            onClick={() => open ? close() : void run(() => wallet.selectAccount(a.index), () => onSwitched(a.label, a.evm))}>
            <Bubble w={active} index={a.index} />
            <small>{a.label}</small>
          </button>;
        })}
        {others.length > 0 && <div className="rail-divider" />}
        {others.map(w => <button key={w.id} type="button" className="rail-item" disabled={busy} aria-label={`Open wallet ${w.label}`} title={`${w.label} · ${w.accounts.length} account${w.accounts.length === 1 ? "" : "s"}`}
          onClick={() => void run(() => wallet.select(w.id))}>
          <Bubble w={w} />
          <small>{w.label}</small>
        </button>)}
      </div>
      {error && <p className="rail-error" role="alert">{error}</p>}
      <div className="rail-tools">
        <button type="button" className="rail-tool" aria-label="Add" aria-expanded={adding} onClick={() => setAdding(x => !x)}><Plus size={20} /></button>
        <button type="button" className="rail-tool" aria-label="Edit accounts" onClick={onManage}><Pencil size={18} /></button>
        <button type="button" className="rail-tool" aria-label="Settings" onClick={onSettings}><SettingsIcon size={19} /></button>
      </div>
      {adding && <div className="rail-menu glass" role="menu">
        <button type="button" role="menuitem" disabled={busy} onClick={() => void run(() => wallet.addAccount())}><UserPlus size={16} />New account<small>from this recovery phrase</small></button>
        <button type="button" role="menuitem" onClick={() => onAdd("create")}><Plus size={16} />New wallet<small>its own recovery phrase</small></button>
        <button type="button" role="menuitem" onClick={() => onAdd("import")}><Download size={16} />Import a wallet<small>with a recovery phrase</small></button>
      </div>}
    </nav>
  </>;
}

/**
 * Switching from the header: the open wallet's accounts (all from one recovery phrase: add, switch, rename, hide), then the other
 * wallets on this device, then a new wallet or an imported phrase.
 */
function AccountsSheet({ snap, onClose, onChanged, onAdd, onSwitched }: { snap: wallet.WalletSnapshot; onClose: () => void; onChanged: () => void; onAdd: (kind: "create" | "import") => void; onSwitched: (label: string, evm: string) => void }) {
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
  // Account totals. The open account's is read at once (the home screen reads it anyway); another account's only when the user
  // taps it, one at a time, so the wallet never looks up all its addresses together (which would tie them to each other).
  const [totals, setTotals] = useState<Record<string, number | null | "loading">>({});
  const loadTotal = (a: { evm: string; solana: string }) => {
    setTotals(t => ({ ...t, [a.evm]: "loading" }));
    void settingsStore.read().then(s => readPortfolio({ evm: a.evm, solana: a.solana }, s.showTestnets))
      // A total when everything held has a price (an empty account is $0.00); "—" when something held can't be priced yet.
      .then(p => setTotals(t => ({ ...t, [a.evm]: p.holdings.every(h => h.priced !== false || !h.raw || BigInt(h.raw) === 0n) ? p.totalUsd : null })), () => setTotals(t => ({ ...t, [a.evm]: null })));
  };
  const openEvm = active.accounts.find(a => a.index === active.selected)?.evm;
  useEffect(() => { const open = active.accounts.find(a => a.index === active.selected); if (open) loadTotal(open); }, [openEvm]);
  const [copied, setCopied] = useState("");
  const copyAddress = async (evm: string) => { await copy(evm); setCopied(evm); setTimeout(() => setCopied(""), 1500); };
  useEscape(onClose);
  return <>
    <div className="scrim" onClick={onClose} />
    <section className="sheet" role="dialog" aria-modal="true" aria-label="Accounts">
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
          : <div key={a.index} className="row" style={{ opacity: a.hidden ? .55 : 1 }}>
            <button type="button" className="row" style={{ flex: 1, textAlign: "left", padding: 0, background: "none", border: 0, minWidth: 0 }} aria-label={`Open ${a.label}`}
              onClick={() => a.index === active.selected ? onClose() : void run("Opening account…", async () => { await wallet.selectAccount(a.index); onSwitched(a.label, a.evm); })}>
              <Avatar account={asAccount(active, a.index)} large />
              <div className="main"><b>{a.label}</b><small className="num">{short(a.evm)} · {short(a.solana)}</small></div>
              <div className="end" style={{ textAlign: "right" }}>
                {totals[a.evm] !== undefined && <b className="num" style={{ fontSize: 13 }}>{totals[a.evm] === "loading" ? "…" : totals[a.evm] === null ? "—" : usd(totals[a.evm] as number)}</b>}
                {a.index === active.selected ? <small style={{ color: "var(--positive)", display: "block" }}><Check size={13} style={{ verticalAlign: -2 }} /> Open</small> : a.hidden ? <small style={{ display: "block" }}>Hidden</small> : null}
              </div>
            </button>
            {totals[a.evm] === undefined && <button type="button" className="chip" style={{ fontSize: 11, padding: "2px 8px" }} aria-label={`Show ${a.label}'s balance`} onClick={() => loadTotal(a)}>Balance</button>}
            <button type="button" className="icon-btn" aria-label={`Copy ${a.label}'s EVM address`} title="Copy EVM address" onClick={() => void copyAddress(a.evm)}>{copied === a.evm ? <Check size={15} /> : <Copy size={15} />}</button>
          </div>)}</div>
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


function SettingsView({ snap, mode, go, onTab, toast, onChanged }: { snap: wallet.WalletSnapshot; mode: "popup" | "panel" | "tab"; go: (v: View) => void; onTab: (t: DockTab) => void; toast: (t: string) => void; onChanged: () => void }) {
  const [prefs, setPrefs] = useState<Settings | null>(null);
  const [connected, setConnected] = useState<SitePermission[]>([]);
  useEffect(() => { void settingsStore.read().then(setPrefs); void siteStore.all().then(setConnected); }, []);
  const save = async (patch: Partial<Settings>) => { await settingsStore.write(patch); setPrefs(await settingsStore.read()); };
  const [lockPicker, setLockPicker] = useState(false);
  // One row shape for every setting: icon, label (with a short note when it needs one), and on the right its value, a switch,
  // or an arrow.
  const item = (icon: React.ReactNode, label: string, onClick: () => void, danger = false, value?: string, testId?: string) => <button type="button" className="row set-row" data-testid={testId} onClick={onClick}>
    <span className={`set-icon${danger ? " danger" : ""}`}>{icon}</span><div className="main"><b style={{ color: danger ? "var(--negative)" : undefined }}>{label}</b></div>
    {value && <span className="set-value">{value}</span>}<ChevronRight size={16} style={{ color: "var(--dim)" }} />
  </button>;
  const toggle = (icon: React.ReactNode, label: string, note: string, on: boolean, flip: () => void) => <div className="row set-row">
    <span className="set-icon">{icon}</span><div className="main"><b>{label}</b><small>{note}</small></div>
    <button type="button" role="switch" aria-label={label} aria-checked={on} className={`toggle${on ? " on" : ""}`} onClick={flip} />
  </div>;
  const link = (icon: React.ReactNode, label: string, url: string) => item(icon, label, () => void chrome.tabs.create({ url }));
  const lockLabel = (m: number, long = false) => m < 60 ? `${m} ${long ? (m === 1 ? "minute" : "minutes") : "min"}` : `${m / 60} ${long ? (m === 60 ? "hour" : "hours") : "h"}`;
  return <div className="popup"><div className="backdrop" />
    <PageHead title={t("settings.title")} />
    <div className="scroll">
      <div className="section-head" style={{ marginTop: 4 }}><h2>{t("settings.view")}</h2></div>
      <div className="card rows">
        {mode !== "panel" && item(<PanelRight size={18} />, "Open in the side panel", async () => {
          try { const win = await chrome.windows.getCurrent(); await chrome.sidePanel.open({ windowId: win.id! }); if (mode === "popup") window.close(); }
          catch { toast("This browser has no side panel. Use the full tab instead."); }
        })}
        {mode !== "tab" && item(<Maximize2 size={18} />, "Open in a full tab", () => { void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=tab") }); if (mode === "popup") window.close(); })}
      </div>
      <div className="section-head"><h2>{t("settings.security")}</h2></div>
      <div className="card rows">
        {item(<Timer size={18} />, t("settings.autolock"), () => setLockPicker(true), false, prefs ? lockLabel(prefs.autoLockMinutes) : "", "autolock-row")}
        {item(<Lock size={18} />, "Lock now", async () => { await wallet.lock(); onChanged(); })}
        {item(<KeyRound size={18} />, t("settings.changePassword"), () => go({ name: "change-password" }))}
        {item(<ScrollText size={18} />, "Show recovery phrase", () => go({ name: "export", kind: "phrase" }))}
        {item(<KeySquare size={18} />, "Export private keys", () => go({ name: "export", kind: "keys" }))}
      </div>
      <div className="section-head"><h2>{t("settings.privacy")} and {t("settings.networks").toLowerCase()}</h2></div>
      <div className="card rows">
        {toggle(<EyeOff size={18} />, t("settings.hideBalances"), "Amounts show as dots", !!prefs?.hideBalances, () => void save({ hideBalances: !prefs?.hideBalances }))}
        {item(<NetworkIcon size={18} />, t("settings.networksManage"), () => go({ name: "networks" }))}
        {toggle(<FlaskConical size={18} />, t("settings.testnets"), t("settings.testnets.note", { names: listNames(networks(true).filter(n => n.testnet).map(n => n.name)) }), !!prefs?.showTestnets, () => void save({ showTestnets: !prefs?.showTestnets }))}
        <div className="row set-row"><span className="set-icon"><DollarSign size={18} /></span><div className="main"><b>{t("settings.currency")}</b></div><span className="set-value">USD</span></div>
      </div>
      <div className="section-head"><h2>{t("settings.sites")}</h2></div>
      <div className="card rows">
        {item(<Globe size={18} />, `Connected sites${connected.length ? ` (${connected.length})` : ""}`, () => go({ name: "sites" }))}
        {item(<ShieldCheck size={18} />, "Token approvals", () => go({ name: "approvals" }))}
      </div>
      <div className="section-head"><h2>Wallet</h2></div>
      <div className="card rows">
        {item(<LogOut size={18} />, "Remove this wallet from this device", () => go({ name: "remove" }), true)}
      </div>
      <div className="section-head"><h2>{t("settings.about")}</h2></div>
      <div className="card rows" data-testid="about">
        {link(<LifeBuoy size={18} />, t("settings.support"), LINKS.support)}
        {link(<Code2 size={18} />, t("settings.source"), LINKS.source)}
        {link(<ShieldCheck size={18} />, t("settings.securityPolicy"), LINKS.security)}
      </div>
      <p style={{ fontSize: 11.5, color: "var(--dim)", textAlign: "center", margin: "16px 0 4px", lineHeight: 1.5 }} data-testid="version">{t("settings.version", { version: chrome.runtime.getManifest().version, n: snap.accounts.length })}<br />{t("settings.keysNote")}</p>
    </div>
    <Dock tab="settings" onTab={onTab} />
    {lockPicker && <ChoiceSheet title={t("settings.autolock")} note={t("settings.autolock.note")} onClose={() => setLockPicker(false)}
      choices={AUTO_LOCK_CHOICES.map(m => ({ id: String(m), label: lockLabel(m, true), on: prefs?.autoLockMinutes === m }))}
      onPick={id => { setLockPicker(false); void save({ autoLockMinutes: Number(id) as Settings["autoLockMinutes"] }); }} />}
  </div>;
}

/** A short list to pick one from (a setting's choices), as a sheet: the chosen one ticked. */
function ChoiceSheet({ title, note, choices, onPick, onClose }: { title: string; note?: string; choices: { id: string; label: string; on: boolean }[]; onPick: (id: string) => void; onClose: () => void }) {
  useEscape(onClose);
  return <>
    <div className="scrim" onClick={onClose} />
    <section className="sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="grab" />
      <div className="sheet-head"><h2>{title}</h2></div>
      {note && <p className="sheet-note">{note}</p>}
      <div className="choice-list">{choices.map(c => <button key={c.id} type="button" className={c.on ? "on" : ""} aria-pressed={c.on} onClick={() => onPick(c.id)}>{c.label}{c.on && <Check size={17} />}</button>)}</div>
    </section>
  </>;
}

/** Removing a wallet: only once it's backed up, after the same warning and the password. */
function RemoveWallet({ backedUp, onClose, onRemoved }: { backedUp: boolean; onClose: () => void; onRemoved: () => void }) {
  const [sure, setSure] = useState(false);
  const [error, setError] = useState(""), [waitUntil, setWaitUntil] = useState(wallet.pinWaitUntil());
  return <div className="popup"><div className="backdrop" style={{ background: "radial-gradient(120% 50% at 50% -10%, rgb(225 93 85 / .14), transparent 60%)" }} />
    <PageHead title="Remove wallet" onBack={onClose} />
    <div className="scroll" style={{ paddingBottom: 130 }}>
      {!backedUp ? <><div className="danger-mark"><Trash2 size={28} /></div><h2 className="center-title">Back up first</h2><p className="center-sub">This wallet isn't backed up. Removing it now would lose it for good. Show your recovery phrase and write it down first.</p></>
        : !sure ? <><div className="danger-mark"><Trash2 size={28} /></div><h2 className="center-title">Remove from this device?</h2><p className="center-sub">Its keys are deleted from this browser. You can restore it any time with your recovery phrase, on any device. Without the phrase, it's gone.</p>
          <div className="checks"><button type="button" className="check" onClick={() => setSure(true)}><span className="box" /><span>I have my recovery phrase written down, and I understand this removes the wallet here.</span></button></div></>
          : <PasswordForm title="Enter your password" subtitle="To remove this wallet from this device." submitLabel="Remove wallet" error={error} waitUntil={waitUntil} onComplete={async pin => {
            try { await wallet.remove(pin); onRemoved(); } catch (e) { setError(message(e)); setWaitUntil(wallet.pinWaitUntil()); }
          }} />}
    </div>
    {!sure && <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><button type="button" className="btn secondary" onClick={onClose}>Keep it</button></div>}
  </div>;
}
