import { useEffect, useState } from "react";

const LENGTH = 6;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

/**
 * Six-digit PIN entry: on-screen keys and the keyboard both work. When the PIN is complete it calls
 * onComplete; a rejected promise clears the dots so the user can try again. During a wait it counts down.
 */
export function PinPad({ title, subtitle, error, waitUntil = 0, onComplete }: {
  title: string;
  subtitle?: string;
  error?: string;
  waitUntil?: number;
  onComplete: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const waiting = waitUntil > now;

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [waiting, waitUntil]);

  const press = (key: string) => {
    if (busy || waiting) return;
    if (key === "back") return setPin(p => p.slice(0, -1));
    if (!/^\d$/.test(key)) return;
    if (pin.length >= LENGTH) return;
    const next = pin + key;
    setPin(next);
    if (next.length === LENGTH) {
      setBusy(true);
      onComplete(next).catch(() => {}).finally(() => { setBusy(false); setPin(""); });
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (/^\d$/.test(event.key)) press(event.key);
      else if (event.key === "Backspace") press("back");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const seconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const waitText = seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${seconds}s`;
  return (
    <div className="pin">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      <div className={`dots${error && !pin ? " shake" : ""}`} role="img" aria-label={`${pin.length} of ${LENGTH} digits entered`}>
        {Array.from({ length: LENGTH }, (_, i) => <span key={i} className={i < pin.length ? "on" : ""} />)}
      </div>
      <p className={`pin-note${error ? " error" : ""}`} role={error ? "alert" : undefined}>
        {waiting ? `Too many wrong PINs. Try again in ${waitText}.` : busy ? "Checking…" : error || " "}
      </p>
      <div className="keys">
        {KEYS.map((key, i) => key === "" ? <span key={i} /> :
          <button key={i} type="button" disabled={busy || waiting} onClick={() => press(key)} aria-label={key === "back" ? "Delete" : key}>
            {key === "back" ? "⌫" : key}
          </button>)}
      </div>
    </div>
  );
}
