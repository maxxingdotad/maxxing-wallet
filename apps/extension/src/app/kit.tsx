import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Delete } from "lucide-react";

/** Six digits, by tap or keyboard. Shakes on a wrong PIN; shows the wait after repeated wrong tries. */
export function PinPad({ title, subtitle, error, waitUntil = 0, onComplete }: { title: string; subtitle?: string; error?: string; waitUntil?: number; onComplete: (pin: string) => Promise<void> | void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [now, setNow] = useState(Date.now());
  const waiting = waitUntil > now;
  useEffect(() => { if (!waiting) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [waiting]);
  useEffect(() => { if (error) { setShake(true); const t = setTimeout(() => setShake(false), 400); return () => clearTimeout(t); } }, [error]);
  const press = (digit: string) => {
    if (busy || waiting || pin.length >= 6) return;
    const next = pin + digit;
    setPin(next);
    if (next.length === 6) {
      setBusy(true);
      Promise.resolve(onComplete(next)).catch(() => {}).finally(() => { setBusy(false); setPin(""); });
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === "Backspace") setPin(p => p.slice(0, -1)); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const note = waiting ? `Too many wrong PINs. Try again in ${Math.ceil((waitUntil - now) / 1000)}s.` : error ?? (busy ? "Checking…" : "");
  return <div className="pin">
    <h1>{title}</h1>
    {subtitle && <p>{subtitle}</p>}
    <div className={`dots${shake ? " shake" : ""}`} aria-label={`${pin.length} of 6 digits`}>{Array.from({ length: 6 }, (_, i) => <span key={i} className={i < pin.length ? "on" : ""} />)}</div>
    <div className={`pin-note${error || waiting ? " down-text" : ""}`} role="status">{note}</div>
    <div className="keys">
      {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(d => <button key={d} type="button" disabled={busy || waiting} onClick={() => press(d)}>{d}</button>)}
      <span />
      <button type="button" disabled={busy || waiting} onClick={() => press("0")}>0</button>
      <button type="button" className="ghost-key" aria-label="Delete" onClick={() => setPin(p => p.slice(0, -1))}><Delete size={20} strokeWidth={1.7} /></button>
    </div>
  </div>;
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
  return known[code] ?? code;
};
