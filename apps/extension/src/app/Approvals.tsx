import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { formatUnits } from "viem";
import { ChainLogo, TokenLogo } from "../ui/logos";
import { short, usd } from "../ui/parts";
import { Busy, PageHead, message } from "./kit";
import { NetworkButton, NetworkSheet } from "./Assets";
import { approvals, readApprovals, revokeCall, type LiveApproval } from "../lib/approvals";
import { shownNetworks } from "../lib/balances";
import { draftEvmCall, maxFeeOf, sendEvm, type EvmDraft } from "../lib/send";
import { price } from "../lib/market";
import { settings as settingsStore, type Settings } from "../lib/store";

/**
 * Token approvals this wallet gave, still open on chain, per network: who may spend what. Revoking builds approve(spender, 0)
 * (or ends a collection's access), shown in the same review as any send before it is signed.
 */
export function ApprovalsView({ account, onBack, toast }: { account: { evm: string }; onBack: () => void; toast: (t: string) => void }) {
  const [prefs, setPrefs] = useState<Settings | null>(null);
  const [live, setLive] = useState<LiveApproval[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [revoking, setRevoking] = useState<{ item: LiveApproval; draft: EvmDraft | null; feeUsd: number | null; error: string } | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(async () => {
    setLive(null);
    const s = await settingsStore.read(); setPrefs(s);
    const shown = shownNetworks(s.showTestnets, s.network).filter(n => n.family === "EVM");
    const ids = new Set(shown.map(n => n.networkId));
    setLive(await readApprovals(account.evm, (await approvals.all()).filter(r => ids.has(r.networkId)), shown));
  }, [account.evm]);
  useEffect(() => { void load(); }, [load]);
  const networkOf = (id: string) => shownNetworks(true).find(n => n.networkId === id);

  const startRevoke = async (item: LiveApproval) => {
    const network = networkOf(item.networkId);
    if (!network) return;
    setRevoking({ item, draft: null, feeUsd: null, error: "" });
    try {
      const call = revokeCall(item);
      const draft = await draftEvmCall({ network, from: account.evm, call: { to: call.to, value: 0n, data: call.data } });
      setRevoking({ item, draft, feeUsd: null, error: "" });
      const fee = Number(formatUnits(maxFeeOf(draft.transaction as { gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint }), 18));
      void price(network.networkId, null).then(p => setRevoking(r => r && r.draft === draft ? { ...r, feeUsd: p.priceUsd === null ? null : fee * p.priceUsd } : r));
    } catch (e) { setRevoking({ item, draft: null, feeUsd: null, error: message(e) }); }
  };

  if (busy) return <div className="popup"><div className="backdrop" /><PageHead title="Revoke" /><Busy text={busy} /></div>;
  if (revoking) {
    const { item, draft, feeUsd, error } = revoking, network = networkOf(item.networkId);
    return <div className="popup"><div className="backdrop" />
      <PageHead title="Revoke" onBack={() => setRevoking(null)} />
      <div className="scroll stack" style={{ paddingBottom: 130 }} data-testid="revoke-review">
        <h1 className="ask-title" style={{ margin: "4px 2px 0" }}>{draft?.summary.tokenCall?.text ?? `Remove ${short(item.spender)}'s access to your ${item.symbol}`}</h1>
        <p className="ask-sub" style={{ margin: "0 2px" }}>On {network?.name}. After this, {short(item.spender)} can't spend your {item.symbol} until you approve it again.</p>
        <div className="card facts">
          <div className="fact"><span>Token</span><b className="num">{item.symbol} · {short(item.token)}</b></div>
          <div className="fact"><span>Spender</span><b className="num">{short(item.spender)}</b></div>
          {draft && <div className="fact"><span>Network fee, at most</span><b>{draft.summary.maxFee ?? "—"}{feeUsd !== null && <span className="muted" style={{ fontSize: 12 }}> ≈ {feeUsd < 0.01 ? "< $0.01" : usd(feeUsd)}</span>}</b></div>}
        </div>
        {!draft && !error && <Busy text="Preparing…" />}
        {error && <div className="alert danger" role="alert">{error}</div>}
      </div>
      <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><div className="btn-row">
        <button type="button" className="btn secondary" onClick={() => setRevoking(null)}>Back</button>
        <button type="button" className="btn primary" disabled={!draft} onClick={async () => {
          setBusy("Signing and sending…");
          try { await sendEvm(draft!); toast("Revoke sent. It disappears here once confirmed."); setRevoking(null); void load(); }
          catch (e) { setRevoking({ ...revoking, error: message(e) }); }
          finally { setBusy(""); }
        }}>Confirm revoke</button>
      </div></div>
    </div>;
  }

  const groups = new Map<string, LiveApproval[]>();
  for (const a of live ?? []) groups.set(a.networkId, [...(groups.get(a.networkId) ?? []), a]);
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Approvals" onBack={onBack} right={prefs && <NetworkButton selected={prefs.network} onOpen={() => setPicking(true)} />} />
    <div className="scroll" data-testid="approvals">
      <p className="receive-note" style={{ margin: "0 4px 10px" }}>Contracts you let spend your tokens with this wallet, still open on chain. Approvals given from another wallet don't show here.</p>
      {!live ? <Busy text="Reading approvals from the networks…" /> : live.length === 0
        ? <div className="card empty"><ShieldCheck size={22} style={{ display: "block", margin: "0 auto 8px", color: "var(--muted)" }} />No open approvals. When you let an app spend a token, it shows here and you can take it back.</div>
        : [...groups].map(([id, items]) => {
          const network = networkOf(id);
          return <section key={id}>
            <div className="day-head" style={{ display: "flex", alignItems: "center", gap: 6 }}>{network && <ChainLogo networkId={id} name={network.name} size={14} />}{network?.name ?? id}</div>
            <div className="card rows">{items.map(a => <div key={`${a.token}:${a.spender}:${a.kind}`} className="row approval-row">
              <span className="token-stack"><TokenLogo symbol={a.symbol} size={32} verified={a.verified} /></span>
              <div className="main"><b>{a.symbol} {a.unlimited && <span className="tag warn"><AlertTriangle size={11} /> {a.kind === "collection" ? "All items" : "Unlimited"}</span>}</b>
                <small className="num">{a.unlimited ? "" : `${a.amount} · `}to {short(a.spender)}{a.origin ? ` · ${a.origin.replace(/^https?:\/\//, "")}` : ""}</small></div>
              <button type="button" className="chip" onClick={() => void startRevoke(a)}>Revoke</button>
            </div>)}</div>
          </section>;
        })}
    </div>
    {picking && prefs && <NetworkSheet selected={prefs.network} showTestnets={prefs.showTestnets} onClose={() => setPicking(false)}
      onPick={async networkId => { setPicking(false); await settingsStore.write({ network: networkId }); void load(); }} />}
  </div>;
}
