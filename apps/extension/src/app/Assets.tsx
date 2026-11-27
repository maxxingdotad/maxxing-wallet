import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, BadgeCheck, Check, ChevronDown, Eye, EyeOff, Plus, SlidersHorizontal } from "lucide-react";
import { ChainLogo, TokenLogo } from "../ui/logos";
import { usd, type Holding } from "../ui/parts";
import { Busy, PageHead, message, useEscape } from "./kit";
import { networkLabel, networks, type Network } from "../lib/chains";
import { CustomTag } from "./Networks";
import { assetKey, listAssets, spamCount, verifiedAssets, trustOf, type AssetPrefs, type AssetRef, type ListedAsset } from "../lib/assets";
import { assetPrefs } from "../lib/store";
import { rpc } from "../lib/rpc";

/** The header's network button: "All networks" or the chosen chain, with its logo. */
export function NetworkButton({ selected, onOpen }: { selected: string; onOpen: () => void }) {
  const chosen = selected === "all" ? null : networks(true).find(n => n.networkId === selected) ?? null;
  return <button type="button" className="chip network-chip" onClick={onOpen} aria-haspopup="dialog" aria-label={`Network: ${chosen ? networkLabel(chosen) : "All networks"}. Change`}>
    {chosen ? <ChainLogo networkId={chosen.networkId} name={chosen.name} size={16} /> : <span className="dot" style={{ background: "conic-gradient(#A36AFF, #3FD5F5, #E8E4DC, #A36AFF)" }} />}
    <span>{chosen?.name ?? "All"}</span>{chosen?.custom && <span className="tag warn" title={networkLabel(chosen)}>added</span>}<ChevronDown size={14} />
  </button>;
}

/** A form's network field: the chosen network with its logo; a tap opens the network sheet (never the system's dropdown). */
export function NetworkField({ network, onOpen, testId, label = "Network" }: { network: Network | null; onOpen: () => void; testId?: string; label?: string }) {
  return <button type="button" className="asset-field network-field" data-testid={testId} data-network={network?.networkId ?? ""} onClick={onOpen} aria-haspopup="dialog" aria-label={`${label}: ${network ? networkLabel(network) : "choose"}`}>
    {network ? <ChainLogo networkId={network.networkId} name={network.name} size={26} /> : <span className="dot" style={{ width: 26, height: 26, borderRadius: 999, background: "var(--surface-3)" }} />}
    <span className="main"><b>{network?.name ?? "Choose a network"}</b>{network && <small>{network.testnet ? "Test network" : `Fees in ${network.nativeSymbol}`}</small>}</span>
    <ChevronDown size={16} className="chev" />
  </button>;
}

/**
 * Every network from the registry (test networks only when turned on), plus "All networks". With `only`, the sheet chooses one
 * network from that list (no "All networks").
 */
