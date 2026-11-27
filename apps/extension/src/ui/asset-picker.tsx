import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Search } from "lucide-react";
import { ChainLogo, TokenLogo } from "./logos";
import { useEscape } from "../app/kit";

/**
 * A token on its network: its logo with the network's as a badge, from the bundled icons only. `verified`: the branded logo,
 * for a registry token or a coin (anyone can name a token "USDC"; an unverified one gets its initials).
 */
export function AssetMark({ symbol, networkId, networkName, size = 30, verified = true }: { symbol: string; networkId: string; networkName: string; size?: number; verified?: boolean }) {
  return <span className="asset-mark" style={{ width: size, height: size }}>
    <TokenLogo symbol={symbol} size={size} verified={verified} />
    <span className="asset-badge"><ChainLogo networkId={networkId} name={networkName} size={Math.round(size * .46)} /></span>
  </span>;
}

export type AssetChoice = { key: string; mark: ReactNode; title: string; sub: string; end?: string };

/**
 * Choosing a token, as a sheet: every choice with its logo, network and (for what you hold) the amount; typing filters by token
 * or network. The chosen one is ticked. Each row carries its key (`data-key`) for tests.
 */
export function AssetSheet({ title, choices, selected, onPick, onClose }: { title: string; choices: AssetChoice[]; selected?: string; onPick: (key: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  useEscape(onClose);
  const q = query.trim().toLowerCase();
  const shown = q ? choices.filter(c => c.title.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q)) : choices;
  // Drawn at the top of the popup, not where it's used: inside a scrolling form it would sit under the screen's bottom button.
  return createPortal(<>
    <div className="scrim" onClick={onClose} />
    <section className="sheet asset-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <div className="grab" />
      <div className="sheet-head"><h2>{title}</h2></div>
      {choices.length > 6 && <div className="asset-search"><Search size={15} /><input autoFocus placeholder="Token or network" value={query} onChange={e => setQuery(e.target.value)} /></div>}
      <div className="asset-list">
        {shown.map(c => <button key={c.key} type="button" className={`asset-row${selected === c.key ? " on" : ""}`} data-key={c.key} onClick={() => { onPick(c.key); onClose(); }}>
          {c.mark}
          <span className="main"><b>{c.title}</b><small>{c.sub}</small></span>
          {c.end && <span className="num end">{c.end}</span>}
          {selected === c.key && <Check size={16} className="end-check" />}
        </button>)}
        {!shown.length && <p className="empty-hint">Nothing matches “{query}”.</p>}
      </div>
    </section>
  </>, document.querySelector(".popup") ?? document.body);
}
