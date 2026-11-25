import { ArrowDownUp, ChevronDown, ChevronLeft, Fuel, Route, Settings2 } from "lucide-react";
import { Dock, TokenMark, type ChainMark } from "../parts";

/**
 * Swap and bridge: any asset to any asset, across chains, through Relay. The route is shown as it travels, and when you have no
 * gas on the source chain the fee is taken from a token you hold, said plainly.
 */
export function Swap({ from, to }: { from: { symbol: string; chain: ChainMark; logo?: string; color?: string }; to: { symbol: string; chain: ChainMark; logo?: string; color?: string } }) {
  return <div className="popup">
    <div className="backdrop" />
    <header className="page-head">
      <button type="button" className="icon-btn" aria-label="Back"><ChevronLeft size={20} /></button>
      <h1>Swap & bridge</h1>
      <button type="button" className="icon-btn" aria-label="Slippage"><Settings2 size={18} strokeWidth={1.7} /></button>
    </header>
    <div className="scroll" style={{ paddingBottom: 150 }}>
      <div className="swap-card">
        <label><span>You pay</span><span className="num">Balance 1,620.00</span></label>
        <div className="swap-line"><span className="swap-amount num">500</span><button type="button" className="swap-asset"><TokenMark holding={from} />{from.symbol}<ChevronDown size={15} /></button></div>
        <label style={{ marginTop: 6 }}><span className="num">$500.00 · on {from.chain.name}</span><span style={{ color: "var(--text-2)", fontWeight: 600 }}>Max</span></label>
      </div>
      <div className="swap-flip"><button type="button" aria-label="Flip"><ArrowDownUp size={16} /></button></div>
      <div className="swap-card">
        <label><span>You get</span><span style={{ color: "var(--positive)" }}>Best of 6 routes</span></label>
        <div className="swap-line"><span className="swap-amount num">2.3741</span><button type="button" className="swap-asset"><TokenMark holding={to} />{to.symbol}<ChevronDown size={15} /></button></div>
        <label style={{ marginTop: 6 }}><span className="num">$497.21 · on {to.chain.name}</span><span className="num">−0.56%</span></label>
      </div>
      <div className="card route" style={{ marginTop: 8 }}>
        <Route size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
        <span className="hop">{from.symbol} · {from.chain.name}</span><span className="line" /><span className="hop">Relay</span><span className="line" /><span className="hop">{to.symbol} · {to.chain.name}</span>
      </div>
      <div className="gasless" style={{ marginTop: 10 }}>
        <Fuel size={17} strokeWidth={1.7} />
        <span style={{ flex: 1 }}><b>Fee paid in USDC.</b> You have no ETH on {from.chain.name}, so you don't need any.</span>
        <span className="fee-token num"><span className="logo" style={{ background: "#3E73C4" }} />0.41</span>
      </div>
      <div className="card facts" style={{ marginTop: 10 }}>
        <div className="fact"><span>Rate</span><b>1 SOL = 210.61 USDC</b></div>
        <div className="fact"><span>Price impact</span><b style={{ color: "var(--positive)" }}>0.08%</b></div>
        <div className="fact"><span>Minimum received</span><b>2.3622 SOL</b></div>
        <div className="fact"><span>Arrives in</span><b>~ 12 seconds</b></div>
      </div>
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 72 }}>
      <button type="button" className="btn primary">Review swap</button>
    </div>
    <Dock tab="swap" />
  </div>;
}
