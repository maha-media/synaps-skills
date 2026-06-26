/*
 * theme_client.test.js — DT-2: site.js live re-theme helper, headless.
 *   - applyTheme updates the identity block (#brand-title/#brand-monogram/
 *     #brand-tagline) + document.title
 *   - applyTheme cache-busts the generated theme.css link so palette/fonts swap
 *     live without a full reload
 *   - missing identity nodes are tolerated (no throw)
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PlanSite = require("../../assets/site.js");
const { makeDocument } = require("../harness/dom.js");

function shellDoc() {
  const d = makeDocument();
  const mk = (tag, id, attrs) => { const n = d.createElement(tag); if (id) n.setAttribute("id", id); if (attrs) Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k])); d.body.appendChild(n); return n; };
  mk("link", "theme-css", { rel: "stylesheet", href: "/_assets/theme.css" });
  mk("span", "brand-monogram");
  mk("span", "brand-title");
  mk("span", "brand-tagline");
  return d;
}

const THEME = { schema: "engtheme/1", title: "Synaps Engineering", tagline: "agentic toolkit", monogram: "SE", palette: { accent: "#7aa2f7" }, fonts: { display: "Space Grotesk", ui: "Inter" } };

test("applyTheme updates identity block + document.title", () => {
  const d = shellDoc();
  PlanSite.applyTheme(d, THEME, { version: 42 });
  assert.equal(d.getElementById("brand-title").textContent, "Synaps Engineering");
  assert.equal(d.getElementById("brand-monogram").textContent, "SE");
  assert.equal(d.getElementById("brand-tagline").textContent, "agentic toolkit");
  assert.equal(d.title, "Synaps Engineering", "tab title updated");
});

test("applyTheme cache-busts the generated theme.css link", () => {
  const d = shellDoc();
  const before = d.getElementById("theme-css").getAttribute("href");
  assert.equal(before, "/_assets/theme.css");
  PlanSite.applyTheme(d, THEME, { version: 99 });
  const after = d.getElementById("theme-css").getAttribute("href");
  assert.match(after, /^\/_assets\/theme\.css\?v=99$/, "href cache-busted, still local");
  assert.ok(!/https?:\/\//.test(after), "no external URL introduced");
});

test("applyTheme tolerates missing identity nodes (no throw)", () => {
  const d = makeDocument();
  assert.doesNotThrow(() => PlanSite.applyTheme(d, THEME, { version: 1 }));
});

test("applyTheme exported as a function", () => {
  assert.equal(typeof PlanSite.applyTheme, "function");
});
