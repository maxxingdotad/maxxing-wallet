import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowLeftRight, Clock3, House, Settings } from "lucide-react";
import { KNOWN_SOLANA_MINTS, knownTokens } from "@maxxing/wallet-core/chains";
import { ChainLogo, TokenLogo } from "./logos";
import { Metal } from "./metal";

/** A chain as the screens show it: a logo when the repo has one, else its initial on its color. */
export type ChainMark = { id: string; name: string; color: string; logo?: string };
export type Holding = {
  symbol: string; name: string; chain: ChainMark; amount: string; usd: number; change: number; logo?: string; color?: string;
  /** Real holdings: whether `usd` is a price (false: no price known), the exact amount, the token, and its network. */
  priced?: boolean; raw?: string; decimals?: number; address?: string | null; networkId?: string;
};
export type Account = { id: string; name: string; color: string; evm: string; solana: string; usd: number; hidden?: boolean; kind?: "phrase" | "imported" };

export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** A typed amount as a plain decimal the amount parser accepts (8 significant digits, never `1e-8` or `1e+21`). */
export const plainDecimal = (value: number) => value.toLocaleString("en-US", { useGrouping: false, maximumSignificantDigits: 8 });
export const usd = (value: number, digits = 2) => value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

export function ChainDot({ chain, size = 16 }: { chain: ChainMark; size?: number }) {
  return chain.logo
    ? <img className="dot" src={chain.logo} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: 999 }} />
    : <span className="dot" style={{ width: size, height: size, borderRadius: 999, background: chain.color, display: "inline-grid", placeItems: "center", fontSize: size * .5, fontWeight: 800, color: "#141518" }}>{chain.name[0]}</span>;
}

/** A token logo with its chain as a small badge, the way the MAXXING app shows holdings. */
export function TokenMark({ holding }: { holding: Pick<Holding, "symbol" | "logo" | "color" | "chain"> & Partial<Pick<Holding, "address" | "networkId">> }) {
  // A real holding: the same bundled logos as everywhere else (the brand's only for a coin or a token the registry lists),
  // with its network as a round badge.
  const networkId = holding.networkId ?? (holding.chain.id.includes(":") ? holding.chain.id : null);
  if (networkId && !holding.logo) {
    const address = holding.address ?? null;
    const listed = !address || (networkId.startsWith("solana:") ? address in KNOWN_SOLANA_MINTS : knownTokens(networkId).some(t => t.address.toLowerCase() === address.toLowerCase()));
    return <span className="token-stack lg"><TokenLogo symbol={holding.symbol} size={38} verified={listed} /><span className="badge-logo"><ChainLogo networkId={networkId} name={holding.chain.name} size={16} /></span></span>;
  }
  return <span className="token">
    {holding.logo ? <img className="logo" src={holding.logo} alt="" />
      : <span className="logo" style={{ background: holding.color ?? "var(--surface-3)", color: /^USD/.test(holding.symbol) ? "#fff" : "#141518", fontSize: /^USD/.test(holding.symbol) ? 17 : undefined }}>{/^USD/.test(holding.symbol) ? "$" : holding.symbol.slice(0, 2)}</span>}
    {holding.chain.logo ? <img className="badge" src={holding.chain.logo} alt="" /> : <span className="badge" style={{ background: holding.chain.color, color: "#141518" }}>{holding.chain.name[0]}</span>}
  </span>;
}

/** Each account's own mark: its color and initial, so switching is recognisable at a glance. */
export function Avatar({ account, large }: { account: Pick<Account, "name" | "color">; large?: boolean }) {
  return <span className={`avatar${large ? " lg" : ""}`} style={{ background: `linear-gradient(140deg, ${account.color}, color-mix(in srgb, ${account.color} 55%, #141518))` }}>{account.name[0]}</span>;
}

/**
 * The portfolio as an orbit: the total in the middle, each chain a planet on the ring, sized by its share. The ring turns slowly;
 * with reduced motion it stands still.
 */
