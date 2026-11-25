import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Builds the published package. Chain data from the MAXXING registry is bundled in; the wallet libraries stay as dependencies. */
export default defineConfig({
  build: {
    target: "es2020",
    sourcemap: true,
    lib: { entry: { index: resolve(import.meta.dirname, "src/index.ts"), server: resolve(import.meta.dirname, "src/server.ts"), siwe: resolve(import.meta.dirname, "src/siwe.ts"), appearance: resolve(import.meta.dirname, "src/appearance.ts"), data: resolve(import.meta.dirname, "src/data.ts"), react: resolve(import.meta.dirname, "src/react.ts") }, formats: ["es"], fileName: (_format, name) => `${name}.js` },
    rollupOptions: { external: [/^react($|\/)/, /^@wallet-standard\//, /^@solana\//, /^@noble\//, "bs58"] },
  },
});
