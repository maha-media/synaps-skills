/*
 * brand.test.js — PS-0: the Maha Media brand foundation is applied to the
 * shared renderer stylesheet (plan.css) and is fully local (no CDN).
 *
 * plan.css is loaded by BOTH the SPA shell and standalone plan files, so the
 * brand tokens + @font-face must live there. Fonts must reference only the
 * bundled WOFF2 under /_assets/fonts/ — zero external URLs anywhere.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withServer, PLUGIN_DIR } = require("../harness/runner.js");

test("plan.css declares the Maha Media brand tokens", async () => {
  const css = fs.readFileSync(path.join(PLUGIN_DIR, "assets", "plan.css"), "utf8");
  assert.match(css, /--gold:\s*#d4a574/i, "warm-gold accent token");
  assert.match(css, /--bg:\s*#0d0d0d/i, "brand background token");
  assert.match(css, /--text:\s*#f5f2eb/i, "warm off-white text token");
  assert.match(css, /--font-display:[^;]*Cormorant Garamond/i, "display serif token");
  assert.match(css, /--font-ui:[^;]*Outfit/i, "UI sans token");
});

test("plan.css @font-face references ONLY bundled local WOFF2 (no CDN)", async () => {
  const css = fs.readFileSync(path.join(PLUGIN_DIR, "assets", "plan.css"), "utf8");
  assert.match(css, /@font-face/i, "must declare @font-face");
  assert.match(css, /\/_assets\/fonts\/outfit-latin\.woff2/, "Outfit served locally");
  assert.match(css, /\/_assets\/fonts\/cormorant-garamond-latin\.woff2/, "Cormorant served locally");
  assert.match(css, /font-display:\s*swap/i, "font-display: swap for graceful fallback");
  // No external font/asset URLs whatsoever.
  assert.ok(!/https?:\/\//i.test(css), "plan.css must contain zero http(s) URLs");
  assert.ok(!/fonts\.googleapis|gstatic/i.test(css), "no Google Fonts CDN");
});

test("served /_assets/plan.css carries the brand and is local-only", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/_assets/plan.css");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/css/);
    assert.match(res.text, /--gold:\s*#d4a574/i);
    assert.ok(!/https?:\/\//i.test(res.text), "served CSS must have no external URLs");
  });
});

test("the bundled brand assets exist on disk (fonts + logo)", async () => {
  const fontsDir = path.join(PLUGIN_DIR, "assets", "fonts");
  assert.ok(fs.existsSync(path.join(fontsDir, "outfit-latin.woff2")), "Outfit woff2 bundled");
  assert.ok(fs.existsSync(path.join(fontsDir, "cormorant-garamond-latin.woff2")), "Cormorant woff2 bundled");
  const logo = path.join(PLUGIN_DIR, "assets", "mahamedia-logo.svg");
  assert.ok(fs.existsSync(logo), "logo svg bundled");
});
