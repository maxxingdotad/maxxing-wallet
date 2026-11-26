import { useEffect, useState } from "react";
import { AlertTriangle, BookUser, Clock, ExternalLink, Send as SendIcon } from "lucide-react";
import { formatUnits } from "viem";
import { TokenMark, short, usd, type Holding } from "../ui/parts";
import { Busy, PageHead, message } from "./kit";
import { loadPortfolio } from "../lib/balances";
import { explorerTx, networkById, networkLabel, networks } from "../lib/chains";
import { book, checkRecipient, draftEvmMaxSend, draftEvmSend, draftSolSend, maxFeeOf, maxSendable, same, sendEvm, sendSol, sendStatus, settleSendActivity, validRecipient, type EvmDraft, type RecipientCheck, type Saved, type SolDraft } from "../lib/send";
import { isEnsName, resolveEns } from "../lib/ens";
import { price } from "../lib/market";
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
  useEffect(() => { void settings.read().then(s => loadPortfolio({ evm: account.evm, solana: account.solana }, s.showTestnets, initial?.networkId ?? s.network)).then(p => { setHoldings(p.holdings.filter(h => h.raw && BigInt(h.raw) > 0n)); }); }, [account.evm, account.solana]);
  const network = holding?.networkId ? networks(true).find(n => n.networkId === holding.networkId) ?? null : null;
  const family = network?.family ?? "EVM";
  const splToken = family === "SOLANA" && holding?.address;
  // The address book (this device only), and ENS names resolved to an address that is always shown before sending.
  const [saved, setSaved] = useState<{ recents: Saved[]; contacts: Saved[] }>({ recents: [], contacts: [] });
  useEffect(() => { void Promise.all([book.recents(), book.contacts()]).then(([recents, contacts]) => setSaved({ recents, contacts })); }, [done]);
  const [ens, setEns] = useState<{ name: string; address: string | null } | null>(null);
  const ensName = family === "EVM" && isEnsName(to) ? to.trim() : null;
  useEffect(() => {
    setEns(null);
    if (!ensName) return;
    let live = true;
    const timer = setTimeout(() => void resolveEns(ensName).then(address => { if (live) setEns({ name: ensName, address }); }), 350);
    return () => { live = false; clearTimeout(timer); };
  }, [ensName]);
  const recipient = ensName ? (ens?.name === ensName ? ens.address ?? "" : "") : to.trim();
  const [maxNote, setMaxNote] = useState("");
  const [usedMax, setUsedMax] = useState(false); // the amount is Max (until the user types another)
  const [feeUsd, setFeeUsd] = useState<number | null>(null);
  const [contactName, setContactName] = useState(""), [contactSaved, setContactSaved] = useState(false);
  const fillMax = async () => {
    if (!holding || !network) return;
    try {
      const max = await maxSendable(network, holding, family === "SOLANA" ? account.solana : account.evm, recipient || undefined);
      setAmount(max.amount); setUsedMax(true);
      setMaxNote(max.keep > 0n ? `Keeps ${formatUnits(max.keep, holding.decimals ?? (family === "SOLANA" ? 9 : 18))} ${holding.symbol} for the network fee.` : "");
    } catch { setAmount(holding.amount.replace(/,/g, "")); setMaxNote("Couldn't read today's fee: leave some for it."); }
  };

  const review = async () => {
    if (!holding || !network) return;
    setError(""); setBusy("Preparing…"); setFeeUsd(null);
    try {
      if (ensName && !recipient) throw new Error(`${ensName} has no address the wallet can read.`);
      if (!validRecipient(family, recipient)) throw new Error(family === "EVM" ? "That isn't an EVM address (0x…) or a .eth name." : "That isn't a Solana address.");
      const check = await checkRecipient(recipient);
      const share = holding.raw ? Number(amount.replace(/,/g, "")) / (Number(holding.raw) / 10 ** (holding.decimals ?? 18)) : 0;
      const large = share >= 0.5 || (holding.priced !== false && holding.usd * share >= 1000);
      // Max of the coin: drafted again now from the balance and that draft's own fees, not the amount shown when Max was pressed.
      const coinMax = usedMax && family === "EVM" && !holding.address && !!holding.raw;
      const next = family === "EVM"
        ? { evm: coinMax ? await draftEvmMaxSend({ network, from: account.evm, to: recipient, balance: BigInt(holding.raw!) })
          : await draftEvmSend({ network, from: account.evm, to: recipient, amount, token: holding.address ? { address: holding.address, decimals: holding.decimals ?? 18 } : null }), check, large }
        : { sol: await draftSolSend({ network, from: account.solana, to: recipient, amount }), check, large };
      setDraft(next);
      if (coinMax) setAmount(formatUnits(next.evm!.transaction.value ?? 0n, 18));
      // The fee in dollars, from the coin's price; left out when there's no price (never guessed).
      const fee = next.evm ? Number(formatUnits(maxFeeOf(next.evm.transaction as { gas?: bigint; maxFeePerGas?: bigint; gasPrice?: bigint }), 18)) : Number(next.sol!.fee) / 1e9;
      void price(network.networkId, null).then(p => setFeeUsd(p.priceUsd === null ? null : fee * p.priceUsd));
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

  const sentTo = draft?.evm?.to ?? draft?.sol?.to ?? recipient;
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
      {draft && !draft.check.contact && (contactSaved ? <p className="center-sub" style={{ marginTop: 12 }}>Saved to contacts.</p>
        : <form className="card" style={{ padding: 12, marginTop: 12 }} onSubmit={e => { e.preventDefault(); void book.saveContact({ address: sentTo, family, name: contactName }).then(() => setContactSaved(true), err => setError(message(err))); }}>
          <label className="field" style={{ margin: 0 }}>Save {short(sentTo)} as a contact<input value={contactName} onChange={e => setContactName(e.target.value)} placeholder="Name" maxLength={40} /></label>
          <button type="submit" className="btn secondary" style={{ marginTop: 8 }} disabled={!contactName.trim()}><BookUser size={16} />Save contact</button>
          {error && <div className="alert danger" role="alert" style={{ marginTop: 8 }}>{error}</div>}
        </form>)}
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
        <p className="ask-sub" style={{ margin: "0 2px" }}>To {draft.check.contact ?? ensName ?? short(sentTo)} on {network && networkLabel(network)}</p>
        {network?.custom && <div className="alert warn"><AlertTriangle size={17} /><span><b>{networkLabel(network)}.</b> MAXXING doesn't list or check this network: its endpoint decides what you see. Send only if you trust it.</span></div>}
        <div className="card" style={{ padding: 12 }}><div className="addr" data-testid="review-recipient">{sentTo}</div>{ensName && <small className="muted" style={{ fontSize: 12 }}>{ensName} points to this address now. Check it before you confirm.</small>}</div>
        {draft.check.lookalike && <div className="alert danger"><AlertTriangle size={17} /><span><b>This address looks like one you've used, but it's different.</b> Scammers send dust from look-alike addresses so you copy theirs. Check every character. Known: {short(draft.check.lookalike)}</span></div>}
        {draft.check.firstTime && !draft.check.lookalike && <div className="alert warn"><AlertTriangle size={17} /><span><b>First time sending to this address.</b> Check it with the person you're paying before you confirm.</span></div>}
        {draft.large && <div className="alert warn"><AlertTriangle size={17} /><span><b>This is a large share of your {holding?.symbol}.</b> Make sure the amount is right.</span></div>}
        <div className="card facts">
          <div className="fact"><span>From</span><b>{account.label}</b></div>
          <div className="fact"><span>Network</span><b>{network && networkLabel(network)}</b></div>
          {draft.evm?.feeCapped && <div className="fact" data-testid="fee-capped"><span>Tip (added network)</span><b>capped at 2 gwei</b></div>}
          {s && <div className="fact"><span>Network fee, at most</span><b>{s.maxFee ?? "—"}{feeUsd !== null && <span className="muted" style={{ fontSize: 12 }}> ≈ {feeUsd < 0.01 ? "< $0.01" : usd(feeUsd)}</span>}</b></div>}
          {draft.sol && <div className="fact"><span>Network fee</span><b>0.000005 SOL{feeUsd !== null && <span className="muted" style={{ fontSize: 12 }}> ≈ {feeUsd < 0.01 ? "< $0.01" : usd(feeUsd)}</span>}</b></div>}
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
        <label className="field">To<input value={to} onChange={e => setTo(e.target.value)} placeholder={family === "EVM" ? "0x… address or name.eth" : "Solana address"} autoComplete="off" spellCheck={false} data-testid="send-to" />
          {ensName && <span className="hint" data-testid="ens-result">{ens?.name !== ensName ? "Looking up the name…" : ens.address ? `${ensName} → ${ens.address}` : `${ensName} has no address the wallet can read.`}</span>}
        </label>
        {!to && <AddressBook family={family} saved={saved} onPick={address => setTo(address)} />}
        <label className="field">Amount<input className="amount-input num" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setMaxNote(""); setUsedMax(false); }} placeholder="0" />
          {holding && <span className="hint">Available {holding.amount} {holding.symbol} · <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => void fillMax()}>Max</button>{maxNote ? ` · ${maxNote}` : ""}</span>}
        </label>
      </>}
      {error && <div className="alert danger" role="alert">{error}</div>}
    </form>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><button type="button" className="btn primary" disabled={!holding || !recipient || !amount || Boolean(splToken)} onClick={() => void review()}>Review</button></div>
  </div>;
}

