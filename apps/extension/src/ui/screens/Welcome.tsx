import { LiquidText } from "../metal";

/**
 * The first screen, kept to four things: the MAXXING wordmark, one line, the two buttons, and the cap at the bottom edge.
 * The only motion is the cap rising in once (styles.css, "Brand screens"); none under prefers-reduced-motion.
 */
export function Welcome({ onCreate, onImport }: { onCreate?: () => void; onImport?: () => void }) {
  return <div className="popup brand-screen" data-testid="welcome">
    <div className="brand-body">
      <BrandMark />
      <p className="brand-line">Every chain. One balance. Your keys.</p>
      <div className="brand-actions">
        <button type="button" className="btn primary" onClick={onCreate}>Create a new wallet</button>
        <button type="button" className="btn ghost" onClick={onImport}>I already have a wallet</button>
      </div>
    </div>
    <BrandCap />
  </div>;
}

/** The wordmark: MAXXING, big and tight, with WALLET spaced out under it. */
export function BrandMark({ as: Tag = "h1" }: { as?: "h1" | "div" }) {
  return <Tag className="brand-mark" aria-label="MAXXING Wallet"><LiquidText>MAXXING</LiquidText><small aria-hidden="true">WALLET</small></Tag>;
}

/** The cap, large, cropped by the bottom edge of the screen. It rises in from below once, then stays still. */
export function BrandCap({ className = "" }: { className?: string }) {
  return <div className={`brand-cap ${className}`} aria-hidden="true"><img src="/brand/cap-real.webp" alt="" draggable={false} /></div>;
}
