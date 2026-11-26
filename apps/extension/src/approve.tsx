import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { AlertTriangle, BadgeCheck, Eye, Link2, PenLine, ShieldAlert } from "lucide-react";
import "./ui/styles.css";
import type { ApprovalView } from "@maxxing/wallet-core/request-view";
import { Avatar, SafetyScore, short } from "./ui/parts";
import { LookalikeWarning, PhishingBlocked } from "./ui/screens/Blocked";
import { suffixRules, type SuffixRules } from "./lib/psl";
import { Busy, PasswordForm, message } from "./app/kit";
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

/** A rough 0–100 for "how ordinary is this": every warning the review raised costs, and so does an unfamiliar site. */
function score(view: ApprovalView | null, known: boolean) {
  let s = 94 - (known ? 0 : 12);
  for (const w of view?.warnings ?? []) s -= /unlimited|no limit|every item|control|lose|different site|spend/i.test(w) ? 38 : 20;
  return Math.max(6, Math.min(99, s));
}

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

function SiteCard({ name, known }: { name: SiteName; known: boolean }) {
  return <div className="card site">
    <span className="favicon">{name.domain[0]!.toUpperCase()}</span>
    <div style={{ minWidth: 0 }}>
      <b style={{ fontSize: 16, overflowWrap: "anywhere" }} data-testid="site-domain">{name.domain}</b>
      {name.host !== name.domain && <small style={{ display: "block", overflowWrap: "anywhere", color: "var(--muted)" }}>{name.address}</small>}
      {name.unicode && <small className="review-flag" style={{ display: "block" }}><AlertTriangle size={13} /> Uses non-Latin letters: reads as “{name.unicode}”</small>}
      {name.insecure && <small className="review-flag" style={{ display: "block" }}><AlertTriangle size={13} /> Not a secure (https) connection</small>}
      {known ? <small className="verified"><BadgeCheck size={13} /> Connected before</small> : <small className="review-flag"><ShieldAlert size={13} /> First time here. Take a close look</small>}
    </div>
  </div>;
}

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
    return <div className="popup"><div className="backdrop" />
      <div className="scroll" style={{ paddingTop: 12, paddingBottom: 130 }} data-testid="add-network-request">
        {site}
        <h1 className="ask-title" style={{ overflowWrap: "anywhere" }}>Add {asked?.name ?? "a network"}?</h1>
        <div className="alert warn" style={{ marginBottom: 10 }}><AlertTriangle size={16} /><span><b>{name.domain} wants to add a network MAXXING doesn't list.</b> Its endpoint decides what you see there: balances, fees and what a transaction does. Only add it if you trust this site.</span></div>
        {asked && <div className="card facts">
          <div className="fact"><span>Network</span><b>{asked.name}</b></div>
          <div className="fact"><span>Chain ID</span><b className="num">{asked.chainId}</b></div>
          <div className="fact"><span>Coin</span><b>{asked.symbol}</b></div>
          <div className="fact"><span>RPC</span><b style={{ overflowWrap: "anywhere" }}>{host(asked.rpcUrls[0]!)}</b></div>
          {asked.explorerUrl && <div className="fact"><span>Explorer</span><b style={{ overflowWrap: "anywhere" }}>{host(asked.explorerUrl)}</b></div>}
        </div>}
        {known && asked && <p className="ask-sub" style={{ marginTop: 10, color: "var(--text)" }} data-testid="will-switch"><b>{name.domain} will switch to {asked.name}</b> once it's added.</p>}
        <p className="ask-sub" style={{ marginTop: known ? 4 : 10 }}>It shows as added by this site, never verified. Gas-free and swaps work there only if Relay supports it.</p>
        {error && <div className="alert danger" role="alert" style={{ marginTop: 8 }}>{error}</div>}
      </div>
      <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><div className="btn-row">
        <button type="button" className="btn secondary" onClick={decline}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !armed || !asked} onClick={async () => {
          setBusy(true); setError("");
          try { await approval.approveAddNetwork(pending); window.close(); } catch (e) { setError(message(e)); setBusy(false); }
        }}>{busy ? "Checking the endpoint…" : "Add network"}</button>
      </div></div>
    </div>;
  }

  // A connected site asks to move to another network. Nothing is signed, so the wallet needn't be unlocked.
  if (pending.kind === "switch") {
    const target = approval.switchTarget(pending);
    return <div className="popup"><div className="backdrop" />
      <div className="scroll" style={{ paddingTop: 12, paddingBottom: 130 }} data-testid="switch-request">
        {site}
        <h1 className="ask-title" style={{ overflowWrap: "anywhere" }}>Switch {name.domain} to {target?.name ?? "another network"}?</h1>
        {target && <div className="card row" style={{ minHeight: 60 }}><ChainLogo networkId={target.networkId} name={target.name} size={32} /><div className="main"><b>{target.name}</b><small>{target.nativeSymbol} pays the fees{target.testnet ? " · test network" : ""}</small></div></div>}
        <p className="ask-sub" style={{ marginTop: 10 }}>The site's requests will be for {target?.name ?? "that network"}. Every signature still comes here, showing its network.</p>
        {error && <div className="alert danger" role="alert" style={{ marginTop: 8 }}>{error}</div>}
      </div>
      <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><div className="btn-row">
        <button type="button" className="btn secondary" onClick={decline}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !armed || !target} onClick={async () => {
          setBusy(true);
          try { await approval.approveSwitch(pending); window.close(); } catch (e) { setError(message(e)); setBusy(false); }
        }}>Switch network</button>
      </div></div>
    </div>;
  }

  if (!unlocked) {
    const active = snap.accounts.find(a => a.id === snap.activeId);
    return <div className="popup"><div className="backdrop" />
      <div className="scroll" style={{ paddingTop: 12 }}>
        {site}
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

  if (pending.kind === "connect") return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 12, paddingBottom: 130 }}>
      {site}
      <h1 className="ask-title" style={{ overflowWrap: "anywhere" }}>Connect to {name.domain}?</h1>
      <p className="ask-sub">The site will see your public addresses. It can't move anything: every signature still comes here for you to approve.</p>
      <div className="card rows">
        <div className="row"><Avatar account={{ name: active.label, color: "#E8E4DC" }} /><div className="main"><b>{active.label}</b><small className="num">EVM {short(open.evm)} · Solana {short(open.solana)}</small></div></div>
      </div>
      <div className="section-head"><h2>It will be able to</h2></div>
      <div className="card facts">
        <div className="fact"><span><Eye size={13} style={{ verticalAlign: -2 }} /> See your addresses and balances</span><b style={{ color: "var(--positive)" }}>Yes</b></div>
        <div className="fact"><span><PenLine size={13} style={{ verticalAlign: -2 }} /> Ask you to sign</span><b>Each time, here</b></div>
        <div className="fact"><span><Link2 size={13} style={{ verticalAlign: -2 }} /> Move funds without asking</span><b style={{ color: "var(--negative)" }}>Never</b></div>
      </div>
      {error && <div className="alert danger" role="alert" style={{ marginTop: 8 }}>{error}</div>}
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><div className="btn-row">
      <button type="button" className="btn secondary" onClick={decline}>Cancel</button>
      <button type="button" className="btn primary" disabled={busy || !armed} onClick={async () => {
        setBusy(true);
        try { await approval.approveConnect(pending); window.close(); } catch (e) { setError(message(e)); setBusy(false); }
      }}>Connect</button>
    </div></div>
  </div>;

  // A signature.
  if (!signReview) return <div className="popup"><div className="backdrop" /><Busy text="Reading the request…" /></div>;
  const { reviewed, refused } = signReview;
  const view = reviewed?.view ?? null;
  const method = pending.method;
  // The network an EVM request is for (a transaction's chainId, or typed data's domain): a user-added one is called out.
  const signChain = (() => { const p = decode(pending.params) as { transaction?: { chainId?: unknown }; typedData?: { domain?: { chainId?: unknown } } } | null; return Number(p?.transaction?.chainId ?? p?.typedData?.domain?.chainId); })();
  const signNetwork = method.startsWith("evm.") && Number.isSafeInteger(signChain) ? evmNetwork(signChain) : null;
  return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 12, paddingBottom: 130 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ flex: 1, minWidth: 0 }}>{site}</div><SafetyScore value={refused ? 5 : score(view, known)} /></div>
      {refused ? <><h1 className="ask-title">This request can't be signed</h1><div className="alert danger"><AlertTriangle size={17} /><span>{message(new Error(refused))}</span></div></> : view && <>
        <h1 className="ask-title">{view.title}</h1>
        {signNetwork?.custom && <div className="alert warn" style={{ marginBottom: 8 }} data-testid="custom-network-sign"><AlertTriangle size={17} /><span><b>On {networkLabel(signNetwork)}.</b> MAXXING doesn't list or check this network: its endpoint decides what this does. Only sign if you trust it.</span></div>}
        <p className="ask-sub">From {active.label} ({short(method.startsWith("evm.") ? open.evm : open.solana)})</p>
        {view.warnings.map((w, i) => <div key={i} className="alert danger" style={{ marginBottom: 8 }}><AlertTriangle size={17} /><span>{/no limit|unlimited/i.test(w) ? <><span className="unlimited">UNLIMITED</span> {w}</> : w}</span></div>)}
        {view.actions.map((a, i) => <p key={i} style={{ fontSize: 14, fontWeight: 600, margin: "4px 2px 8px" }}>{a}</p>)}
        {view.rows.length > 0 && <div className="card facts" style={{ marginBottom: 10 }}>{view.rows.map(([label, value], i) => <div key={i} className="fact"><span>{label}</span><b style={{ overflowWrap: "anywhere" }}>{value}</b></div>)}</div>}
        {view.text && <pre className="message-box">{view.text.text}</pre>}
      </>}
      {error && <div className="alert danger" role="alert" style={{ marginTop: 8 }}>{error}</div>}
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><div className="btn-row">
      <button type="button" className="btn secondary" onClick={refused === ERRORS.otherAccount.message ? () => close(() => approval.answer(pending, { ok: false, error: ERRORS.otherAccount })) : decline}>{refused ? "Close" : "Decline"}</button>
      <button type="button" className="btn primary" disabled={!reviewed || busy || !armed} onClick={async () => {
        setBusy(true); setError("");
        try { await approval.approveSign(pending, reviewed!); window.close(); } catch (e) { setError(message(e)); setBusy(false); }
      }}>Approve</button>
    </div></div>
  </div>;
}

createRoot(document.getElementById("app")!).render(<Approve />);
