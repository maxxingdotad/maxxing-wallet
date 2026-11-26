import { useEffect, useRef, useState } from "react";
import { Camera, Check, Clock3, Copy, EyeOff, KeyRound } from "lucide-react";
import { Steps } from "../ui/parts";
import { PageHead, PasswordForm, canClearClipboard, copy, message } from "./kit";
import * as wallet from "../lib/wallet";

const HIDE_AFTER = 60;

/**
 * A secret behind a press-and-hold: blurred until held for 1.5 s, hidden again after 60 s, and a reminder not to screenshot it.
 * Copy is offered only where the background really clears the clipboard after 60 s (see kit.copy). Used for the recovery phrase and for private keys.
 */
export function HoldReveal({ title, words, secrets, step, onBack, onDone, doneLabel = "Done" }: {
  title: string; words?: string[]; secrets?: { label: string; value: string }[]; step?: { at: number; of: number };
  onBack: () => void; onDone: () => void; doneLabel?: string;
}) {
  const [held, setHeld] = useState(0);
  const [left, setLeft] = useState(HIDE_AFTER);
  const [copied, setCopied] = useState("");
  const timer = useRef<number | null>(null);
  const shown = held >= 1;
  useEffect(() => {
    if (!shown) return;
    setLeft(HIDE_AFTER);
    const t = setInterval(() => setLeft(s => { if (s <= 1) { setHeld(0); return HIDE_AFTER; } return s - 1; }), 1000);
    return () => clearInterval(t);
  }, [shown]);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const start = () => { const t0 = Date.now(); timer.current = window.setInterval(() => { const v = Math.min(1, (Date.now() - t0) / 1500); setHeld(v); if (v >= 1 && timer.current) clearInterval(timer.current); }, 30); };
  const stop = () => { if (timer.current) clearInterval(timer.current); setHeld(h => h >= 1 ? 1 : 0); };
  const doCopy = async (label: string, value: string) => { await copy(value, HIDE_AFTER); setCopied(label); setTimeout(() => setCopied(""), 2000); };
  const copyable = canClearClipboard();
  return <div className="popup"><div className="backdrop" />
    <PageHead title={title} onBack={onBack} />
    <div className="scroll" style={{ paddingBottom: 150 }}>
      {step && <Steps at={step.at} of={step.of} />}
      <div className="alert warn" style={{ margin: "12px 0" }}><Camera size={16} /><span><b>No screenshots.</b> Write it on paper and keep it offline. MAXXING will never ask for it.</span></div>
      {words && <ol className={`phrase${shown ? "" : " blurred"}`} style={{ margin: 0 }}>
        {words.map((w, i) => <li key={i}><small>{i + 1}</small>{w}</li>)}
        {!shown && <div className="veil"><EyeOff size={22} style={{ color: "var(--text-2)" }} /></div>}
      </ol>}
      {secrets?.map(s => <div key={s.label} style={{ marginBottom: 10 }}>
        <div className="section-head" style={{ marginTop: 4 }}><h2>{s.label}</h2>{shown && copyable && <button type="button" onClick={() => doCopy(s.label, s.value)}>{copied === s.label ? "Copied · clears in 60s" : "Copy"}</button>}</div>
        <div className="card" style={{ padding: 12, position: "relative" }}><div className="addr" style={{ filter: shown ? "none" : "blur(6px)", userSelect: shown ? "text" : "none" }}>{s.value}</div></div>
      </div>)}
      {shown && <div className="timer"><Clock3 size={13} /> Hides again in {left}s · <button type="button" className="link-btn" style={{ fontSize: 12 }} onClick={() => setHeld(0)}>Hide now</button></div>}
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      {shown
        ? <>{words && copyable && <button type="button" className="btn secondary" onClick={() => doCopy("phrase", words.join(" "))}><Copy size={16} />{copied ? "Copied · clears in 60s" : "Copy (clears in 60s)"}</button>}<button type="button" className="btn primary" onClick={onDone}>{doneLabel}</button></>
        : <button type="button" className="btn primary hold" style={{ ["--held" as string]: held }} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onKeyDown={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (!timer.current) start(); } }} onKeyUp={() => { stop(); timer.current = null; }}><span className="fill" /><span>Press and hold to reveal</span></button>}
    </div>
  </div>;
}

