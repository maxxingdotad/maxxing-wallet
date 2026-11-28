import { useState } from "react";
import { AlertTriangle, Download, RotateCcw } from "lucide-react";
import { short } from "../ui/parts";
import { Busy, NewPassword, PageHead, message } from "./kit";
import * as wallet from "../lib/wallet";

/**
 * Starting over after a forgotten password, from the lock screen. The password can't be reset (it is what encrypts the keys, and
 * MAXXING never has it), so the way back is the recovery phrase: this erases the wallets on this device, restores the phrase's
 * wallet, and asks for a new password. Three steps, and nothing is erased before the last one:
 *   1. what will be erased, naming every wallet that isn't backed up, and a box to tick;
 *   2. the recovery phrase, checked, with the addresses it restores shown;
 *   3. the new password. Only saving it erases and restores.
 */
export function StartOver({ snap, onBack, onDone }: { snap: wallet.WalletSnapshot; onBack: () => void; onDone: () => void }) {
  const [step, setStep] = useState<"warn" | "phrase" | "password">("warn");
  const [sure, setSure] = useState(false);
  const [phrase, setPhrase] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ evm: string; solana: string } | null>(null);
  const notBackedUp = snap.accounts.filter(a => !a.backedUp);
  // Whether the phrase is for a wallet that is here now: the others will not come back with it.
  const restored = preview ? snap.accounts.find(a => a.evm.toLowerCase() === preview.evm.toLowerCase()) : undefined;
  const others = snap.accounts.filter(a => a !== restored);

  if (busy) return <div className="popup"><div className="backdrop" /><Busy text="Restoring your wallet…" /></div>;

  if (step === "warn") return <div className="popup" data-testid="start-over"><div className="backdrop" style={{ background: "radial-gradient(120% 50% at 50% -10%, rgb(225 93 85 / .14), transparent 60%)" }} />
    <PageHead title="Start over" onBack={onBack} />
    <div className="scroll">
      <div className="danger-mark"><RotateCcw size={28} /></div>
      <h2 className="center-title">Start over with your recovery phrase</h2>
      <p className="center-sub">Every wallet on this device is erased. The wallet of the recovery phrase you enter next comes back, with a new password. Your funds stay on the blockchain.</p>
      <div className="card rows" style={{ marginTop: 12 }}>{snap.accounts.map(a => <div key={a.id} className="row"><div className="main"><b>{a.label}</b><span className="num">{short(a.evm)}</span></div><span style={{ fontSize: 12, color: a.backedUp ? "var(--muted)" : "var(--negative)" }}>{a.backedUp ? "Backed up" : "Not backed up"}</span></div>)}</div>
      {notBackedUp.length > 0 && <div className="alert danger" style={{ marginTop: 10 }}><AlertTriangle size={16} /><span>
        <b>{notBackedUp.length === 1 ? `${notBackedUp[0]!.label} isn't backed up.` : `${notBackedUp.length} wallets aren't backed up.`}</b> Without {notBackedUp.length === 1 ? "its" : "their"} recovery phrase, starting over loses {notBackedUp.length === 1 ? "it" : "them"} for good. Keep trying to remember your password first.</span></div>}
      <div className="checks"><button type="button" className={`check${sure ? " on" : ""}`} aria-pressed={sure} onClick={() => setSure(s => !s)}><span className="box" /><span>I have the recovery phrase of every wallet I want to keep, and I understand the others are erased here.</span></button></div>
    </div>
    <div className="footer">
      <button type="button" className="btn primary" disabled={!sure} onClick={() => setStep("phrase")}>Continue</button>
      <button type="button" className="btn ghost" onClick={onBack}>Keep trying my password</button>
    </div>
  </div>;

  if (step === "phrase") return <div className="popup"><div className="backdrop" />
    <PageHead title="Start over" onBack={() => setStep("warn")} />
    <div className="scroll">
      <form className="stack" onSubmit={e => { e.preventDefault(); setError(""); try { setPreview(wallet.vault.previewPlatformPhrase(phrase)); setStep("password"); } catch (err) { setError(message(err)); } }}>
        <label className="field">Recovery phrase<textarea autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={e => { setPhrase(e.target.value); setError(""); }} placeholder="12 or 24 words, in order, separated by spaces" /><span className="hint">Nothing is erased yet. The phrase is checked first.</span></label>
        {error && <div className="alert danger" role="alert">{error}</div>}
        <button type="submit" className="btn primary" disabled={phrase.trim().split(/\s+/).length < 12}><Download size={17} />Continue</button>
      </form>
    </div>
  </div>;

  return <div className="popup"><div className="backdrop" />
    <PageHead title="Start over" onBack={() => setStep("phrase")} />
    <div className="scroll">
      {preview && <div className="card facts" style={{ marginBottom: 12 }}><div className="fact"><span>{restored ? restored.label : "Comes back"}</span><b className="num">{short(preview.evm)}</b></div><div className="fact"><span>Solana</span><b className="num">{short(preview.solana)}</b></div></div>}
      {others.length > 0 && <div className="alert danger" style={{ marginBottom: 12 }}><AlertTriangle size={16} /><span>{others.length === 1 ? `${others[0]!.label} is` : `${others.length} other wallets are`} erased from this device when you save the password. Restore {others.length === 1 ? "it" : "them"} afterwards with {others.length === 1 ? "its" : "their"} own recovery phrase.</span></div>}
      <NewPassword title="Choose a new password" subtitle="Saving it erases the wallets on this device and restores this one." submitLabel="Erase and restore" onPassword={async password => {
        setBusy(true);
        try { await wallet.startOver(phrase, password, restored?.label); setPhrase(""); onDone(); } finally { setBusy(false); }
      }} />
    </div>
  </div>;
}
