/**
 * Liquid metal: the wallet's one material. A small shader draws flowing chrome (bands of light bending over a slow noise field,
 * with a faint colour fringe where they turn, like polished metal catching a room) once per frame into one hidden canvas; every
 * `<Metal />` on screen copies that frame, and CSS cuts it to a rim. One WebGL context for the whole page, about 30 frames a
 * second, asleep when nothing shows it. Reduced motion, or no WebGL: one still frame of the same metal.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { reducedMotion } from "./motion";

const W = 224, H = 72;
const FRAGMENT = `
precision mediump float;
uniform float t; uniform vec2 r;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float band(float a) {
  float s = 0.5 + 0.5 * sin(a);
  // Mostly dark steel, a quick rise to bright, and a hard white glint at the crest.
  return 0.10 + 0.62 * pow(s, 2.4) + 0.5 * smoothstep(0.86, 1.0, s);
}
void main() {
  vec2 uv = gl_FragCoord.xy / r;
  float flow = noise(uv * vec2(3.0, 2.0) + vec2(t * 0.11, -t * 0.07)) + 0.5 * noise(uv * vec2(7.0, 5.0) - t * 0.09);
  float a = (uv.x * 2.2 + uv.y * 1.1) * 6.2832 + flow * 3.4 - t * 0.55;
  vec3 c = vec3(band(a - 0.16), band(a), band(a + 0.20));
  // A cool cast in the shadows, so it reads as steel rather than grey.
  c = mix(c, c * vec3(0.86, 0.93, 1.08), 0.5);
  gl_FragColor = vec4(min(c, 1.0), 1.0);
}`;

type Source = { canvas: HTMLCanvasElement; draw: (seconds: number) => void };
let source: Source | null | undefined;
function makeSource(): Source | null {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!gl) return null;
  const shader = (type: number, text: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, text); gl.compileShader(s); return s; };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }"));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one triangle over the whole canvas
  const at = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(at);
  gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(gl.getUniformLocation(program, "r"), W, H);
  const time = gl.getUniformLocation(program, "t");
  return { canvas, draw: seconds => { gl.uniform1f(time, seconds); gl.drawArrays(gl.TRIANGLES, 0, 3); } };
}

/** Without WebGL: the same metal as a still gradient. */
function still(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  for (const [stop, color] of [[0, "#f4f6fa"], [0.18, "#5d626c"], [0.36, "#ffffff"], [0.55, "#3c4048"], [0.72, "#dfe4ee"], [0.88, "#767c88"], [1, "#f4f6fa"]] as const) g.addColorStop(stop, color);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

const showing = new Set<CanvasRenderingContext2D>();
let raf = 0, frame = 0;
const started = typeof performance === "undefined" ? 0 : performance.now();
function paint(now: number) {
  // Every other frame: metal moves slowly, and half the work is plenty.
  if (frame++ % 2 === 0 && source) {
    source.draw((now - started) / 1000);
    for (const ctx of showing) ctx.drawImage(source.canvas, 0, 0);
  }
  raf = showing.size ? requestAnimationFrame(paint) : 0;
}
function show(ctx: CanvasRenderingContext2D) {
  if (source === undefined) { try { source = makeSource(); } catch { source = null; } }
  if (!source) { still(ctx); return () => {}; }
  if (reducedMotion()) { source.draw(4); ctx.drawImage(source.canvas, 0, 0); return () => {}; }
  showing.add(ctx);
  if (!raf) raf = requestAnimationFrame(paint);
  return () => { showing.delete(ctx); };
}

/**
 * Words cut from liquid metal: the chrome flows behind, and only the letters let it through (white letters on black, multiplied
 * with the metal). For the few words that are the wallet itself: its name, and the total. Sits on black.
 */
export function LiquidText({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={`liquid-text${className ? ` ${className}` : ""}`}><Metal fill /><span className="liquid-ink">{children}</span></span>;
}

/**
 * A liquid metal rim on its parent (which must be positioned): it follows the parent's corner radius, and `--rim` sets its width
 * (2px unless set). `fill` covers the whole parent instead of only its edge.
 */
export function Metal({ fill, className }: { fill?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const ctx = ref.current?.getContext("2d"); return ctx ? show(ctx) : undefined; }, []);
  return <span className={`metal${fill ? " fill" : ""}${className ? ` ${className}` : ""}`} aria-hidden="true"><canvas ref={ref} width={W} height={H} /></span>;
}
