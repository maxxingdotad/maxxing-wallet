import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowUpRight, ExternalLink, Globe, KeyRound, Lock, Unlock } from "lucide-react";
import { formatUnits } from "viem";
import { Dock, usd, type DockTab } from "../ui/parts";
import { ChainLogo } from "../ui/logos";
import { HoldButton } from "../ui/moving";
import { Busy, PageHead, message, useToast } from "./kit";
import { NetworkButton, NetworkSheet } from "./Assets";
import { activity as activityLog, settings as settingsStore, type Activity, type Settings, type TxStatus } from "../lib/store";
import { explorerTx, networkById, networks } from "../lib/chains";
import { sendStatus, settleSendActivity } from "../lib/send";
import { ReplaceError, describe, draftReplacement, markReplaced, replaceMessage, replacedElsewhere, sendReplacement, type ReplaceKind, type Replacement } from "../lib/replace";
import { price } from "../lib/market";

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

const STATUS_TEXT: Record<TxStatus, string> = { pending: "Pending", confirmed: "Confirmed", failed: "Failed", "not-sent": "Not sent", replaced: "Replaced", cancelled: "Cancelled" };

/** A waiting transaction this account sent on an EVM network can be sped up or cancelled (lib/replace.ts). */
export function replaceable(a: Activity, account: { evm: string }): boolean {
  return a.kind === "send" && statusOf(a) === "pending" && !!a.hash && !!a.networkId?.startsWith("eip155:") && a.account?.toLowerCase() === account.evm.toLowerCase();
}
/** While transactions wait, their networks are asked again this often. */
const RECHECK_MS = 6000;
const coin = (wei: bigint) => Number(formatUnits(wei, 18)).toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false });
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
  const [replacing, setReplacing] = useState<{ entry: Activity; kind: ReplaceKind; draft: Replacement | null; feeUsd: number | null; error: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [toast, showToast] = useToast();
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  /** Reads the list, asks the networks where the waiting transactions of the last week stand, and records what is settled. */
  const refresh = useCallback(async () => {
    const all = await activityLog.all();
    if (!live.current) return;
    setItems(all);
    const known = networks(true);
    const open = all.filter(a => statusOf(a) === "pending" && a.hash && a.networkId && Date.now() - a.at < 7 * 86_400_000).slice(0, 10);
    const settled = await Promise.all(open.map(async a => {
      const n = known.find(x => x.networkId === a.networkId);
      const state = n ? await sendStatus(n, a.hash!).catch(() => "error" as const) : "error";
      if (state === "confirmed" || state === "failed") { await settleSendActivity(a.hash!, state); return true; }
      // No node knows it and its nonce is used: something else took its place.
      if (state === "unknown" && n && await replacedElsewhere(n, a).catch(() => false)) { await markReplaced(a.hash!); return true; }
      return false;
    }));
    if (live.current && settled.some(Boolean)) setItems(await activityLog.all());
  }, []);
  useEffect(() => { void settingsStore.read().then(s => { if (live.current) setPrefs(s); }); void refresh(); }, [refresh]);
  // While something waits, ask again every few seconds, so a speed-up or cancel shows its outcome without reopening the screen.
  const waiting = !!items?.some(a => statusOf(a) === "pending" && a.hash && Date.now() - a.at < 7 * 86_400_000);
  useEffect(() => { if (!waiting) return; const t = setInterval(() => void refresh(), RECHECK_MS); return () => clearInterval(t); }, [waiting, refresh]);

  const startReplace = async (entry: Activity, kind: ReplaceKind) => {
    const network = networks(true).find(n => n.networkId === entry.networkId);
    if (!network) return;
    setReplacing({ entry, kind, draft: null, feeUsd: null, error: "" });
    try {
      const draft = await draftReplacement({ network, from: account.evm, hash: entry.hash!, kind });
      setReplacing({ entry, kind, draft, feeUsd: null, error: "" });
      const fee = Number(formatUnits(draft.newMaxFee, 18));
      void price(network.networkId, null).then(p => setReplacing(r => r && r.draft === draft ? { ...r, feeUsd: p.priceUsd === null ? null : fee * p.priceUsd } : r));
    } catch (e) {
      // Already in a block: nothing to replace, and the list should say so now.
      if (e instanceof ReplaceError && e.reason === "landed") void refresh();
      setReplacing({ entry, kind, draft: null, feeUsd: null, error: e instanceof ReplaceError ? e.message : replaceMessage(message(e)) });
    }
  };

  const shown = useMemo(() => items && prefs ? visibleActivity(items, account, prefs.network, filter) : null, [items, prefs, account, filter]);
  const groups = useMemo(() => {
    const out: { day: string; items: Activity[] }[] = [];
    for (const a of shown ?? []) { const d = day(a.at); if (out.at(-1)?.day !== d) out.push({ day: d, items: [] }); out.at(-1)!.items.push(a); }
    return out;
  }, [shown]);

  if (busy) return <div className="popup"><div className="backdrop" /><PageHead title={replacing?.kind === "cancel" ? "Cancel" : "Speed up"} /><Busy text={busy} /></div>;
  if (replacing) {
    const { entry, kind, draft, feeUsd, error } = replacing, network = entry.networkId ? networkById(entry.networkId) : null;
    const cancel = kind === "cancel", symbol = network?.nativeSymbol ?? "";
    return <div className="popup"><div className="backdrop" />
      <PageHead title={cancel ? "Cancel" : "Speed up"} onBack={() => setReplacing(null)} />
      <div className="scroll stack" style={{ paddingBottom: 130 }} data-testid="replace-review" data-kind={kind}>
        <h1 className="ask-title" style={{ margin: "4px 2px 0" }}>{cancel ? "Cancel this transaction?" : "Speed up this transaction?"}</h1>
        <p className="ask-sub" style={{ margin: "0 2px" }}>{cancel
          ? `The wallet sends 0 ${symbol} to yourself in its place, with a higher fee. If that gets into a block first, the original never will, and you pay the fee below.`
          : "The wallet sends the same transaction again with a higher fee, so the network picks it up sooner. Only one of the two can land."}</p>
        <div className="card facts">
          <div className="fact"><span>Transaction</span><b>{describe(entry)}</b></div>
          <div className="fact"><span>Network</span><b>{network?.name ?? "—"}</b></div>
          {draft && <div className="fact"><span>Network fee, at most</span><b className="num" data-testid="replace-fee">{coin(draft.newMaxFee)} {symbol}{feeUsd !== null && <span className="muted" style={{ fontSize: 12 }}> ≈ {feeUsd < 0.01 ? "< $0.01" : usd(feeUsd)}</span>}</b></div>}
          {draft && <div className="fact"><span>{cancel ? "The original's fee, at most" : "Was, at most"}</span><b className="num">{coin(draft.oldMaxFee)} {symbol}</b></div>}
          {draft && <div className="fact"><span>Nonce</span><b className="num">{draft.nonce}</b></div>}
        </div>
        {draft && <div className="alert warn"><AlertTriangle size={16} /><span>{cancel ? "A cancel can come too late: if the original is already on its way into a block, it still goes through." : "If the original lands first, this one is dropped and costs nothing."}</span></div>}
        {!draft && !error && <Busy text="Reading the transaction from the network…" />}
        {error && <div className="alert danger" role="alert">{error}</div>}
      </div>
      <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
        {draft ? <HoldButton label={cancel ? "Cancel transaction" : "Speed up"} busyLabel="Sending…" onConfirm={async () => {
          setBusy("Signing and sending…");
          try {
            await sendReplacement(draft);
            showToast(cancel ? "Cancel sent. Activity shows which of the two lands." : "Sent again with a higher fee.");
            setReplacing(null); void refresh();
          } catch (e) { setReplacing({ ...replacing, error: replaceMessage(message(e)) }); void refresh(); }
          finally { setBusy(""); }
        }} /> : <button type="button" className="btn secondary" onClick={() => setReplacing(null)}>Back</button>}
      </div>
    </div>;
  }
  return<div className="popup"><div className="backdrop" />
    <PageHead title="Activity" right={prefs && <NetworkButton selected={prefs.network} onOpen={() => setPicking(true)} />} />
    <div className="scroll" data-testid="activity">
      <div className="seg" role="tablist" aria-label="Show" style={{ marginBottom: 10 }}>{FILTERS.map(f => <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? "on" : ""} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>
      {!shown ? <div className="card rows" aria-busy="true">{[0, 1, 2].map(i => <div key={i} className="row skeleton-row"><span className="sk sk-circle" /><div className="main"><span className="sk sk-line" /><span className="sk sk-line short" /></div></div>)}</div>
        : !shown.length ? <div className="blank"><span className="blank-mark"><ArrowUpRight size={22} /></span><b>{filter === "tx" || prefs?.network !== "all" ? "No transactions here yet" : "Nothing here yet"}</b>
          <p>{filter === "tx" || prefs?.network !== "all" ? "Sends and swaps from this account show up here with their status." : "Connections, signatures, sends, locks and exports show up here. They stay on this device."}</p></div>
        : groups.map(g => <section key={g.day}>
          <div className="day-head">{g.day}</div>
          <div className="card rows">{g.items.map((a, i) => {
            const status = statusOf(a), chain = a.networkId ? networkById(a.networkId) : null, url = chain && a.hash ? explorerTx(chain, a.hash) : null;
            const alarm = a.kind === "export" || a.kind === "blocked" || status === "failed";
            return <div key={`${a.at}-${i}`} className="row activity-row" data-kind={a.kind} data-status={status ?? undefined}>
              <span className="token-stack"><span className="logo" style={{ background: alarm ? "var(--negative-soft)" : "var(--surface-3)", color: alarm ? "var(--negative)" : "var(--text-2)" }}>{icon(a.kind)}</span>
                {chain && <span className="badge-logo"><ChainLogo networkId={chain.networkId} name={chain.name} size={15} /></span>}</span>
              <div className="main"><b>{a.text.replace(/ · [0-9A-Za-z]{40,}$/, "")}</b>
                <small>{a.site ? `${a.site.replace(/^https?:\/\//, "")} · ` : ""}{new Date(a.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}{chain ? ` · ${chain.name}` : ""}</small>
                {replaceable(a, account) && <span className="row-actions">
                  <button type="button" className="chip" data-testid="speed-up" onClick={() => void startReplace(a, "speed-up")}>Speed up</button>
                  <button type="button" className="chip" data-testid="cancel-tx" onClick={() => void startReplace(a, "cancel")}>Cancel</button>
                </span>}</div>
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
    {toast}
  </div>;
}
