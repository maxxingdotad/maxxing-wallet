import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WalletScreen, WalletScreenResult } from "../protocol";
import * as vault from "@maxxing/wallet-core/vault";
import { forgetWallet, oneTapEnabled, setOneTap } from "@maxxing/wallet-core/approvals";
import type { ApprovalView } from "../consent";
import { PinPad } from "./PinPad";
import "./styles.css";

export const SCREENS: WalletScreen[] = ["create", "unlock", "restore", "backup", "reveal", "change-pin", "remove", "passkey", "one-tap"];

let root: Root | null = null;
let closeCurrent: ((result: WalletScreenResult) => void) | null = null;

/** Closes whatever screen or approval is open, as if the user closed it. */
export function closeScreens() { closeCurrent?.({ done: false }); }

/**
 * Shows a signing request and resolves true only when the user approves it. Requests wait their turn: one sheet at a time, in order.
 * Another screen opening, a cancel or a sign-out closes it as declined.
 */
let approvalQueue: Promise<unknown> = Promise.resolve();
export function openApproval(view: ApprovalView, setVisible: (visible: boolean) => void): Promise<boolean> {
  const next = approvalQueue.then(() => new Promise<boolean>(resolve => {
    const host = document.getElementById("wallet-ui") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "wallet-ui" }));
    root ??= createRoot(host);
    closeCurrent?.({ done: false });
    setVisible(true);
    const finish = (result: WalletScreenResult) => {
      if (closeCurrent !== finish) return;
      closeCurrent = null;
      root?.render(null);
      setVisible(false);
      resolve(result.done);
    };
    closeCurrent = finish;
    root!.render(<ApprovalSheet key={Date.now()} view={view} finish={finish} />);
  }));
  approvalQueue = next.catch(() => false);
  return next;
}

