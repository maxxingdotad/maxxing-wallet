import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { AlertTriangle, BadgeCheck, Eye, Link2, PenLine, ShieldAlert } from "lucide-react";
import "./ui/styles.css";
import type { ApprovalView } from "@maxxing/wallet-core/request-view";
import { Avatar, SafetyScore, short } from "./ui/parts";
import { PhishingBlocked } from "./ui/screens/Blocked";
import { Busy, PinPad, message } from "./app/kit";
import * as wallet from "./lib/wallet";
import * as approval from "./lib/approval";
import { ERRORS, LIMITS, type Pending } from "./lib/protocol";
import { siteName } from "./lib/site";
import { sites } from "./lib/store";

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

function SiteCard({ origin, known }: { origin: string; known: boolean }) {
  const name = siteName(origin);
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
  const unlocked = !!snap?.unlocked && !!snap.public;
  const armed = useArmed(`${pending?.kind}:${unlocked}`);
  useEffect(() => {
    void (async () => {
      const p = await approval.loadPending(id);
      setPending(p);
      if (p) setKnown(Boolean(await sites.get(p.origin)));
      setSnap(await wallet.start());
      setWaitUntil(wallet.pinWaitUntil());
    })();
  }, []);
  useEffect(() => { if (pending?.kind === "sign" && unlocked) void approval.reviewSign(pending).then(setSignReview); }, [pending, unlocked, snap?.public?.evm]);
  if (pending === undefined || !snap) return <div className="popup"><div className="backdrop" /><Busy text="Opening the request…" /></div>;
  if (pending === null) return <div className="popup"><div className="backdrop" /><div className="scroll" style={{ paddingTop: 40 }}><div className="card empty">This request is no longer waiting. You can close this window.</div></div><div className="footer"><button type="button" className="btn primary" onClick={() => window.close()}>Close</button></div></div>;
  const name = siteName(pending.origin);
  const close = async (run: () => Promise<void>) => { await run(); window.close(); };

  // A blocked site: this screen is the only way on. Closing the site, or closing this window; nothing reaches the wallet.
  if (pending.kind === "blocked") return <div style={{ position: "relative" }}>
    <PhishingBlocked host={name.host} lookalike="maxxing.ad" />
    <div style={{ position: "absolute", left: 16, right: 16, bottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <button type="button" className="btn primary" onClick={() => close(async () => { await chrome.tabs.remove(pending.tabId).catch(() => {}); await approval.clearPending(pending); })}>Close that site</button>
      <button type="button" className="btn ghost" style={{ fontSize: 12, height: 32, color: "var(--dim)" }} onClick={() => close(() => approval.clearPending(pending))}>Keep it open (it stays blocked)</button>
    </div>
  </div>;

  const site = <SiteCard origin={pending.origin} known={known} />;
  const decline = () => close(() => approval.decline(pending));

  if (!unlocked) {
    const active = snap.accounts.find(a => a.id === snap.activeId);
    return <div className="popup"><div className="backdrop" />
      <div className="scroll" style={{ paddingTop: 12 }}>
        {site}
        {!active ? <div className="card empty" style={{ marginTop: 12 }}>Set up your MAXXING wallet first: open the extension from the toolbar.</div>
          : <PinPad title="Unlock to continue" subtitle={`${active.label} · ${short(active.evm)}`} error={error} waitUntil={waitUntil} onComplete={async pin => {
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
  return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 12, paddingBottom: 130 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ flex: 1, minWidth: 0 }}>{site}</div><SafetyScore value={refused ? 5 : score(view, known)} /></div>
      {refused ? <><h1 className="ask-title">This request can't be signed</h1><div className="alert danger"><AlertTriangle size={17} /><span>{message(new Error(refused))}</span></div></> : view && <>
        <h1 className="ask-title">{view.title}</h1>
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
