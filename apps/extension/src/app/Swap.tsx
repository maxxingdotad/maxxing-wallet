import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDownUp, ExternalLink, Route } from "lucide-react";
import { knownTokens, KNOWN_SOLANA_MINTS } from "@maxxing/wallet-core/chains";
import { Dock, usd, type DockTab, type Holding } from "../ui/parts";
import { Busy, PageHead, message } from "./kit";
import { loadPortfolio } from "../lib/balances";
import { explorerTx, networks, type Network } from "../lib/chains";
import { parseUnits } from "../lib/send";
import { formatUnits } from "viem";
import { execute, prepare, quote, status, type Asset, type Prepared, type Quote } from "../lib/relay";
import { settings } from "../lib/store";
import type * as wallet from "../lib/wallet";

type Account = wallet.WalletSnapshot["accounts"][number];

/** What you can receive on a network: its coin and the tokens the wallet names there. */
function assetsOn(network: Network): Asset[] {
  const native: Asset = { network, address: null, symbol: network.nativeSymbol, decimals: network.family === "SOLANA" ? 9 : 18 };
  if (network.family === "SOLANA") return [native, ...Object.entries(KNOWN_SOLANA_MINTS).filter(([, t]) => t.symbol !== "SOL").map(([mint, t]) => ({ network, address: mint, symbol: t.symbol, decimals: t.decimals }))];
  return [native, ...knownTokens(network.networkId).map(t => ({ network, address: t.address, symbol: t.symbol, decimals: t.decimals }))];
}
const key = (a: Asset) => `${a.network.networkId}|${a.address ?? ""}`;

