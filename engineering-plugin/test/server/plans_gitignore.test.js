"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const store = require("../../lib/store.js");
const { planNew } = require("../../bin/plan.js");

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plans-gi-"));
}

// G2 — direct planNew() coverage. ensurePlansGitignore is called from planNew
// (bin/plan.js); this asserts it directly rather than transitively via appendEvent.
test("planNew() scaffolds .plans/.gitignore that ignores runtime artifacts but not the plan doc", () => {
  const repo = tmpRepo();
  const slug = "g2-direct-plan";
  const { file } = planNew(repo, "plan", slug, { title: "G2 Direct" });
  const gi = path.join(repo, ".plans", ".gitignore");
  assert.ok(fs.existsSync(gi), "planNew should scaffold .plans/.gitignore");
  const txt = fs.readFileSync(gi, "utf8");
  for (const pat of ["*.events.json", "*.notes.json", "agents.json", "*.oracle.jsonl", "*.lock", "*.tmp-*"]) {
    assert.ok(txt.includes(pat), `gitignore should list ${pat}`);
  }
  // The plan document itself must NOT be matched by any rule in the file.
  const rules = txt.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const planDoc = path.basename(file); // "<slug>.plan.html"
  for (const r of rules) {
    assert.ok(!matchesRule(planDoc, r), `rule "${r}" must not match the plan doc ${planDoc}`);
  }
});

// Minimal glob match for the simple patterns we emit (*.ext, name, *substr*).
function matchesRule(name, rule) {
  const rx = new RegExp(
    "^" + rule.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
  );
  return rx.test(name);
}

test("appendEvent scaffolds .plans/.gitignore that ignores runtime artifacts", () => {
  const repo = tmpRepo();
  fs.mkdirSync(path.join(repo, ".plans"), { recursive: true }); // planNew creates this in prod
  store.appendEvent(repo, "demo-plan", { section_id: "s1", type: "comment", actor: "human", text: "hi" });
  const gi = path.join(repo, ".plans", ".gitignore");
  assert.ok(fs.existsSync(gi), ".plans/.gitignore should be created");
  const txt = fs.readFileSync(gi, "utf8");
  for (const pat of ["*.events.json", "*.notes.json", "agents.json", "*.oracle.jsonl", "*.lock", "*.tmp-*"]) {
    assert.ok(txt.includes(pat), `gitignore should list ${pat}`);
  }
});

test("ensurePlansGitignore is idempotent and does not clobber an existing file", () => {
  const repo = tmpRepo();
  const giDir = path.join(repo, ".plans");
  fs.mkdirSync(giDir, { recursive: true });
  const gi = path.join(giDir, ".gitignore");
  fs.writeFileSync(gi, "# custom user content\n");
  store.ensurePlansGitignore(repo);
  assert.strictEqual(fs.readFileSync(gi, "utf8"), "# custom user content\n");
});

test("plan documents are NOT ignored by the scaffolded patterns", () => {
  const repo = tmpRepo();
  store.ensurePlansGitignore(repo);
  const txt = fs.readFileSync(path.join(repo, ".plans", ".gitignore"), "utf8");
  const rules = txt.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  assert.ok(!rules.some((r) => r.includes("plan.html")), "plan.html must stay tracked");
  assert.ok(!rules.some((r) => /^_assets\b/.test(r.trim())), "_assets must stay tracked");
});

