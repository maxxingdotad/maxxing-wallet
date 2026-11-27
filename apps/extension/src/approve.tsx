import { createRoot } from "react-dom/client";
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowUpRight, BadgeCheck, Eye, Globe, Link2, Lock, PenLine, ShieldAlert } from "lucide-react";
import "./ui/styles.css";
import { short } from "./ui/parts";
import { LookalikeWarning, PhishingBlocked } from "./ui/screens/Blocked";
import { suffixRules, type SuffixRules } from "./lib/psl";
import { Busy, PasswordForm, message } from "./app/kit";
import { HoldButton } from "./ui/moving";
import * as wallet from "./lib/wallet";
import * as approval from "./lib/approval";
import { ERRORS, LIMITS, type Pending } from "./lib/protocol";
import { siteName, type SiteName } from "./lib/site";
import { sites } from "./lib/store";
import { ChainLogo } from "./ui/logos";
import { decode } from "./lib/codec";
import { evmNetwork, networkLabel } from "./lib/chains";

/**
 * The approval window: one site request, shown in full before anything happens. It unlocks the wallet with the PIN if needed,
 * shows the request through the wallet core's review (request-view), and answers the page that asked (lib/approval.ts).
 * Connect and Approve wait a moment after the window shows or gets focus back, so a click aimed at the site can't land on them.
 */
const id = new URLSearchParams(location.search).get("id") ?? "";

/** False until the window has been visible and focused for a moment; false again whenever it loses focus. */
function useArmed(screen: string) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    let timer = 0;
    const disarm = () => { window.clearTimeout(timer); setArmed(false); };
    const arm = () => { disarm(); if (document.visibilityState === "visible") timer = window.setTimeout(() => setArmed(true), LIMITS.armDelayMs); };
    arm();
    window.addEventListener("focus", arm); window.addEventListener("blur", disarm); document.addEventListener("visibilitychange", arm);
    return () => { disarm(); window.removeEventListener("focus", arm); window.removeEventListener("blur", disarm); document.removeEventListener("visibilitychange", arm); };
  }, [screen]);
  return armed;
}

/** Who is asking, at the top of every request: the site's registered name in full, whether it's been here before, and anything odd about it. */
function SiteCard({ name, known }: { name: SiteName; known: boolean }) {
  return <div className="ask-site">
    <div className="ask-site-chip">
      <span className="favicon">{name.domain[0]!.toUpperCase()}</span>
      <b data-testid="site-domain">{name.domain}</b>
      {known ? <span className="ask-tag good"><BadgeCheck size={12} />Connected before</span> : <span className="ask-tag warn"><ShieldAlert size={12} />First time here</span>}
    </div>
    {name.host !== name.domain && <small>{name.address}</small>}
    {name.unicode && <small className="review-flag"><AlertTriangle size={13} /> Uses non-Latin letters: reads as “{name.unicode}”</small>}
    {name.insecure && <small className="review-flag"><AlertTriangle size={13} /> Not a secure (https) connection</small>}
  </div>;
}

/**
 * One layout for every request, the same as the Send review: who asks (top), what they ask (centre, one title), anything to
 * be careful about under it, then the facts and the two buttons on the glowing panel.
 */
function Ask({ site, mark, title, sub, children, rows, actions, testId }: { site: ReactNode; mark: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode; rows?: ReactNode; actions: ReactNode; testId?: string }) {
  return <div className="popup confirm-screen" data-testid={testId}>
    {site}
    <div className="scroll confirm-scroll">
      <div className="confirm-hero ask-hero"><span className="ask-mark">{mark}</span><h1 className="ask-title">{title}</h1>{sub && <p className="ask-sub">{sub}</p>}</div>
      <div className="confirm-warnings">{children}</div>
    </div>
    <div className="confirm-panel">{rows && <div className="confirm-rows">{rows}</div>}<div className="btn-row">{actions}</div></div>
  </div>;
}
/** A whole address (EVM or Solana): shown in full, in small fixed-width type, so it can be compared character by character. */
const isAddress = (value: string) => /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/.test(value);
const Warn = ({ children, danger, testId }: { children: ReactNode; danger?: boolean; testId?: string }) =>
  <div className={`confirm-warn${danger ? " danger" : ""}`} role={danger ? "alert" : undefined} data-testid={testId}><AlertTriangle size={15} /><span>{children}</span></div>;

