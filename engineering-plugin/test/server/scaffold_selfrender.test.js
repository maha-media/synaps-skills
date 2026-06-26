/*
 * scaffold_selfrender.test.js — PS-5: `plan new` still scaffolds a standalone
 * self-contained *.plan.html that renders from its embedded engplan/1 JSON on
 * file:// (degraded mode), independent of the SPA shell or any server.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const planCli = require("../../bin/plan.js");
const PlanRenderer = require("../../assets/plan.js");
const discovery = require("../../lib/discovery.js");
const { makeDocument } = require("../harness/dom.js");

function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-new-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  return dir;
}
function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }

test("plan new scaffolds a self-contained file that self-renders on file://", () => {
  const repo = tmpRepo();
  try {
    const { file } = planCli.planNew(repo, "plan", "scaffold-demo", { title: "Scaffold Demo" });
    const html = fs.readFileSync(file, "utf8");

    // self-contained: embedded JSON + renderer ref + a static (./_assets) fallback
    assert.match(html, /<script id="plan" type="application\/json">/, "embeds engplan JSON");
    assert.match(html, /_assets\/plan\.js/, "references the renderer");
    assert.ok(!/https?:\/\//i.test(html), "scaffold has zero external URLs");
    // fallback assets copied for offline rendering
    assert.ok(fs.existsSync(path.join(repo, ".plans", "_assets", "plan.js")), "plan.js copied for file://");
    assert.ok(fs.existsSync(path.join(repo, ".plans", "_assets", "plan.css")), "plan.css copied for file://");

    // degraded render: boot from the embedded JSON with NO fetch / NO server
    const json = discovery.extractPlanJson(html);
    assert.ok(json && json.schema === "engplan/1", "embedded JSON is valid engplan/1");
    const d = makeDocument();
    const script = d.createElement("script");
    script.setAttribute("id", "plan"); script.setAttribute("type", "application/json");
    script.textContent = JSON.stringify(json);
    const app = d.createElement("div"); app.setAttribute("id", "app");
    d.body.appendChild(script); d.body.appendChild(app);
    PlanRenderer.boot({ document: d });
    assert.ok(app.querySelector(".plan-header"), "self-renders header offline");
    assert.match(app.querySelector(".plan-header").textContent, /Scaffold Demo/);
  } finally { rmrf(repo); }
});
