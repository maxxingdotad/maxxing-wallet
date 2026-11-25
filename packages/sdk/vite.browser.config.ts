import { resolve } from "node:path";
import { defineConfig } from "vite";

/**
 * The script-tag build (dist/maxxing-wallet.js, plus an ES module). Unlike the npm build, every dependency is bundled in.
 * The developers site serves these files at /sdk/v0/, and they ship in the npm package for CDNs such as jsDelivr.
 */
export default defineConfig({
  build: {
    target: "es2020",
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: false,
    sourcemap: true,
    lib: { entry: resolve(import.meta.dirname, "src/browser.ts"), name: "MaxxingWalletBundle", formats: ["iife", "es"], fileName: format => format === "iife" ? "maxxing-wallet.js" : "maxxing-wallet.mjs" },
  },
});
