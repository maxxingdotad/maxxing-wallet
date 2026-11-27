import { useEffect, useRef, useState, type ReactNode } from "react";
import { Spring, frameLoop, reducedMotion } from "./motion";

/**
 * Hold to confirm: press and keep holding (mouse, touch, or Space/Enter) and the fill charges up; let go early and it springs
 * back down, nothing sent. Full charge fires `onConfirm` once, with a small give in the button as it lands.
 * Under reduced motion it's a plain button (one click confirms), since the hold is a guard, not decoration.
 */
const HOLD_SECONDS = 0.9;

export function HoldButton({ label, busyLabel, onConfirm, disabled }: {
  label: string; busyLabel?: string;
  /** May return a promise: while it runs the button shows `busyLabel`; if the screen is still there when it settles (an error
   *  shown, a cancel), the button arms again for another hold. */
  onConfirm: () => unknown;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [fired, setFired] = useState(false);
  const plain = reducedMotion();
  // Kept in a ref, so a re-render mid-hold (a fee arriving) doesn't restart the charge.
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;
  const done = useRef(false), mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const fire = () => {
    done.current = true; setFired(true);
    void Promise.resolve().then(() => confirmRef.current()).catch(() => {}).finally(() => {
      if (!mounted.current) return;
      done.current = false; setFired(false);
      ref.current?.style.setProperty("--charge", "0");
    });
  };
  useEffect(() => {
    const el = ref.current;
    if (!el || plain) return;
    let holding = false, charge = 0;
    const give = new Spring(1, 420, 20);
    const loop = frameLoop(dt => {
      if (el.disabled) holding = false; // disabled mid-hold (a quote expiring, a lost balance): the charge drains, nothing fires
      // Charging is steady (you can feel how long is left); letting go drains fast.
      charge = holding ? Math.min(1, charge + dt / HOLD_SECONDS) : Math.max(0, charge - dt * 3.2);
      give.target = holding ? 0.97 : 1;
      give.step(dt);
      el.style.setProperty("--charge", charge.toFixed(4));
      el.style.setProperty("--give", give.value.toFixed(4));
      if (charge >= 1 && !done.current && !el.disabled) {
        holding = false; charge = 0;
        give.value = 0.94; give.velocity = 4; give.target = 1; // the landing: a small bounce
        el.style.setProperty("--charge", "1");
        fire();
        return !give.resting;
      }
      return holding || charge > 0 || !give.resting;
    });
    const start = (e: Event) => { if (done.current || el.disabled) return; e.preventDefault(); holding = true; loop.wake(); };
    const end = () => { holding = false; loop.wake(); };
    const key = (e: KeyboardEvent) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) start(e); };
    const keyUp = (e: KeyboardEvent) => { if (e.key === " " || e.key === "Enter") end(); };
    el.addEventListener("pointerdown", start);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    el.addEventListener("pointerleave", end);
    el.addEventListener("keydown", key);
    el.addEventListener("keyup", keyUp);
    el.addEventListener("blur", end);
    return () => {
      loop.stop();
      el.removeEventListener("pointerdown", start); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
      el.removeEventListener("pointerleave", end); el.removeEventListener("keydown", key); el.removeEventListener("keyup", keyUp); el.removeEventListener("blur", end);
    };
  }, [plain]);
  return <button ref={ref} type="button" className="btn primary hold-btn" disabled={disabled || fired} data-testid="hold-to-confirm"
    onClick={plain ? () => { if (!done.current) fire(); } : e => e.preventDefault()} aria-label={plain ? label : `${label}: press and hold`}>
    <span className="hold-fill" aria-hidden="true" />
    <span className="hold-label">{fired && busyLabel ? busyLabel : plain ? label : `Hold to ${label.toLowerCase()}`}</span>
  </button>;
}

/**
 * The receipt card: the thing you just did. It rises in once when it shows, then stays still (no hover or cursor motion).
 */
export function ReceiptCard({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`receipt-card ${className}`}>{children}</div>;
}
