import { ShieldX } from "lucide-react";

/** A site on the phishing list: the wallet stops before anything can be asked, says why, and makes leaving the easy choice. */
export function PhishingBlocked({ host, lookalike }: { host: string; lookalike: string }) {
  return <div className="popup blocked">
    <div className="scroll" style={{ paddingTop: 34, paddingBottom: 140 }}>
      <div className="danger-mark"><ShieldX size={38} strokeWidth={1.7} /></div>
      <h2 className="center-title" style={{ fontSize: 23 }}>This site is a known scam</h2>
      <p className="center-sub">It's on MAXXING's phishing list. It pretends to be <b style={{ color: "var(--text)" }}>{lookalike}</b> to get your recovery phrase or a signature that drains your wallet.</p>
      <div className="url">https://<mark>{host}</mark>/claim</div>
      <div className="card facts">
        <div className="fact"><span>Reported</span><b>2 hours ago</b></div>
        <div className="fact"><span>Looks like</span><b>{lookalike}</b></div>
        <div className="fact"><span>Your wallet</span><b style={{ color: "var(--positive)" }}>Nothing was shared</b></div>
      </div>
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <button type="button" className="btn primary">Get me out of here</button>
      <button type="button" className="btn ghost" style={{ fontSize: 12, height: 32, color: "var(--dim)" }}>I understand the risk, continue anyway</button>
    </div>
  </div>;
}
