import { Check, GripVertical, KeyRound, Plus, Download } from "lucide-react";
import { Avatar, short, usd, type Account } from "../parts";

/** Switching accounts from the header: every account from your recovery phrase, plus imported ones, each with its own color. */
export function AccountsSheet({ accounts, activeId }: { accounts: Account[]; activeId: string }) {
  const fromPhrase = accounts.filter(a => a.kind !== "imported"), imported = accounts.filter(a => a.kind === "imported");
  const row = (a: Account) => <div key={a.id} className="row" style={{ cursor: "pointer" }}>
    <Avatar account={a} large />
    <div className="main"><b>{a.name}</b><small className="num">{short(a.evm)}{a.solana ? ` · ${short(a.solana)}` : ""}</small></div>
    <div className="end"><b className="num">{usd(a.usd, 0)}</b>{a.id === activeId ? <small style={{ color: "var(--positive)" }}><Check size={13} style={{ verticalAlign: -2 }} /> Active</small> : <small><GripVertical size={14} style={{ verticalAlign: -3 }} /></small>}</div>
  </div>;
  return <>
    <div className="scrim" />
    <section className="sheet" role="dialog" aria-label="Accounts">
      <div className="grab" />
      <div className="sheet-head"><h2>Accounts</h2><span style={{ fontSize: 12, color: "var(--muted)" }}>{accounts.length} on this device</span></div>
      <div style={{ overflowY: "auto", padding: "0 12px" }}>
        <div className="section-head" style={{ marginTop: 0 }}><h2>From your recovery phrase</h2></div>
        <div className="card rows">{fromPhrase.map(row)}</div>
        <div className="section-head"><h2>Imported</h2></div>
        <div className="card rows">{imported.map(row)}</div>
      </div>
      <div className="footer" style={{ flexDirection: "row" }}>
        <button type="button" className="btn secondary"><Plus size={17} />New account</button>
        <button type="button" className="btn secondary"><Download size={17} />Import</button>
      </div>
      <p style={{ margin: "-6px 16px 14px", fontSize: 11, color: "var(--dim)", textAlign: "center" }}><KeyRound size={11} style={{ verticalAlign: -1 }} /> New accounts come from the same recovery phrase. Drag to reorder.</p>
    </section>
  </>;
}