export function SwapView({ account, onTab }: { account: Account; onTab: (t: DockTab) => void; toast: (t: string) => void }) {
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [all, setAll] = useState<Network[]>([]);
  const [fromKey, setFromKey] = useState(""), [toKey, setToKey] = useState("");
  const [amount, setAmount] = useState("");
  const [q, setQ] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState(""), [reviewing, setReviewing] = useState(false);
  const [progress, setProgress] = useState(""), [done, setDone] = useState<{ hashes: string[]; state: string } | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null), [prepareError, setPrepareError] = useState("");
  useEffect(() => { void settings.read().then(async s => { setAll(networks(s.showTestnets)); const p = await loadPortfolio({ evm: account.evm, solana: account.solana }, s.showTestnets); setHoldings(p.holdings.filter(h => h.raw && BigInt(h.raw) > 0n)); }); }, [account.evm, account.solana]);

  const fromAssets = useMemo(() => (holdings ?? []).filter(h => h.networkId?.startsWith("eip155:")).map(h => ({ holding: h, asset: { network: all.find(n => n.networkId === h.networkId)!, address: h.address ?? null, symbol: h.symbol, decimals: h.decimals ?? 18 } as Asset })).filter(x => x.asset.network), [holdings, all]);
  const toAssets = useMemo(() => all.flatMap(assetsOn), [all]);
  const from = fromAssets.find(x => key(x.asset) === fromKey) ?? null;
  const to = toAssets.find(a => key(a) === toKey) ?? null;

  // A fresh quote as the inputs settle.
  useEffect(() => {
    setQ(null); setError("");
    if (!from || !to || !amount || Number(amount) <= 0) return;
    let live = true;
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        const amountRaw = parseUnits(amount, from.asset.decimals);
        const next = await quote({ from: from.asset, to, amountRaw, user: account.evm, recipient: to.network.family === "SOLANA" ? account.solana : account.evm });
        if (live) setQ(next);
      } catch (e) { if (live) setError(message(e)); } finally { if (live) setQuoting(false); }
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [fromKey, toKey, amount]);

  // The exact transactions to sign, checked against Relay's contracts, with fees set here.
  useEffect(() => {
    setPrepared(null); setPrepareError("");
    if (!reviewing || !q || !from) return;
    let live = true;
    prepare(q, account.evm, from.asset).then(p => { if (live) setPrepared(p); }, e => { if (live) setPrepareError(message(e)); });
    return () => { live = false; };
  }, [reviewing, q]);

  if (progress) return <div className="popup"><div className="backdrop" /><PageHead title="Swap & bridge" /><Busy text={progress} /></div>;
  if (done) return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 40 }}>
      <div className="danger-mark" style={{ background: "var(--positive-soft)", color: "var(--positive)" }}><Route size={28} /></div>
      <h2 className="center-title">{done.state === "success" ? "Arrived" : "On its way"}</h2>
      <p className="center-sub">{done.state === "success" ? "Relay delivered it." : "Relay is delivering it. It shows in your balance when it lands."}</p>
      {done.hashes.map(h => <div key={h} className="card" style={{ padding: 10, marginBottom: 8 }}><div className="addr">{h}</div></div>)}
    </div>
    <div className="footer">{from && done.hashes.at(-1) && <button type="button" className="btn secondary" onClick={() => { const url = explorerTx(from.asset.network, done.hashes.at(-1)!); if (url) void chrome.tabs.create({ url }); }}><ExternalLink size={16} />View on explorer</button>}<button type="button" className="btn primary" onClick={() => { setDone(null); setAmount(""); }}>Done</button></div>
  </div>;

  if (reviewing && q && from && to) {
    if (!prepared && !prepareError) return <div className="popup"><div className="backdrop" /><PageHead title="Review swap" onBack={() => setReviewing(false)} /><Busy text="Checking the route and its fees…" /></div>;
    const txs = prepared?.txs ?? [];
    const reviewError = prepareError;
    return <div className="popup"><div className="backdrop" />
      <PageHead title="Review swap" onBack={() => setReviewing(false)} />
      <div className="scroll stack" style={{ paddingBottom: 130 }}>
        <h1 className="ask-title" style={{ margin: "4px 2px 0" }}>{amount} {from.asset.symbol} → {q.amountOut} {to.symbol}</h1>
        <p className="ask-sub" style={{ margin: "0 2px" }}>{from.asset.network.name} → {to.network.name} · through Relay</p>
        {(q.impactPercent ?? 0) <= -3 && <div className="alert danger"><AlertTriangle size={17} /><span><b>High price impact: {q.impactPercent?.toFixed(2)}%.</b> You'd get noticeably less than the amount is worth.</span></div>}
        <div className="card facts">
          <div className="fact"><span>Minimum received</span><b>{q.minimumOut ?? "—"} {to.symbol}</b></div>
          <div className="fact"><span>Price impact</span><b style={{ color: (q.impactPercent ?? 0) <= -3 ? "var(--negative)" : "var(--positive)" }}>{q.impactPercent === null ? "—" : `${q.impactPercent.toFixed(2)}%`}</b></div>
          <div className="fact"><span>Relay's fees (in the price)</span><b>{q.feesUsd === null ? "—" : usd(q.feesUsd)}</b></div>
          {prepared && <div className="fact"><span>Network fee, at most</span><b className="num">{Number(formatUnits(prepared.maxFee, 18)).toPrecision(3)} {prepared.nativeSymbol}</b></div>}
          {q.timeSeconds && <div className="fact"><span>Arrives in</span><b>~ {q.timeSeconds} s</b></div>}
        </div>
        <div className="section-head"><h2>{txs.length} transaction{txs.length === 1 ? "" : "s"} you'll sign</h2></div>
        {txs.map((t, i) => <div key={i} className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{i + 1}. {t.summary.tokenCall?.text ?? t.label}</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>{t.summary.network} · sends {t.summary.amount} · to {t.transaction.to?.slice(0, 8)}…{t.transaction.to?.slice(-6)} ({t.transaction.data?.startsWith("0x095ea7b3") ? "your token, letting only a Relay contract spend it" : "a Relay contract"}) · fee at most {Number(formatUnits(t.maxFee, 18)).toPrecision(3)}</div>
          {t.summary.tokenCall?.warning && <div className="alert warn" style={{ marginTop: 8 }}><AlertTriangle size={15} /><span>{t.summary.tokenCall.warning}</span></div>}
        </div>)}
        <p style={{ fontSize: 11.5, color: "var(--muted)", margin: 0 }}>You pay the network fee in {from.asset.network.nativeSymbol}. Paying fees with the token you hold comes with gasless trading.</p>
        {(reviewError || error) && <div className="alert danger" role="alert">{reviewError || error}</div>}
      </div>
      <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><div className="btn-row"><button type="button" className="btn secondary" onClick={() => setReviewing(false)}>Back</button><button type="button" className="btn primary" disabled={!!reviewError || !prepared} onClick={async () => {
        try {
          const hashes = await execute(prepared!, setProgress);
          setProgress("Waiting for Relay…");
          let state = "pending";
          if (q.requestId) for (let i = 0; i < 20 && !["success", "failure", "refund"].includes(state); i++) { await new Promise(r => setTimeout(r, 3000)); state = await status(q.requestId).catch(() => state); }
          setDone({ hashes, state });
        } catch (e) { setError(message(e)); } finally { setProgress(""); setReviewing(false); }
      }}>Confirm swap</button></div></div>
    </div>;
  }

  return <div className="popup"><div className="backdrop" />
    <PageHead title="Swap & bridge" />
    <div className="scroll" style={{ paddingBottom: 150 }}>
      {holdings === null ? <Busy text="Reading balances…" /> : <>
        <div className="swap-card">
          <label><span>You pay</span>{from && <span className="num">Balance {from.holding.amount}</span>}</label>
          <div className="swap-line">
            <input className="swap-amount num" style={{ background: "none", border: 0, outline: "none", width: "55%", color: "var(--text)" }} inputMode="decimal" placeholder="0" value={amount} onChange={e => setAmount(e.target.value)} />
            <select className="swap-asset" style={{ maxWidth: 150 }} value={fromKey} onChange={e => setFromKey(e.target.value)}>
              <option value="">Choose</option>
              {fromAssets.map(x => <option key={key(x.asset)} value={key(x.asset)}>{x.asset.symbol} · {x.asset.network.name}</option>)}
            </select>
          </div>
          {from && <label style={{ marginTop: 6 }}><span>on {from.asset.network.name}</span><button type="button" style={{ color: "var(--text-2)", fontWeight: 600, fontSize: 12 }} onClick={() => setAmount(from.holding.amount.replace(/,/g, ""))}>Max</button></label>}
        </div>
        <div className="swap-flip"><button type="button" aria-label="Flip" disabled><ArrowDownUp size={16} /></button></div>
        <div className="swap-card">
          <label><span>You get</span>{quoting ? <span>Finding the best route…</span> : q ? <span style={{ color: "var(--positive)" }}>Route found</span> : null}</label>
          <div className="swap-line">
            <span className="swap-amount num">{q ? q.amountOut : "0"}</span>
            <select className="swap-asset" style={{ maxWidth: 150 }} value={toKey} onChange={e => setToKey(e.target.value)}>
              <option value="">Choose</option>
              {toAssets.map(a => <option key={key(a)} value={key(a)}>{a.symbol} · {a.network.name}</option>)}
            </select>
          </div>
          {to && <label style={{ marginTop: 6 }}><span>on {to.network.name}{to.network.family === "SOLANA" ? " (to your Solana address)" : ""}</span><span className="num">{q?.amountOutUsd != null ? usd(q.amountOutUsd) : ""}</span></label>}
        </div>
        {from && to && <div className="card route" style={{ marginTop: 8 }}>
          <Route size={15} style={{ color: "var(--muted)", flexShrink: 0 }} />
          <span className="hop">{from.asset.symbol} · {from.asset.network.name}</span><span className="line" /><span className="hop">Relay</span><span className="line" /><span className="hop">{to.symbol} · {to.network.name}</span>
        </div>}
        {q && <div className="card facts" style={{ marginTop: 8 }}>
          <div className="fact"><span>Price impact</span><b style={{ color: (q.impactPercent ?? 0) <= -3 ? "var(--negative)" : "var(--positive)" }}>{q.impactPercent === null ? "—" : `${q.impactPercent.toFixed(2)}%`}</b></div>
          <div className="fact"><span>Minimum received</span><b>{q.minimumOut ?? "—"} {to?.symbol}</b></div>
          <div className="fact"><span>Fees</span><b>{q.feesUsd === null ? "—" : usd(q.feesUsd)}</b></div>
        </div>}
        {!fromAssets.length && <div className="card empty" style={{ marginTop: 8 }}>Swaps start from a token on an EVM chain. Receive some first; Solana as the source comes next.</div>}
        {error && <div className="alert danger" role="alert" style={{ marginTop: 8 }}>{error}</div>}      </>}
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 72 }}><button type="button" className="btn primary" disabled={!q} onClick={() => setReviewing(true)}>Review swap</button></div>
    <Dock tab="swap" onTab={onTab} />
  </div>;
}
