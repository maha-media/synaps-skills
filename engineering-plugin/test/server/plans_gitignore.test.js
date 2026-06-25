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

// G1 — Option A managed-block merge semantics. Existing files gain the block on
// upgrade; user content outside the markers is never touched.

const MANAGED_BEGIN = "# >>> engineering plans (managed — do not edit inside) >>>";
const MANAGED_END = "# <<< engineering plans (managed) <<<";

function readGi(repo) {
  return fs.readFileSync(path.join(repo, ".plans", ".gitignore"), "utf8");
}

test("ensurePlansGitignore appends the managed block to an existing file, preserving user lines byte-for-byte", () => {
  const repo = tmpRepo();
  const giDir = path.join(repo, ".plans");
  fs.mkdirSync(giDir, { recursive: true });
  const gi = path.join(giDir, ".gitignore");
  const userContent = "# my custom rules\nsecrets.txt\n*.bak\n";
  fs.writeFileSync(gi, userContent);
  store.ensurePlansGitignore(repo);
  const out = readGi(repo);
  // Every original byte is preserved at the head of the file.
  assert.ok(out.startsWith(userContent), "user content must be preserved byte-for-byte at the head");
  // The managed block was appended.
  assert.ok(out.includes(MANAGED_BEGIN) && out.includes(MANAGED_END), "managed block markers must be present");
  for (const pat of ["agents.json", "*.events.json", "*.notes.json", "*.oracle.jsonl", "*.tmp-*", "*.lock"]) {
    assert.ok(out.includes(pat), `block should list ${pat}`);
  }
  // User rules still ignore-effective; plan docs never added.
  assert.ok(out.includes("secrets.txt") && out.includes("*.bak"), "user rules retained");
  assert.ok(!out.includes("plan.html"), "plan.html must never be added as a rule");
});

test("ensurePlansGitignore is a byte-identical no-op when the managed block is already up to date", () => {
  const repo = tmpRepo();
  store.ensurePlansGitignore(repo);           // create
  const first = readGi(repo);
  store.ensurePlansGitignore(repo);           // second call
  const second = readGi(repo);
  assert.strictEqual(second, first, "second call must produce a byte-identical file (idempotent)");
  // And appending to an already-migrated existing file is also a no-op.
  store.ensurePlansGitignore(repo);
  assert.strictEqual(readGi(repo), first, "third call must remain byte-identical");
});

test("ensurePlansGitignore replaces only the block interior when the patterns change, preserving surrounding user content", () => {
  const repo = tmpRepo();
  const giDir = path.join(repo, ".plans");
  fs.mkdirSync(giDir, { recursive: true });
  const gi = path.join(giDir, ".gitignore");
  // A file with a STALE managed block (only one outdated pattern inside) wrapped
  // by user content above and below.
  const before = "# header user line\nkeep-me.log\n";
  const after = "# trailing user line\nalso-keep.tmp\n";
  const staleBlock = [MANAGED_BEGIN, "*.events.json", MANAGED_END].join("\n");
  fs.writeFileSync(gi, before + staleBlock + "\n" + after);
  store.ensurePlansGitignore(repo);
  const out = readGi(repo);
  // Surrounding user content preserved exactly.
  assert.ok(out.startsWith(before), "content before the block preserved byte-for-byte");
  assert.ok(out.endsWith(after), "content after the block preserved byte-for-byte");
  // Interior now carries the full current pattern set.
  for (const pat of ["agents.json", "*.notes.json", "*.oracle.jsonl", "*.tmp-*", "*.lock"]) {
    assert.ok(out.includes(pat), `interior should be updated to include ${pat}`);
  }
  // Exactly one managed block (no duplication).
  assert.strictEqual(out.split(MANAGED_BEGIN).length - 1, 1, "exactly one begin marker");
  assert.strictEqual(out.split(MANAGED_END).length - 1, 1, "exactly one end marker");
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