export function NetworkSheet({ selected, showTestnets, onPick, onClose, only }: { selected: string; showTestnets: boolean; onPick: (networkId: string) => void; onClose: () => void; only?: Network[] }) {
  const list = only ?? networks(showTestnets);
  const [query, setQuery] = useState("");
  const shown = list.filter(n => n.name.toLowerCase().includes(query.trim().toLowerCase()));
  useEscape(onClose);
  // Drawn at the top of the popup, so it is never under a screen's bottom button or clipped by a scrolling list.
  return createPortal(<>
    <div className="scrim" onClick={onClose} />
    <section className="sheet" role="dialog" aria-modal="true" aria-label="Choose a network">
      <div className="grab" />
      <div className="sheet-head"><h2>Network</h2></div>
      <div style={{ padding: "0 12px 8px" }}><input className="search" autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search networks" aria-label="Search networks" /></div>
      <div style={{ overflowY: "auto", padding: "0 12px 12px" }}>
        <div className="card rows">
          {!query && !only && <button type="button" className="row" style={{ width: "100%", textAlign: "left" }} onClick={() => onPick("all")}>
            <span className="dot" style={{ width: 24, height: 24, borderRadius: 999, background: "conic-gradient(#A36AFF, #3FD5F5, #E8E4DC, #A36AFF)" }} />
            <div className="main"><b>All networks</b><small>{list.length} networks</small></div>
            {selected === "all" && <Check size={16} style={{ color: "var(--text)" }} />}
          </button>}
          {shown.map(n => <button type="button" key={n.networkId} className="row" style={{ width: "100%", textAlign: "left" }} onClick={() => onPick(n.networkId)}>
            <ChainLogo networkId={n.networkId} name={n.name} size={24} />
            <div className="main"><b>{n.name}{n.custom && <> <CustomTag network={n} /></>}</b><small>{n.testnet ? "Test network" : n.nativeSymbol}</small></div>
            {selected === n.networkId && <Check size={16} />}
          </button>)}
        </div>
        {!shown.length && <p className="empty-hint">No network matches “{query}”.</p>}
        {!showTestnets && !only && <p style={{ fontSize: 11.5, color: "var(--dim)", margin: "8px 4px 0" }}>Test networks are hidden. Turn them on in Settings.</p>}
      </div>
    </section>
  </>, document.querySelector(".popup") ?? document.body);
}

/** The trust mark next to a token: verified (the registry names it), or unverified. */
export function TrustMark({ trust }: { trust: "verified" | "unverified" | "spam" }) {
  if (trust === "verified") return <BadgeCheck size={13} aria-label="Verified" style={{ color: "var(--text-2)", verticalAlign: -2 }} />;
  return <span className="tag warn" title={trust === "spam" ? "Looks like spam" : "Not on MAXXING's lists"}>{trust === "spam" ? "Spam?" : "Unverified"}</span>;
}

/** Home's tokens: held ones and each network's defaults at 0, marked; spam counted, hidden unless shown. */
export function AssetList({ shown, holdings, prefs, hideBalances, pending, onOpen, onManage, onShowSpam }: {
  shown: Network[]; holdings: Holding[]; prefs: AssetPrefs; hideBalances?: boolean; /** Balances still being read: rows show, amounts wait. */ pending?: boolean;
  onOpen: (h: Holding) => void; onManage: () => void; onShowSpam: () => void;
}) {
  // Held value first; then the registry's network order, each network's coin before its tokens.
  const items = useMemo(() => {
    const order = new Map(shown.map((n, i) => [n.networkId, i]));
    return listAssets(shown, holdings.map(h => ({ ...h, networkId: h.networkId })), prefs)
      .sort((a, b) => (b.held?.usd ?? 0) - (a.held?.usd ?? 0) || Number(!!b.held) - Number(!!a.held)
        || (order.get(a.ref.networkId) ?? 0) - (order.get(b.ref.networkId) ?? 0) || Number(!!a.ref.address) - Number(!!b.ref.address) || a.ref.symbol.localeCompare(b.ref.symbol));
  }, [shown, holdings, prefs]);
  const spam = prefs.showSpam ? 0 : spamCount(shown, holdings.map(h => ({ ...h })));
  const byId = new Map(shown.map(n => [n.networkId, n]));
  return <>
    <div className="card rows" data-testid="asset-list">{items.map(a => {
      const n = byId.get(a.ref.networkId);
      const h = a.held ?? asHolding(a, n);
      return <button type="button" key={a.key} className="row asset-row" data-trust={a.trust} style={{ width: "100%", textAlign: "left" }} onClick={() => onOpen(h)}>
        <span className="token-stack"><TokenLogo symbol={a.ref.symbol} size={36} verified={a.trust === "verified"} />{n && <span className="badge-logo"><ChainLogo networkId={n.networkId} name={n.name} size={15} /></span>}</span>
        <div className="main"><b>{a.ref.name} <TrustMark trust={a.trust} /></b><small className="num">{hideBalances ? "••••" : pending && !a.held ? a.ref.symbol : `${a.held?.amount ?? "0"} ${a.ref.symbol}`} · {n && networkLabel(n)}</small></div>
        <div className="end">{pending && !a.held && !hideBalances ? <span className="sk sk-line" style={{ width: 56, height: 14 }} aria-label="Reading balance" /> : <b className="num">{hideBalances ? "••••" : a.held ? (a.held.priced === false ? "—" : usd(a.held.usd)) : "$0.00"}</b>}{a.held?.priced === false && <small>no price yet</small>}</div>
      </button>;
    })}</div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 2px" }}>
      <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={onManage}><SlidersHorizontal size={13} style={{ verticalAlign: -2 }} /> Manage assets</button>
      {spam > 0 && <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={onShowSpam}>{spam} hidden as possible spam · Show</button>}
    </div>
  </>;
}
function asHolding(a: ListedAsset<Holding>, n: Network | undefined): Holding {
  return { symbol: a.ref.symbol, name: a.ref.name, chain: { id: a.ref.networkId, name: n?.name ?? "", color: "#8E919A" }, amount: "0", usd: 0, change: 0, priced: true, raw: "0", decimals: a.ref.decimals, address: a.ref.address, networkId: a.ref.networkId };
}

