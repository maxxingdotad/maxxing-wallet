import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Eye, EyeOff } from "lucide-react";
import { PASSWORD_RULE, weakPassword } from "../lib/password";

/** Escape closes the sheet or dialog that is open (keyboard access). */
export function useEscape(onClose: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
}

/** Seconds left until `until` (0 when it's past), ticking while there are any. */
function useSecondsLeft(until: number) {
  const [now, setNow] = useState(Date.now());
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  useEffect(() => { if (left <= 0) return; const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, [left > 0, until]);
  return left;
}

/** A masked password input with a show/hide button. Never stored, never sent anywhere but the wallet core on this device. */
export function PasswordField({ value, onChange, label, autoFocus, autoComplete = "current-password", invalid, describedBy, disabled }: {
  value: string; onChange: (v: string) => void; label: string; autoFocus?: boolean; autoComplete?: "current-password" | "new-password";
  invalid?: boolean; describedBy?: string; disabled?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return <div className={`pw-field${invalid ? " invalid" : ""}`}>
    <input className="pw-input" type={shown ? "text" : "password"} value={value} onChange={e => onChange(e.target.value)} aria-label={label} placeholder={label}
      autoFocus={autoFocus} autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={128} disabled={disabled}
      aria-invalid={invalid || undefined} aria-describedby={describedBy} />
    <button type="button" className="pw-eye" aria-label={shown ? "Hide password" : "Show password"} aria-pressed={shown} onClick={() => setShown(s => !s)}>
      {shown ? <EyeOff size={17} strokeWidth={1.8} /> : <Eye size={17} strokeWidth={1.8} />}
    </button>
  </div>;
}

/**
 * Asks for the password: one field, a full-width button (Enter works too), errors under the field. After repeated wrong tries the
 * wallet core makes the next try wait; this shows "Try again in 30 s" counting down, and the button waits with it.
 */
export function PasswordForm({ title, subtitle, error, waitUntil = 0, submitLabel = "Continue", label = "Password", onComplete }: {
  title?: string; subtitle?: string; error?: string; waitUntil?: number; submitLabel?: string; label?: string; onComplete: (password: string) => Promise<void> | void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const left = useSecondsLeft(waitUntil);
  const submit = async () => {
    if (!value || busy || left > 0) return;
    setBusy(true);
    try { await onComplete(value); } catch { /* the screen shows its own error */ } finally { setBusy(false); setValue(""); }
  };
  const note = left > 0 ? `Too many wrong tries. Try again in ${left} s.` : error;
  return <form className="pw-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
    {title && <h1 className="pw-title">{title}</h1>}
    {subtitle && <p className="pw-sub">{subtitle}</p>}
    <PasswordField value={value} onChange={setValue} label={label} autoFocus invalid={!!note} describedBy="pw-note" disabled={busy} />
    <div id="pw-note" className="pw-note" role="alert">{note}</div>
    <button type="submit" className="btn primary" disabled={!value || busy || left > 0}>{busy ? "Checking…" : left > 0 ? `Try again in ${left} s` : submitLabel}</button>
  </form>;
}

/** Choosing a password: typed twice on one screen, with the strength rules as you type (lib/password.ts). */
export function NewPassword({ title, subtitle, submitLabel = "Continue", onPassword }: { title: string; subtitle?: string; submitLabel?: string; onPassword: (password: string) => Promise<void> }) {
  const [first, setFirst] = useState(""), [again, setAgain] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const weak = first ? weakPassword(first) : null;
  const mismatch = !!again && again !== first;
  const ready = !!first && !weak && first === again && !busy;
  return <form className="pw-form" onSubmit={async e => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setError("");
    try { await onPassword(first); } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }}>
    <h1 className="pw-title">{title}</h1>
    {subtitle && <p className="pw-sub">{subtitle}</p>}
    <PasswordField value={first} onChange={setFirst} label="New password" autoFocus autoComplete="new-password" invalid={!!weak} describedBy="pw-rule" />
    <div id="pw-rule" className={`pw-note${weak ? "" : " quiet"}`} role="status">{weak ?? PASSWORD_RULE}</div>
    <PasswordField value={again} onChange={setAgain} label="Repeat it" autoComplete="new-password" invalid={mismatch} describedBy="pw-again" />
    <div id="pw-again" className="pw-note" role="alert">{mismatch ? "They don't match yet." : error}</div>
    <button type="submit" className="btn primary" disabled={!ready}>{busy ? "Saving…" : submitLabel}</button>
  </form>;
}

export function PageHead({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  return <header className="page-head">
    {onBack ? <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}><ChevronLeft size={20} /></button> : <span style={{ width: 8 }} />}
    <h1>{title}</h1>
    {right}
  </header>;
}

export function Busy({ text }: { text: string }) { return <div className="busy" role="status"><span className="spinner" aria-hidden="true" />{text}</div>; }

/**
 * True where the background can clear the clipboard later (Chrome and Edge: an alarm plus an offscreen document, which work after
 * this window has closed). Elsewhere secrets get no Copy button, rather than a promise to clear that nothing would keep.
 */
export const canClearClipboard = () => typeof chrome !== "undefined" && !!chrome.offscreen;

/** SHA-256 of a text, hex: what the background keeps to recognise a copied secret without holding it. */
export async function sha256(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Copies. For a secret (`clearAfter`), the background empties the clipboard after that many seconds, but only if it still holds
 * this secret (it compares a hash), so whatever the user copied since is left alone. Checking needs the clipboard-read
 * permission, asked for here the first time (not at install); without it, secrets aren't copied.
 */
export async function copy(text: string, clearAfter?: number) {
  if (clearAfter) {
    if (!canClearClipboard()) throw new Error("This browser can't clear the clipboard afterwards, so secrets aren't copied.");
    const want = { permissions: ["clipboardRead" as const] };
    const allowed = await chrome.permissions.contains(want).catch(() => false) || await chrome.permissions.request(want).catch(() => false);
    if (!allowed) throw new Error("To copy a secret, allow MAXXING Wallet to check the clipboard: it clears the secret after 60 seconds if it's still there.");
  }
  await navigator.clipboard.writeText(text);
  if (clearAfter) await chrome.runtime.sendMessage({ type: "clear-clipboard-later", seconds: clearAfter, hash: await sha256(text) }).catch(() => {});
}

export function useToast(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => { if (!text) return; const t = setTimeout(() => setText(null), 2400); return () => clearTimeout(t); }, [text]);
  return [text ? <div className="toast" role="status">{text}</div> : null, setText];
}

export const message = (error: unknown) => {
  const code = error instanceof Error ? error.message : String(error);
  const known: Record<string, string> = {
    WALLET_LOCKED: "The wallet is locked.", WALLET_STORAGE_DAMAGED_RESTORE_BACKUP: "This device's wallet data is damaged. Restore with your recovery phrase.",
    WALLET_OPERATION_CANCELLED: "Cancelled.", INVALID_TRANSACTION: "This transaction can't be shown exactly, so it won't be signed.",
    SOLANA_MESSAGE_IS_TRANSACTION: "This \"message\" is really a transaction. It won't be signed as a message.", WALLET_CHANGED: "The site asked for a different account. Reconnect it.",
  };
  // The core says "PIN" (the web wallet's word); here the six digits are the one password.
  return known[code] ?? code.replace(/^Wrong PIN\./, "Wrong password.").replace(/^Too many wrong PINs\./, "Too many wrong tries.");
};