function Approve() {
  const [pending, setPending] = useState<Pending | null | undefined>(undefined);
  const [snap, setSnap] = useState<wallet.WalletSnapshot | null>(null);
  const [known, setKnown] = useState(false);
  const [error, setError] = useState(""), [waitUntil, setWaitUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  const [signReview, setSignReview] = useState<Awaited<ReturnType<typeof approval.reviewSign>> | null>(null);
  const [rules, setRules] = useState<SuffixRules | null>(null);
  const unlocked = !!snap?.unlocked && !!snap.public;
  // The buttons re-arm whenever what they act on changes: the screen, the unlock, and the review once it has loaded.
  const armed = useArmed(`${pending?.kind}:${unlocked}:${signReview ? "reviewed" : "reading"}`);
  useEffect(() => {
    void (async () => {
      setRules(await suffixRules());
      const p = await approval.loadPending(id);
      setPending(p);
      if (p) setKnown(Boolean(await sites.get(p.origin)));
      setSnap(await wallet.start());
      setWaitUntil(wallet.pinWaitUntil());
    })();
  }, []);
  useEffect(() => { if (pending?.kind === "sign" && unlocked) void approval.reviewSign(pending).then(setSignReview); }, [pending, unlocked, snap?.public?.evm]);
  if (pending === undefined || !snap || !rules) return <div className="popup"><div className="backdrop" /><Busy text="Opening the request…" /></div>;
  if (pending === null) return <div className="popup"><div className="backdrop" /><div className="scroll" style={{ paddingTop: 40 }}><div className="card empty">This request is no longer waiting. You can close this window.</div></div><div className="footer"><button type="button" className="btn primary" onClick={() => window.close()}>Close</button></div></div>;
  const name = siteName(pending.origin, rules);
  const close = async (run: () => Promise<void>) => { await run(); window.close(); };
  const closeSite = (run: () => Promise<void>) => close(async () => { await chrome.tabs.remove(pending.tabId).catch(() => {}); await run(); });

  // A known scam: this screen is the only way on. Closing the site, or closing this window; nothing reaches the wallet.
  if (pending.kind === "blocked") return <PhishingBlocked host={name.host} domain={name.domain}
    onLeave={() => closeSite(() => approval.clearPending(pending))} onKeep={() => close(() => approval.clearPending(pending))} />;

  // A name that reads as MAXXING: warn first; the request goes on only if the user says they know the site.
  if (pending.kind === "lookalike") return <LookalikeWarning host={name.host} domain={name.domain} unicode={name.unicode}
    onLeave={() => closeSite(() => approval.decline(pending))}
    onContinue={async () => { setPending(await approval.continueLookalike(pending)); }} />;

  const site = <SiteCard name={name} known={known} />;
  const decline = () => close(() => approval.decline(pending));

  // A site asks to add a network the wallet doesn't have. Nothing is signed; the endpoint is checked before it's kept.
  if (pending.kind === "add-network") {
    const asked = approval.addNetworkRequest(pending);
    const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
    return <Ask site={site} testId="add-network-request" mark={<Globe size={26} />} title={<>Add {asked?.name ?? "a network"}?</>}
      sub="It shows as added by this site, never verified. Gas-free and swaps work there only if Relay supports it."
      rows={asked && <>
        <div><span>Chain ID</span><b className="num">{asked.chainId}</b></div>
        <div><span>Coin</span><b>{asked.symbol}</b></div>
        <div><span>RPC</span><b>{host(asked.rpcUrls[0]!)}</b></div>
        {asked.explorerUrl && <div><span>Explorer</span><b>{host(asked.explorerUrl)}</b></div>}
      </>}
      actions={<>
        <button type="button" className="btn secondary" onClick={decline}>Cancel</button>
        <HoldButton label="Add network" busyLabel="Checking the endpoint…" disabled={busy || !armed || !asked} onConfirm={async () => {
          setBusy(true); setError("");
          try { await approval.approveAddNetwork(pending); window.close(); } catch (e) { setError(message(e)); setBusy(false); }
        }} />
      </>}>
      <Warn><b>{name.domain} wants to add a network MAXXING doesn't list.</b> Its endpoint decides what you see there: balances, fees and what a transaction does. Only add it if you trust this site.</Warn>
      {known && asked && <p className="ask-note" data-testid="will-switch"><b>{name.domain} will switch to {asked.name}</b> once it's added.</p>}
      {error && <Warn danger>{error}</Warn>}
    </Ask>;
  }

  // A connected site asks to move to another network. Nothing is signed, so the wallet needn't be unlocked.
  if (pending.kind === "switch") {
    const target = approval.switchTarget(pending);
    return <Ask site={site} testId="switch-request" mark={target ? <ChainLogo networkId={target.networkId} name={target.name} size={34} /> : <Globe size={26} />}
      title={<>Switch to {target?.name ?? "another network"}?</>}
      sub={<>{name.domain}'s requests will be for {target?.name ?? "that network"}. Every signature still comes here, showing its network.</>}
      rows={target && <>
        <div><span>Network</span><b>{target.name}{target.testnet ? " · test network" : ""}</b></div>
        <div><span>Fees are paid in</span><b>{target.nativeSymbol}</b></div>
      </>}
      actions={<>
        <button type="button" className="btn secondary" onClick={decline}>Cancel</button>
        <HoldButton label="Switch" busyLabel="Switching…" disabled={busy || !armed || !target} onConfirm={async () => {
          setBusy(true);
          try { await approval.approveSwitch(pending); window.close(); } catch (e) { setError(message(e)); setBusy(false); }
        }} />
      </>}>
      {error && <Warn danger>{error}</Warn>}
    </Ask>;
  }

  if (!unlocked) {
    const active = snap.accounts.find(a => a.id === snap.activeId);
    return <div className="popup confirm-screen">
      {site}
      <div className="scroll" style={{ paddingTop: 28 }}>
        {!active ? <div className="card empty" style={{ marginTop: 12 }}>Set up your MAXXING wallet first: open the extension from the toolbar.</div>
          : <PasswordForm title="Unlock to continue" subtitle={`${active.label} · ${short(active.evm)}`} submitLabel="Unlock" error={error} waitUntil={waitUntil} onComplete={async pin => {
            try { setError(""); await wallet.unlock(pin); setSnap(wallet.snapshot()); } catch (e) { setError(message(e)); setWaitUntil(wallet.pinWaitUntil()); }
          }} />}
      </div>
      <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><button type="button" className="btn secondary" onClick={decline}>Cancel</button></div>
    </div>;
  }
  const open = snap.public!;
  const active = snap.accounts.find(a => a.id === snap.activeId)!;

  if (pending.kind === "connect") return <Ask site={site} mark={<Link2 size={26} />} title={<>Connect to {name.domain}?</>}
    sub="It will see your public addresses. It can't move anything: every signature still comes here for you to approve."
    rows={<>
      <div><span>Wallet</span><b>{active.label} <em className="num">{short(open.evm)}</em></b></div>
      <div><span><Eye size={13} /> See addresses and balances</span><b>Yes</b></div>
      <div><span><PenLine size={13} /> Ask you to sign</span><b>Each time, here</b></div>
      <div><span><Lock size={13} /> Move funds without asking</span><b>Never</b></div>
    </>}
    actions={<>
      <button type="button" className="btn secondary" onClick={decline}>Cancel</button>
      <HoldButton label="Connect" busyLabel="Connecting…" disabled={busy || !armed} onConfirm={async () => {
        setBusy(true);
        try { await approval.approveConnect(pending); window.close(); } catch (e) { setError(message(e)); setBusy(false); }
      }} />
    </>}>
    {error && <Warn danger>{error}</Warn>}
  </Ask>;

  // A signature.
  if (!signReview) return <div className="popup confirm-screen">{site}<Busy text="Reading the request…" /></div>;
  const { reviewed, refused } = signReview;
  const view = reviewed?.view ?? null;
  const method = pending.method;
  // The network an EVM request is for (a transaction's chainId, or typed data's domain): a user-added one is called out.
  const signChain = (() => { const p = decode(pending.params) as { transaction?: { chainId?: unknown }; typedData?: { domain?: { chainId?: unknown } } } | null; return Number(p?.transaction?.chainId ?? p?.typedData?.domain?.chainId); })();
  const signNetwork = method.startsWith("evm.") && Number.isSafeInteger(signChain) ? evmNetwork(signChain) : null;
  const risky = !!refused || (view?.warnings.length ?? 0) > 0;
  // Up to five facts sit on the panel beside the button; a longer list (typed data) scrolls above it instead.
  const facts = view?.rows ?? [];
  const onPanel = facts.length <= 5;
  const from = <div><span>From</span><b>{active.label} <em className="num">{short(method.startsWith("evm.") ? open.evm : open.solana)}</em></b></div>;
  return <Ask site={site} mark={risky ? <ShieldAlert size={26} /> : view?.text ? <PenLine size={26} /> : <ArrowUpRight size={26} />}
    title={refused ? "This request can't be signed" : view?.title}
    sub={!refused && view && view.actions.length > 0 ? view.actions.map((a, i) => <span key={i} className="ask-action">{a}</span>) : undefined}
    rows={!refused && view ? <>{from}{onPanel && facts.map(([label, value], i) => <div key={i}><span>{label}</span><b className={isAddress(value) ? "addr" : undefined}>{value}</b></div>)}</> : undefined}
    actions={<>
      <button type="button" className="btn secondary" onClick={refused === ERRORS.otherAccount.message ? () => close(() => approval.answer(pending, { ok: false, error: ERRORS.otherAccount })) : decline}>{refused ? "Close" : "Decline"}</button>
      <HoldButton label="Approve" busyLabel="Signing…" disabled={!reviewed || busy || !armed} onConfirm={async () => {
        setBusy(true); setError("");
        try { await approval.approveSign(pending, reviewed!); window.close(); } catch (e) { setError(message(e)); setBusy(false); }
      }} />
    </>}>
    {refused ? <Warn danger>{message(new Error(refused))}</Warn> : view && <>
      {signNetwork?.custom && <Warn testId="custom-network-sign"><b>On {networkLabel(signNetwork)}.</b> MAXXING doesn't list or check this network: its endpoint decides what this does. Only sign if you trust it.</Warn>}
      {view.warnings.map((w, i) => <Warn key={i} danger>{/no limit|unlimited/i.test(w) ? <><span className="unlimited">UNLIMITED</span> {w}</> : w}</Warn>)}
      {!onPanel && <div className="card facts">{facts.map(([label, value], i) => <div key={i} className="fact"><span>{label}</span><b className={isAddress(value) ? "addr" : undefined} style={{ overflowWrap: "anywhere" }}>{value}</b></div>)}</div>}
      {view.text && <pre className="message-box">{view.text.text}</pre>}
    </>}
    {error && <Warn danger>{error}</Warn>}
  </Ask>;
}

createRoot(document.getElementById("app")!).render(<Approve />);
