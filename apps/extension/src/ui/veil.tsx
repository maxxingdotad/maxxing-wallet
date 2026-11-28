/**
 * A secret under a field of small dark cells. A few cells glint like steel and settle while it waits; a tap dissolves the field
 * cell by cell outward from where it was touched, a bright edge running ahead, and what was under it is there. Quiet on purpose:
 * the wallet's liquid metal is for its controls, and a hidden secret should look closed, not decorated.
 * It is one button (Enter and Space work); under reduced motion the field simply goes.
 */
import { useEffect, useRef } from "react";
import { Eye } from "lucide-react";
import { reducedMotion } from "./motion";

const CELL = 8; // one cell with its 1px gap, in CSS pixels
const DISSOLVE_MS = 650;

export function PixelVeil({ label = "Tap to reveal", dissolving, onTap, onDone }: {
  label?: string;
  /** Set once the reveal has begun: the field dissolves from `at` (in the field's own pixels), or from its centre. */
  dissolving?: { at?: { x: number; y: number } } | null;
  onTap: (at: { x: number; y: number }) => void;
  /** The last cell is gone. */
  onDone: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef({ dissolving, onDone });
  state.current = { dissolving, onDone };
  useEffect(() => {
    const el = canvas.current, ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const still = reducedMotion();
    const box = el.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(box.width)), h = Math.max(1, Math.round(box.height));
    el.width = w * dpr; el.height = h * dpr;
    ctx.scale(dpr, dpr);
    const cols = Math.ceil(w / CELL), rows = Math.ceil(h / CELL);
    // Each cell: its own shade of near-black, when it glints, and how early or late it leaves.
    const cells = Array.from({ length: cols * rows }, () => ({ shade: 17 + Math.random() * 20, phase: Math.random() * 40, jitter: Math.random() }));
    let raf = 0, began = 0, finished = false;
    const draw = (now: number) => {
      const go = state.current.dissolving;
      if (go && !began) began = now;
      const p = go ? (still ? 1 : Math.min(1, (now - began) / DISSOLVE_MS)) : 0;
      const ox = go?.at?.x ?? w / 2, oy = go?.at?.y ?? h / 2;
      const far = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy)) || 1;
      ctx.clearRect(0, 0, w, h);
      if (!go) { ctx.fillStyle = "#0a0a0c"; ctx.fillRect(0, 0, w, h); } // sealed: nothing shows between the cells
      const t = now / 1000;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const cell = cells[r * cols + c]!, x = c * CELL, y = r * CELL;
        let shade = cell.shade, alpha = 1;
        // Waiting: now and then a cell brightens to steel and settles.
        if (!still) { const glint = Math.sin(t * 0.9 + cell.phase); if (glint > 0.992) shade += (glint - 0.992) / 0.008 * 62; }
        if (go) {
          const d = Math.hypot(x + CELL / 2 - ox, y + CELL / 2 - oy) / far;
          const edge = p * 1.3 - cell.jitter * 0.18; // the front, a little ragged
          if (d < edge - 0.1) continue; // gone
          if (d < edge) { shade = 200; alpha = (edge - d) / 0.1 < 0.5 ? 1 : 2 - (edge - d) / 0.05; } // the bright edge, then out
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.fillStyle = `rgb(${shade} ${shade + 1} ${shade + 4})`;
        ctx.fillRect(x, y, CELL - 1, CELL - 1);
      }
      ctx.globalAlpha = 1;
      if (go && p >= 1) { if (!finished) { finished = true; state.current.onDone(); } return; }
      // Sealed, the field only needs a few frames a second; dissolving, every frame.
      raf = go ? requestAnimationFrame(draw) : still ? 0 : window.setTimeout(() => { raf = requestAnimationFrame(draw); }, 90);
    };
    raf = requestAnimationFrame(draw);
    // A tap arrives between the slow sealed frames: start drawing every frame at once.
    const wake = () => { cancelAnimationFrame(raf); clearTimeout(raf); raf = requestAnimationFrame(draw); };
    el.addEventListener("veil-wake", wake);
    return () => { cancelAnimationFrame(raf); clearTimeout(raf); el.removeEventListener("veil-wake", wake); };
  }, []);
  useEffect(() => { if (dissolving) canvas.current?.dispatchEvent(new Event("veil-wake")); }, [dissolving]);
  return <button type="button" className={`pixel-veil${dissolving ? " going" : ""}`} data-testid="veil" aria-label={label} disabled={!!dissolving}
    onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onTap(e.detail === 0 ? { x: r.width / 2, y: r.height / 2 } : { x: e.clientX - r.left, y: e.clientY - r.top }); }}>
    <canvas ref={canvas} aria-hidden="true" />
    <span className="veil-chip"><Eye size={15} />{label}</span>
  </button>;
}
