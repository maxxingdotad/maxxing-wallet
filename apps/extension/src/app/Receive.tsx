import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Copy } from "lucide-react";
import { addressMatrix } from "../lib/qr";
import { ChainLogo } from "../ui/logos";
import { PageHead, copy } from "./kit";
import { NetworkButton, NetworkSheet } from "./Assets";
import { networks, type Network } from "../lib/chains";
import { listNames } from "../lib/strings";
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

/** One address with its QR, copy, and the network it's for. */
function AddressCard({ network, address, onCopied }: { network: Network | null; address: string; onCopied: () => void }) {
  const [copied, setCopied] = useState(false);
  const family = network?.family ?? (address.startsWith("0x") ? "EVM" : "SOLANA");
  const title = network ? network.name : family === "EVM" ? "EVM networks" : "Solana";
  return <div className="card receive-card">
    <div className="receive-head">{network ? <ChainLogo networkId={network.networkId} name={network.name} size={22} /> : null}<b>{title}</b></div>
    <div className="qr-wrap"><AddressQr value={address} label={`QR code of your ${title} address`} /></div>
    <div className="addr receive-addr" data-testid="receive-address">{address}</div>
    <button type="button" className="btn secondary" style={{ height: 40 }} onClick={async () => { await copy(address); setCopied(true); onCopied(); setTimeout(() => setCopied(false), 1500); }}>
      {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "Copied" : "Copy address"}
    </button>
  </div>;
}

/**
 * Receive, per network: the address for the network picked (or both addresses for "All networks"), each with its QR code and
 * copy, and a plain warning to send only on that network.
 */
export function ReceiveView({ account, onBack, toast }: { account: Account; onBack: () => void; toast: (t: string) => void }) {
  const [prefs, setPrefs] = useState<Settings | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => { void settingsStore.read().then(setPrefs); }, []);
  if (!prefs) return <div className="popup"><div className="backdrop" /><PageHead title="Receive" onBack={onBack} /></div>;
  const network = prefs.network === "all" ? null : networks(prefs.showTestnets).find(n => n.networkId === prefs.network) ?? null;
  // Named from the registry: its three most used EVM networks.
  const evmExamples = listNames(networks(false).filter(n => n.family === "EVM").slice(0, 3).map(n => n.name));
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Receive" onBack={onBack} right={<NetworkButton selected={prefs.network} onOpen={() => setPicking(true)} />} />
    <div className="scroll stack" data-testid="receive">
      {network ? <>
        <div className="alert warn" role="note"><AlertTriangle size={16} /><span><b>Send only on {network.name}.</b> {network.family === "EVM"
          ? `This address is the same on every EVM network, but tokens sent on another network arrive there, not on ${network.name}.`
          : "Tokens sent from another network to this address can be lost."}</span></div>
        <AddressCard network={network} address={network.family === "SOLANA" ? account.solana : account.evm} onCopied={() => toast("Address copied")} />
      </> : <>
        <p className="ask-sub" style={{ margin: "0 2px" }}>Pick a network above to get its address with a warning for it. Your two addresses:</p>
        <AddressCard network={null} address={account.evm} onCopied={() => toast("Address copied")} />
        <p className="receive-note">One address for {evmExamples} and every EVM network. Check the sender uses the network you expect.</p>
        <AddressCard network={null} address={account.solana} onCopied={() => toast("Address copied")} />
        <p className="receive-note">Solana only. Never send from an EVM network to this address.</p>
      </>}
    </div>
    {picking && <NetworkSheet selected={prefs.network} showTestnets={prefs.showTestnets} onClose={() => setPicking(false)}
      onPick={async networkId => { setPicking(false); await settingsStore.write({ network: networkId }); setPrefs(await settingsStore.read()); }} />}
  </div>;
}
