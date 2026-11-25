import { useEffect, useRef, useState } from "react";
import { Camera, Check, ChevronLeft, Clock3, Copy, EyeOff, KeyRound } from "lucide-react";
import { Steps } from "../parts";

const CHECKS = [
  "Anyone with my recovery phrase can take everything in every account, on every chain.",
  "MAXXING will never ask for it: not support, not an email, not a site.",
  "I'm alone, and no one can see my screen.",
];

/** Step one of exporting a recovery phrase or a private key: say exactly what is at stake, and make each point a deliberate tick. */
export function ExportWarning({ ticked = [true, true, false] }: { ticked?: boolean[] }) {
  const [on, setOn] = useState(ticked);
  return <div className="popup">
    <div className="backdrop" style={{ background: "radial-gradient(120% 50% at 50% -10%, rgb(225 93 85 / .14), transparent 60%)" }} />
    <header className="page-head"><button type="button" className="icon-btn" aria-label="Back"><ChevronLeft size={20} /></button><h1>Show recovery phrase</h1></header>
    <div className="scroll" style={{ paddingBottom: 130 }}>
      <Steps at={1} of={3} />
      <div className="danger-mark"><KeyRound size={28} strokeWidth={1.8} /></div>
      <h2 className="center-title">Anyone with this can take everything.</h2>
      <p className="center-sub">MAXXING will never ask for it. If someone is asking you for it right now, close this and stop talking to them.</p>
      <div className="checks">
        {CHECKS.map((text, i) => <button key={i} type="button" className={`check${on[i] ? " on" : ""}`} role="checkbox" aria-checked={on[i]} onClick={() => setOn(v => v.map((x, j) => j === i ? !x : x))}>
          <span className="box">{on[i] && <Check size={14} strokeWidth={3} />}</span><span>{text}</span>
        </button>)}
      </div>
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      <button type="button" className="btn danger" disabled={!on.every(Boolean)}>Continue to PIN</button>
    </div>
  </div>;
}

const WORDS = ["orbit", "velvet", "canyon", "lunar", "harbor", "pixel", "summit", "ember", "quartz", "willow", "drift", "anchor"];

/** The last step: blurred until you press and hold, hidden again after 60 seconds, and copying clears itself. */
export function ExportReveal({ revealed = false }: { revealed?: boolean }) {
  const [held, setHeld] = useState(revealed ? 1 : 0);
  const [left, setLeft] = useState(revealed ? 47 : 60);
  const timer = useRef<number | null>(null);
  const shown = held >= 1;
  useEffect(() => { if (!shown) return; const t = setInterval(() => setLeft(s => Math.max(0, s - 1)), 1000); return () => clearInterval(t); }, [shown]);
  const start = () => { const t0 = Date.now(); timer.current = window.setInterval(() => setHeld(Math.min(1, (Date.now() - t0) / 1500)), 30); };
  const stop = () => { if (timer.current) clearInterval(timer.current); if (held < 1) setHeld(0); };
  return <div className="popup">
    <div className="backdrop" />
    <header className="page-head"><button type="button" className="icon-btn" aria-label="Back"><ChevronLeft size={20} /></button><h1>Recovery phrase</h1></header>
    <div className="scroll" style={{ paddingBottom: 130 }}>
      <Steps at={3} of={3} />
      <div className="alert warn" style={{ margin: "12px 0" }}><Camera size={16} /><span><b>No screenshots.</b> Write the words on paper, in order, and keep them offline.</span></div>
      <ol className={`phrase${shown ? "" : " blurred"}`} style={{ margin: 0 }}>
        {WORDS.map((w, i) => <li key={i}><small>{i + 1}</small>{w}</li>)}
        {!shown && <div className="veil"><EyeOff size={22} style={{ color: "var(--text-2)" }} /></div>}
      </ol>
      {shown && <>
        <div className="timer"><Clock3 size={13} /> Hides again in {left}s · <button type="button" style={{ color: "var(--text-2)", fontWeight: 600, fontSize: 12 }} onClick={() => setHeld(0)}>Hide now</button></div>
        <div className="card facts" style={{ marginTop: 14 }}>
          <div className="fact"><span>Never type it into a website</span><b style={{ color: "var(--negative)" }}>Ever</b></div>
          <div className="fact"><span>Restores every account on every chain</span><b>All 3</b></div>
          <div className="fact"><span>This view was logged</span><b>Activity · just now</b></div>
        </div>
      </>}
    </div>
    <div className="footer" style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}>
      {shown
        ? <button type="button" className="btn secondary"><Copy size={16} />Copy (clears in 60s)</button>
        : <button type="button" className="btn primary hold" style={{ ["--held" as string]: held }} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop}><span className="fill" /><span>Press and hold to reveal</span></button>}
    </div>
  </div>;
}
