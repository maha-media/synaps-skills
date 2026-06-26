/*
 * theme_core.test.js — DT-0: lib/theme.js engtheme/1 core.
 *   - defaultTheme is a valid Maha-look engtheme/1 constant
 *   - FONT_REGISTRY covers the 8 bundled families + 3 system stacks
 *   - parseTheme never throws; per-key validation + fallback; strict color
 *     allowlist (CSS-injection attempt dropped); over-long title/tagline/monogram
 *     repaired; bogus font → default pairing
 *   - parseThemeStrict reports errors for the rejected fields
 *   - inferTheme returns a complete valid theme from a fixture repo
 *   - resolveTheme order: file → inferred → default (+ _source tag)
 *   - themeCss emits validated :root vars + @font-face for the used families
 *     ONLY, references only /_assets/fonts/*, and strips an injection fixture
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const theme = require("../../lib/theme.js");

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "theme-core-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  return dir;
}
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

const COLOR_KEYS = ["bg", "surface", "surface2", "text", "muted", "border", "accent",
  "accentSoft", "stateTodo", "stateDoing", "stateDone", "stateBlocked", "warn", "review"];

const STRICT_COLOR = /^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/;

function assertValidTheme(t, label) {
  assert.equal(t.schema, "engtheme/1", label + " schema");
  assert.equal(typeof t.title, "string");
  assert.ok(t.title.length > 0 && t.title.length <= 80, label + " title length");
  for (const k of COLOR_KEYS) {
    assert.ok(t.palette[k], label + " palette has " + k);
    assert.match(t.palette[k], STRICT_COLOR, label + " palette." + k + " is a strict color");
  }
  assert.ok(t.fonts && t.fonts.display && t.fonts.ui, label + " fonts present");
}

test("defaultTheme is a valid Maha-look engtheme/1 constant", () => {
  assertValidTheme(theme.defaultTheme, "default");
  assert.equal(theme.defaultTheme.palette.accent.toLowerCase(), "#d4a574", "warm gold accent");
  assert.equal(theme.defaultTheme.palette.bg.toLowerCase(), "#0d0d0d");
  assert.match(theme.defaultTheme.fonts.display, /Cormorant Garamond/i);
  assert.match(theme.defaultTheme.fonts.ui, /Outfit/i);
});

test("FONT_REGISTRY covers the 8 bundled families + 3 system stacks", () => {
  const reg = theme.FONT_REGISTRY;
  const families = ["Cormorant Garamond", "Outfit", "Space Grotesk", "Inter",
    "JetBrains Mono", "Fraunces", "Work Sans", "Archivo"];
  for (const f of families) {
    const e = reg[f.toLowerCase()];
    assert.ok(e, "registry has " + f);
    assert.ok(/\/_assets\/fonts\/.+\.woff2$/.test(e.file), f + " bundled woff2 path");
    assert.ok(typeof e.stack === "string" && e.stack.length, f + " fallback stack");
  }
  for (const s of ["system-serif", "system-sans", "system-mono"]) {
    const e = reg[s];
    assert.ok(e, "registry has " + s);
    assert.ok(e.system === true && !e.file, s + " is a fileless system stack");
  }
});

test("parseTheme accepts a fully valid theme unchanged (per-key)", () => {
  const input = {
    schema: "engtheme/1", title: "Synaps Engineering", tagline: "ship software",
    monogram: "SE",
    palette: Object.assign({}, theme.defaultTheme.palette, { accent: "#7aa2f7" }),
    fonts: { display: "Space Grotesk", ui: "Inter" }, generated_by: "llm",
  };
  const t = theme.parseTheme(input);
  assertValidTheme(t, "valid");
  assert.equal(t.title, "Synaps Engineering");
  assert.equal(t.palette.accent, "#7aa2f7");
  assert.match(t.fonts.display, /Space Grotesk/);
  assert.match(t.fonts.ui, /Inter/);
});

test("parseTheme NEVER throws and drops a CSS-injection color (per-key fallback)", () => {
  const malicious = {
    schema: "engtheme/1", title: "Evil",
    palette: { accent: "red;}body{background:url(http://evil/x)}", bg: "#000000" },
    fonts: { display: "Outfit", ui: "Outfit" },
  };
  let t;
  assert.doesNotThrow(() => { t = theme.parseTheme(malicious); });
  // the injection value must be dropped and replaced with the default accent
  assert.notEqual(t.palette.accent, malicious.palette.accent, "injection dropped");
  assert.match(t.palette.accent, STRICT_COLOR, "accent falls back to a strict color");
  assert.equal(t.palette.accent, theme.defaultTheme.palette.accent, "falls back to default accent");
  // the valid bg the caller supplied is kept
  assert.equal(t.palette.bg, "#000000");
});

test("parseTheme repairs over-long title/tagline + derives monogram; bogus font → default", () => {
  const t = theme.parseTheme({
    schema: "engtheme/1",
    title: "x".repeat(200),
    tagline: "y".repeat(400),
    monogram: "toolong",
    palette: {},
    fonts: { display: "Nonexistent Face", ui: "Also Bogus" },
  });
  assert.ok(t.title.length <= 80, "title clamped to <=80");
  assert.ok(t.tagline.length <= 140, "tagline clamped to <=140");
  assert.ok(t.monogram.length <= 3, "monogram clamped to <=3");
  // bogus fonts fall back to the default pairing families
  assert.match(t.fonts.display, /Cormorant Garamond/i, "bogus display → default display");
  assert.match(t.fonts.ui, /Outfit/i, "bogus ui → default ui");
});

test("parseTheme accepts a system-stack font id", () => {
  const t = theme.parseTheme({
    schema: "engtheme/1", title: "Sys",
    palette: {}, fonts: { display: "system-serif", ui: "system-mono" },
  });
  assert.equal(t.fonts.display, "system-serif");
  assert.equal(t.fonts.ui, "system-mono");
});

test("parseThemeStrict reports errors for rejected fields and returns a repaired theme", () => {
  const { theme: t, errors } = theme.parseThemeStrict({
    schema: "engtheme/1", title: "ok",
    palette: { accent: "red;}x{" }, fonts: { display: "Bogus", ui: "Outfit" },
  });
  assertValidTheme(t, "strict-repaired");
  assert.ok(Array.isArray(errors) && errors.length >= 2, "reports at least the bad color + bad font");
  assert.ok(errors.some((e) => /accent/.test(e)), "error mentions accent");
  assert.ok(errors.some((e) => /display|font/i.test(e)), "error mentions the bad font");
});

test("parseThemeStrict flags a wrong schema", () => {
  const { errors } = theme.parseThemeStrict({ schema: "nope", title: "x", palette: {}, fonts: {} });
  assert.ok(errors.some((e) => /schema/i.test(e)), "schema error reported");
});

test("inferTheme returns a complete valid theme from a fixture repo (title + accent)", () => {
  const repo = tmpRepo();
  try {
    fs.writeFileSync(path.join(repo, "package.json"),
      JSON.stringify({ name: "cool-widget-kit", description: "a kit of widgets" }));
    fs.writeFileSync(path.join(repo, "theme.css"), ":root{--brand:#3366ff;}");
    const t = theme.inferTheme(repo);
    assertValidTheme(t, "inferred");
    assert.equal(t.generated_by, "inferred");
    assert.match(t.title, /Cool Widget Kit/i, "title prettified from package.json name");
    assert.equal(t.palette.accent.toLowerCase(), "#3366ff", "accent discovered from theme.css");
  } finally { rmrf(repo); }
});

test("inferTheme is deterministic & varied across repo names with no brand color", () => {
  const a = tmpRepo(); const b = tmpRepo();
  try {
    fs.writeFileSync(path.join(a, "package.json"), JSON.stringify({ name: "alpha-project" }));
    fs.writeFileSync(path.join(b, "package.json"), JSON.stringify({ name: "zeta-system" }));
    const t1 = theme.inferTheme(a); const t1b = theme.inferTheme(a); const t2 = theme.inferTheme(b);
    assert.equal(t1.palette.accent, t1b.palette.accent, "stable per repo");
    assert.notEqual(t1.palette.accent, t2.palette.accent, "varied across repos");
  } finally { rmrf(a); rmrf(b); }
});

test("resolveTheme order: file → inferred → default with _source tag", () => {
  const repo = tmpRepo();
  try {
    // 1. no file, no signals → default
    const d = theme.resolveTheme(repo);
    assert.equal(d._source, "default");
    assert.equal(d.palette.accent.toLowerCase(), "#d4a574");

    // 2. signals present, still no file → inferred
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "infer-me" }));
    const inf = theme.resolveTheme(repo);
    assert.equal(inf._source, "inferred");
    assert.match(inf.title, /Infer Me/i);

    // 3. theme.json present → file
    fs.writeFileSync(path.join(repo, ".plans", "theme.json"), JSON.stringify({
      schema: "engtheme/1", title: "From File", palette: { accent: "#9ece6a" },
      fonts: { display: "Inter", ui: "Inter" }, generated_by: "llm",
    }));
    const f = theme.resolveTheme(repo);
    assert.equal(f._source, "file");
    assert.equal(f.title, "From File");
    assert.equal(f.palette.accent, "#9ece6a");
  } finally { rmrf(repo); }
});

test("resolveTheme NEVER throws on a wholly invalid theme.json → falls back", () => {
  const repo = tmpRepo();
  try {
    fs.writeFileSync(path.join(repo, ".plans", "theme.json"), "{ not json at all ");
    let t;
    assert.doesNotThrow(() => { t = theme.resolveTheme(repo); });
    assert.ok(t._source === "inferred" || t._source === "default", "degrades, never throws");
    assertValidTheme(t, "degraded");
  } finally { rmrf(repo); }
});

test("themeCss emits validated :root vars + @font-face for the used families ONLY", () => {
  const t = theme.parseTheme({
    schema: "engtheme/1", title: "CssTest",
    palette: Object.assign({}, theme.defaultTheme.palette, { accent: "#7aa2f7" }),
    fonts: { display: "Space Grotesk", ui: "Inter" },
  });
  const css = theme.themeCss(t);
  assert.match(css, /:root\s*{/, "emits :root block");
  assert.match(css, /--gold:\s*#7aa2f7/i, "accent → --gold");
  assert.match(css, /--bg:\s*#0d0d0d/i, "bg var present");
  assert.match(css, /--font-display:[^;]*Space Grotesk/i, "display font var");
  assert.match(css, /--font-ui:[^;]*Inter/i, "ui font var");
  // @font-face only for the two used families
  assert.match(css, /\/_assets\/fonts\/space-grotesk-latin\.woff2/, "@font-face Space Grotesk");
  assert.match(css, /\/_assets\/fonts\/inter-latin\.woff2/, "@font-face Inter");
  assert.ok(!/cormorant-garamond-latin\.woff2/.test(css), "no unused Cormorant @font-face");
  assert.ok(!/outfit-latin\.woff2/.test(css), "no unused Outfit @font-face");
  // no external URLs at all
  assert.ok(!/https?:\/\//i.test(css), "themeCss has zero http(s) URLs");
});

test("themeCss strips a CSS-injection color (defense in depth via parse)", () => {
  // even if someone hands themeCss a raw object, the emitter must not echo a
  // non-color value — it parses first.
  const css = theme.themeCss({
    schema: "engtheme/1", title: "x",
    palette: { accent: "red;}body{display:none}" },
    fonts: { display: "Outfit", ui: "Outfit" },
  });
  assert.ok(!/display:none/.test(css), "injection payload not echoed into CSS");
  assert.ok(!/red;}/.test(css), "raw injection string stripped");
  assert.match(css, /--gold:\s*#d4a574/i, "accent fell back to default gold");
});

test("themeCss with system-stack fonts emits NO @font-face for them", () => {
  const css = theme.themeCss(theme.parseTheme({
    schema: "engtheme/1", title: "Sys", palette: {},
    fonts: { display: "system-serif", ui: "system-sans" },
  }));
  assert.ok(!/@font-face/.test(css), "system stacks need no @font-face");
  assert.match(css, /--font-display:\s*[^;]*serif/i, "display falls to a serif system stack");
});
