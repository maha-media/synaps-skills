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

// G3 — silent-failure resilience. The try/catch in ensurePlansGitignore is
// intentional: a failed ignore-scaffold must never block a notes/events write.

test("ensurePlansGitignore does not throw when the .plans dir is unwritable", () => {
  const repo = tmpRepo();
  const plansDir = path.join(repo, ".plans");
  fs.mkdirSync(plansDir, { recursive: true });
  fs.chmodSync(plansDir, 0o500); // read+execute, no write
  // Self-skip when chmod can't actually restrict us (running as root) — else
  // we'd false-pass without exercising the failure path.
  let restricted = true;
  try {
    const probe = path.join(plansDir, ".probe-write");
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    restricted = false; // write succeeded → not restricted (root)
  } catch (_) { /* expected: write blocked */ }
  try {
    if (!restricted) {
      // restore perms before skipping so tmp cleanup works
      fs.chmodSync(plansDir, 0o700);
      return; // node:test treats a clean return as pass; we note the skip below
    }
    // The core assertion: must not throw even though the write fails.
    assert.doesNotThrow(() => store.ensurePlansGitignore(repo));
    // And the file must NOT have been created (write genuinely failed).
    assert.ok(!fs.existsSync(path.join(plansDir, ".gitignore")), "gitignore write should have failed silently");
  } finally {
    fs.chmodSync(plansDir, 0o700); // make dir removable for tmp cleanup
  }
});

test("appendEvent still persists the event when gitignore scaffolding fails", () => {
  const repo = tmpRepo();
  const plansDir = path.join(repo, ".plans");
  fs.mkdirSync(plansDir, { recursive: true });
  // Make ONLY the .gitignore write fail while keeping the dir writable for the
  // events file: a dangling symlink whose parent dir does not exist. Writing
  // through it raises ENOENT (structural, so this holds even under root), while
  // the events file write into the writable .plans dir succeeds.
  const gi = path.join(plansDir, ".gitignore");
  fs.symlinkSync(path.join(os.tmpdir(), "g3-nonexistent-" + process.pid, ".gitignore"), gi);
  // Sanity: ensurePlansGitignore would throw if unguarded; it must not here.
  assert.doesNotThrow(() => store.ensurePlansGitignore(repo));
  // appendEvent calls ensurePlansGitignore internally and must still succeed.
  const ev = store.appendEvent(repo, "g3-resilience", { section_id: "s1", type: "comment", actor: "human", text: "still works" });
  assert.ok(ev, "appendEvent should return the persisted event");
  const events = JSON.parse(fs.readFileSync(path.join(plansDir, "g3-resilience.events.json"), "utf8"));
  assert.strictEqual(events.length, 1, "event should be persisted despite gitignore failure");
  assert.strictEqual(events[0].text, "still works");
});
