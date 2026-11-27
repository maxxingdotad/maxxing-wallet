import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { addressMatrix } from "../lib/qr";
import { ChainLogo } from "../ui/logos";
import { PageHead, copy } from "./kit";
import { NetworkButton, NetworkSheet } from "./Assets";
import { networks, type Network } from "../lib/chains";
import { settings as settingsStore, type Settings } from "../lib/store";

const FINDER = 7;
/** An address as a QR code: dot modules and rounded finder marks (the MAXXING web app's style), dark on light so any phone reads it. */
export function AddressQr({ value, label }: { value: string; label: string }) {
  const qr = useMemo(() => addressMatrix(value), [value]);
  const n = qr.size;
  const finder = (x: number, y: number) => (x < FINDER && y < FINDER) || (x >= n - FINDER && y < FINDER) || (x < FINDER && y >= n - FINDER);
  const dots: string[] = [];
  qr.data.forEach((row, y) => row.forEach((on, x) => { if (on && !finder(x, y)) dots.push(`M${x + 0.5} ${y + 0.04}a.46 .46 0 1 1 0 .92a.46 .46 0 1 1 0-.92z`); }));
  const marks = [[0, 0], [n - FINDER, 0], [0, n - FINDER]] as const;
  return <svg className="address-qr" viewBox={`-2 -2 ${n + 4} ${n + 4}`} role="img" aria-label={label} shapeRendering="geometricPrecision" data-testid="address-qr">
    <path d={dots.join("")} fill="#0B0C0F" />
    {marks.map(([x, y]) => <g key={`${x}:${y}`}>
      <rect x={x + 0.5} y={y + 0.5} width={FINDER - 1} height={FINDER - 1} rx={2} fill="none" stroke="#0B0C0F" strokeWidth={1} />
      <circle cx={x + FINDER / 2} cy={y + FINDER / 2} r={1.55} fill="#0B0C0F" />
    </g>)}
  </svg>;
}

type Account = { evm: string; solana: string; label?: string };
type Family = "EVM" | "SOLANA";

/**
 * Receive: one address at a time, big enough to scan, one tap to copy. With "All networks" a switch chooses between the EVM
 * address (the same on every EVM network) and the Solana one; with a network picked, its address and a plain "send only on" line.
 * Under the code: the networks this address works on, so nobody sends from the wrong one.
 */
export function ReceiveView({ account, onBack, toast }: { account: Account; onBack: () => void; toast: (t: string) => void }) {
  const [prefs, setPrefs] = useState<Settings | null>(null);
  const [picking, setPicking] = useState(false);
  const [side, setSide] = useState<Family>("EVM");
  const [copied, setCopied] = useState(false);
  useEffect(() => { void settingsStore.read().then(setPrefs); }, []);
  if (!prefs) return <div className="popup"><div className="backdrop" /><PageHead title="Receive" onBack={onBack} /></div>;
  const network = prefs.network === "all" ? null : networks(prefs.showTestnets).find(n => n.networkId === prefs.network) ?? null;
  const family: Family = network?.family ?? side;
  const address = family === "SOLANA" ? account.solana : account.evm;
  const works = network ? [network] : networks(false).filter(n => n.family === family);
  const title = network ? network.name : family === "EVM" ? "EVM" : "Solana";
  // The first and last characters are what people compare, so they stand out; the middle is quieter.
  const head = address.slice(0, family === "EVM" ? 6 : 4), tail = address.slice(-4), middle = address.slice(head.length, -4);
  const copyIt = async () => { await copy(address); setCopied(true); toast("Address copied"); setTimeout(() => setCopied(false), 1600); };
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Receive" onBack={onBack} right={<NetworkButton selected={prefs.network} onOpen={() => setPicking(true)} />} />
    <div className="scroll receive" data-testid="receive">
      {!network && <div className="switch2" role="tablist" aria-label="Which address" data-side={side}>
        <span className="switch2-thumb" aria-hidden="true" />
        {(["EVM", "SOLANA"] as const).map(f => <button key={f} type="button" role="tab" aria-selected={side === f} data-testid={`receive-${f.toLowerCase()}`} onClick={() => setSide(f)}>{f === "EVM" ? "EVM networks" : "Solana"}</button>)}
      </div>}
      {/* Keyed by the address, so changing it draws the new code in. */}
      <div className="receive-qr" key={address}>
        <AddressQr value={address} label={`QR code of your ${title} address`} />
        <span className="receive-qr-mark">{network ? <ChainLogo networkId={network.networkId} name={network.name} size={26} /> : <ChainLogo networkId={works[0]?.networkId ?? ""} name={title} size={26} />}</span>
      </div>
      <button type="button" className="receive-address num" onClick={() => void copyIt()} aria-label={`Copy your ${title} address`} title="Copy">
        <span data-testid="receive-address"><b>{head}</b>{middle}<b>{tail}</b></span>
      </button>
      <div className="receive-works">
        <span className="receive-logos">{works.slice(0, 6).map(n => <ChainLogo key={n.networkId} networkId={n.networkId} name={n.name} size={20} />)}{works.length > 6 && <i>+{works.length - 6}</i>}</span>
        <span>{network ? `Only on ${network.name}` : family === "EVM" ? `The same address on all ${works.length} EVM networks` : "Solana only"}</span>
      </div>
      {(network || family === "SOLANA") && <div className="confirm-warn" role="note"><AlertTriangle size={15} /><span>{network
        ? <><b>Send only on {network.name}.</b> {network.family === "EVM" ? `Tokens sent on another network arrive there, not on ${network.name}.` : "Tokens sent from another network to this address can be lost."}</>
        : <><b>Solana only.</b> Never send from an EVM network to this address.</>}</span></div>}
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <button type="button" className={`btn primary copy-btn${copied ? " done" : ""}`} onClick={() => void copyIt()}>{copied ? <Check size={17} /> : <Copy size={16} />}{copied ? "Copied" : "Copy address"}</button>
    </div>
    {picking && <NetworkSheet selected={prefs.network} showTestnets={prefs.showTestnets} onClose={() => setPicking(false)}
      onPick={async networkId => { setPicking(false); await settingsStore.write({ network: networkId }); setPrefs(await settingsStore.read()); }} />}
  </div>;
}
