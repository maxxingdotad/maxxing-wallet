import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Check, ChevronLeft, Copy, ExternalLink, MoreVertical } from "lucide-react";
import { ChainLogo, TokenLogo } from "../ui/logos";
import { Metal } from "../ui/metal";
import { ActionDisc, usd, type Holding } from "../ui/parts";
import { copy, useEscape } from "./kit";
import { TrustMark } from "./Assets";
import { chart, price, type Price, type Range } from "../lib/market";
import { explorerToken, networkLabel, networks } from "../lib/chains";
import { trustOf, verifiedAssets } from "../lib/assets";

type Point = { time: number; close: number };
const RANGE_ORDER: Range[] = ["1H", "1D", "1W", "1M", "All"];
/** What each range covers, in seconds and in words. */
const SPAN: Record<Range, { seconds: number; words: string }> = {
  "1H": { seconds: 3600, words: "past hour" }, "1D": { seconds: 86_400, words: "past day" }, "1W": { seconds: 7 * 86_400, words: "past week" },
  "1M": { seconds: 30 * 86_400, words: "past month" }, All: { seconds: Infinity, words: "all time" },
};
/** A price to read at a glance: cents for dollars, more digits for tokens worth a fraction of a cent. */
const money = (n: number) => n >= 1 ? usd(n) : n >= 0.01 ? `$${n.toFixed(4)}` : `$${n.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false })}`;
const dayOf = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
const momentOf = (seconds: number, range: Range) => new Date(seconds * 1000).toLocaleString(undefined, range === "1H" || range === "1D"
  ? { hour: "2-digit", minute: "2-digit" } : range === "All" ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const W = 360, H = 208, TOP = 34, BOTTOM = 34;
/**
 * The price over the range, edge to edge: the line with a soft fill, a dashed line at where the range began, the highest and
 * lowest price marked where they happened, and a live dot at now. Drag (or move) across it to read any moment: the screen's price
 * and date follow the finger.
 */
function PriceChart({ points, up, scrub, onScrub }: { points: Point[]; up: boolean; scrub: number | null; onScrub: (index: number | null) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const shape = useMemo(() => {
    if (points.length < 2) return null;
    const closes = points.map(p => p.close), min = Math.min(...closes), max = Math.max(...closes), span = max - min || 1;
    const x = (i: number) => i / (points.length - 1) * W, y = (c: number) => TOP + (1 - (c - min) / span) * (H - TOP - BOTTOM);
    const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.close).toFixed(1)}`).join("");
    return { line, area: `${line}L${W} ${H}L0 ${H}Z`, x, y, hi: closes.indexOf(max), lo: closes.indexOf(min), flat: max === min, start: y(points[0]!.close) };
  }, [points]);
  if (!shape) return <div className="chart-empty">No chart yet for this token.</div>;
  const at = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    onScrub(Math.max(0, Math.min(points.length - 1, Math.round((clientX - r.left) / r.width * (points.length - 1)))));
  };
  const pct = (i: number) => shape.x(i) / W * 100;
  // A label sits over its point, pulled inward near the edges so it never leaves the screen.
  const mark = (i: number, above: boolean) => {
    const left = pct(i), side = left < 14 ? "start" : left > 86 ? "end" : "mid";
    return <span className={`chart-mark ${side} num`} style={{ left: `${left}%`, top: shape.y(points[i]!.close) + (above ? -22 : 8) }}>{money(points[i]!.close)}</span>;
  };
  const shown = scrub ?? points.length - 1;
  return <div ref={box} className={`chart ${up ? "up" : "down"}${scrub !== null ? " scrubbing" : ""}`} data-testid="price-chart" role="img" aria-label={`Price ${up ? "up" : "down"} over the range`}
    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); at(e.clientX); }} onPointerMove={e => { if (e.pointerType === "mouse" || e.buttons) at(e.clientX); }}
    onPointerUp={() => onScrub(null)} onPointerLeave={() => onScrub(null)} onPointerCancel={() => onScrub(null)}>
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".26" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path d={shape.area} fill="url(#chart-fill)" />
      <line x1="0" x2={W} y1={shape.start} y2={shape.start} className="chart-start" vectorEffect="non-scaling-stroke" />
      <path d={shape.line} className="chart-line" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
    {!shape.flat && mark(shape.hi, true)}
    {!shape.flat && mark(shape.lo, false)}
    {scrub !== null && <span className="chart-cursor" style={{ left: `${pct(scrub)}%` }} />}
    <span className={`chart-dot${scrub === null ? " live" : ""}`} style={{ left: `${pct(shown)}%`, top: shape.y(points[shown]!.close) }} />
  </div>;
}

/**
 * A token: its price, a chart across the whole screen (an hour to all time) that can be read at any moment by dragging, what you
 * hold of it on each network, and Send, Receive and Swap. All networks' holdings of the same symbol show together.
 */
export function TokenDetail({ holding, all, onBack, onSend, onReceive, onSwap }: {
  holding: Holding; all: Holding[]; onBack: () => void; onSend: (h: Holding) => void; onReceive: () => void; onSwap: () => void;
}) {
  const [range, setRange] = useState<Range>("1D");
  const [quote, setQuote] = useState<Price | null>(null);
  const [points, setPoints] = useState<Point[] | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [menu, setMenu] = useState(false), [copied, setCopied] = useState(false);
  useEscape(() => setMenu(false));
  const networkId = holding.networkId ?? "";
  useEffect(() => { void price(networkId, holding.address ?? null).then(setQuote); }, [networkId, holding.address]);
  useEffect(() => { setPoints(null); setScrub(null); void chart(networkId, holding.address ?? null, range).then(setPoints); }, [networkId, holding.address, range]);
  const shownNets = networks(true);
  const perChain = all.filter(h => h.symbol === holding.symbol);
  const rows = perChain.length ? perChain : [holding];
  const net = shownNets.find(n => n.networkId === networkId);
  const trust = trustOf({ networkId, address: holding.address ?? null, symbol: holding.symbol, name: holding.name }, verifiedAssets(net ? [net] : []));

  // The price shown: the moment under the finger, else the live price. The change: from where the range began to that price.
  const drawn = points && points.length >= 2 ? points : null;
  const picked = drawn && scrub !== null ? drawn[Math.min(scrub, drawn.length - 1)]! : null;
  const now = picked?.close ?? quote?.priceUsd ?? drawn?.at(-1)?.close ?? null;
  const began = drawn?.[0]?.close ?? null;
  const link = net && holding.address ? explorerToken(net, holding.address) : null;
  const change = now !== null && began ? (now - began) / began * 100 : picked ? null : quote?.change24hPct ?? null;
  const up = (change ?? 0) >= 0;
  // A token the market has followed for less time than the range: say how far back the line really goes.
  const short = drawn && Number.isFinite(SPAN[range].seconds) && drawn.at(-1)!.time - drawn[0]!.time < SPAN[range].seconds * 0.8;
  const when = picked ? momentOf(picked.time, range) : !drawn ? (began === null && change !== null ? "past day" : "") : short || range === "All" ? `since ${dayOf(drawn[0]!.time)}` : SPAN[range].words;

  return <div className="popup"><div className="backdrop" />
    {/* The top bar is the token: back, its logo and name, and a menu for its contract. Nothing repeats below. */}
    <header className="page-head token-head">
      <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}><ChevronLeft size={20} /></button>
      <span className="token-stack" style={{ width: 30, height: 30 }}><TokenLogo symbol={holding.symbol} size={30} verified={trust === "verified"} />{net && <span className="badge-logo"><ChainLogo networkId={net.networkId} name={net.name} size={13} /></span>}</span>
      <div className="token-name"><b>{holding.name}</b> <TrustMark trust={trust} /></div>
      {holding.address && <button type="button" className="icon-btn" aria-label="More" aria-haspopup="menu" aria-expanded={menu} data-testid="token-menu" onClick={() => setMenu(m => !m)}><MoreVertical size={18} /></button>}
      {menu && holding.address && <>
        <div className="menu-scrim" onClick={() => setMenu(false)} />
        <div className="menu" role="menu">
          {link && <button type="button" role="menuitem" onClick={() => { setMenu(false); void chrome.tabs.create({ url: link }); }}><ExternalLink size={16} />View on explorer</button>}
          <button type="button" role="menuitem" onClick={async () => { await copy(holding.address!); setCopied(true); setTimeout(() => { setCopied(false); setMenu(false); }, 900); }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "Copied" : "Copy contract address"}</button>
          <small className="num">{holding.address}</small>
        </div>
      </>}
    </header>
    <div className="scroll token-screen" data-testid="token-detail">
      <div className="token-price num">{quote === null && now === null ? <span className="sk sk-line" style={{ width: 150, height: 40 }} /> : now === null ? <span className="muted">No price yet</span> : money(now)}</div>
      <div className={`token-change num ${up ? "up" : "down"}`} data-testid="token-change">
        {change !== null && <b>{up ? "+" : "−"}{Math.abs(change).toFixed(2)}%</b>}{when && <span>{when}</span>}
      </div>
      <div className="chart-bleed">{points === null ? <div className="sk chart-wait" /> : <PriceChart points={points} up={up} scrub={scrub} onScrub={setScrub} />}</div>
      <div className="ranges" role="tablist" aria-label="Chart range">{RANGE_ORDER.map(r =>
        <button key={r} type="button" role="tab" aria-selected={range === r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{range === r && <Metal />}{r}</button>)}</div>
      <div className="actions" style={{ marginTop: 16 }}>
        <button type="button" className="action" onClick={() => onSend(holding)}><ActionDisc><ArrowUpRight size={18} /></ActionDisc>Send</button>
        <button type="button" className="action" onClick={onReceive}><ActionDisc><ArrowDownLeft size={18} /></ActionDisc>Receive</button>
        <button type="button" className="action" onClick={onSwap}><ActionDisc><ArrowLeftRight size={18} /></ActionDisc>Swap</button>
      </div>
      <div className="section-head"><h2>Your {holding.symbol}</h2></div>
      <div className="card rows">{rows.map(h => {
        const n = shownNets.find(x => x.networkId === h.networkId);
        return <div key={`${h.networkId}:${h.address ?? ""}`} className="row">
          {n && <ChainLogo networkId={n.networkId} name={n.name} size={26} />}
          <div className="main"><b>{n ? networkLabel(n) : h.chain.name}</b><small className="num">{h.amount} {h.symbol}</small></div>
          <div className="end"><b className="num">{h.priced === false ? "—" : usd(h.usd)}</b></div>
        </div>;
      })}</div>
    </div>
  </div>;
}
