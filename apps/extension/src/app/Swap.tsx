import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowDownUp, ChevronDown, ExternalLink, Route } from "lucide-react";
import { HoldButton, ReceiptCard } from "../ui/moving";
import { BigAmount } from "../ui/confirm";
import { knownTokens, KNOWN_SOLANA_MINTS } from "@maxxing/wallet-core/chains";
import { Dock, plainDecimal, short, usd, type DockTab, type Holding } from "../ui/parts";
import { Busy, PageHead, message } from "./kit";
import { AssetMark, AssetSheet } from "../ui/asset-picker";
import { portfolio as loadPortfolio } from "../lib/balances";
import { explorerTx, networkLabel, networks, type Network } from "../lib/chains";
import { parseUnits } from "../lib/send";
import { formatUnits } from "viem";
import { execute, gaslessAvailable, prepare, quote, status, type Asset, type Prepared, type Quote } from "../lib/relay";
import { settings } from "../lib/store";
import { feePercent } from "../lib/swap-fee";
import type * as wallet from "../lib/wallet";

type Account = wallet.WalletSnapshot["accounts"][number];

/** What you can receive on a network: its coin and the tokens the wallet names there. */
function assetsOn(network: Network): Asset[] {
  const native: Asset = { network, address: null, symbol: network.nativeSymbol, decimals: network.family === "SOLANA" ? 9 : 18 };
  if (network.family === "SOLANA") return [native, ...Object.entries(KNOWN_SOLANA_MINTS).filter(([, t]) => t.symbol !== "SOL").map(([mint, t]) => ({ network, address: mint, symbol: t.symbol, decimals: t.decimals }))];
  return [native, ...knownTokens(network.networkId).map(t => ({ network, address: t.address, symbol: t.symbol, decimals: t.decimals }))];
}
const key = (a: Asset) => `${a.network.networkId}|${a.address ?? ""}`;

/** A sensible first pair: what you hold most of, into a dollar coin on the same network (or into its coin, from a dollar coin). */
function defaultTo(from: Asset, all: Asset[]): Asset | undefined {
  const same = all.filter(a => a.network.networkId === from.network.networkId && key(a) !== key(from));
  return /^USD[CT]/.test(from.symbol) ? same.find(a => a.address === null) : same.find(a => a.symbol === "USDC") ?? same.find(a => a.address === null);
}
/** An amount for reading: at most eight significant digits (a coin's eighteen decimals don't fit, and nobody reads them). */
const nice = (amount: string) => { const n = Number(String(amount).replace(/,/g, "")); return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumSignificantDigits: 8 }) : amount; };
/** A fee for reading: three significant digits of the coin, and dollars with a floor of a cent. */
const coins = (n: number) => n.toLocaleString("en-US", { maximumSignificantDigits: 3 });
const feeText = (n: number) => n < 0.01 ? "< $0.01" : usd(n);
/** The amount typed, in the token's smallest unit, or null while it isn't a number yet. */
function rawOf(amount: string, decimals: number): bigint | null {
  try { return amount && Number(amount) > 0 ? parseUnits(amount, decimals) : null; } catch { return null; }
}

