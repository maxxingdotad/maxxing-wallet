import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { parseFirstPartyApps, type WalletApp } from "./src/first-party";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

/**
 * The first-party apps (VITE_WALLET_APPS) by the frame's own rule (src/first-party.ts): https only outside development. A list the
 * frame would refuse fails the build, so a production frame never quietly falls back to another list than the one configured.
 */
function firstPartyApps(raw: string | undefined, development: boolean) {
  if (!raw) return null;
  const parsed = parseFirstPartyApps(raw, development);
  if (parsed) return parsed;
  const problem = "VITE_WALLET_APPS must be a JSON list of {id, name, origins} with https origins (http only while developing).";
  if (!development) throw new Error(problem);
  console.error(problem);
  return null;
}

/** Who may embed the frame. Production adds these headers in its host config (vercel.json); this covers local development. */
function frameAncestors(apps: WalletApp[] | null) {
  if (apps) return apps.flatMap(app => app.origins).join(" ");
  // Local apps that embed the wallet: web (5173), web against the production API (5178) and the mobile app on the web (8081).
  return ["5173", "5178", "8081"].flatMap(port => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]).join(" ");
}

const baseHeaders = { "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

/**
 * Two kinds of page, two policies. The hidden frame (index.html) is embedded only by MAXXING and talks to nothing.
 * The wallet window (connect.html, apps.html) is a top-level page that no one may embed; it reads app records and logos from the API.
 * Vite injects styles inline while developing; the production build serves stylesheets (see vercel.json).
 */
function policies(env: Record<string, string>, port: number, apps: WalletApp[] | null) {
  const api = new URL(env.VITE_API_URL || "http://localhost:4000").origin;
  const hmr = `ws://localhost:${port}`;
  const common = ["default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"];
  const frame = [...common, `connect-src 'self' ${hmr}`, "img-src 'self' data:", `frame-ancestors ${frameAncestors(apps)}`].join("; ");
  const window = [...common, `connect-src 'self' ${hmr} ${api}`, `img-src 'self' data: ${api}`, "frame-ancestors 'none'"].join("; ");
  // The dashboard's live preview of an app's sign-in: embedded only by the developer dashboard; it talks to nothing.
  const dashboards = (env.VITE_DEVELOPERS_URL || "http://localhost:5177,http://127.0.0.1:5177").split(",").map(v => v.trim()).filter(Boolean).join(" ");
  const preview = [...common, `connect-src 'self' ${hmr}`, `img-src 'self' data: ${api}`, `frame-ancestors ${dashboards}`].join("; ");
  return { frame, window, preview };
}
const isWindowPage = (url = "") => /^\/(connect|apps|login)(\.html)?(\?|#|$)/.test(url);
const isPreviewPage = (url = "") => /^\/preview(\.html)?(\?|#|$)/.test(url);

function pagePolicies(env: Record<string, string>, port: number, apps: WalletApp[] | null): Plugin {
  const { frame, window, preview } = policies(env, port, apps);
  const apply = (url: string | undefined, setHeader: (name: string, value: string) => void) => {
    setHeader("Content-Security-Policy", isPreviewPage(url) ? preview : isWindowPage(url) ? window : frame);
    for (const [name, value] of Object.entries(baseHeaders)) setHeader(name, value);
  };
  return {
    name: "maxxing-wallet-page-policies",
    configureServer(server) { server.middlewares.use((req, res, next) => { apply(req.url, (n, v) => res.setHeader(n, v)); next(); }); },
    configurePreviewServer(server) { server.middlewares.use((req, res, next) => { apply(req.url, (n, v) => res.setHeader(n, v)); next(); }); },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, root, "VITE_");
  const port = Number(process.env.WALLET_FRAME_PORT || 5175);
  // The frame reads import.meta.env.DEV, which is true only on the dev server: the same split decides http here.
  const apps = firstPartyApps(env.VITE_WALLET_APPS, command === "serve");
  return {
    envDir: root,
    // The chain registry's cluster in the browser: on "production" it switches test networks off (packages/chain-registry).
    // VITE_MAXXING_CLUSTER when set, else production for a Vercel production build (VERCEL_ENV), else development.
    define: { "globalThis.__MAXXING_CLUSTER__": JSON.stringify(process.env.VITE_MAXXING_CLUSTER || env.VITE_MAXXING_CLUSTER || (process.env.VERCEL_ENV === "production" ? "production" : "development")) },
    // JSX compiles without the React plugin: its dev preamble is an inline script, which this frame never allows.
    esbuild: { jsx: "automatic" },
    plugins: [pagePolicies(env, port, apps)],
    server: { port, strictPort: true },
    build: {
      target: "es2022",
      sourcemap: false,
      rollupOptions: { input: { index: resolve(here, "index.html"), connect: resolve(here, "connect.html"), apps: resolve(here, "apps.html"), login: resolve(here, "login.html"), preview: resolve(here, "preview.html") } },
    },
  };
});
