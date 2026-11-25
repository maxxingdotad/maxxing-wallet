import test from "node:test";
import assert from "node:assert/strict";
import { appearanceVars, BRAND_ICONS, cleanAppearance, cleanText, contrast, DEFAULT_APPEARANCE, inkOn, orderMethods, resolveMode } from "../src/appearance";

test("Kick shows its own mark in the wallet window: dark K on its green tile", () => {
  const kick = BRAND_ICONS.kick!;
  assert.equal(kick.tile, "#53FC18");
  assert.equal(kick.ink, "#0B0E0F");
  assert.ok(kick.paths[0]!.d.startsWith("M1.333 0h8"));
});

test("an appearance keeps valid fields and falls back field by field", () => {
  const look = cleanAppearance({ theme: "light", accent: "#ff5500", radius: "full", font: "comic", title: "  Welcome   to Acme ", wallet: "before", order: ["twitter", "google", "twitter", "BAD", "x"], termsUrl: "javascript:alert(1)", privacyUrl: "https://acme.example/privacy" });
  assert.equal(look.theme, "light");
  assert.equal(look.accent, "#FF5500");
  assert.equal(look.radius, "full");
  assert.equal(look.font, DEFAULT_APPEARANCE.font, "unknown font keeps the base");
  assert.equal(look.title, "Welcome to Acme");
  assert.deepEqual(look.order, ["twitter", "google"]);
  assert.equal(look.termsUrl, null, "a non-https link is dropped");
  assert.equal(look.privacyUrl, "https://acme.example/privacy");
  // Code overrides on top of the dashboard's look: only what's sent changes.
  const both = cleanAppearance({ accent: "#000000" }, look);
  assert.equal(both.accent, "#000000");
  assert.equal(both.theme, "light");
  assert.equal(cleanAppearance({ title: null }, look).title, null, "null clears text");
});

test("headings stay plain words: no links, markup or hidden characters", () => {
  assert.equal(cleanText("Visit https://evil.example", 48), undefined);
  assert.equal(cleanText("Go to maxxing-support.com now", 48), undefined);
  assert.equal(cleanText("<b>Hi</b>", 48), undefined);
  assert.equal(cleanText("Hi‮there", 48), "Hi there");
  assert.equal(cleanText("x".repeat(80), 48)?.length, 48);
});

test("sign-in methods follow the chosen order, the rest keep theirs", () => {
  const methods = ["google", "twitter", "discord", "tiktok"].map(provider => ({ provider }));
  assert.deepEqual(orderMethods(methods, ["tiktok", "twitter"]).map(m => m.provider), ["tiktok", "twitter", "google", "discord"]);
});

test("colours stay readable: text on the accent, and a light page gets dark text", () => {
  assert.equal(inkOn("#FFFFFF"), "#141518");
  assert.equal(inkOn("#1D4ED8"), "#FFFFFF");
  assert.ok(contrast("#000000", "#FFFFFF") > 20);
  const light = appearanceVars(cleanAppearance({ background: "#FFF7E8" }), "dark");
  assert.equal(light["--text"], "#141518", "a pale custom page uses dark text whatever the theme");
  const vars = appearanceVars(cleanAppearance({ accent: "#FFFFFF", theme: "light" }), "light");
  assert.notEqual(vars["--accent-edge"], "transparent", "a white button on a white page gets an edge");
  assert.equal(resolveMode("auto", true), "light");
  assert.equal(resolveMode("dark", true), "dark");
});
