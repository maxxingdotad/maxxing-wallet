import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronRight, Plus, RotateCcw, Trash2 } from "lucide-react";
import { ChainLogo } from "../ui/logos";
import { Busy, PageHead, message } from "./kit";
import { networkById, networks, registryHasChain, type Network } from "../lib/chains";
import { addCustomNetwork, addRpc, checkHealth, preferRpc, removeCustomNetwork, removeRpc, resetRpcs, rpcHost, rpcUrlProblem, type Health } from "../lib/user-networks";
import { userNetworksNow } from "../lib/user-networks-state";
import { activity, settings as settingsStore } from "../lib/store";

/** A network's tag: added by the user (or by a site they approved), never "verified". */
export function CustomTag({ network }: { network: Pick<Network, "custom" | "addedBy"> }) {
  if (!network.custom) return null;
  return <span className="tag warn" title="Not part of MAXXING's network list">{network.custom === "site" && network.addedBy ? `Added by ${new URL(network.addedBy).host}` : "Added by you"}</span>;
}

/** Settings → Networks: every network, how many endpoints it has, and the ones the user added. */
export function NetworksView({ onBack, onOpen, onAdd }: { onBack: () => void; onOpen: (networkId: string) => void; onAdd: () => void }) {
  const [testnets, setTestnets] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => { void settingsStore.read().then(s => setTestnets(s.showTestnets)); }, []);
  if (testnets === null) return <div className="popup"><div className="backdrop" /><PageHead title="Networks" onBack={onBack} /><Busy text="Loading…" /></div>;
  const user = userNetworksNow();
  const list = networks(testnets).filter(n => n.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Networks" onBack={onBack} right={<button type="button" className="chip" onClick={onAdd}><Plus size={14} /> Add</button>} />
    <div className="scroll" data-testid="networks">
      <input className="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search networks" aria-label="Search networks" style={{ marginBottom: 10 }} />
      <div className="card rows">{list.map(n => {
        const own = (user.rpcs[n.networkId]?.length ?? 0) + (n.custom ? n.rpc.length : 0);
        return <button key={n.networkId} type="button" className="row" style={{ width: "100%", textAlign: "left" }} onClick={() => onOpen(n.networkId)} data-network={n.networkId}>
          <ChainLogo networkId={n.networkId} name={n.name} size={28} />
          <div className="main"><b>{n.name}{n.custom && <> <CustomTag network={n} /></>}</b><small>{n.rpc.length} endpoint{n.rpc.length === 1 ? "" : "s"}{own && !n.custom ? ` · ${own} yours` : ""}{user.preferred[n.networkId] ? " · your choice first" : ""}</small></div>
          <ChevronRight size={16} style={{ color: "var(--dim)" }} />
        </button>;
      })}</div>
      <button type="button" className="btn secondary" style={{ marginTop: 12 }} onClick={onAdd}><Plus size={16} />Add a network</button>
    </div>
  </div>;
}

/**
 * One network's endpoints, checked live: each one's latest block and how fast it answered. The user can add their own (checked:
 * https, and the endpoint's chain id must match), choose which goes first, and go back to the registry's defaults.
 */
