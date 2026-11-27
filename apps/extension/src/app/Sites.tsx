import { useEffect, useState } from "react";
import { ChevronDown, Globe, Unplug } from "lucide-react";
import { ChainLogo } from "../ui/logos";
import { NetworkSheet } from "./Assets";
import { short } from "../ui/parts";
import { PageHead } from "./kit";
import { activity, settings as settingsStore, sites as siteStore, type SitePermission } from "../lib/store";
import { evmNetwork, networkLabel, networks } from "../lib/chains";
import * as wallet from "../lib/wallet";

/** Which account a site was connected with, by name, or its short address if it's in no wallet here. */
function accountNamed(snap: wallet.WalletSnapshot, evm: string) {
  for (const w of snap.accounts) for (const a of w.accounts) if (a.evm.toLowerCase() === evm.toLowerCase())
    return (w.accounts.length > 1 || snap.accounts.length > 1) && a.label !== w.label ? `${w.label} · ${a.label}` : a.label;
  return short(evm);
}

/**
 * Connected sites: each with the account it was connected with and the network it's on (kept per site). Changing the network here
 * moves the site's open pages to it; disconnecting stops the site seeing the addresses at once.
 */
export function ConnectedSites({ snap, onBack, toast }: { snap: wallet.WalletSnapshot; onBack: () => void; toast: (t: string) => void }) {
  const [list, setList] = useState<SitePermission[] | null>(null);
  const [testnets, setTestnets] = useState(false);
  const [picking, setPicking] = useState<SitePermission | null>(null);
  useEffect(() => { void siteStore.all().then(setList); void settingsStore.read().then(s => setTestnets(s.showTestnets)); }, []);
  const evm = networks(testnets).filter(n => n.family === "EVM" && n.evmChainId);
  const refresh = async () => { await wallet.announce(); setList(await siteStore.all()); };
  const disconnect = async (origin: string) => { await siteStore.revoke(origin); await activity.add({ kind: "revoke", text: "Disconnected a site", site: origin }); await refresh(); toast("Disconnected"); };
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Connected sites" onBack={onBack} />
    <div className="scroll" data-testid="connected-sites">
      {!list ? null : list.length === 0 ? <div className="card empty"><Globe size={22} style={{ display: "block", margin: "0 auto 8px", color: "var(--muted)" }} />No site is connected. Sites ask first, and you choose.</div> : <>
        <p className="receive-note" style={{ margin: "0 4px 10px" }}>A connected site sees your public addresses. It can't move anything: every signature asks you here.</p>
        <div className="card rows">{list.map(s => {
          const host = new URL(s.origin).host, chain = s.chainId ? evmNetwork(s.chainId) : null;
          return <div key={s.origin} className="row site-row" style={{ flexWrap: "wrap", rowGap: 8 }}>
            <span className="favicon" style={{ width: 32, height: 32, borderRadius: 9, background: "var(--surface-3)", display: "grid", placeItems: "center", fontWeight: 700 }}>{host[0]!.toUpperCase()}</span>
            <div className="main"><b style={{ overflowWrap: "anywhere" }}>{host}</b><small className="num">{accountNamed(snap, s.evm)} · last used {new Date(s.lastUsedAt).toLocaleDateString()}</small></div>
            <button type="button" className="icon-btn small" aria-label={`Disconnect ${host}`} onClick={() => void disconnect(s.origin)}><Unplug size={15} /></button>
            <button type="button" className="site-network" data-testid="site-network" data-chain={s.chainId ?? ""} aria-haspopup="dialog" aria-label={`Network for ${host}: ${chain ? networkLabel(chain) : "the site's choice"}. Change`} onClick={() => setPicking(s)}>
              {chain ? <ChainLogo networkId={chain.networkId} name={chain.name} size={18} /> : <Globe size={16} />}
              <span>{chain ? networkLabel(chain) : "The site's choice"}</span><ChevronDown size={14} />
            </button>
          </div>;
        })}</div>
        {picking && <NetworkSheet only={evm} showTestnets selected={evm.find(n => n.evmChainId === picking.chainId)?.networkId ?? ""} onClose={() => setPicking(null)} onPick={async networkId => {
          const next = evm.find(n => n.networkId === networkId), site = picking, host = new URL(site.origin).host;
          setPicking(null);
          if (!next?.evmChainId) return;
          await siteStore.setChain(site.origin, next.evmChainId);
          await activity.add({ kind: "connect", text: `Switched the site to ${next.name}`, site: site.origin, networkId: next.networkId });
          await refresh(); toast(`${host} is on ${next.name}`);
        }} />}
        <button type="button" className="btn secondary" style={{ marginTop: 12 }} onClick={async () => { for (const s of list) await siteStore.revoke(s.origin); await activity.add({ kind: "revoke", text: `Disconnected all ${list.length} sites` }); await refresh(); toast("All sites disconnected"); }}>Disconnect all</button>
      </>}
    </div>
  </div>;
}
