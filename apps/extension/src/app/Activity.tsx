import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUpRight, ExternalLink, Globe, KeyRound, Lock, Unlock } from "lucide-react";
import { Dock, type DockTab } from "../ui/parts";
import { ChainLogo } from "../ui/logos";
import { PageHead } from "./kit";
import { NetworkButton, NetworkSheet } from "./Assets";
import { activity as activityLog, settings as settingsStore, type Activity, type Settings, type TxStatus } from "../lib/store";
import { explorerTx, networkById, networks } from "../lib/chains";
import { sendStatus, settleSendActivity } from "../lib/send";

export type Filter = "all" | "tx" | "sites" | "security";
const FILTERS: { id: Filter; label: string }[] = [{ id: "all", label: "All" }, { id: "tx", label: "Transactions" }, { id: "sites", label: "Sites" }, { id: "security", label: "Security" }];
const KINDS: Record<Exclude<Filter, "all">, Activity["kind"][]> = { tx: ["send"], sites: ["connect", "sign", "revoke", "blocked"], security: ["lock", "unlock", "export"] };

/** An entry's status: its own field, or for entries written before statuses existed, read from the start of its text. */
export function statusOf(a: Activity): TxStatus | null {
  if (a.status) return a.status;
  if (a.kind !== "send") return null;
  if (/^Confirmed/.test(a.text)) return "confirmed";
  if (/^Failed/.test(a.text)) return "failed";
  if (/^Not sent/.test(a.text)) return "not-sent";
  return /^(Sent|Not confirmed yet|Swap step not confirmed)/.test(a.text) ? "pending" : null;
}

/**
 * What Activity shows for one account and network: wallet-wide events (locks, reveals, sites) under every account; transactions only
 * under the account that sent them. With one network picked, only that network's transactions.
 */
export function visibleActivity(items: readonly Activity[], account: { evm: string; solana: string }, network: string, filter: Filter): Activity[] {
  const mine = (a: Activity) => !a.account || a.account.toLowerCase() === account.evm.toLowerCase() || a.account === account.solana;
  return items.filter(a => mine(a) && (network === "all" || a.networkId === network) && (filter === "all" || KINDS[filter].includes(a.kind)));
}

const STATUS_TEXT: Record<TxStatus, string> = { pending: "Pending", confirmed: "Confirmed", failed: "Failed", "not-sent": "Not sent" };
const day = (at: number) => {
  const d = new Date(at), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  return diff === 0 ? "Today" : diff === 1 ? "Yesterday" : d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};
const icon = (kind: Activity["kind"]) => kind === "export" ? <KeyRound size={16} /> : kind === "blocked" ? <AlertTriangle size={16} /> : kind === "lock" ? <Lock size={16} /> : kind === "unlock" ? <Unlock size={16} /> : kind === "send" ? <ArrowUpRight size={16} /> : <Globe size={16} />;

export function ActivityView({ account, onTab }: { account: { evm: string; solana: string }; onTab: (t: DockTab) => void }) {
  const [items, setItems] = useState<Activity[] | null>(null);
  const [prefs, setPrefs] = useState<Settings | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const [all, s] = await Promise.all([activityLog.all(), settingsStore.read()]);
      if (!live) return;
      setItems(all); setPrefs(s);
      // Pending transactions from the last week: ask their network once where they stand, and record it.
      const known = networks(true);
      const open = all.filter(a => statusOf(a) === "pending" && a.hash && a.networkId && Date.now() - a.at < 7 * 86_400_000).slice(0, 10);
      const settled = await Promise.all(open.map(async a => {
        const n = known.find(x => x.networkId === a.networkId);
        const state = n ? await sendStatus(n, a.hash!).catch(() => "unknown" as const) : "unknown";
        if (state === "confirmed" || state === "failed") { await settleSendActivity(a.hash!, state); return true; }
        return false;
      }));
      if (live && settled.some(Boolean)) setItems(await activityLog.all());
    })();
    return () => { live = false; };
  }, []);
  const shown = useMemo(() => items && prefs ? visibleActivity(items, account, prefs.network, filter) : null, [items, prefs, account, filter]);
  const groups = useMemo(() => {
    const out: { day: string; items: Activity[] }[] = [];
    for (const a of shown ?? []) { const d = day(a.at); if (out.at(-1)?.day !== d) out.push({ day: d, items: [] }); out.at(-1)!.items.push(a); }
    return out;
  }, [shown]);
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Activity" right={prefs && <NetworkButton selected={prefs.network} onOpen={() => setPicking(true)} />} />
    <div className="scroll" data-testid="activity">
      <div className="seg" role="tablist" aria-label="Show" style={{ marginBottom: 10 }}>{FILTERS.map(f => <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? "on" : ""} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>
      {!shown ? <div className="card rows" aria-busy="true">{[0, 1, 2].map(i => <div key={i} className="row skeleton-row"><span className="sk sk-circle" /><div className="main"><span className="sk sk-line" /><span className="sk sk-line short" /></div></div>)}</div>
        : !shown.length ? <div className="card empty">{filter === "tx" || prefs?.network !== "all" ? "No transactions here yet. Sends and swaps from this account show up here with their status." : "Connections, signatures, sends, locks and exports show up here. They stay on this device."}</div>
        : groups.map(g => <section key={g.day}>
          <div className="day-head">{g.day}</div>
          <div className="card rows">{g.items.map((a, i) => {
            const status = statusOf(a), chain = a.networkId ? networkById(a.networkId) : null, url = chain && a.hash ? explorerTx(chain, a.hash) : null;
            const alarm = a.kind === "export" || a.kind === "blocked" || status === "failed";
            return <div key={`${a.at}-${i}`} className="row activity-row" data-kind={a.kind} data-status={status ?? undefined}>
              <span className="token-stack"><span className="logo" style={{ background: alarm ? "var(--negative-soft)" : "var(--surface-3)", color: alarm ? "var(--negative)" : "var(--text-2)" }}>{icon(a.kind)}</span>
                {chain && <span className="badge-logo"><ChainLogo networkId={chain.networkId} name={chain.name} size={15} /></span>}</span>
              <div className="main"><b>{a.text.replace(/ · [0-9A-Za-z]{40,}$/, "")}</b>
                <small>{a.site ? `${a.site.replace(/^https?:\/\//, "")} · ` : ""}{new Date(a.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}{chain ? ` · ${chain.name}` : ""}</small></div>
              <div className="end">
                {status && <span className={`status-tag ${status}`}>{STATUS_TEXT[status]}</span>}
                {url && <button type="button" className="icon-btn small" aria-label="View on explorer" onClick={() => void chrome.tabs.create({ url })}><ExternalLink size={14} /></button>}
              </div>
            </div>;
          })}</div>
        </section>)}
    </div>
    {picking && prefs && <NetworkSheet selected={prefs.network} showTestnets={prefs.showTestnets} onClose={() => setPicking(false)}
      onPick={async networkId => { setPicking(false); await settingsStore.write({ network: networkId }); setPrefs(await settingsStore.read()); }} />}
    <Dock tab="activity" onTab={onTab} />
  </div>;
}
