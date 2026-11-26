import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight } from "lucide-react";
import { ChainLogo, TokenLogo } from "../ui/logos";
import { usd, type Holding } from "../ui/parts";
import { PageHead } from "./kit";
import { TrustMark } from "./Assets";
import { chart, price, type Price, type Range } from "../lib/market";
import { networks } from "../lib/chains";
import { trustOf, verifiedAssets } from "../lib/assets";

/** A price line: the range's closes, scaled to the box, with a soft fill. Flat or empty data draws a quiet empty state. */
function PriceChart({ points }: { points: { time: number; close: number }[] }) {
  const path = useMemo(() => {
    if (points.length < 2) return null;
    const w = 320, h = 120, min = Math.min(...points.map(p => p.close)), max = Math.max(...points.map(p => p.close)), span = max - min || 1;
    const xy = points.map((p, i) => [i / (points.length - 1) * w, h - 6 - (p.close - min) / span * (h - 12)] as const);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");
    return { line, area: `${line}L${w} ${h}L0 ${h}Z`, up: points.at(-1)!.close >= points[0]!.close };
  }, [points]);
  if (!path) return <div className="chart-empty">No chart yet for this token.</div>;
  const color = path.up ? "var(--text)" : "var(--negative)";
  return <svg className="price-chart" viewBox="0 0 320 120" preserveAspectRatio="none" role="img" aria-label={`Price ${path.up ? "up" : "down"} over the range`} data-testid="price-chart">
    <defs><linearGradient id="fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
    <path d={path.area} fill="url(#fill)" /><path d={path.line} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
  </svg>;
}

/**
 * A token: its price and 24h change, a 24h/7d chart, what you hold of it on each network, and Send, Receive and Swap. All networks'
 * holdings of the same symbol show together, each on its own row.
 */
export function TokenDetail({ holding, all, onBack, onSend, onReceive, onSwap }: {
  holding: Holding; all: Holding[]; onBack: () => void; onSend: (h: Holding) => void; onReceive: () => void; onSwap: () => void;
}) {
  const [range, setRange] = useState<Range>("24h");
  const [quote, setQuote] = useState<Price | null>(null);
  const [points, setPoints] = useState<{ time: number; close: number }[] | null>(null);
  const networkId = holding.networkId ?? "";
  useEffect(() => { void price(networkId, holding.address ?? null).then(setQuote); }, [networkId, holding.address]);
  useEffect(() => { setPoints(null); void chart(networkId, holding.address ?? null, range).then(setPoints); }, [networkId, holding.address, range]);
  const shownNets = networks(true);
  const perChain = all.filter(h => h.symbol === holding.symbol);
  const rows = perChain.length ? perChain : [holding];
  const net = shownNets.find(n => n.networkId === networkId);
  const trust = trustOf({ networkId, address: holding.address ?? null, symbol: holding.symbol, name: holding.name }, verifiedAssets(net ? [net] : []));
  const change = quote?.change24hPct ?? null;
  return <div className="popup"><div className="backdrop" />
    <PageHead title={holding.symbol} onBack={onBack} />
    <div className="scroll" data-testid="token-detail">
      <div className="token-hero">
        <span className="token-stack" style={{ width: 48, height: 48 }}><TokenLogo symbol={holding.symbol} size={48} verified={trust === "verified"} />{net && <span className="badge-logo"><ChainLogo networkId={net.networkId} name={net.name} size={18} /></span>}</span>
        <div><div className="token-name">{holding.name} <TrustMark trust={trust} /></div>
          <div className="token-price num">{quote === null ? <span className="sk sk-line" style={{ width: 90, height: 22 }} /> : quote.priceUsd === null ? <span className="muted">No price yet</span> : usd(quote.priceUsd)}
            {change !== null && <span className={`chg ${change >= 0 ? "up" : "down"}`}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</span>}</div></div>
      </div>
      <div className="seg" role="tablist" aria-label="Chart range" style={{ margin: "10px 0" }}>{(["24h", "7d"] as const).map(r => <button key={r} type="button" role="tab" aria-selected={range === r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}</div>
      <div className="card" style={{ padding: 10 }}>{points === null ? <div className="sk" style={{ height: 120 }} /> : <PriceChart points={points} />}</div>
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="action" onClick={() => onSend(holding)}><i><ArrowUpRight size={18} /></i>Send</button>
        <button type="button" className="action" onClick={onReceive}><i><ArrowDownLeft size={18} /></i>Receive</button>
        <button type="button" className="action" onClick={onSwap}><i><ArrowLeftRight size={18} /></i>Swap</button>
      </div>
      <div className="section-head"><h2>Your {holding.symbol}</h2></div>
      <div className="card rows">{rows.map(h => {
        const n = shownNets.find(x => x.networkId === h.networkId);
        return <div key={`${h.networkId}:${h.address ?? ""}`} className="row">
          {n && <ChainLogo networkId={n.networkId} name={n.name} size={26} />}
          <div className="main"><b>{n?.name ?? h.chain.name}</b><small className="num">{h.amount} {h.symbol}</small></div>
          <div className="end"><b className="num">{h.priced === false ? "—" : usd(h.usd)}</b></div>
        </div>;
      })}</div>
      {holding.address && <p className="receive-note" style={{ marginTop: 10, wordBreak: "break-all" }}>Contract {holding.address}</p>}
    </div>
  </div>;
}
