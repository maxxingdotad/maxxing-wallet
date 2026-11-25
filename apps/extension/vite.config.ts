import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The extension's pages: popup.html (toolbar popup, also the full tab), sidepanel.html (Chrome's side panel), approve.html (site
 * requests), offscreen.html (Chrome: empties the clipboard after a secret was copied). design.html is the design gallery, served while developing only. The background, content and in-page scripts are
 * built by scripts/build.mjs, one self-contained file each, as Chrome requires.
 */
export default defineConfig(({ command }) => {
  const input: Record<string, string> = { popup: resolve(here, "popup.html"), sidepanel: resolve(here, "sidepanel.html"), approve: resolve(here, "approve.html"), offscreen: resolve(here, "offscreen.html") };
  if (command !== "build") input.design = resolve(here, "design.html");
  return {
    // JSX compiles without the React plugin: extension pages allow no inline scripts, so no dev preamble either.
    esbuild: { jsx: "automatic" },
    server: { port: 8085, strictPort: true },
    build: { target: "es2022", sourcemap: false, modulePreload: false, rollupOptions: { input } },
  };
});