function ApprovalSheet({ view, finish }: { view: ApprovalView; finish: (result: WalletScreenResult) => void }) {
  const decline = () => finish({ done: false });
  useEffect(() => { window.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") decline(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget) decline(); }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label="Approve in your MAXXING wallet">
        <header className="sheet-head">
          <span className="brand"><img src="/cap.webp" alt="" width="18" height="18" />MAXXING wallet</span>
          <button type="button" className="icon" onClick={decline} aria-label="Decline">×</button>
        </header>
        <p className="site">{view.site} asks you to</p>
        <h1>{view.title}</h1>
        {view.actions.map((line, i) => <p key={i} className="action">{line}</p>)}
        {view.warnings.map((line, i) => <p key={i} className="error" role="alert">{line}</p>)}
        {view.rows.length > 0 && <dl className="rows">{view.rows.map(([label, value], i) => <div key={i}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
        {view.text && <pre className={`message${view.text.raw ? " raw" : ""}`}>{view.text.text}</pre>}
        <button type="button" className="primary" autoFocus onClick={() => finish({ done: true })}>Approve</button>
        <button type="button" className="secondary" onClick={decline}>Decline</button>
        <footer className="sheet-foot">Only approve what you expect. One-tap trading can skip this; it's off unless you turn it on.</footer>
      </section>
    </div>
  );
}

/** Shows one wallet screen and resolves when the user finishes or closes it. One screen at a time. */
export function openScreen(screen: WalletScreen, setVisible: (visible: boolean) => void): Promise<WalletScreenResult> {
  closeCurrent?.({ done: false });
  const host = document.getElementById("wallet-ui") ?? document.body.appendChild(Object.assign(document.createElement("div"), { id: "wallet-ui" }));
  root ??= createRoot(host);
  setVisible(true);
  return new Promise(resolve => {
    const finish = (result: WalletScreenResult) => {
      if (closeCurrent !== finish) return;
      closeCurrent = null;
      root?.render(null);
      setVisible(false);
      resolve(result);
    };
    closeCurrent = finish;
    root!.render(<Sheet key={`${screen}:${Date.now()}`} screen={screen} finish={finish} />);
  });
}

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const message = (error: unknown) => error instanceof Error ? friendly(error.message) : "Something went wrong. Try again.";
function friendly(code: string) {
  if (code === "WALLET_OPERATION_CANCELLED") return "Cancelled.";
  if (code === "NO_PLATFORM_WALLET") return "There is no wallet on this device yet.";
  if (code === "WALLET_STORAGE_DAMAGED_RESTORE_BACKUP") return "This device's wallet data is damaged. Restore with your recovery phrase.";
  if (code === "PASSKEY_CANCELLED") return "Passkey cancelled.";
  if (code === "PASSKEY_EXISTS") return "This passkey already opens this wallet.";
  if (code === "PASSKEY_PRF_UNAVAILABLE") return "This browser or passkey can't open a wallet. Use your PIN, or try another browser or passkey.";
  if (code === "PASSKEY_WRONG") return "That passkey doesn't open this wallet. Use your PIN.";
  if (code === "PASSKEY_NOT_SET") return "No passkey is set up for this wallet.";
  return code;
}
function waitOf(error: unknown) { const w = (error as { waitUntil?: number })?.waitUntil; return typeof w === "number" && w > Date.now() ? w : 0; }

function Sheet({ screen, finish }: { screen: WalletScreen; finish: (result: WalletScreenResult) => void }) {
  const close = () => finish({ done: false });
  // Take the keyboard as soon as the screen opens, so the PIN can be typed without clicking first.
  useEffect(() => { window.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const done = () => finish({ done: true });
  return (
    <div className="backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label="MAXXING wallet">
        <header className="sheet-head">
          <span className="brand"><img src="/cap.webp" alt="" width="18" height="18" />MAXXING wallet</span>
          <button type="button" className="icon" onClick={close} aria-label="Close">×</button>
        </header>
        {screen === "create" && <Create done={done} />}
        {screen === "unlock" && <Unlock done={done} />}
        {screen === "restore" && <Restore done={done} />}
        {screen === "backup" && <Backup done={done} />}
        {screen === "reveal" && <Reveal done={done} />}
        {screen === "change-pin" && <ChangePin done={done} />}
        {screen === "remove" && <Remove done={done} close={close} />}
        {screen === "passkey" && <Passkey done={done} />}
        {screen === "one-tap" && <OneTap done={done} />}
        <footer className="sheet-foot">Only you can open your wallet</footer>
      </section>
    </div>
  );
}

/** Asks for a new PIN twice. */
function NewPin({ title, onPin }: { title: string; onPin: (pin: string) => Promise<void> }) {
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (first == null) return <PinPad key="first" title={title} subtitle="6 digits. You'll use it to open your wallet." error={error} onComplete={async pin => { setError(""); setFirst(pin); }} />;
  return <PinPad key="again" title="Enter it again" onComplete={async pin => {
    if (pin !== first) { setFirst(null); setError("The PINs didn't match. Try again."); return; }
    await onPin(pin);
  }} />;
}

/** Asks for the current PIN, showing waits after wrong tries. */
function CurrentPin({ title, subtitle, onPin }: { title: string; subtitle?: string; onPin: (pin: string) => Promise<void> }) {
  const [error, setError] = useState("");
  const [waitUntil, setWaitUntil] = useState(() => vault.pinWaitUntil());
  return <PinPad title={title} subtitle={subtitle} error={error} waitUntil={waitUntil} onComplete={async pin => {
    try { setError(""); await onPin(pin); }
    catch (e) { setError(message(e)); setWaitUntil(waitOf(e)); throw e; }
  }} />;
}

function Create({ done }: { done: () => void }) {
  const [pin, setPin] = useState<string | null>(null);
  const [offered, setOffered] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (pin && !offered) return <PasskeyOffer next={() => setOffered(true)} />;
  if (pin) return <Backup pin={pin} done={done} intro />;
  if (busy) return <Busy text="Creating your wallet…" />;
  return <>
    {error && <p className="error" role="alert">{error}</p>}
    <NewPin title="Create a PIN" onPin={async next => {
      setBusy(true);
      try { await vault.createPlatformWallet(next); setPin(next); }
      catch (e) { setError(message(e)); }
      finally { setBusy(false); }
    }} />
  </>;
}

function Unlock({ done }: { done: () => void }) {
  const [restoring, setRestoring] = useState(false);
  const accounts = safeAccounts(), active = accounts.find(a => a.id === vault.activePlatformWalletId());
  const [usePin, setUsePin] = useState(!active?.passkey);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  if (restoring) return <Restore done={done} />;
  const withPasskey = async () => {
    setBusy(true); setError("");
    try { await vault.unlockPlatformWalletWithPasskey(); done(); }
    catch (e) { const code = e instanceof Error ? e.message : ""; setError(message(e)); if (code !== "PASSKEY_CANCELLED") setUsePin(true); }
    finally { setBusy(false); }
  };
  return <>
    {active && <div className="account"><b>{active.label}</b><small>{short(active.evm)}</small></div>}
    {!usePin ? <>
      <h1>Open your wallet</h1>
      <p>Use the passkey you set up on this device.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="primary" autoFocus disabled={busy} onClick={withPasskey}>{busy ? "Waiting for your passkey…" : "Unlock with passkey"}</button>
      <button type="button" className="secondary" onClick={() => { setError(""); setUsePin(true); }}>Use PIN instead</button>
    </> : <>
      {error && <p className="error" role="alert">{error}</p>}
      <CurrentPin title="Enter your PIN" onPin={async pin => { await vault.unlockPlatformWallet(pin); done(); }} />
      {active?.passkey && <button type="button" className="link" onClick={() => { setError(""); setUsePin(false); }}>Use passkey instead</button>}
    </>}
    <button type="button" className="link" onClick={() => setRestoring(true)}>Forgot your PIN? Restore with your recovery phrase</button>
  </>;
}

/** Shows the phrase, then checks two words. With `intro`, it follows creating a wallet and can be skipped. */
function Backup({ done, pin: knownPin, intro }: { done: () => void; pin?: string; intro?: boolean }) {
  const [pin, setPin] = useState(knownPin ?? null);
  const [words, setWords] = useState<string[] | null>(null);
  const [showIntro, setShowIntro] = useState(Boolean(intro));
  const [error, setError] = useState("");
  useEffect(() => { if (pin && !words) vault.revealPlatformMnemonic(pin).then(m => setWords(m.split(" ")), e => setError(message(e))); }, [pin]);
  if (!pin) return <CurrentPin title="Enter your PIN" subtitle="To show your recovery phrase." onPin={async next => { await vault.checkPlatformPin(next); setPin(next); }} />;
  if (showIntro && words) return <>
    <div className="done-mark" aria-hidden="true">✓</div>
    <h1>Your wallet is ready</h1>
    <p>Back up your recovery phrase now. It's the only way back in if you lose this device or forget your PIN.</p>
    <button type="button" className="primary" onClick={() => setShowIntro(false)}>Back up now</button>
    <button type="button" className="secondary" onClick={done}>Later</button>
  </>;
  if (!words) return error ? <p className="error" role="alert">{error}</p> : <Busy text="Opening…" />;
  return <PhraseCheck words={words} pin={pin} done={done} />;
}

function PhraseCheck({ words, pin, done }: { words: string[]; pin: string; done: () => void }) {
  const [step, setStep] = useState<"show" | "check">("show");
  const [picks] = useState(() => { const a = Math.floor(Math.random() * 6), b = 6 + Math.floor(Math.random() * 6); return [a, b]; });
  const [answers, setAnswers] = useState(["", ""]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (step === "show") return <>
    <h1>Your recovery phrase</h1>
    <p>Write these {words.length} words down in order and keep them offline. Anyone with them can take your funds.</p>
    <Phrase words={words} />
    <button type="button" className="primary" onClick={() => setStep("check")}>I wrote them down</button>
  </>;
  return <form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError("");
    try { await vault.confirmPlatformBackup(pin, picks.map((index, i) => ({ index, word: answers[i] }))); done(); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }}>
    <h1>Check your copy</h1>
    <p>Enter these two words from your copy.</p>
    <div className="pair">
      {picks.map((index, i) => <label key={index}>Word {index + 1}<input autoFocus={i === 0} autoComplete="off" autoCapitalize="none" spellCheck={false} value={answers[i]} onChange={e => setAnswers(a => a.map((v, j) => j === i ? e.target.value : v))} /></label>)}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <button type="submit" className="primary" disabled={busy || answers.some(a => !a.trim())}>{busy ? "Checking…" : "Done"}</button>
    <button type="button" className="secondary" onClick={() => setStep("show")}>Show the words again</button>
  </form>;
}

function Phrase({ words }: { words: string[] }) {
  const [shown, setShown] = useState(false);
  return <div className={`phrase${shown ? "" : " hidden"}`}>
    <ol>{words.map((word, index) => <li key={index}><small>{index + 1}</small>{word}</li>)}</ol>
    {!shown && <button type="button" className="reveal" onClick={() => setShown(true)}>Tap to show. Make sure no one can see your screen.</button>}
  </div>;
}

function Reveal({ done }: { done: () => void }) {
  const [words, setWords] = useState<string[] | null>(null);
  if (!words) return <CurrentPin title="Enter your PIN" subtitle="To show your recovery phrase." onPin={async pin => setWords((await vault.revealPlatformMnemonic(pin)).split(" "))} />;
  return <>
    <h1>Your recovery phrase</h1>
    <p>Anyone with these words can take your funds. Never share them.</p>
    <Phrase words={words} />
    <button type="button" className="primary" onClick={done}>Done</button>
  </>;
}

function ChangePin({ done }: { done: () => void }) {
  const [old, setOld] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!old) return <CurrentPin title="Enter your current PIN" onPin={async pin => { await vault.checkPlatformPin(pin); setOld(pin); }} />;
  return <>
    {error && <p className="error" role="alert">{error}</p>}
    <NewPin title="Choose a new PIN" onPin={async pin => { try { await vault.changePlatformPin(old, pin); done(); } catch (e) { setError(message(e)); } }} />
  </>;
}

function Remove({ done, close }: { done: () => void; close: () => void }) {
  const active = safeAccounts().find(a => a.id === vault.activePlatformWalletId());
  const [sure, setSure] = useState(false);
  if (active && !active.backedUp) return <>
    <h1>Back up first</h1>
    <p>This wallet isn't backed up. Removing it now would lose it for good.</p>
    <button type="button" className="primary" onClick={close}>OK</button>
  </>;
  if (!sure) return <>
    <h1>Remove this wallet from this device?</h1>
    <p>You can restore it later with your recovery phrase.</p>
    <button type="button" className="danger" onClick={() => setSure(true)}>Remove</button>
    <button type="button" className="secondary" onClick={close}>Cancel</button>
  </>;
  return <CurrentPin title="Enter your PIN" subtitle="To remove this wallet." onPin={async pin => { const id = active?.id; await vault.forgetPlatformWallet(pin); if (id) forgetWallet(id); done(); }} />;
}

function Restore({ done }: { done: () => void }) {
  const [mode, setMode] = useState<"choose" | "phrase" | "file">("choose");
  const [phrase, setPhrase] = useState("");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<{ evm: string; solana: string } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  if (restored) return <PasskeyOffer next={done} />;
  if (busy) return <Busy text="Restoring your wallet…" />;
  if (preview) return <>
    <div className="account"><b>Wallet found</b><small>{short(preview.evm)} · {short(preview.solana)}</small></div>
    {error && <p className="error" role="alert">{error}</p>}
    <NewPin title="Create a PIN for this device" onPin={async pin => {
      setBusy(true); setError("");
      try { mode === "phrase" ? await vault.importPlatformWallet(phrase, pin) : await vault.importPlatformBackup(file!.text, password, pin); setRestored(true); }
      catch (e) { setError(message(e)); setPreview(null); }
      finally { setBusy(false); }
    }} />
  </>;
  if (mode === "choose") return <>
    <h1>Restore your wallet</h1>
    <div className="choices">
      <button type="button" onClick={() => setMode("phrase")}><b>Recovery phrase</b><small>Your 12 or 24 words</small></button>
      <button type="button" onClick={() => setMode("file")}><b>Older backup file</b><small>A .json file saved before, with its password</small></button>
    </div>
  </>;
  if (mode === "phrase") return <form onSubmit={event => {
    event.preventDefault(); setError("");
    try { setPreview(vault.previewPlatformPhrase(phrase)); } catch (e) { setError(message(e)); }
  }}>
    <h1>Enter your recovery phrase</h1>
    <p>All the words, in order, separated by spaces.</p>
    <textarea rows={4} autoFocus autoComplete="off" autoCapitalize="none" spellCheck={false} value={phrase} onChange={e => { setPhrase(e.target.value); setError(""); }} aria-label="Recovery phrase" />
    {error && <p className="error" role="alert">{error}</p>}
    <button type="submit" className="primary" disabled={phrase.trim().split(/\s+/).length < 12}>Continue</button>
    <button type="button" className="secondary" onClick={() => setMode("choose")}>Back</button>
  </form>;
  return <form onSubmit={async event => {
    event.preventDefault(); setError(""); setBusy(true);
    try { setPreview(await vault.previewPlatformBackup(file!.text, password)); } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }}>
    <h1>Restore from an older backup file</h1>
    <input ref={picker} type="file" accept="application/json,.json" hidden onChange={async e => { const f = e.target.files?.[0]; if (f) setFile({ name: f.name, text: await f.text() }); }} />
    <button type="button" className="file" onClick={() => picker.current?.click()}>{file ? file.name : "Choose backup file"}</button>
    <label>File password<input type="password" autoComplete="off" value={password} onChange={e => { setPassword(e.target.value); setError(""); }} /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <button type="submit" className="primary" disabled={!file || !password}>Continue</button>
    <button type="button" className="secondary" onClick={() => setMode("choose")}>Back</button>
  </form>;
}

/** Whether this browser may unlock with a passkey; null while checking. */
function usePasskeySupport() {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => { let live = true; void vault.passkeysSupported().then(ok => { if (live) setSupported(ok); }); return () => { live = false; }; }, []);
  return supported;
}

/** Right after a wallet is made or restored (it is open, so no PIN is needed): offers a passkey for quicker unlocks. Skips itself where passkeys can't work. */
function PasskeyOffer({ next }: { next: () => void }) {
  const supported = usePasskeySupport();
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { if (supported === false) next(); }, [supported]);
  if (!supported) return <Busy text="Opening…" />;
  return <>
    <h1>Unlock faster next time?</h1>
    <p>Use Face ID, Touch ID, Windows Hello or a security key instead of typing your PIN. Your PIN still works.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button type="button" className="primary" autoFocus disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await vault.addPlatformPasskey(); next(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
    }}>{busy ? "Waiting for your passkey…" : "Use a passkey"}</button>
    <button type="button" className="secondary" disabled={busy} onClick={next}>Not now</button>
  </>;
}

/** Turns passkey unlock on or off for the active wallet. Turning it on asks for the PIN only if the wallet isn't open here. */
function Passkey({ done }: { done: () => void }) {
  const supported = usePasskeySupport();
  const active = safeAccounts().find(a => a.id === vault.activePlatformWalletId());
  const [needsPin, setNeedsPin] = useState<boolean | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { void vault.passkeyNeedsPin().then(setNeedsPin); }, []);
  if (!active) return <p className="error" role="alert">{friendly("NO_PLATFORM_WALLET")}</p>;
  if (supported === null || needsPin === null) return <Busy text="Checking…" />;
  if (active.passkey) return <>
    <h1>Passkey unlock is on</h1>
    <p>A passkey opens this wallet on this device. Turning it off leaves your PIN as the way in.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button type="button" className="danger" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await vault.removePlatformPasskey(); done(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
    }}>Turn off</button>
    <button type="button" className="secondary" disabled={busy} onClick={done}>Keep it on</button>
  </>;
  if (!supported) return <>
    <h1>Passkeys aren't available here</h1>
    <p>This browser can't open a wallet with a passkey. Current Chrome, Edge, Safari and Firefox can, with most built-in passkeys and password managers.</p>
    <button type="button" className="primary" onClick={done}>OK</button>
  </>;
  if (needsPin && !pin) return <CurrentPin title="Enter your PIN" subtitle="To set up a passkey for this wallet." onPin={async next => { await vault.checkPlatformPin(next); setPin(next); }} />;
  return <>
    <h1>Unlock with a passkey</h1>
    <p>Use Face ID, Touch ID, Windows Hello or a security key instead of typing your PIN on this device. Your PIN still works, and your recovery phrase is still the way back if you lose this device.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <button type="button" className="primary" autoFocus disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await vault.addPlatformPasskey(pin ?? undefined); done(); }
      catch (e) { if ((e as { code?: string })?.code === "PIN_NEEDED") setNeedsPin(true); setError(message(e)); }
      finally { setBusy(false); }
    }}>{busy ? "Waiting for your passkey…" : "Set up passkey"}</button>
  </>;
}

