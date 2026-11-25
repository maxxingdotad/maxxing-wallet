import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import "../ui/styles.css";
import { Welcome } from "../ui/screens/Welcome";
import { Home } from "../ui/screens/Home";
import { AccountsSheet } from "../ui/screens/Accounts";
import { Swap } from "../ui/screens/Swap";
import { ApproveTransaction } from "../ui/screens/Approve";
import { ExportReveal, ExportWarning } from "../ui/screens/Export";
import { PhishingBlocked } from "../ui/screens/Blocked";
import { ACCOUNTS, CHAINS, HOLDINGS } from "./sample";

/**
 * The design gallery: every screen at the popup's real size (360×600) with sample data, for review. `?screen=<id>` shows one
 * screen alone, for screenshots. Not part of the extension build.
 */
const SCREENS: { id: string; label: string; render: () => ReactNode }[] = [
  { id: "welcome", label: "1 · Welcome (animated)", render: () => <Welcome /> },
  { id: "home", label: "2 · Home: one balance", render: () => <Home account={ACCOUNTS[0]!} holdings={HOLDINGS} network="all" /> },
  { id: "accounts", label: "3 · Accounts", render: () => <div style={{ position: "relative" }}><Home account={ACCOUNTS[0]!} holdings={HOLDINGS} network="all" /><div style={{ position: "absolute", inset: 0, borderRadius: 14, overflow: "hidden" }}><AccountsSheet accounts={ACCOUNTS} activeId="a1" /></div></div> },
  { id: "swap", label: "4 · Swap & bridge, fee paid in USDC", render: () => <Swap from={{ symbol: "USDC", chain: CHAINS.base!, color: "#3E73C4" }} to={{ symbol: "SOL", chain: CHAINS.solana!, logo: "/brand/sol-symbol.webp" }} /> },
  { id: "approve", label: "5 · Approval: unlimited spend", render: () => <ApproveTransaction chain={CHAINS.base!} site="app.example-dex.io" verified={false} /> },
  { id: "export-warning", label: "6 · Export: warning", render: () => <ExportWarning /> },
  { id: "export-reveal", label: "7 · Export: hold to reveal", render: () => <ExportReveal /> },
  { id: "export-shown", label: "8 · Export: shown, auto-hides", render: () => <ExportReveal revealed /> },
  { id: "phishing", label: "9 · Phishing site blocked", render: () => <PhishingBlocked host="maxxing-airdrop.claims" lookalike="maxxing.ad" /> },
];

const one = new URLSearchParams(location.search).get("screen");
const screen = SCREENS.find(s => s.id === one);
createRoot(document.getElementById("app")!).render(screen
  ? <div style={{ width: 360, height: 600, position: "relative" }}>{screen.render()}</div>
  : <main className="gallery">{SCREENS.map(s => <div key={s.id} className="frame"><span>{s.label}</span>{s.render()}</div>)}</main>);