/** Hide or show assets, show spam, and add a token by its address (with a warning: anyone can make a token with any name). */
export function ManageAssets({ shown, holdings, onBack }: { shown: Network[]; holdings: Holding[]; onBack: () => void }) {
  const [prefs, setPrefs] = useState<AssetPrefs | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => { void assetPrefs.read().then(setPrefs); }, []);
  if (!prefs) return <div className="popup"><div className="backdrop" /><Busy text="Loading…" /></div>;
  const save = async (change: (p: AssetPrefs) => AssetPrefs) => { await assetPrefs.update(change); setPrefs(await assetPrefs.read()); };
  if (adding) return <AddToken shown={shown} onBack={() => setAdding(false)} onAdd={async ref => { await save(p => ({ ...p, custom: [...p.custom.filter(c => assetKey(c.networkId, c.address) !== assetKey(ref.networkId, ref.address)), ref] })); setAdding(false); }} />;
  const all = listAssets(shown, holdings, { ...prefs, hidden: [], showSpam: true });
  const hidden = new Set(prefs.hidden);
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Manage assets" onBack={onBack} />
    <div className="scroll">
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, marginBottom: 10 }}>
        <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600 }}>Show possible spam</div><div style={{ fontSize: 12, color: "var(--muted)" }}>Tokens that advertise links or "claims" are hidden.</div></div>
        <button type="button" role="switch" aria-checked={prefs.showSpam} className={`toggle${prefs.showSpam ? " on" : ""}`} onClick={() => void save(p => ({ ...p, showSpam: !p.showSpam }))} />
      </div>
      <div className="card rows">{all.map(a => <div key={a.key} className="row">
        <TokenLogo symbol={a.ref.symbol} size={30} verified={a.trust === "verified"} />
        <div className="main"><b>{a.ref.symbol} <TrustMark trust={a.trust} /></b><small>{shown.find(n => n.networkId === a.ref.networkId)?.name}{a.custom ? " · added by you" : ""}</small></div>
        <button type="button" className="icon-btn" aria-label={hidden.has(a.key) ? `Show ${a.ref.symbol}` : `Hide ${a.ref.symbol}`} onClick={() => void save(p => ({ ...p, hidden: hidden.has(a.key) ? p.hidden.filter(k => k !== a.key) : [...p.hidden, a.key] }))}>
          {hidden.has(a.key) ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>)}</div>
    </div>
    <div className="footer"><button type="button" className="btn secondary" onClick={() => setAdding(true)}><Plus size={16} />Add a token by address</button></div>
  </div>;
}

