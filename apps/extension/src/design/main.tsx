import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import "../ui/styles.css";
import { Welcome } from "../ui/screens/Welcome";
import { WalletReveal } from "../ui/screens/Reveal";
import { Steps, TokenMark } from "../ui/parts";
import { HoldButton, ReceiptCard } from "../ui/moving";
import { AddressAvatar, BigAmount } from "../ui/confirm";
import { Home } from "../ui/screens/Home";
import { AccountsSheet } from "../ui/screens/Accounts";
import { Swap } from "../ui/screens/Swap";
import { ApproveTransaction } from "../ui/screens/Approve";
import { ExportReveal, ExportWarning } from "../ui/screens/Export";
import { LookalikeWarning, PhishingBlocked } from "../ui/screens/Blocked";
import { ACCOUNTS, CHAINS, HOLDINGS } from "./sample";

/**
 * The design gallery: every screen at the popup's real size (360×600) with sample data, for review. `?screen=<id>` shows one
 * screen alone, for screenshots. Not part of the extension build.
 */
const SCREENS: { id: string; label: string; render: () => ReactNode }[] = [
  { id: "welcome", label: "1 · Welcome (animated)", render: () => <Welcome /> },
  { id: "reveal", label: "1b · New wallet opens (tap the cap)", render: () => <WalletReveal addresses={{ evm: ACCOUNTS[0]!.evm, solana: ACCOUNTS[0]!.solana }} title="Your wallet is ready" steps={<Steps at={2} of={3} />} footer={<><button type="button" className="btn primary">Back up now</button><button type="button" className="btn ghost">Later (you'll be reminded)</button></>}><p className="center-sub">Now write down your recovery phrase. It's the only way back in if you lose this device or forget your password, and anyone who has it can take everything.</p></WalletReveal> },
  { id: "send-done", label: "1c · Sent: the receipt", render: () => <div className="popup"><div className="backdrop" /><div className="scroll" style={{ paddingTop: 22 }}>
    <ReceiptCard className="receipt"><span className="receipt-status good" style={{ background: "var(--positive-soft)", color: "var(--positive)" }}>Confirmed</span>
      <div className="receipt-mark"><TokenMark holding={HOLDINGS[0]!} /></div><BigAmount value="250" symbol="USDC" />
      <div className="receipt-to">to <b>0x8ba1…BA72</b> on Base</div><div className="receipt-hash num">0x5c4e…d7c0</div></ReceiptCard>
    <p className="center-sub" style={{ marginTop: 16 }}>It's in a block. It shows in your balance now.</p></div>
    <div className="footer"><button type="button" className="btn secondary">View on explorer</button><button type="button" className="btn primary">Done</button></div></div> },
  { id: "send-review", label: "1d · Send review", render: () => <div className="popup confirm-screen"><div className="page-head"><span style={{ width: 8 }} /><h1>Review</h1></div>
    <div className="scroll confirm-scroll"><div className="confirm-hero"><AddressAvatar address="0x8ba1f109551bD432803012645Ac136ddd64DBA72" />
      <div className="confirm-to">To <b>0x8ba1…BA72</b></div><BigAmount value="240.00" symbol="USDC" /><div className="confirm-usd">≈ $240.00</div>
      <div className="confirm-address num">0x8ba1f109551bD432803012645Ac136ddd64DBA72</div></div>
      <div className="confirm-warnings"><div className="confirm-warn"><span><b>First time sending to this address.</b> Check it with the person you're paying.</span></div></div></div>
    <div className="confirm-panel"><div className="confirm-rows"><div><span>From</span><b>Main</b></div><div><span>Network</span><b>Base</b></div><div><span>Network fee, at most</span><b>0.000012 ETH<em> ≈ $0.04</em></b></div></div>
      <HoldButton label="Send" busyLabel="Sending…" onConfirm={() => {}} /></div></div> },
  { id: "home", label: "2 · Home: one balance", render: () => <Home account={ACCOUNTS[0]!} holdings={HOLDINGS} network="all" /> },
  { id: "accounts", label: "3 · Accounts", render: () => <div style={{ position: "relative" }}><Home account={ACCOUNTS[0]!} holdings={HOLDINGS} network="all" /><div style={{ position: "absolute", inset: 0, borderRadius: 14, overflow: "hidden" }}><AccountsSheet accounts={ACCOUNTS} activeId="a1" /></div></div> },
  { id: "swap", label: "4 · Swap & bridge, fee paid in USDC", render: () => <Swap from={{ symbol: "USDC", chain: CHAINS.base!, color: "#3E73C4" }} to={{ symbol: "SOL", chain: CHAINS.solana!, logo: "/brand/sol-symbol.webp" }} /> },
  { id: "approve", label: "5 · Approval: unlimited spend", render: () => <ApproveTransaction chain={CHAINS.base!} site="app.example-dex.io" verified={false} /> },
  { id: "export-warning", label: "6 · Export: warning", render: () => <ExportWarning /> },
  { id: "export-reveal", label: "7 · Export: hold to reveal", render: () => <ExportReveal /> },
  { id: "export-shown", label: "8 · Export: shown, auto-hides", render: () => <ExportReveal revealed /> },
  { id: "phishing", label: "9 · Known scam blocked", render: () => <PhishingBlocked host="claim.wallet-drainer.example" domain="wallet-drainer.example" onLeave={() => {}} onKeep={() => {}} /> },
  { id: "lookalike", label: "10 · Look-alike name warning", render: () => <LookalikeWarning host="maxxing-airdrop.claims" domain="maxxing-airdrop.claims" unicode={null} onLeave={() => {}} onContinue={() => {}} /> },
];

const one = new URLSearchParams(location.search).get("screen");
const screen = SCREENS.find(s => s.id === one);
createRoot(document.getElementById("app")!).render(screen
  ? <div style={{ width: 360, height: 600, position: "relative" }}>{screen.render()}</div>
  : <main className="gallery">{SCREENS.map(s => <div key={s.id} className="frame"><span>{s.label}</span>{s.render()}</div>)}</main>);
