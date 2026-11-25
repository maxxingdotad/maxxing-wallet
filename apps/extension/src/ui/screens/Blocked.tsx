import { useEffect, useState } from "react";
import { AlertTriangle, ShieldX } from "lucide-react";

/**
 * A site on the phishing blocklist: the wallet stops before anything can be asked and says only what it knows (the address, and
 * that it is on the blocklist). Leaving is the main choice; keeping the tab open changes nothing: the site stays blocked.
 */
export function PhishingBlocked({ host, domain, onLeave, onKeep }: { host: string; domain: string; onLeave: () => void; onKeep: () => void }) {
  return <div className="popup blocked">
    <div className="scroll" style={{ paddingTop: 34, paddingBottom: 140 }}>
      <div className="danger-mark"><ShieldX size={38} strokeWidth={1.7} /></div>
      <h2 className="center-title" style={{ fontSize: 23 }}>This site is a known scam</h2>
      <p className="center-sub">It's on the phishing blocklist MAXXING Wallet checks. Sites like it try to get a recovery phrase or a signature that empties a wallet.</p>
      <div className="url" style={{ overflowWrap: "anywhere" }} data-testid="blocked-host"><mark>{host}</mark></div>
      <div className="card facts">
        <div className="fact"><span>Site</span><b style={{ overflowWrap: "anywhere" }}>{domain}</b></div>
        <div className="fact"><span>Why</span><b>On the phishing blocklist</b></div>
        <div className="fact"><span>Your wallet</span><b style={{ color: "var(--positive)" }}>Nothing was shared</b></div>
      </div>
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <button type="button" className="btn primary" onClick={onLeave}>Close that site</button>
      <button type="button" className="btn ghost" style={{ fontSize: 12, height: 32, color: "var(--dim)" }} onClick={onKeep}>Keep the tab open (it stays blocked)</button>
    </div>
  </div>;
}

/**
 * A site whose name reads as MAXXING but isn't maxxing.ad. Not a known scam, so the user may go on for a site they know, after
 * ticking that they know it and a short wait. Leaving stays the main choice.
 */
export function LookalikeWarning({ host, domain, unicode, onLeave, onContinue }: { host: string; domain: string; unicode: string | null; onLeave: () => void; onContinue: () => void }) {
  const [sure, setSure] = useState(false), [ready, setReady] = useState(false);
  useEffect(() => { setReady(false); if (!sure) return; const t = setTimeout(() => setReady(true), 3000); return () => clearTimeout(t); }, [sure]);
  return <div className="popup blocked">
    <div className="scroll" style={{ paddingTop: 34, paddingBottom: 170 }}>
      <div className="danger-mark" style={{ background: "var(--warning-soft, rgba(240,185,11,.14))", color: "var(--warning, #F0B90B)" }}><AlertTriangle size={36} strokeWidth={1.7} /></div>
      <h2 className="center-title" style={{ fontSize: 22 }}>This isn't MAXXING</h2>
      <p className="center-sub">The site's name reads like MAXXING, but MAXXING's own sites are only on <b style={{ color: "var(--text)" }}>maxxing.ad</b>. Copies of a name are a common way to steal wallets.</p>
      <div className="url" style={{ overflowWrap: "anywhere" }} data-testid="lookalike-host"><mark>{host}</mark></div>
      <div className="card facts">
        <div className="fact"><span>Site</span><b style={{ overflowWrap: "anywhere" }}>{domain}</b></div>
        {unicode && <div className="fact"><span>Reads as</span><b style={{ overflowWrap: "anywhere" }}>{unicode}</b></div>}
        <div className="fact"><span>On the blocklist</span><b>No</b></div>
      </div>
      <label className="card" style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 12, marginTop: 10, fontSize: 13, cursor: "pointer" }}>
        <input type="checkbox" checked={sure} onChange={e => setSure(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I know this site, and it isn't pretending to be MAXXING.</span>
      </label>
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <button type="button" className="btn primary" onClick={onLeave}>Close that site</button>
      <button type="button" className="btn ghost" style={{ fontSize: 12, height: 32 }} disabled={!sure || !ready} onClick={onContinue}>{sure && !ready ? "Continue (wait a moment)…" : "Continue to the site's request"}</button>
    </div>
  </div>;
}