export function Orbit({ total, change, shares, note, hidden }: { total: number; change: number | null; shares: { chain: ChainMark; usd: number }[]; note?: string; /** Balances hidden (Settings): the total shows as dots. */ hidden?: boolean }) {
  const id = useId().replace(/[^a-z0-9]/gi, "");
  const [whole, cents] = usd(total).split(".");
  // With nothing priced yet, every chain gets an equal place on the ring.
  const sum = shares.reduce((s, x) => s + x.usd, 0) || shares.length || 1;
  shares = shares.map(s => ({ ...s, usd: shares.some(x => x.usd > 0) ? s.usd : 1 }));
  // An ellipse tilted like the welcome art's orbit.
  const rx = 152, ry = 72, tilt = -14, cx = 180, cy = 107;
  const point = (t: number) => {
    const a = (tilt * Math.PI) / 180, x = rx * Math.cos(t), y = ry * Math.sin(t);
    return { x: cx + x * Math.cos(a) - y * Math.sin(a), y: cy + x * Math.sin(a) + y * Math.cos(a) };
  };
  let at = -Math.PI * 0.62;
  const planets = shares.map(share => {
    const span = (share.usd / sum) * Math.PI * 2;
    const p = point(at + span / 2);
    at += span;
    return { ...share, ...p, r: 7 + Math.sqrt(share.usd / sum) * 12 };
  });
  return <div className="orbit">
    <svg className="ring" viewBox="0 0 360 214" aria-hidden="true">
      <defs>
        <linearGradient id={`ring-${id}`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#A36AFF" /><stop offset=".55" stopColor="#E8E4DC" stopOpacity=".55" /><stop offset="1" stopColor="#3FD5F5" />
        </linearGradient>
      </defs>
      <ellipse className="ring-ghost" cx={cx} cy={cy} rx={rx + 10} ry={ry + 6} transform={`rotate(${tilt} ${cx} ${cy})`} />
      <g className="spin" style={{ transformOrigin: `${cx}px ${cy}px` }}>
        <ellipse cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${tilt} ${cx} ${cy})`} fill="none" stroke={`url(#ring-${id})`} strokeWidth="1.2" />
        {planets.map(p => <g key={p.chain.id} className="planet">
          <circle cx={p.x} cy={p.y} r={p.r + 5} fill={p.chain.color} opacity=".12" />
          {p.chain.logo
            ? <image href={p.chain.logo} x={p.x - p.r} y={p.y - p.r} width={p.r * 2} height={p.r * 2} />
            : <circle cx={p.x} cy={p.y} r={p.r} fill={p.chain.color} />}
        </g>)}
      </g>
    </svg>
    <div className="orbit-center">
      <small>{shares.length ? `One balance · ${shares.length} chain${shares.length === 1 ? "" : "s"}` : "One balance · every chain"}</small>
      {/* The total is cut out of liquid metal: the chrome flows behind, and only the digits let it through. */}
      <div className="balance-metal"><Metal fill />
        <div className="balance num" data-testid="total">{hidden ? "$••••" : <><Rolling text={whole!} /><span className="cents"><Rolling text={`.${cents}`} /></span></>}</div>
      </div>
      {change !== null
        ? <span className={`delta ${change >= 0 ? "up" : "down"}`}>{change >= 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}% today</span>
        : note ? <span className="delta" style={{ color: "var(--muted)", background: "var(--surface-2)" }}>{note}</span> : null}
    </div>
  </div>;
}

/**
 * A number whose digits roll into place like an odometer when it changes (and once when it first shows). Screen readers and copy
 * get the plain text; the rolling columns are decoration. Under reduced motion the digits simply change.
 */
export function Rolling({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const raf = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(raf); }, []);
  const chars = [...text];
  return <span className="rolling"><span className="sr-only">{text}</span><span aria-hidden="true">{chars.map((c, i) => {
    // Keyed from the right, so a total gaining a digit keeps its other columns in place.
    const key = chars.length - i;
    if (!/\d/.test(c)) return <span key={`s${key}`} className="roll-static">{c}</span>;
    return <span key={key} className="roll"><span className="roll-strip" style={{ transform: `translateY(-${shown ? Number(c) * 10 : 0}%)`, transitionDelay: `${(chars.length - i) * 35}ms` }}>
      {"0123456789".split("").map(d => <span key={d}>{d}</span>)}
    </span></span>;
  })}</span></span>;
}

/** The disc of a round action (Send, Receive, Swap): dark glass in a liquid metal ring. */
export function ActionDisc({ children }: { children: ReactNode }) { return <i><Metal />{children}</i>; }

export type DockTab = "home" | "swap" | "activity" | "settings";
/** The floating glass dock from the mobile app, with the violet glow gliding to the open tab. */
let lastDockIndex = 0;
export function Dock({ tab, onTab }: { tab: DockTab; onTab?: (tab: DockTab) => void }) {
  const tabs: { id: DockTab; label: string; icon: ReactNode }[] = [
    { id: "home", label: "Home", icon: <House size={21} strokeWidth={1.7} /> },
    { id: "swap", label: "Swap and bridge", icon: <ArrowLeftRight size={21} strokeWidth={1.7} /> },
    { id: "activity", label: "Activity", icon: <Clock3 size={21} strokeWidth={1.7} /> },
    { id: "settings", label: "Settings", icon: <Settings size={21} strokeWidth={1.7} /> },
  ];
  const index = tabs.findIndex(t => t.id === tab);
  // Each screen draws its own dock, so the pill starts where the last one left it and slides to this screen's tab.
  const [at, setAt] = useState(lastDockIndex);
  useEffect(() => { lastDockIndex = index; const frame = requestAnimationFrame(() => setAt(index)); return () => cancelAnimationFrame(frame); }, [index]);
  return <nav className="dock" aria-label="Wallet" style={{ ["--glow" as string]: `${(index - 1.5) * 100}%`, ["--at" as string]: at }}>
    <Metal className="dock-rim" />
    <span className="dock-thumb" aria-hidden="true"><Metal /></span>
    {tabs.map(t => <button key={t.id} type="button" className={`tab${t.id === tab ? " on" : ""}`} aria-label={t.label} aria-current={t.id === tab ? "page" : undefined} onClick={() => onTab?.(t.id)}>
      {t.id === "home" ? <img src="/brand/cap-neutral.webp" alt="" /> : t.icon}
    </button>)}
  </nav>;
}

/** A 0–100 safety score as a ring: green when the request is ordinary, amber when it needs a look, red when it is dangerous. */
export function SafetyScore({ value }: { value: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => { const t = setTimeout(() => setShown(value), 120); return () => clearTimeout(t); }, [value]);
  const color = value >= 75 ? "var(--positive)" : value >= 45 ? "var(--warning)" : "var(--negative)";
  const c = 2 * Math.PI * 19;
  return <div className="score" title="Safety score" aria-label={`Safety score ${value} of 100`}>
    <svg viewBox="0 0 46 46"><circle className="track" cx="23" cy="23" r="19" /><circle className="value" cx="23" cy="23" r="19" stroke={color} strokeDasharray={c} strokeDashoffset={c * (1 - shown / 100)} /></svg>
    <span style={{ color }}>{value}</span>
  </div>;
}

export function Steps({ at, of }: { at: number; of: number }) {
  return <div className="steps" aria-label={`Step ${at} of ${of}`}>{Array.from({ length: of }, (_, i) => <i key={i} className={i + 1 === at ? "on" : i + 1 < at ? "done" : ""} />)}</div>;
}
