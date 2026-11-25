import { test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, avatarGradient, resolveTheme, shortAddress } from "../src/theme";

test("a theme starts from MAXXING's dark or light palette and takes the partner's own values", () => {
  assert.deepEqual(resolveTheme(), THEMES.dark);
  assert.deepEqual(resolveTheme({ mode: "light" }), THEMES.light);
  const brand = resolveTheme({ mode: "light", accent: "#7C3AED", accentText: "white", radius: 999, font: "Poppins, sans-serif" });
  assert.equal(brand.accent, "#7C3AED");
  assert.equal(brand.accentText, "white");
  assert.equal(brand.background, THEMES.light.background);
  assert.equal(brand.radius, 28, "radius is capped");
  assert.equal(brand.font, "Poppins, sans-serif");
  assert.equal(resolveTheme({ accent: "rgb(10 20 30 / .5)" }).accent, "rgb(10 20 30 / .5)");
});

test("values that aren't plain colours, sizes or font names fall back instead of reaching the styles", () => {
  const bad = resolveTheme({ accent: "red; background: url(https://x)", text: "</style><script>", radius: Number.NaN, font: "x; } :host { display:none" });
  assert.equal(bad.accent, THEMES.dark.accent);
  assert.equal(bad.text, THEMES.dark.text);
  assert.equal(bad.radius, THEMES.dark.radius);
  assert.equal(bad.font, THEMES.dark.font);
  assert.equal(resolveTheme({ radius: -4 }).radius, 0);
});

test("addresses are shortened and get a steady avatar", () => {
  assert.equal(shortAddress("0x1111111111111111111111111111111111111111"), "0x1111…1111");
  assert.equal(shortAddress("0x12"), "0x12");
  const a = "0xabcdef0123456789abcdef0123456789abcdef01";
  assert.equal(avatarGradient(a), avatarGradient(a));
  assert.notEqual(avatarGradient(a), avatarGradient("0x0123456789abcdef0123456789abcdef01234567"));
});

test("the <maxxing-connect> tag reads its theme and chains from attributes", async () => {
  const { themeFromAttributes, chainsFromAttribute } = await import("../src/element");
  const attrs: Record<string, string> = { mode: "auto", accent: "#7C3AED", "accent-text": "white", radius: "28", font: "inherit", bogus: "x" };
  assert.deepEqual(themeFromAttributes(name => attrs[name] ?? null), { mode: "auto", accent: "#7C3AED", accentText: "white", radius: 28, font: "inherit" });
  assert.equal(themeFromAttributes(name => (name === "mode" ? "neon" : null)).mode, undefined, "unknown modes are ignored");
  assert.deepEqual(chainsFromAttribute("8453, 1 42161"), [8453, 1, 42161]);
  assert.equal(chainsFromAttribute("abc"), undefined);
  assert.equal(chainsFromAttribute(null), undefined);
});

test("mode auto follows the visitor's setting", () => {
  assert.equal(resolveTheme({ mode: "auto" }, true).mode, "light");
  assert.equal(resolveTheme({ mode: "auto" }, false).mode, "dark");
});

test("balances read short and plain", async () => {
  const { balanceText } = await import("../src/widget");
  assert.equal(balanceText(0n), "0");
  assert.equal(balanceText(1234567000000000000n), "1.2346");
  assert.equal(balanceText(1500n * 10n ** 18n), "1,500");
  assert.equal(balanceText(123456789000000n), "0.000123");
});
