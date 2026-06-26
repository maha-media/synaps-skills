/*
 * plan_theme_cli.test.js — DT-3: `plan theme` CLI library surface.
 *   - planThemeInfer writes a valid .plans/theme.json (generated_by:inferred)
 *   - planThemeWrite rejects an invalid theme (errors, NO write) and accepts a
 *     valid one (writes, generated_by:llm)
 *   - planThemeShow returns the resolved theme + source
 *   - planThemeDigest is a prompt-ready blob (schema + title candidates + fonts)
 *   - planNew seeds a deterministic theme when none exists (best-effort)
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const plan = require("../../bin/plan.js");
const themeLib = require("../../lib/theme.js");

function tmpRepo(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-theme-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  if (seed) Object.keys(seed).forEach((f) => fs.writeFileSync(path.join(dir, f), seed[f]));
  return dir;
}
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
function themePath(repo) { return path.join(repo, ".plans", "theme.json"); }

test("planThemeInfer writes a valid .plans/theme.json (generated_by:inferred)", () => {
  const repo = tmpRepo({ "package.json": JSON.stringify({ name: "neat-thing", description: "does neat" }) });
  try {
    const r = plan.planThemeInfer(repo);
    assert.ok(fs.existsSync(themePath(repo)), "theme.json written");
    const obj = JSON.parse(fs.readFileSync(themePath(repo), "utf8"));
    assert.equal(obj.schema, "engtheme/1");
    assert.equal(obj.generated_by, "inferred");
    assert.match(obj.title, /Neat Thing/i);
    // round-trips through the validator
    const t = themeLib.parseTheme(obj);
    assert.equal(t.schema, "engtheme/1");
    assert.ok(r.theme && r.file);
  } finally { rmrf(repo); }
});

test("planThemeWrite rejects an invalid theme (errors returned, NO file written)", () => {
  const repo = tmpRepo();
  try {
    const bad = JSON.stringify({ schema: "nope", title: "", palette: { accent: "red;}x{" }, fonts: { display: "Bogus", ui: "X" } });
    const r = plan.planThemeWrite(repo, bad);
    assert.equal(r.ok, false, "rejected");
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, "reports errors");
    assert.ok(r.errors.some((e) => /schema/i.test(e)), "schema error present");
    assert.ok(!fs.existsSync(themePath(repo)), "no theme.json written on rejection");
  } finally { rmrf(repo); }
});

test("planThemeWrite accepts a valid theme and writes it (generated_by:llm)", () => {
  const repo = tmpRepo();
  try {
    const good = JSON.stringify({
      schema: "engtheme/1", title: "Synaps Engineering", tagline: "ship it",
      monogram: "SE", palette: { accent: "#7aa2f7" },
      fonts: { display: "Space Grotesk", ui: "Inter" },
    });
    const r = plan.planThemeWrite(repo, good);
    assert.equal(r.ok, true, "accepted");
    assert.ok(fs.existsSync(themePath(repo)), "theme.json written");
    const obj = JSON.parse(fs.readFileSync(themePath(repo), "utf8"));
    assert.equal(obj.title, "Synaps Engineering");
    assert.equal(obj.generated_by, "llm", "marked llm-generated");
    assert.equal(obj.palette.accent, "#7aa2f7");
  } finally { rmrf(repo); }
});

test("planThemeWrite rejects malformed JSON without throwing", () => {
  const repo = tmpRepo();
  try {
    const r = plan.planThemeWrite(repo, "{ not json ");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /json/i.test(e)), "json parse error reported");
    assert.ok(!fs.existsSync(themePath(repo)));
  } finally { rmrf(repo); }
});

test("planThemeShow returns the resolved theme + source", () => {
  const repo = tmpRepo({ "package.json": JSON.stringify({ name: "show-me" }) });
  try {
    const r = plan.planThemeShow(repo);
    assert.equal(r.theme.schema, "engtheme/1");
    assert.ok(["file", "inferred", "default"].indexOf(r.source) !== -1);
    assert.equal(r.source, "inferred");
  } finally { rmrf(repo); }
});

test("planThemeDigest is a prompt-ready blob (schema + title candidates + fonts)", () => {
  const repo = tmpRepo({
    "package.json": JSON.stringify({ name: "widget-kit", description: "a widget kit" }),
    "theme.css": ":root{--brand:#3366ff;}",
    "README.md": "# Widget Kit\n\n> the best widgets\n",
  });
  try {
    const digest = plan.planThemeDigest(repo);
    assert.equal(typeof digest, "string");
    assert.match(digest, /engtheme\/1/, "includes the schema id");
    assert.match(digest, /widget-kit|Widget Kit/i, "includes a title candidate");
    assert.match(digest, /Space Grotesk/, "lists a bundled font family");
    assert.match(digest, /system-serif|system-sans|system-mono/, "lists system stacks");
    assert.match(digest, /#3366ff/i, "surfaces a discovered brand color");
    assert.match(digest, /editorial|geometric|techno/, "lists suggested pairings");
  } finally { rmrf(repo); }
});

test("planNew seeds a deterministic theme when none exists (best-effort)", () => {
  const repo = tmpRepo({ "package.json": JSON.stringify({ name: "seed-me" }) });
  try {
    plan.planNew(repo, "plan", "demo", { title: "Demo" });
    assert.ok(fs.existsSync(themePath(repo)), "plan new seeded a theme.json");
    const obj = JSON.parse(fs.readFileSync(themePath(repo), "utf8"));
    assert.equal(obj.schema, "engtheme/1");
  } finally { rmrf(repo); }
});

test("planNew does NOT overwrite an existing theme.json", () => {
  const repo = tmpRepo({ "package.json": JSON.stringify({ name: "keep-me" }) });
  try {
    const existing = { schema: "engtheme/1", title: "Pre-existing", palette: {}, fonts: { display: "Inter", ui: "Inter" }, generated_by: "llm" };
    fs.writeFileSync(themePath(repo), JSON.stringify(existing));
    plan.planNew(repo, "plan", "demo2", { title: "Demo2" });
    const obj = JSON.parse(fs.readFileSync(themePath(repo), "utf8"));
    assert.equal(obj.title, "Pre-existing", "existing theme preserved");
  } finally { rmrf(repo); }
});
