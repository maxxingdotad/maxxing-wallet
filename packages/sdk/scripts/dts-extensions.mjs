// The bundle is one dist/index.js, but tsc writes one .d.ts per source file with extensionless relative imports.
// Projects on moduleResolution "node16"/"nodenext" need "./x.js" there, so add it; every other setup reads both.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const dir = new URL("../dist/", import.meta.url);
for (const name of readdirSync(dir).filter(f => f.endsWith(".d.ts"))) {
  const file = new URL(name, dir);
  const text = readFileSync(file, "utf8");
  const fixed = text.replace(/(from\s+["'])(\.\.?\/[^"']+?)(["'])/g, (all, a, path, b) => /\.[cm]?js$/.test(path) ? all : `${a}${path}.js${b}`);
  if (fixed !== text) writeFileSync(file, fixed);
}