type Choice = { key: string; symbol: string; network: Network; balance?: string };
/** Swap's token chooser: a chip with the chosen token (or "Select") that opens the shared token sheet. */
function AssetPicker({ label, value, choices, onPick, testId }: { label: string; value: Choice | null; choices: Choice[]; onPick: (key: string) => void; testId: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={`asset-chip${value ? "" : " empty"}`} data-testid={testId} aria-label={value ? `${label}: ${value.symbol} on ${value.network.name}` : `${label}: select a token`} onClick={() => setOpen(true)}>
      {value ? <><AssetMark symbol={value.symbol} networkId={value.network.networkId} networkName={value.network.name} size={26} /><b>{value.symbol}</b></> : <b>Select</b>}
      <ChevronDown size={15} />
    </button>
    {open && <AssetSheet title={label} selected={value?.key} onPick={onPick} onClose={() => setOpen(false)}
      choices={choices.map(c => ({ key: c.key, title: c.symbol, sub: networkLabel(c.network), end: c.balance, mark: <AssetMark symbol={c.symbol} networkId={c.network.networkId} networkName={c.network.name} size={34} /> }))} />}
  </>;
}

/** MAXXING's fee on its own line: the rate and its value in dollars (from the quote, checked against the rate). */
function MaxxingFeeRow({ q }: { q: Quote }) {
  if (!q.maxxingFee) return null;
  return <div className="fact" data-testid="maxxing-fee"><span>MAXXING fee {feePercent(q.maxxingFee.bps)}</span><b>{q.maxxingFee.usd === null ? "—" : `≈ ${q.maxxingFee.usd < 0.01 ? "< $0.01" : usd(q.maxxingFee.usd)}`}</b></div>;
}

export function SwapView({ account, onTab }: { account: Account; onTab: (t: DockTab) => void; toast: (t: string) => void }) {
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [all, setAll] = useState<Network[]>([]);
  const [fromKey, setFromKey] = useState(""), [toKey, setToKey] = useState("");
  const [amount, setAmount] = useState("");
  const [q, setQ] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState(""), [reviewing, setReviewing] = useState(false);
  /** The review shows three lines; this opens the breakdown of the fees and the steps. */
  const [details, setDetails] = useState(false);
  const [progress, setProgress] = useState(""), [done, setDone] = useState<{ hashes: string[]; state: string } | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null), [prepareError, setPrepareError] = useState("");
  useEffect(() => { void settings.read().then(async s => { setAll(networks(s.showTestnets)); const p = await loadPortfolio({ evm: account.evm, solana: account.solana }, s.showTestnets, s.network); /* pay from the selected network */ setHoldings(p.holdings.filter(h => h.raw && BigInt(h.raw) > 0n)); }); }, [account.evm, account.solana]);

  const fromAssets = useMemo(() => (holdings ?? []).filter(h => h.networkId?.startsWith("eip155:")).map(h => ({ holding: h, asset: { network: all.find(n => n.networkId === h.networkId)!, address: h.address ?? null, symbol: h.symbol, decimals: h.decimals ?? 18 } as Asset })).filter(x => x.asset.network), [holdings, all]);
  const toAssets = useMemo(() => all.flatMap(assetsOn), [all]);
  const from = fromAssets.find(x => key(x.asset) === fromKey) ?? null;
  const to = toAssets.find(a => key(a) === toKey) ?? null;
  // Start ready to go: pay with the biggest holding, get a dollar coin (or the coin) on the same network.
  useEffect(() => {
    if (fromKey || !fromAssets.length || !toAssets.length) return;
    const top = [...fromAssets].sort((a, b) => b.holding.usd - a.holding.usd)[0]!;
    setFromKey(key(top.asset));
    const next = defaultTo(top.asset, toAssets);
    if (next && !toKey) setToKey(key(next));
  }, [fromAssets, toAssets]);
  const amountRaw = from ? rawOf(amount, from.asset.decimals) : null;
  const tooMuch = !!from && amountRaw !== null && !!from.holding.raw && amountRaw > BigInt(from.holding.raw);
  const unitPrice = from?.holding.priced !== false && from ? from.holding.usd / (Number(from.holding.amount.replace(/,/g, "")) || Infinity) : 0;
  // The pay amount can be typed in dollars or in the token; `amount` is always the token amount.
  const [inUsd, setInUsd] = useState(false), [usdText, setUsdText] = useState("");
  const tokenOf = (dollars: string) => { const n = Number(dollars); return n > 0 && unitPrice > 0 ? plainDecimal(n / unitPrice) : ""; };
  const dollarsOf = (tokens: string) => { const n = Number(tokens); return n > 0 && unitPrice > 0 ? (n * unitPrice).toFixed(2) : ""; };
  const typed = (v: string) => { if (inUsd) { setUsdText(v); setAmount(tokenOf(v)); } else setAmount(v); };
  const clear = () => { setAmount(""); setUsdText(""); };
  const other = inUsd ? `${amountRaw !== null ? `≈ ${Number(amount).toLocaleString("en-US", { maximumSignificantDigits: 6 })}` : "0"} ${from?.asset.symbol ?? ""}`
    : amountRaw !== null && unitPrice > 0 ? `≈ ${usd(Number(amount) * unitPrice)}` : "$0.00";
  const share = (pct: bigint) => { if (from?.holding.raw) { const next = formatUnits(BigInt(from.holding.raw) * pct / 100n, from.asset.decimals); setAmount(next); setUsdText(dollarsOf(next)); } };
  const canFlip = !!to && fromAssets.some(x => key(x.asset) === toKey);
  const toHeld = to ? (holdings ?? []).find(h => h.networkId === to.network.networkId && (h.address ?? null)?.toLowerCase() === (to.address ?? undefined)?.toLowerCase())?.amount : undefined;
  const dash = <i className="dash">—</i>;
  const perOne = q && from && Number(amount) > 0 ? Number(String(q.amountOut).replace(/,/g, "")) / Number(amount) : NaN;
  const rate = from && to && Number.isFinite(perOne) && perOne > 0 ? `1 ${from.asset.symbol} ≈ ${perOne.toLocaleString("en-US", { maximumSignificantDigits: 6 })} ${to.symbol}` : null;
  const flip = () => { const f = fromKey; setFromKey(toKey); setToKey(f); clear(); };
  // The button says what's missing, so the screen never has a dead grey button without a reason.
  const action = !from ? "Choose what you pay" : !to ? "Choose what you get" : amountRaw === null ? "Enter an amount"
    : tooMuch ? `Not enough ${from.asset.symbol}` : quoting ? "Finding the best route…" : q ? "Review swap" : error ? "No route for this swap" : "Finding the best route…";
  // Paying with a token: the network fee can come out of the swap (gasless), on by default when there's no coin for gas there.
  // Gasless is offered only for a token that takes an EIP-3009 authorization from Relay's approval contract on that network
  // (checked by simulating the call), and across networks: Relay's same-network gasless route would need a lasting allowance.
  const [tokenGasless, setTokenGasless] = useState<boolean | null>(null);
  useEffect(() => {
    setTokenGasless(null);
    if (!from?.asset.address) return;
    let current = true; // an answer for a token the user has since changed away from is dropped
    void gaslessAvailable(from.asset).then(ok => { if (current) setTokenGasless(ok); }, () => { if (current) setTokenGasless(false); });
    return () => { current = false; };
  }, [fromKey]);
  const canGasless = !!from && !!to && from.asset.address !== null && tokenGasless === true && to.network.networkId !== from.asset.network.networkId;
  const hasGasCoin = !!from && (holdings ?? []).some(h => h.networkId === from.asset.network.networkId && !h.address);
  const [gaslessChoice, setGaslessChoice] = useState<boolean | null>(null);
  const gasless = canGasless && (gaslessChoice ?? !hasGasCoin);
  useEffect(() => setGaslessChoice(null), [fromKey]);

  // A fresh quote as the inputs settle.
  useEffect(() => {
    setQ(null); setError("");
    if (!from || !to || !amount || Number(amount) <= 0 || tooMuch) return;
    let live = true;
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        const amountRaw = parseUnits(amount, from.asset.decimals);
        const next = await quote({ from: from.asset, to, amountRaw, user: account.evm, recipient: to.network.family === "SOLANA" ? account.solana : account.evm, gasless });
        if (live) setQ(next);
      } catch (e) { if (live) setError(message(e)); } finally { if (live) setQuoting(false); }
    }, 450);
    return () => { live = false; clearTimeout(t); };
  }, [fromKey, toKey, amount, gasless, tooMuch]);

  // The exact transactions to sign, checked against Relay's contracts, with fees set here.
  useEffect(() => {
    setPrepared(null); setPrepareError("");
    if (!reviewing || !q || !from) return;
    let live = true;
    prepare(q, account.evm, from.asset).then(p => { if (live) setPrepared(p); }, e => { if (live) setPrepareError(message(e)); });
    return () => { live = false; };
  }, [reviewing, q]);

  if (progress) return <div className="popup"><div className="backdrop" /><PageHead title="Swap & bridge" /><Busy text={progress} /></div>;
  if (done) {
    // Relay's own reading, said as it is: delivered, failed, refunded, or still on its way.
    const view = done.state === "success" ? { tone: "good", title: "Arrived", text: "Relay delivered it. It shows in your balance now." }
      : done.state === "failure" ? { tone: "bad", title: "Failed", text: "Relay couldn't complete this swap. Check the explorer for what happened to your funds." }
      : done.state === "refund" ? { tone: "warn", title: "Refunded", text: "Relay couldn't complete the swap and is sending your funds back." }
      : { tone: "warn", title: "On its way", text: "Relay is delivering it. It shows in your balance when it lands." };
    const colors = view.tone === "good" ? { background: "var(--positive-soft)", color: "var(--positive)" } : view.tone === "bad" ? { background: "var(--negative-soft)", color: "var(--negative)" } : { background: "rgba(240,185,11,.14)", color: "#F0B90B" };
    return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 22 }} data-testid="swap-result" data-state={done.state}>
      <ReceiptCard className="receipt">
        <span className={`receipt-status ${view.tone}`} style={colors}><Route size={13} />{view.title}</span>
        <BigAmount value={amount.replace(/,/g, "")} symbol={from?.asset.symbol ?? ""} />
        <div className="receipt-out num">→ {q ? nice(q.amountOut) : "…"} {to?.symbol}</div>
        <div className="receipt-to">{from && networkLabel(from.asset.network)}{to && <> to <b>{networkLabel(to.network)}</b></>} · through Relay</div>
        {done.hashes.map(h => <div key={h} className="receipt-hash num" title={h}>{short(h)}</div>)}
      </ReceiptCard>
      <p className="center-sub" style={{ marginTop: 16 }}>{view.text}</p>
    </div>
    <div className="footer">{from && done.hashes.at(-1) && <button type="button" className="btn secondary" onClick={() => { const url = explorerTx(from.asset.network, done.hashes.at(-1)!); if (url) void chrome.tabs.create({ url }); }}><ExternalLink size={16} />View on explorer</button>}<button type="button" className="btn primary" onClick={() => { setDone(null); clear(); }}>Done</button></div>
  </div>;
  }

  if (reviewing && q && from && to) {
    if (!prepared && !prepareError) return <div className="popup"><div className="backdrop" /><PageHead title="Review swap" onBack={() => setReviewing(false)} /><Busy text="Checking the route and its fees…" /></div>;
    const steps = prepared?.steps ?? [];
    const reviewError = prepareError;
    const what = prepared?.gasless ? `${steps.length} authorization${steps.length === 1 ? "" : "s"} you'll sign` : `${steps.length} step${steps.length === 1 ? "" : "s"} you'll sign`;
    const run = async () => {
      try {
        const hashes = await execute(prepared!, setProgress);
        setProgress("Waiting for Relay…");
        let state = "pending";
        if (q.requestId) for (let i = 0; i < 20 && !["success", "failure", "refund"].includes(state); i++) { await new Promise(r => setTimeout(r, 3000)); state = await status(q.requestId).catch(() => state); }
        setDone({ hashes, state });
      } catch (e) { setError(message(e)); } finally { setProgress(""); setReviewing(false); }
    };
    // Every fee in dollars, added up: Relay's, MAXXING's, and the network fee where the quote prices it. Unknown parts are left out
    // of the sum (and shown as "—" in the breakdown), never guessed.
    const feeParts = [q.feesUsd, q.maxxingFee?.usd ?? null, prepared?.gasless ? null : q.networkFee?.usd ?? null].filter((v): v is number => v !== null);
    const feeTotal = feeParts.length ? feeParts.reduce((a, b) => a + b, 0) : null;
    const tokenWarnings = steps.flatMap(s => s.kind === "signature" ? [] : s.summary.tokenCall?.warning ? [s.summary.tokenCall.warning] : []);
    return <div className={`popup confirm-screen${details ? " with-details" : ""}`} data-testid="swap-review">
      <PageHead title="Review swap" onBack={() => setReviewing(false)} />
      <div className="scroll confirm-scroll">
        {/* What goes in, what comes out: the one thing to look at. */}
        <div className="confirm-hero swap-hero">
          <div className="confirm-to">You pay on <b>{networkLabel(from.asset.network)}</b></div>
          <BigAmount value={amount.replace(/,/g, "")} symbol={from.asset.symbol} />
          <div className="swap-arrow" aria-hidden="true"><ArrowDown size={16} /></div>
          <div className="swap-out num" title={q.amountOut}>{nice(q.amountOut)} <span>{to.symbol}</span></div>
          <div className="confirm-usd">on {networkLabel(to.network)}{q.timeSeconds ? ` · about ${q.timeSeconds < 1 ? "a second" : `${q.timeSeconds} s`}` : ""}</div>
        </div>
        {/* Only what needs attention shows by itself: a bad price, a risky approval, an error. */}
        <div className="confirm-warnings">
          {(q.impactPercent ?? 0) <= -3 && <div className="confirm-warn danger"><AlertTriangle size={15} /><span><b>High price impact: {q.impactPercent?.toFixed(2)}%.</b> You'd get noticeably less than the amount is worth.</span></div>}
          {tokenWarnings.map((w, i) => <div key={i} className="confirm-warn"><AlertTriangle size={15} /><span>{w}</span></div>)}
          {(reviewError || error) && <div className="confirm-warn danger" role="alert"><AlertTriangle size={15} /><span>{reviewError || error}</span></div>}
        </div>
        {/* The steps, for whoever wants them: opened with the fees. */}
        {details && <div className="swap-steps" data-testid="swap-steps">
          <div className="section-head" style={{ marginTop: 0 }}><h2>{what}</h2></div>
          {steps.map((s, i) => s.kind === "signature"
            ? <div key={i} className="swap-step" data-testid="gasless-step"><b>{i + 1}. {s.label}</b><small>{s.text}</small></div>
            : <div key={i} className="swap-step"><b>{i + 1}. {s.summary.tokenCall?.text ?? s.label}</b>
                <small>To {s.transaction.to?.slice(0, 8)}…{s.transaction.to?.slice(-6)}, {s.transaction.data?.startsWith("0x095ea7b3") ? "your token: only a Relay contract may spend it" : "a Relay contract"}</small></div>)}
        </div>}
      </div>
      {/* Three lines and the one button, on the same glowing panel as Send. A tap on the fees opens every one of them. */}
      <div className="confirm-panel">
        <div className="confirm-rows">
          <div><span>You get at least</span><b className="num">{q.minimumOut ?? "—"} {to.symbol}</b></div>
          <button type="button" className="fees-row" aria-expanded={details} data-testid="swap-fees" onClick={() => setDetails(d => !d)}>
            <span>Fees, in total</span><b className="num">{feeTotal === null ? "—" : feeTotal < 0.01 ? "< $0.01" : `≈ ${usd(feeTotal)}`}<ChevronDown size={15} className="chev" /></b>
          </button>
          {details && <div className="fee-breakdown">
            <div><span>Relay's fees (in the price)</span><b>{q.feesUsd === null ? "—" : usd(q.feesUsd)}</b></div>
            <MaxxingFeeRow q={q} />
            {prepared && (prepared.gasless
              ? <div><span>Network fee</span><b>Paid from the swap</b></div>
              : <div><span>Network fee, at most</span><b className="num">{Number(formatUnits(prepared.maxFee, 18)).toPrecision(3)} {prepared.nativeSymbol}</b></div>)}
            <div><span>Price impact</span><b style={{ color: (q.impactPercent ?? 0) <= -3 ? "var(--negative)" : undefined }}>{q.impactPercent === null ? "—" : `${q.impactPercent.toFixed(2)}%`}</b></div>
          </div>}
          {!details && <div className="quiet-row"><span>{prepared?.gasless ? "No network fee from you" : `${steps.length} signature${steps.length === 1 ? "" : "s"}`}</span><b>through Relay</b></div>}
        </div>
        <HoldButton label="Swap" busyLabel="Swapping…" disabled={!!reviewError || !prepared} onConfirm={run} />
      </div>
    </div>;
  }

  return <div className="popup"><div className="backdrop" />
    <PageHead title="Swap & bridge" />
    <div className="scroll" style={{ paddingBottom: 150 }}>
      {holdings === null ? <Busy text="Reading balances…" /> : <>
        <div className={`swap-card${tooMuch ? " over" : ""}`}>
          <div className="swap-top"><span>You pay</span>{from && <span>on {networkLabel(from.asset.network)}</span>}</div>
          <div className="swap-line">
            {inUsd && <span className="swap-amount swap-dollar">$</span>}
            <input className="swap-amount swap-input num" inputMode="decimal" placeholder="0" aria-label={inUsd ? "Amount to pay, in dollars" : "Amount to pay"} data-testid="swap-amount" value={inUsd ? usdText : amount} onChange={e => typed(e.target.value.replace(",", "."))} />
            <AssetPicker label="You pay" testId="swap-from" value={from ? { key: key(from.asset), symbol: from.asset.symbol, network: from.asset.network } : null}
              choices={fromAssets.map(x => ({ key: key(x.asset), symbol: x.asset.symbol, network: x.asset.network, balance: x.holding.amount }))} onPick={k => { setFromKey(k); clear(); }} />
          </div>
          <div className="swap-sub">
            {tooMuch ? <span><em>More than you have</em></span> : unitPrice > 0 && from
              ? <button type="button" className="unit-switch num" data-testid="swap-unit" title={inUsd ? `Type in ${from.asset.symbol}` : "Type in dollars"} onClick={() => { if (!inUsd) setUsdText(dollarsOf(amount)); setInUsd(v => !v); }}><ArrowDownUp size={12} />{other}</button>
              : <span />}
            {from && <span className="swap-bal"><span className="num">{from.holding.amount} {from.asset.symbol}</span><button type="button" onClick={() => share(50n)}>50%</button><button type="button" onClick={() => share(100n)}>Max</button></span>}
          </div>
        </div>
        {/* Between the two: a flip button when you hold the other token too, otherwise just the direction. */}
        <div className="swap-flip">{canFlip
          ? <button type="button" aria-label="Flip pay and get" onClick={flip} title="Flip"><ArrowDownUp size={16} /></button>
          : <span aria-hidden="true"><ArrowDown size={16} /></span>}</div>
        <div className="swap-card">
          <div className="swap-top"><span>You get</span>{to && <span>on {networkLabel(to.network)}</span>}</div>
          <div className="swap-line">
            <span key={q?.amountOut ?? "none"} className={`swap-amount num${q ? " tick" : " idle"}${quoting ? " pulse" : ""}`}>{q ? nice(q.amountOut) : "0"}</span>
            <AssetPicker label="You get" testId="swap-to" value={to ? { key: key(to), symbol: to.symbol, network: to.network } : null}
              choices={toAssets.map(a => ({ key: key(a), symbol: a.symbol, network: a.network, balance: (holdings ?? []).find(h => h.networkId === a.network.networkId && (h.address ?? null)?.toLowerCase() === a.address?.toLowerCase())?.amount }))} onPick={setToKey} />
          </div>
          <div className="swap-sub">
            <span className="num">{q?.amountOutUsd != null ? usd(q.amountOutUsd) : ""}</span>
            <span className="num">{to ? `You have ${toHeld ?? "0"} ${to.symbol}` : ""}</span>
          </div>
        </div>
        {/* The details are always here, filled in when the quote arrives, so the screen doesn't jump or sit half empty. */}
        {from && to && <div className={`card facts swap-facts${q ? " ready" : ""}`} data-testid="swap-facts">
          <div className="fact"><span>Rate</span><b className="num">{rate ?? dash}</b></div>
          <div className="fact"><span>{from.asset.network.networkId === to.network.networkId ? "Swap" : "Bridge"} through Relay</span><b>{q?.timeSeconds ? (q.timeSeconds < 5 ? "Arrives in seconds" : `About ${Math.round(q.timeSeconds)} s`) : dash}</b></div>
          {/* Price impact takes a row only when it's worth a look; the review always shows it. */}
          {q && (q.impactPercent ?? 0) <= -1 && <div className="fact"><span>Price impact</span><b className="num" style={{ color: (q.impactPercent ?? 0) <= -3 ? "var(--negative)" : "var(--warning)" }}>{q.impactPercent!.toFixed(2)}%</b></div>}
          <div className="fact"><span>Relay's fees</span><b className="num">{q && q.feesUsd !== null ? usd(q.feesUsd) : dash}</b></div>
          {q && <MaxxingFeeRow q={q} />}
          {/* The network fee of your own transaction: an estimate here, the exact ceiling on the review. Dollars first when typing in dollars. */}
          <div className="fact" data-testid="swap-network-fee"><span>{gasless ? "Network fee" : "Network fee, about"}</span><b className="num">{gasless ? "Paid from the swap" : !q?.networkFee ? dash
            : inUsd && q.networkFee.usd !== null ? <>{feeText(q.networkFee.usd)} <em>{coins(q.networkFee.amount)} {q.networkFee.symbol}</em></>
            : <>{coins(q.networkFee.amount)} {q.networkFee.symbol}{q.networkFee.usd !== null && <em> {q.networkFee.usd < 0.01 ? "" : "≈ "}{feeText(q.networkFee.usd)}</em>}</>}</b></div>
        </div>}
        {canGasless && from && <label className="card" style={{ display: "flex", gap: 10, alignItems: "center", padding: 12, marginTop: 8, fontSize: 13, cursor: "pointer" }} data-testid="gasless-toggle">
          <input type="checkbox" checked={gasless} onChange={e => setGaslessChoice(e.target.checked)} />
          <span><b>Pay the network fee with {from.asset.symbol}</b><br /><small style={{ color: "var(--muted)" }}>{hasGasCoin ? `No ${from.asset.network.nativeSymbol} spent: the fee comes out of the swap.` : `You have no ${from.asset.network.nativeSymbol} on ${from.asset.network.name}: the fee comes out of the swap.`}</small></span>
        </label>}
        {!fromAssets.length && <div className="card empty" style={{ marginTop: 8 }}>Swaps start from a token on an EVM chain. Receive some first; Solana as the source comes next.</div>}
        {error && <div className="alert danger" role="alert" style={{ marginTop: 8 }}>{error}</div>}      </>}
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 72 }}><button type="button" className="btn primary" data-testid="swap-review-btn" disabled={!q || tooMuch || quoting} onClick={() => setReviewing(true)}>{action}</button></div>
    <Dock tab="swap" onTab={onTab} />
  </div>;
}
