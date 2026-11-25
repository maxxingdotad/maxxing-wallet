import { AlertTriangle, BadgeCheck, ChevronDown, Fuel, ShieldAlert } from "lucide-react";
import { SafetyScore, TokenMark, type ChainMark } from "../parts";

/**
 * A request from a site, before anything is signed: who asks (and whether MAXXING knows them), a safety score, what the
 * transaction would do to your balances (simulated), and loud warnings for anything that hands over control.
 */
export function ApproveTransaction({ chain, site, verified }: { chain: ChainMark; site: string; verified: boolean }) {
  return <div className="popup">
    <div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 12, paddingBottom: 130 }}>
      <div className="card site">
        <span className="favicon">{site[0]!.toUpperCase()}</span>
        <div style={{ minWidth: 0 }}>
          <b>{site}</b>
          {verified ? <small className="verified"><BadgeCheck size={13} /> Reviewed by MAXXING</small> : <small className="review-flag"><ShieldAlert size={13} /> Not reviewed. Take a closer look</small>}
        </div>
        <SafetyScore value={verified ? 41 : 28} />
      </div>
      <h1 className="ask-title">Approve USDC spending</h1>
      <p className="ask-sub">On {chain.name} · from Main (0x7a3F…3E21)</p>
      <div className="alert danger">
        <AlertTriangle size={17} />
        <span><b>This approval is <span className="unlimited">UNLIMITED</span></b><br />0x5e1f…77ab could move all your USDC, now and later, without asking again. Set a limit unless you trust it fully.</span>
      </div>
      <div className="section-head"><h2>Balance changes (simulated)</h2></div>
      <div className="card">
        <div className="change"><TokenMark holding={{ symbol: "USDC", chain, color: "#3E73C4" }} /><span style={{ fontSize: 14, fontWeight: 600 }}>USDC</span><span className="amount" style={{ color: "var(--text-2)" }}>No change now</span></div>
        <div className="change"><span className="token"><span className="logo" style={{ background: "var(--surface-3)", color: "var(--text-2)" }}><Fuel size={17} strokeWidth={1.7} /></span></span><span style={{ fontSize: 14, fontWeight: 600 }}>Network fee</span><span className="amount num down-text">−$0.02</span></div>
      </div>
      <div className="section-head"><h2>Spending limit</h2></div>
      <div className="card facts">
        <div className="fact"><span>Allow up to</span><b><span style={{ color: "var(--negative)" }}>Unlimited</span> · <span style={{ color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: 3 }}>Set 500 USDC</span></b></div>
        <div className="fact"><span>Spender</span><b>0x5e1f…77ab</b></div>
        <div className="fact"><span>Raw data</span><b style={{ color: "var(--muted)" }}>0x095ea7b3 · 68 bytes <ChevronDown size={13} style={{ verticalAlign: -2 }} /></b></div>
      </div>
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <div className="btn-row"><button type="button" className="btn secondary">Decline</button><button type="button" className="btn primary">Approve 500</button></div>
    </div>
  </div>;
}