/** Reads a token's symbol and decimals from the chain (EVM: symbol(), decimals(); Solana: the mint's decimals). */
async function readToken(n: Network, address: string): Promise<{ symbol: string; decimals: number }> {
  if (n.family === "SOLANA") {
    const info = await rpc<{ value: { data: { parsed?: { info?: { decimals?: number } } } } | null }>(n.rpc, "getAccountInfo", [address, { encoding: "jsonParsed" }]);
    const decimals = info.value?.data?.parsed?.info?.decimals;
    if (typeof decimals !== "number") throw new Error("That address isn't a token on this network.");
    return { symbol: `${address.slice(0, 4)}…`, decimals };
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("That isn't an EVM address (0x…).");
  const [sym, dec] = await Promise.all([
    rpc<string>(n.rpc, "eth_call", [{ to: address, data: "0x95d89b41" }, "latest"]), rpc<string>(n.rpc, "eth_call", [{ to: address, data: "0x313ce567" }, "latest"]),
  ]).catch(() => { throw new Error("That address isn't a token on this network."); });
  const decimals = Number(BigInt(dec || "0x0"));
  const hex = sym.replace(/^0x/, "");
  const len = hex.length >= 128 ? Number(BigInt(`0x${hex.slice(64, 128)}`)) : 0;
  const bytes = len ? hex.slice(128, 128 + len * 2) : hex.slice(0, 64).replace(/(00)+$/, "");
  const symbol = new TextDecoder().decode(Uint8Array.from((bytes.match(/../g) ?? []).map(b => parseInt(b, 16)))).replace(/[^\x20-\x7e]/g, "").slice(0, 16);
  if (!symbol || decimals > 36) throw new Error("That address isn't a token on this network.");
  return { symbol, decimals };
}

function AddToken({ shown, onBack, onAdd }: { shown: Network[]; onBack: () => void; onAdd: (ref: AssetRef) => Promise<void> }) {
  const [networkId, setNetworkId] = useState(shown[0]?.networkId ?? "");
  const [picking, setPicking] = useState(false);
  const [address, setAddress] = useState(""), [found, setFound] = useState<AssetRef | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  // Any network can be chosen, not only the one the home screen is filtered to (it starts on that one).
  const choices = useMemo(() => networks(shown.some(x => x.testnet)), [shown]);
  const n = choices.find(x => x.networkId === networkId);
  const trust = found && n ? trustOf(found, verifiedAssets([n])) : null;
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Add a token" onBack={onBack} />
    <form className="scroll stack" onSubmit={async e => {
      e.preventDefault(); if (!n) return; setBusy(true); setError(""); setFound(null);
      try { const t = await readToken(n, address.trim()); setFound({ networkId, address: address.trim(), symbol: t.symbol, name: t.symbol, decimals: t.decimals }); } catch (err) { setError(message(err)); } finally { setBusy(false); }
    }}>
      <div className="alert warn"><AlertTriangle size={16} /><span><b>Anyone can make a token with any name.</b> Add only a token you got from a source you trust. A token here isn't checked by MAXXING.</span></div>
      <div className="field">Network<NetworkField network={n ?? null} onOpen={() => setPicking(true)} testId="add-token-network" /></div>
      <label className="field">Token address<input value={address} onChange={e => { setAddress(e.target.value); setFound(null); }} placeholder={n?.family === "SOLANA" ? "Mint address" : "0x…"} spellCheck={false} autoComplete="off" /></label>
      {busy && <Busy text="Reading the token…" />}
      {error && <div className="alert danger" role="alert">{error}</div>}
      {found && <div className="card facts"><div className="fact"><span>Symbol</span><b>{found.symbol} {trust && <TrustMark trust={trust} />}</b></div><div className="fact"><span>Decimals</span><b>{found.decimals}</b></div></div>}
      {!found ? <button type="submit" className="btn secondary" disabled={!address.trim() || busy}>Look it up</button>
        : <button type="button" className="btn primary" onClick={() => void onAdd(found)}>Add {found.symbol}</button>}
    </form>
    {picking && <NetworkSheet only={choices} selected={networkId} showTestnets onClose={() => setPicking(false)} onPick={id => { setNetworkId(id); setFound(null); setPicking(false); }} />}
  </div>;
}
