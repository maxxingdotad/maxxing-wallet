import { useMemo, useState } from "react";
import { Check, Download, ShieldCheck } from "lucide-react";
import { Welcome } from "../ui/screens/Welcome";
import { Steps, short } from "../ui/parts";
import { Busy, PageHead, PinPad, message } from "./kit";
import { HoldReveal } from "./Export";
import * as wallet from "../lib/wallet";

/** Asks for a new PIN twice. */
export function NewPin({ title, onPin }: { title: string; onPin: (pin: string) => Promise<void> }) {
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (first === null) return <PinPad key="first" title={title} subtitle="6 digits. You'll use it to open your wallet." error={error} onComplete={pin => { setError(""); setFirst(pin); }} />;
  return <PinPad key="again" title="Enter it again" error={error} onComplete={async pin => {
    if (pin !== first) { setFirst(null); setError("The PINs didn't match. Try again."); return; }
    try { await onPin(pin); } catch (e) { setFirst(null); setError(message(e)); }
  }} />;
}

type Step = "welcome" | "create-pin" | "backup-intro" | "backup-show" | "backup-check" | "import-phrase" | "import-pin" | "done";

/** First run: create a wallet (PIN, then the recovery phrase and a check) or bring one in with its recovery phrase. */
export function Onboarding({ onDone, addOnly, onCancel }: { onDone: () => void; addOnly?: "create" | "import"; onCancel?: () => void }) {
  const [step, setStep] = useState<Step>(addOnly === "create" ? "create-pin" : addOnly === "import" ? "import-phrase" : "welcome");
  const [pin, setPin] = useState("");
  const [words, setWords] = useState<string[]>([]);
  const [phrase, setPhrase] = useState("");
  const [preview, setPreview] = useState<{ evm: string; solana: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const back = onCancel ?? (() => setStep("welcome"));

  if (busy) return <div className="popup"><div className="backdrop" /><Busy text={busy} /></div>;
  if (step === "welcome") return <Welcome onCreate={() => setStep("create-pin")} onImport={() => setStep("import-phrase")} />;

  if (step === "create-pin") return <div className="popup"><div className="backdrop" />
    <PageHead title={addOnly ? "New wallet" : "Create your wallet"} onBack={back} />
    <div className="scroll"><Steps at={1} of={3} /><NewPin title="Create a PIN" onPin={async next => {
      setBusy("Creating your wallet…");
      try { await wallet.create(next); setPin(next); setWords((await wallet.vault.revealPlatformMnemonic(next)).split(" ")); setStep("backup-intro"); }
      finally { setBusy(""); }
    }} /></div>
  </div>;

  if (step === "backup-intro") return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 30 }}>
      <Steps at={2} of={3} />
      <div className="danger-mark" style={{ background: "var(--positive-soft)", color: "var(--positive)", boxShadow: "0 0 0 8px rgb(60 176 122 / .06)" }}><ShieldCheck size={30} strokeWidth={1.7} /></div>
      <h2 className="center-title">Your wallet is ready</h2>
      <p className="center-sub">Now write down your recovery phrase. It's the only way back in if you lose this device or forget your PIN, and anyone who has it can take everything.</p>
    </div>
    <div className="footer"><button type="button" className="btn primary" onClick={() => setStep("backup-show")}>Back up now</button><button type="button" className="btn ghost" onClick={onDone}>Later (you'll be reminded)</button></div>
  </div>;

  if (step === "backup-show") return <HoldReveal title="Your recovery phrase" words={words} step={{ at: 2, of: 3 }} onBack={() => setStep("backup-intro")} doneLabel="I wrote them down" onDone={() => setStep("backup-check")} />;

  if (step === "backup-check") return <BackupCheck words={words} onBack={() => setStep("backup-show")} onChecked={async checks => {
    await wallet.confirmBackup(pin, checks);
    setPin(""); setWords([]);
    setStep("done");
  }} />;

  if (step === "import-phrase") return <div className="popup"><div className="backdrop" />
    <PageHead title="Import a wallet" onBack={back} />
    <div className="scroll">
      <form className="stack" onSubmit={e => { e.preventDefault(); setError(""); try { setPreview(wallet.vault.previewPlatformPhrase(phrase)); setStep("import-pin"); } catch (err) { setError(message(err)); } }}>
        <label className="field">Recovery phrase<textarea autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={e => { setPhrase(e.target.value); setError(""); }} placeholder="12 or 24 words, in order, separated by spaces" /><span className="hint">The same phrase restores your MAXXING wallet from maxxing.ad or the app. It stays on this device.</span></label>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <button type="submit" className="btn primary" disabled={phrase.trim().split(/\s+/).length < 12}><Download size={17} />Continue</button>
      </form>
    </div>
  </div>;

  if (step === "import-pin") return <div className="popup"><div className="backdrop" />
    <PageHead title="Import a wallet" onBack={() => setStep("import-phrase")} />
    <div className="scroll">
      {preview && <div className="card facts" style={{ marginBottom: 12 }}><div className="fact"><span>EVM</span><b className="num">{short(preview.evm)}</b></div><div className="fact"><span>Solana</span><b className="num">{short(preview.solana)}</b></div></div>}
      <NewPin title="Create a PIN for this device" onPin={async next => {
        setBusy("Restoring your wallet…");
        try { await wallet.restore(phrase, next); setPhrase(""); setStep("done"); } finally { setBusy(""); }
      }} />
    </div>
  </div>;

  return <div className="popup"><div className="backdrop" />
    <div className="scroll" style={{ paddingTop: 48 }}>
      <Steps at={3} of={3} />
      <div className="danger-mark" style={{ background: "var(--positive-soft)", color: "var(--positive)", boxShadow: "0 0 0 8px rgb(60 176 122 / .06)" }}><Check size={34} strokeWidth={2.2} /></div>
      <h2 className="center-title">You're all set</h2>
      <p className="center-sub">Your keys are on this device, encrypted with your PIN. MAXXING never has them. Sites can now ask to connect, and you'll see every request before anything is signed.</p>
    </div>
    <div className="footer"><button type="button" className="btn primary" onClick={onDone}>Open my wallet</button></div>
  </div>;
}

