import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell, ChevronDown, Fuel, Plus, ScanLine } from "lucide-react";
import { Avatar, ChainDot, Dock, Orbit, TokenMark, usd, type Account, type ChainMark, type Holding } from "../parts";

/** Home: who you are, one balance across every chain, the four things you do most, and what you hold. */
export function Home({ account, holdings, network, onAccounts }: { account: Account; holdings: Holding[]; network: ChainMark | "all"; onAccounts?: () => void }) {
  const total = holdings.reduce((s, h) => s + h.usd, 0);
  const byChain = new Map<string, { chain: ChainMark; usd: number }>();
  for (const h of holdings) byChain.set(h.chain.id, { chain: h.chain, usd: (byChain.get(h.chain.id)?.usd ?? 0) + h.usd });
  return <div className="popup">
    <div className="backdrop" />
    <header className="top">
      <button type="button" className="account-pill" onClick={onAccounts} aria-label="Switch account">
        <Avatar account={account} />
        <b>{account.name}</b>
        <ChevronDown size={16} />
      </button>
      <div className="top-right">
        <span className="chip">{network === "all" ? <><span className="dot" style={{ background: "conic-gradient(#A36AFF, #3FD5F5, #E8E4DC, #A36AFF)" }} />All chains</> : <><ChainDot chain={network} />{network.name}</>}</span>
        <button type="button" className="icon-btn" aria-label="Notifications"><Bell size={18} strokeWidth={1.7} /></button>
      </div>
    </header>
    <div className="scroll">
      <Orbit total={total} change={3.42} shares={[...byChain.values()]} />
      <div className="actions">
        <button type="button" className="action"><i><ArrowUpRight size={18} /></i>Send</button>
        <button type="button" className="action"><i><ArrowDownLeft size={18} /></i>Receive</button>
        <button type="button" className="action"><i><ArrowLeftRight size={18} /></i>Swap</button>
        <button type="button" className="action"><i><Plus size={18} /></i>Buy</button>
      </div>
      <div className="gasless">
        <Fuel size={18} strokeWidth={1.7} />
        <span><b>No gas? No problem.</b> Network fees come out of what you hold, on every chain MAXXING supports.</span>
      </div>
      <div className="section-head"><h2>Tokens</h2><button type="button"><ScanLine size={13} style={{ verticalAlign: -2 }} /> Manage</button></div>
      <div className="card rows">
        {holdings.map(h => <div key={`${h.chain.id}:${h.symbol}`} className="row">
          <TokenMark holding={h} />
          <div className="main"><b>{h.symbol === "MAXX" ? <>MAXX <span className="fee-token" style={{ marginLeft: 4, background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-line)" }}>MAXXING</span></> : h.name}</b><small className="num">{h.amount} {h.symbol} · {h.chain.name}</small></div>
          <div className="end"><b className="num">{usd(h.usd)}</b><small className={`num ${h.change > 0 ? "up-text" : h.change < 0 ? "down-text" : ""}`}>{h.change === 0 ? "—" : `${h.change > 0 ? "+" : ""}${h.change.toFixed(1)}%`}</small></div>
        </div>)}
      </div>
    </div>
    <Dock tab="home" />
  </div>;
}