export function NetworkDetail({ networkId, onBack, toast }: { networkId: string; onBack: () => void; toast: (t: string) => void }) {
  const [version, setVersion] = useState(0);
  const network = useMemo(() => networkById(networkId), [networkId, version]);
  const [health, setHealth] = useState<Health[] | null>(null);
  const [url, setUrl] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { if (!network) return; setHealth(null); void checkHealth(network.rpc, network.family).then(setHealth); }, [network]);
  if (!network) return <div className="popup"><div className="backdrop" /><PageHead title="Network" onBack={onBack} /><div className="scroll"><div className="card empty">This network isn't here anymore.</div></div></div>;
  const user = userNetworksNow();
  const mine = new Set(network.custom ? network.rpc : user.rpcs[networkId] ?? []);
  const first = network.rpc[0];
  const changed = !network.custom && (!!user.rpcs[networkId]?.length || !!user.preferred[networkId]);
  const refresh = () => setVersion(v => v + 1);
  const problem = url ? rpcUrlProblem(url) : null;
  return <div className="popup"><div className="backdrop" />
    <PageHead title={network.name} onBack={onBack} />
    <div className="scroll" data-testid="network-detail">
      <div className="card row" style={{ minHeight: 60, marginBottom: 10 }}>
        <ChainLogo networkId={network.networkId} name={network.name} size={32} />
        <div className="main"><b>{network.name}{network.custom && <> <CustomTag network={network} /></>}</b><small>{network.family === "EVM" ? `Chain ID ${network.evmChainId}` : "Solana"} · {network.nativeSymbol} pays the fees</small></div>
      </div>
      {network.custom && <div className="alert warn" style={{ marginBottom: 10 }}><AlertTriangle size={16} /><span>You added this network. MAXXING doesn't check it: its endpoint decides what you see. No verified badges, gas-free or swaps here unless Relay lists it.</span></div>}
      <div className="section-head"><h2>Endpoints</h2><span style={{ fontSize: 12, color: "var(--muted)" }}>Tried in this order</span></div>
      <div className="card rows" data-testid="rpc-list">{network.rpc.map((u, i) => {
        const h = health?.find(x => x.url === u);
        return <div key={u} className="row rpc-row" data-rpc={rpcHost(u)}>
          <input type="radio" name="preferred" aria-label={`Use ${rpcHost(u)} first`} checked={u === first} onChange={async () => { await preferRpc(networkId, u); refresh(); toast(`${rpcHost(u)} goes first`); }} />
          <div className="main"><b style={{ overflowWrap: "anywhere" }}>{rpcHost(u)} {mine.has(u) && <span className="tag">Yours</span>}</b>
            <small className="num">{!health ? "Checking…" : !h?.ok ? <span className="down-text">Not answering</span> : `${h.ms} ms · ${network.family === "SOLANA" ? "slot" : "block"} ${h.head?.toLocaleString()}`}{i === 0 ? " · first" : ""}</small></div>
          <span className={`health-dot ${!health ? "" : h?.ok ? (h.ms! < 800 ? "good" : "slow") : "down"}`} aria-hidden="true" />
          {mine.has(u) && !network.custom && <button type="button" className="icon-btn small" aria-label={`Remove ${rpcHost(u)}`} onClick={async () => { await removeRpc(networkId, u); refresh(); }}><Trash2 size={14} /></button>}
        </div>;
      })}</div>
      {network.family === "EVM" && <form className="card" style={{ padding: 12, marginTop: 10 }} onSubmit={async e => {
        e.preventDefault();
        if (problem || !url.trim()) return;
        setBusy(true); setError("");
        try {
          await addRpc(network, url);
          await activity.add({ kind: "connect", text: `Added an endpoint for ${network.name}: ${rpcHost(url)}`, networkId });
          setUrl(""); refresh(); toast("Endpoint added. It's tried first.");
        } catch (err) { setError(message(err)); } finally { setBusy(false); }
      }}>
        <label className="field" style={{ margin: 0 }}>Add your own RPC URL
          <input value={url} onChange={e => { setUrl(e.target.value); setError(""); }} placeholder="https://…" autoComplete="off" spellCheck={false} data-testid="rpc-url" /></label>
        <div className="pw-note" role="alert">{problem ?? error}</div>
        <button type="submit" className="btn secondary" disabled={busy || !url.trim() || !!problem}>{busy ? "Checking the endpoint…" : "Check and add"}</button>
      </form>}
      {changed && <button type="button" className="btn secondary" style={{ marginTop: 10 }} onClick={async () => { await resetRpcs(networkId); refresh(); toast("Back to the default endpoints"); }}><RotateCcw size={16} />Reset to default</button>}
      {network.custom && <button type="button" className="btn secondary" style={{ marginTop: 10, color: "var(--negative)" }} onClick={async () => { await removeCustomNetwork(networkId); toast(`${network.name} removed`); onBack(); }}><Trash2 size={16} />Remove this network</button>}
    </div>
  </div>;
}

/** Adding an EVM network the registry doesn't have: its endpoint is asked for its chain id before anything is kept. */
export function AddNetwork({ onBack, onAdded, toast }: { onBack: () => void; onAdded: (networkId: string) => void; toast: (t: string) => void }) {
  const [form, setForm] = useState({ name: "", rpcUrl: "", chainId: "", symbol: "", explorerUrl: "" });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => { setForm(f => ({ ...f, [k]: e.target.value })); setError(""); };
  const problem = form.rpcUrl ? rpcUrlProblem(form.rpcUrl) : null;
  const ready = form.name.trim() && form.rpcUrl.trim() && /^\d+$/.test(form.chainId.trim()) && form.symbol.trim() && !problem;
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Add a network" onBack={onBack} />
    <form className="scroll stack" style={{ paddingBottom: 120 }} data-testid="add-network" onSubmit={async e => {
      e.preventDefault();
      if (!ready) return;
      setBusy(true); setError("");
      try {
        const n = await addCustomNetwork({ ...form, chainId: Number(form.chainId.trim()), registryHas: registryHasChain });
        await activity.add({ kind: "connect", text: `Added a network: ${n.name} (chain ${n.evmChainId}) at ${rpcHost(form.rpcUrl)}`, networkId: n.networkId });
        toast(`${n.name} added`); onAdded(n.networkId);
      } catch (err) { setError(message(err)); } finally { setBusy(false); }
    }}>
      <div className="alert warn"><AlertTriangle size={16} /><span><b>Only add a network you trust.</b> Its endpoint decides what you see: balances, fees and what a transaction does. A bad one can mislead you. MAXXING doesn't check it, and it never gets a verified badge.</span></div>
      <label className="field">Network name<input value={form.name} onChange={set("name")} placeholder="e.g. My Chain" maxLength={40} autoComplete="off" /></label>
      <label className="field">RPC URL<input value={form.rpcUrl} onChange={set("rpcUrl")} placeholder="https://…" autoComplete="off" spellCheck={false} />{problem && <span className="hint down-text">{problem}</span>}</label>
      <label className="field">Chain ID<input value={form.chainId} onChange={set("chainId")} placeholder="e.g. 31337" inputMode="numeric" autoComplete="off" /><span className="hint">Checked against the endpoint before it's added.</span></label>
      <label className="field">Coin symbol<input value={form.symbol} onChange={set("symbol")} placeholder="e.g. ETH" maxLength={12} autoComplete="off" /></label>
      <label className="field">Block explorer (optional)<input value={form.explorerUrl} onChange={set("explorerUrl")} placeholder="https://…" autoComplete="off" spellCheck={false} /></label>
      {error && <div className="alert danger" role="alert">{error}</div>}
    </form>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <button type="button" className="btn primary" disabled={!ready || busy} onClick={() => (document.querySelector('[data-testid="add-network"]') as HTMLFormElement | null)?.requestSubmit()}>{busy ? "Checking the endpoint…" : "Add network"}</button>
    </div>
  </div>;
}
