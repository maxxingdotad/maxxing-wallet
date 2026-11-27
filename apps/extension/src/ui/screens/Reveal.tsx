import { useEffect, useState, type ReactNode } from "react";

/**
 * The moment a wallet is ready: the cap at the top, the wallet's own EVM and Solana addresses decoding on a card, then the words
 * and the next step. Calm on purpose: it opens straight away, and the only motion is the card coming in and the decode
 * (instant under prefers-reduced-motion).
 */
const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function WalletReveal({ addresses, title, children, footer, onOpened, steps }: {
  addresses: { evm: string; solana: string } | null;
  title: string;
  /** Kept for callers; the screen always opens at once now. */
  opened?: boolean;
  onOpened?: () => void;
  /** The step dots, shown at the top. */
  steps?: ReactNode;
  /** The text under the title. */
  children?: ReactNode;
  /** The buttons. */
  footer: ReactNode;
}) {
  useEffect(() => { onOpened?.(); }, []);
  return <div className="popup reveal open" data-testid="wallet-reveal" data-phase="open">
    <div className="backdrop" />
    {steps && <div className="reveal-steps">{steps}</div>}
    <div className="reveal-stage" aria-hidden="true"><img className="reveal-hat" src="/brand/cap-real.webp" alt="" draggable={false} /></div>
    <div className="reveal-body">
      <div className="reveal-card" aria-live="polite">
        <AddressRow label="EVM" value={addresses?.evm ?? ""} delay={150} note="Every EVM chain" />
        <AddressRow label="Solana" value={addresses?.solana ?? ""} delay={330} />
      </div>
      <div className="reveal-copy">
        <h2 className="center-title">{title}</h2>
        {children}
      </div>
    </div>
    <div className="footer reveal-footer">{footer}</div>
  </div>;
}

const shortened = (a: string) => a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
const GLYPHS = "0123456789abcdefABCDEFGHJKLMNPQRSTUVWXYZ";

/** One address, decoding from noise to its real characters left to right (instant under reduced motion). */
function AddressRow({ label, value, delay, note }: { label: string; value: string; delay: number; note?: string }) {
  const target = shortened(value);
  const [text, setText] = useState("");
  useEffect(() => {
    if (!target) return;
    if (reducedMotion()) { setText(target); return; }
    let frame = 0, raf = 0;
    const start = performance.now() + delay, length = 520;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / length));
      const fixed = Math.floor(t * target.length);
      setText(target.split("").map((c, i) => i < fixed || c === "…" ? c : GLYPHS[(i * 7 + frame) % GLYPHS.length]).join(""));
      frame++;
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, delay]);
  return <div className="reveal-row">
    <span>{label}{note && <small>{note}</small>}</span>
    <b className="num" title={value} aria-label={`${label} address ${value}`}>{text || <i className="reveal-blank" aria-hidden="true" />}</b>
  </div>;
}