/**
 * One-tap trading on maxxing.ad, per wallet. Off by default: every signature is shown first. Turning it on takes the PIN and a clear
 * choice; turning it off takes one tap. Only this screen, inside the wallet, can change it.
 */
function OneTap({ done }: { done: () => void }) {
  const active = safeAccounts().find(a => a.id === vault.activePlatformWalletId());
  const [on, setOn] = useState(() => oneTapEnabled(active?.id));
  const [askPin, setAskPin] = useState(false);
  if (!active) return <p className="error" role="alert">{friendly("NO_PLATFORM_WALLET")}</p>;
  if (askPin) return <CurrentPin title="Enter your PIN" subtitle="To turn on one-tap trading." onPin={async pin => { await vault.checkPlatformPin(pin); setOneTap(active.id, true); setOn(true); setAskPin(false); }} />;
  if (on) return <>
    <h1>One-tap trading is on</h1>
    <p>maxxing.ad can sign trades, sign-ins and other requests with this wallet without asking you each time, while the wallet is open. Partner sites always ask.</p>
    <button type="button" className="danger" autoFocus onClick={() => { setOneTap(active.id, false); setOn(false); done(); }}>Turn off</button>
    <button type="button" className="secondary" onClick={done}>Keep it on</button>
  </>;
  return <>
    <h1>One-tap trading on maxxing.ad</h1>
    <p>Right now your wallet shows you every request from maxxing.ad, and nothing is signed until you approve it.</p>
    <p>With one-tap trading, maxxing.ad can sign trades, sign-ins and other requests with this wallet <b>without asking you</b>, whenever the wallet is open. Turn it on only if you trust maxxing.ad to act for you. You can turn it off here at any time.</p>
    <button type="button" className="primary" onClick={() => setAskPin(true)}>Turn on</button>
    <button type="button" className="secondary" autoFocus onClick={done}>Keep asking me</button>
  </>;
}

function Busy({ text }: { text: string }) { return <div className="busy" role="status"><span className="spinner" aria-hidden="true" />{text}</div>; }
function safeAccounts() { try { return vault.savedPlatformWallets(); } catch { return []; } }
