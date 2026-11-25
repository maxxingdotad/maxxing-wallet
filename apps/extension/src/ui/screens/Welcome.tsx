/**
 * The first screen: the MAXXING cap drops in, the orbit draws itself around it, and the chains you'll hold settle into orbit.
 * All motion is CSS (styles.css, "Onboarding") and stops under prefers-reduced-motion.
 */
export function Welcome({ onCreate, onImport }: { onCreate?: () => void; onImport?: () => void }) {
  return <div className="popup welcome">
    <div className="backdrop" />
    <div className="stage" aria-hidden="true">
      <div className="halo" />
      <svg className="paths" viewBox="-180 -190 360 380">
        <defs>
          <linearGradient id="welcome-orbit" x1="0" x2="1" y1="1" y2="0">
            <stop offset="0" stopColor="#A36AFF" /><stop offset=".5" stopColor="#E8E4DC" stopOpacity=".7" /><stop offset="1" stopColor="#3FD5F5" />
          </linearGradient>
        </defs>
        <path className="orbit-line" stroke="url(#welcome-orbit)" d="M -132 18 C -132 -60, 132 -96, 132 -18 C 132 60, -132 96, -132 18 Z" />
        <path className="orbit-line b" stroke="url(#welcome-orbit)" d="M -110 40 C -110 -40, 110 -60, 110 0 C 110 60, -110 110, -110 40 Z" />
      </svg>
      <div className="cap-shadow" />
      <img className="cap" src="/brand/cap.webp" alt="" />
      <span className="sat s1"><img src="/brand/eth-symbol.webp" alt="" /></span>
      <span className="sat s2"><img src="/brand/sol-symbol.webp" alt="" /></span>
      <span className="sat s3"><img src="/brand/base-symbol.webp" alt="" /></span>
      <span className="sat s4" style={{ background: "#0C0D0F", color: "#F4F4F5", fontSize: 11, fontWeight: 800 }}>M</span>
    </div>
    <div className="welcome-copy">
      <div className="wordmark">MAXXING WALLET</div>
      <h1>Every chain.<br /><em>One balance.</em> Your keys.</h1>
      <p>Hold, swap and send across Solana and every EVM chain. Pay fees with what you hold. Your recovery phrase never leaves this device.</p>
    </div>
    <div className="footer">
      <button type="button" className="btn primary" onClick={onCreate}>Create a new wallet</button>
      <button type="button" className="btn ghost" onClick={onImport}>I already have a wallet</button>
    </div>
  </div>;
}