/** Contacts and recent recipients for this network's kind of address; a tap fills the To field. */
function AddressBook({ family, saved, onPick }: { family: "EVM" | "SOLANA"; saved: { recents: Saved[]; contacts: Saved[] }; onPick: (address: string) => void }) {
  const contacts = saved.contacts.filter(c => c.family === family);
  const recents = saved.recents.filter(r => r.family === family && !contacts.some(c => same(c.address, r.address))).slice(0, 5);
  if (!contacts.length && !recents.length) return null;
  const row = (s: Saved, icon: React.ReactNode) => <button key={s.address} type="button" className="row" style={{ width: "100%", textAlign: "left" }} onClick={() => onPick(s.address)}>
    <span style={{ color: "var(--text-2)", display: "grid" }}>{icon}</span>
    <div className="main"><b>{s.name ?? short(s.address)}</b><small className="num">{s.name ? short(s.address) : `Sent ${new Date(s.at).toLocaleDateString()}`}</small></div>
  </button>;
  return <div data-testid="address-book">
    {contacts.length > 0 && <><div className="day-head" style={{ marginTop: 0 }}>Contacts</div><div className="card rows">{contacts.map(c => row(c, <BookUser size={16} />))}</div></>}
    {recents.length > 0 && <><div className="day-head">Recent</div><div className="card rows">{recents.map(r => row(r, <Clock size={16} />))}</div></>}
  </div>;
}