const CHECKS = {
  phrase: ["Anyone with my recovery phrase can take everything in this wallet, on every chain.", "MAXXING will never ask for it: not support, not an email, not a site.", "I'm alone, and no one can see my screen."],
  keys: ["Anyone with these keys can take everything in this account.", "MAXXING will never ask for them: not support, not an email, not a site.", "I'm alone, and no one can see my screen."],
};

/** Exporting the recovery phrase or the private keys: warning and three ticks, then the PIN, then the hold-to-reveal. Logged locally. */
export function ExportFlow({ kind, onClose }: { kind: "phrase" | "keys"; onClose: () => void }) {
  const [step, setStep] = useState<"warn" | "pin" | "show">("warn");
  const [ticks, setTicks] = useState([false, false, false]);
  const [error, setError] = useState(""), [waitUntil, setWaitUntil] = useState(wallet.pinWaitUntil());
  const [secret, setSecret] = useState<{ words?: string[]; secrets?: { label: string; value: string }[] } | null>(null);
  const title = kind === "phrase" ? "Recovery phrase" : "Private keys";
  useEffect(() => () => setSecret(null), []);
  if (step === "warn") return <div className="popup">
    <div className="backdrop" style={{ background: "radial-gradient(120% 50% at 50% -10%, rgb(225 93 85 / .14), transparent 60%)" }} />
    <PageHead title={kind === "phrase" ? "Show recovery phrase" : "Export private keys"} onBack={onClose} />
    <div className="scroll" style={{ paddingBottom: 130 }}>
      <Steps at={1} of={3} />
      <div className="danger-mark"><KeyRound size={28} strokeWidth={1.8} /></div>
      <h2 className="center-title">Anyone with this can take everything.</h2>
      <p className="center-sub">MAXXING will never ask for it. If someone is asking you for it right now, close this and stop talking to them.</p>
      <div className="checks">
        {CHECKS[kind].map((text, i) => <button key={i} type="button" className={`check${ticks[i] ? " on" : ""}`} role="checkbox" aria-checked={ticks[i]} onClick={() => setTicks(v => v.map((x, j) => j === i ? !x : x))}>
          <span className="box">{ticks[i] && <Check size={14} strokeWidth={3} />}</span><span>{text}</span>
        </button>)}
      </div>
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}><button type="button" className="btn danger" disabled={!ticks.every(Boolean)} onClick={() => setStep("pin")}>Continue</button></div>
  </div>;
  if (step === "pin" || !secret) return <div className="popup"><div className="backdrop" />
    <PageHead title={title} onBack={() => setStep("warn")} />
    <div className="scroll"><Steps at={2} of={3} /><PasswordForm title="Enter your password" subtitle={kind === "phrase" ? "To show your recovery phrase." : "To show your private keys."} submitLabel="Continue" error={error} waitUntil={waitUntil} onComplete={async pin => {
      try {
        setError("");
        if (kind === "phrase") setSecret({ words: (await wallet.revealPhrase(pin)).split(" ") });
        else { const keys = await wallet.revealKeys(pin); setSecret({ secrets: [{ label: "EVM private key", value: keys.evm }, { label: "Solana private key (base58)", value: keys.solana }] }); }
        setStep("show");
      } catch (e) { setError(message(e)); setWaitUntil(wallet.pinWaitUntil()); }
    }} /></div>
  </div>;
  return <HoldReveal title={title} words={secret.words} secrets={secret.secrets} step={{ at: 3, of: 3 }} onBack={() => { setSecret(null); onClose(); }} onDone={() => { setSecret(null); onClose(); }} />;
}
