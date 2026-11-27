/**
 * Motion with weight: values pulled toward a target by a damped spring every frame, so they overshoot a touch and settle like
 * a real object, instead of gliding and stopping dead. One frame loop runs while anything is still moving, and sleeps after.
 */

/** A damped spring on one number. `stiffness` pulls toward the target; `damping` bleeds speed (lower = more overshoot). */
export class Spring {
  value: number; velocity = 0; target: number;
  constructor(value: number, public stiffness = 120, public damping = 16) { this.value = value; this.target = value; }
  /** Advances by dt seconds (sub-stepped so a slow frame can't blow it up). */
  step(dt: number) {
    const steps = Math.ceil(dt / (1 / 120));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.velocity += ((this.target - this.value) * this.stiffness - this.velocity * this.damping) * h;
      this.value += this.velocity * h;
    }
  }
  /** Close enough to rest that drawing again changes nothing visible. */
  get resting() { return Math.abs(this.target - this.value) < 0.005 && Math.abs(this.velocity) < 0.01; }
  /** Jumps straight to the target, no motion (reduced motion, or a reset). */
  snap() { this.value = this.target; this.velocity = 0; }
}

/**
 * Runs `frame(dt)` on every animation frame while it returns true (still moving), then stops until `wake()` is called again.
 * dt is in seconds and capped, so a background tab coming back doesn't jump.
 */
export function frameLoop(frame: (dt: number) => boolean) {
  let raf = 0, last = 0;
  const tick = (now: number) => {
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    raf = frame(dt) ? requestAnimationFrame(tick) : 0;
    if (!raf) last = 0;
  };
  return {
    wake() { if (!raf) raf = requestAnimationFrame(tick); },
    stop() { cancelAnimationFrame(raf); raf = 0; last = 0; },
  };
}

/** Pointer speed, smoothed over the last few moves, so a flick on release carries the speed it really had. */
export class Velocity {
  private vx = 0; private vy = 0; private x = 0; private y = 0; private t = 0;
  reset(x: number, y: number) { this.vx = 0; this.vy = 0; this.x = x; this.y = y; this.t = performance.now(); }
  move(x: number, y: number) {
    const now = performance.now(), dt = Math.max((now - this.t) / 1000, 1 / 240);
    this.vx += ((x - this.x) / dt - this.vx) * 0.45; this.vy += ((y - this.y) / dt - this.vy) * 0.45;
    this.x = x; this.y = y; this.t = now;
  }
  /** px per second; zero if the pointer stopped before letting go (a hold isn't a throw). */
  read(): [number, number] { return performance.now() - this.t > 90 ? [0, 0] : [this.vx, this.vy]; }
}

export const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
