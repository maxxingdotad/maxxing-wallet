import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Send as SendIcon } from "lucide-react";
import { TokenMark, short, usd, type Holding } from "../ui/parts";
import { Busy, PageHead, message } from "./kit";
import { loadPortfolio } from "../lib/balances";
import { explorerTx, networkById, networks } from "../lib/chains";
import { checkRecipient, draftEvmSend, draftSolSend, sendEvm, sendSol, sendStatus, settleSendActivity, validRecipient, type EvmDraft, type RecipientCheck, type SolDraft } from "../lib/send";
import { watchSend, type WatchUpdate } from "../lib/send-watch";
import { settings } from "../lib/store";
import type * as wallet from "../lib/wallet";

type Account = wallet.WalletSnapshot["accounts"][number];

/** Send: pick what, to whom and how much; review with the safety checks; confirm. */
export function SendView({ holding: initial, account, onBack, toast }: { holding?: Holding; account: Account; onBack: () => void; toast: (t: string) => void }) {
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [holding, setHolding] = useState<Holding | null>(initial ?? null);
  const [to, setTo] = useState(""), [amount, setAmount] = useState("");
  const [draft, setDraft] = useState<{ evm?: EvmDraft; sol?: SolDraft; check: RecipientCheck; large: boolean } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState("");
  const [done, setDone] = useState<{ hash: string; url: string | null; certain: boolean } | null>(null);
  const [state, setState] = useState<WatchUpdate | "not-sent" | "unsettled" | null>(null);
  const [round, setRound] = useState(0); // "Check again" starts another round
  // After a send, ask the chain where it stands until it's settled (lib/send-watch.ts decides what may be said), and record the
  // outcome in Activity once it's known.
  useEffect(() => {
    if (!done || !network) return;
    let live = true;
    void watchSend({ check: () => sendStatus(network, done.hash), certain: done.certain, onUpdate: s => { if (live) setState(s); }, alive: () => live })
      .then(outcome => {
        if (!live || outcome === "stopped") return;
        if (outcome === "not-sent" || outcome === "unsettled") setState(outcome);
        if (outcome !== "unsettled") void settleSendActivity(done.hash, outcome);
      });
    return () => { live = false; };
  }, [done?.hash, round]);
  useEffect(() => { void settings.read().then(s => loadPortfolio({ evm: account.evm, solana: account.solana }, s.showTestnets)).then(p => { setHoldings(p.holdings.filter(h => h.raw && BigInt(h.raw) > 0n)); }); }, [account.evm, account.solana]);
  const network = holding?.networkId ? networks(true).find(n => n.networkId === holding.networkId) ?? null : null;
  const family = network?.family ?? "EVM";
  const splToken = family === "SOLANA" && holding?.address;

  const review = async () => {
    if (!holding || !network) return;
    setError(""); setBusy("Preparing…");
    try {
      if (!validRecipient(family, to)) throw new Error(family === "EVM" ? "That isn't an EVM address (0x…)." : "That isn't a Solana address.");
      const check = await checkRecipient(to);
      const share = holding.raw ? Number(amount.replace(/,/g, "")) / (Number(holding.raw) / 10 ** (holding.decimals ?? 18)) : 0;
      const large = share >= 0.5 || (holding.priced !== false && holding.usd * share >= 1000);
      if (family === "EVM") setDraft({ evm: await draftEvmSend({ network, from: account.evm, to, amount, token: holding.address ? { address: holding.address, decimals: holding.decimals ?? 18 } : null }), check, large });
      else setDraft({ sol: await draftSolSend({ network, from: account.solana, to, amount }), check, large });
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  };
  const confirm = async () => {
    if (!draft) return;
    setBusy("Signing and sending…"); setError("");
    try {
      const sent = draft.evm ? await sendEvm(draft.evm) : await sendSol(draft.sol!, account.solana);
      const chain = networkById(holding!.networkId!);
      setState(null);
      setDone({ hash: sent.id, url: chain ? explorerTx(chain, sent.id) : null, certain: sent.certain });
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  };

  if (busy) return <div className="popup"><div className="backdrop" /><PageHead title="Send" /><Busy text={busy} /></div>;
  if (done) {
    // "Sent" only when a node is known to have it; "Not sent" only when lib/send-watch.ts proved it; otherwise "Not confirmed yet".
    const checking = state === null || state === "checking" || state === "seen";
    const view = state === "confirmed" ? { tone: "good", title: "Confirmed", text: "It's in a block. It shows in your balance now." }
      : state === "failed" ? { tone: "bad", title: "Failed on the network", text: "The network took it but it failed, so nothing was sent apart from the fee. Check the explorer for the reason." }
      : state === "not-sent" ? { tone: "warn", title: "Not sent", text: "No node has this transaction after five minutes of checking, so it wasn't sent. Nothing left your wallet; you can send again." }
      : state === "unsettled" ? { tone: "warn", title: "Not confirmed yet", text: done.certain ? "The network took it but hasn't put it in a block yet. Check the explorer, or check again; don't send it again." : "The wallet couldn't confirm it either way. Check the explorer, or check again; don't send it again until it's settled." }
      : state === "seen" || done.certain ? { tone: "good", title: "Sent", text: "It's on its way. It shows in your balance once the network confirms it." }
      : { tone: "warn", title: "Not confirmed yet", text: "The network didn't answer clearly, so the wallet is checking whether it arrived. Don't send it again until this says." };
    const colors = view.tone === "good" ? { background: "var(--positive-soft)", color: "var(--positive)" } : view.tone === "bad" ? { background: "var(--negative-soft)", color: "var(--negative)" } : { background: "rgba(240,185,11,.14)", color: "#F0B90B" };
    return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 48 }} data-testid="send-result" data-state={state ?? (done.certain ? "seen" : "checking")}>
      <div className="danger-mark" style={colors}>{view.tone === "good" ? <SendIcon size={28} /> : <AlertTriangle size={28} />}</div>
      <h2 className="center-title">{view.title}</h2>
      <p className="center-sub">{view.text}</p>
      {checking && <Busy text="Checking the network…" />}
      {state === "unsettled" && <button type="button" className="btn secondary" style={{ marginBottom: 10 }} onClick={() => { setState(null); setRound(r => r + 1); }}>Check again</button>}
      <div className="card" style={{ padding: 12 }}><div className="addr">{done.hash}</div></div>
    </div>
    <div className="footer">{done.url && <button type="button" className="btn secondary" onClick={() => void chrome.tabs.create({ url: done.url! })}><ExternalLink size={16} />View on explorer</button>}<button type="button" className="btn primary" onClick={onBack}>Done</button></div>
  </div>;
  }

  if (draft) {
    const s = draft.evm?.summary;
    return <div className="popup"><div className="backdrop" />
      <PageHead title="Review" onBack={() => setDraft(null)} />
      <div className="scroll stack" style={{ paddingBottom: 130 }}>
        <h1 className="ask-title" style={{ margin: "4px 2px 0" }}>{s?.tokenCall?.text ?? (s ? `Send ${s.amount}` : `Send ${amount} SOL`)}</h1>
        <p className="ask-sub" style={{ margin: "0 2px" }}>To {short(to.trim())} on {network?.name}</p>
        {draft.check.lookalike && <div className="alert danger"><AlertTriangle size={17} /><span><b>This address looks like one you've used, but it's different.</b> Scammers send dust from look-alike addresses so you copy theirs. Check every character. Known: {short(draft.check.lookalike)}</span></div>}
        {draft.check.firstTime && !draft.check.lookalike && <div className="alert warn"><AlertTriangle size={17} /><span><b>First time sending to this address.</b> Check it with the person you're paying before you confirm.</span></div>}
        {draft.large && <div className="alert warn"><AlertTriangle size={17} /><span><b>This is a large share of your {holding?.symbol}.</b> Make sure the amount is right.</span></div>}
        <div className="card facts">
          <div className="fact"><span>From</span><b>{account.label}</b></div>
          <div className="fact"><span>Network</span><b>{network?.name}</b></div>
          {s && <div className="fact"><span>Network fee, at most</span><b>{s.maxFee ?? "—"}</b></div>}
          {draft.sol && <div className="fact"><span>Network fee</span><b>0.000005 SOL</b></div>}
          {draft.evm && <div className="fact"><span>Nonce</span><b>{String(draft.evm.transaction.nonce)}</b></div>}
        </div>
        {error && <div className="alert danger" role="alert">{error}</div>}
      </div>
      <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><div className="btn-row"><button type="button" className="btn secondary" onClick={() => setDraft(null)}>Back</button><button type="button" className="btn primary" onClick={() => void confirm()}>Confirm send</button></div></div>
    </div>;
  }

  return <div className="popup"><div className="backdrop" />
    <PageHead title="Send" onBack={onBack} />
    <form className="scroll stack" style={{ paddingBottom: 120 }} onSubmit={e => { e.preventDefault(); void review(); }}>
      <label className="field">Asset
        {holdings === null ? <Busy text="Reading balances…" /> : holdings.length === 0 ? <div className="card empty" style={{ padding: 14 }}>Nothing to send yet.</div>
          : <select value={holding ? `${holding.networkId}:${holding.address ?? ""}` : ""} onChange={e => { setHolding(holdings.find(h => `${h.networkId}:${h.address ?? ""}` === e.target.value) ?? null); setTo(""); }}>
            <option value="" disabled>Choose a token</option>
            {holdings.map(h => <option key={`${h.networkId}:${h.address ?? ""}`} value={`${h.networkId}:${h.address ?? ""}`}>{h.symbol} on {h.chain.name} · {h.amount}</option>)}
          </select>}
      </label>
      {holding && <div className="card row" style={{ minHeight: 56 }}><TokenMark holding={holding} /><div className="main"><b>{holding.symbol}</b><small>{holding.amount} available · {holding.chain.name}</small></div><div className="end"><b className="num">{holding.priced === false ? "" : usd(holding.usd)}</b></div></div>}
      {splToken ? <div className="alert warn"><AlertTriangle size={16} /><span>Sending SPL tokens from the extension comes next. Use SOL for now, or send this token from maxxing.ad.</span></div> : <>
        <label className="field">To<input value={to} onChange={e => setTo(e.target.value)} placeholder={family === "EVM" ? "0x… address" : "Solana address"} autoComplete="off" spellCheck={false} /></label>
        <label className="field">Amount<input className="amount-input num" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" />
          {holding && <span className="hint">Available {holding.amount} {holding.symbol} · <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => setAmount(holding.amount.replace(/,/g, ""))}>Max</button>{!holding.address ? " (keep some for the fee)" : ""}</span>}
        </label>
      </>}
      {error && <div className="alert danger" role="alert">{error}</div>}
    </form>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><button type="button" className="btn primary" disabled={!holding || !to || !amount || Boolean(splToken)} onClick={() => void review()}>Review</button></div>
  </div>;
}