/** Two words from the phrase, by position: proves the copy is right before the wallet counts as backed up. */
function BackupCheck({ words, onChecked, onBack }: { words: string[]; onChecked: (checks: { index: number; word: string }[]) => Promise<void>; onBack: () => void }) {
  const picks = useMemo(() => { const a = Math.floor(Math.random() * 6), b = 6 + Math.floor(Math.random() * (words.length - 6)); return [a, b]; }, [words.length]);
  const [answers, setAnswers] = useState(["", ""]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  return <div className="popup"><div className="backdrop" />
    <PageHead title="Check your copy" onBack={onBack} />
    <form className="scroll stack" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError("");
      try { await onChecked(picks.map((index, i) => ({ index, word: answers[i]! }))); } catch (err) { setError(message(err)); } finally { setBusy(false); }
    }}>
      <Steps at={2} of={3} />
      <p className="ask-sub" style={{ margin: "6px 2px 0" }}>Type these two words from the copy you wrote down.</p>
      <div className="word-grid">{picks.map((index, i) => <label key={index} className="field">Word #{index + 1}<input autoFocus={i === 0} autoComplete="off" autoCapitalize="none" spellCheck={false} value={answers[i]} onChange={e => setAnswers(a => a.map((v, j) => j === i ? e.target.value : v))} /></label>)}</div>
      {error && <div className="alert danger" role="alert">{error}</div>}
      <button type="submit" className="btn primary" disabled={busy || answers.some(a => !a.trim())}>{busy ? "Checking…" : "Confirm backup"}</button>
    </form>
  </div>;
}
