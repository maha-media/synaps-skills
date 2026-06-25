#!/usr/bin/env node
/*
 * gitignore_hardening.js — unattended merge-gate harness for the .plans
 * /.gitignore auto-scaffold hardening (plan: plans-gitignore-hardening, G5).
 *
 * Rebuilds and re-verifies the WHOLE behavior with no human in the loop:
 *   - new-project scaffold (planNew + ensurePlansGitignore)
 *   - existing-project migration (Option A managed-block merge)
 *   - silent-failure resilience (best-effort try/catch guard)
 *   - captured red→green deltas for the G2 and G3 mutations
 *   - the full project test suite (count reported)
 *
 * Mutations are applied to source files and ALWAYS restored in a finally block;
 * a clean-tree check at the end fails the harness if any mutation leaked. Exits
 * 0 only when every stage is green. Run: node test/harness/gitignore_hardening.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const PLUGIN_DIR = path.resolve(__dirname, "..", "..");
const STORE = path.join(PLUGIN_DIR, "lib", "store.js");
const PLAN = path.join(PLUGIN_DIR, "bin", "plan.js");
const GI_TEST = path.join("test", "server", "plans_gitignore.test.js");

function line(c) { return c.repeat(60); }
function log(s) { process.stdout.write(s + "\n"); }

// Run a targeted slice of the gitignore test file; return {pass, fail}.
function runTests(namePattern) {
  const args = ["--test"];
  if (namePattern) args.push("--test-name-pattern=" + namePattern);
  args.push(GI_TEST);
  const r = cp.spawnSync(process.execPath, args, { cwd: PLUGIN_DIR, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = Number((out.match(/(?:ℹ|#)\s*pass\s+(\d+)/) || [])[1] || 0);
  const fail = Number((out.match(/(?:ℹ|#)\s*fail\s+(\d+)/) || [])[1] || 0);
  return { pass, fail, out };
}

// Apply a string mutation to a file, returning a restore() closure.
function mutate(file, oldStr, newStr) {
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(oldStr)) throw new Error("mutation anchor not found in " + path.basename(file));
  fs.writeFileSync(file, orig.replace(oldStr, newStr));
  return () => fs.writeFileSync(file, orig);
}

// A provable mutation: prove the test has teeth (RED) then confirm GREEN.
function prove(label, pattern, file, oldStr, newStr) {
  // sanity GREEN before mutation
  const baseline = runTests(pattern);
  if (baseline.fail !== 0 || baseline.pass === 0) {
    throw new Error(`${label}: baseline not green (pass=${baseline.pass} fail=${baseline.fail})`);
  }
  let red, green;
  const restore = mutate(file, oldStr, newStr);
  try {
    red = runTests(pattern);          // expect failures with the fix removed
    restore();
    green = runTests(pattern);        // expect all pass after restore
  } finally {
    restore(); // idempotent — guarantees restoration even on throw
  }
  if (red.fail === 0) throw new Error(`${label}: mutation produced no RED (test has no teeth)`);
  if (green.fail !== 0) throw new Error(`${label}: not GREEN after restore (fail=${green.fail})`);
  log(`  ${label.padEnd(34)} RED ${red.fail} fail → GREEN ${green.pass} pass  ✓`);
}

// Direct filesystem-fixture checks (no subprocess) for the core behaviors.
function fixtureChecks() {
  const store = require(STORE);
  const { planNew } = require(PLAN);
  const BEGIN = "# >>> engineering plans (managed — do not edit inside) >>>";
  const END = "# <<< engineering plans (managed) <<<";
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gi-harness-"));

  // 1. New-project scaffold via planNew.
  let repo = tmp();
  const { file } = planNew(repo, "plan", "harness-demo", { title: "Harness" });
  let gi = fs.readFileSync(path.join(repo, ".plans", ".gitignore"), "utf8");
  if (!gi.includes(BEGIN) || !gi.includes(END)) throw new Error("new-project scaffold missing managed block");
  if (gi.includes(path.basename(file))) throw new Error("plan doc must not be ignored");
  for (const p of ["agents.json", "*.events.json", "*.notes.json", "*.oracle.jsonl", "*.tmp-*", "*.lock"]) {
    if (!gi.includes(p)) throw new Error("scaffold missing pattern " + p);
  }
  log("  new-project scaffold (planNew)      managed block present, plan doc tracked  ✓");

  // 2. Existing-project migration (Option A): append, preserve, idempotent.
  repo = tmp();
  fs.mkdirSync(path.join(repo, ".plans"), { recursive: true });
  const giPath = path.join(repo, ".plans", ".gitignore");
  const userContent = "# user rules\nsecrets.txt\n";
  fs.writeFileSync(giPath, userContent);
  store.ensurePlansGitignore(repo);
  const migrated = fs.readFileSync(giPath, "utf8");
  if (!migrated.startsWith(userContent)) throw new Error("migration clobbered user content");
  if (!migrated.includes(BEGIN)) throw new Error("migration did not add managed block");
  store.ensurePlansGitignore(repo);
  if (fs.readFileSync(giPath, "utf8") !== migrated) throw new Error("migration not idempotent");
  log("  existing-project migration (Opt A)  block appended, user lines kept, idempotent  ✓");

  // 3. Silent-failure resilience: dangling symlink → write fails, never throws,
  //    and a subsequent appendEvent still persists.
  repo = tmp();
  fs.mkdirSync(path.join(repo, ".plans"), { recursive: true });
  fs.symlinkSync(path.join(os.tmpdir(), "gi-harness-missing-" + process.pid, ".gitignore"),
    path.join(repo, ".plans", ".gitignore"));
  try { store.ensurePlansGitignore(repo); } catch (e) { throw new Error("ensure threw on write failure: " + e.message); }
  const ev = store.appendEvent(repo, "harness-resilience", { section_id: "s1", type: "comment", actor: "human", text: "ok" });
  if (!ev) throw new Error("appendEvent did not persist when scaffolding failed");
  log("  silent-failure resilience           ensure no-throw + appendEvent persisted  ✓");
}

function main() {
  log(line("="));
  log("plans-gitignore-hardening — unattended verification harness");
  log(line("="));

  log("\n[1/3] Behavioral fixtures (Option A)");
  fixtureChecks();

  log("\n[2/3] Red→green proofs (mutate the fix, watch the tests bite)");
  // G2: planNew must scaffold .plans/.gitignore.
  prove(
    "G2 planNew scaffold",
    "planNew\\(\\) scaffolds",
    PLAN,
    "  store.ensurePlansGitignore(repoRoot); // keep runtime artifacts out of git from the start",
    "  /* G5-HARNESS: ensure call removed to prove the test bites */"
  );
  // G3: the best-effort guard must swallow write failures.
  prove(
    "G3 silent-failure guard",
    "(does not throw when the .plans dir|appendEvent still persists)",
    STORE,
    "} catch (_) { /* best-effort; never block a write on ignore scaffolding */ }",
    "} catch (e) { throw e; /* G5-HARNESS: guard defeated to prove the test bites */ }"
  );

  log("\n[3/3] Full project test suite");
  const args = ["--test", "test/**/*.test.js"];
  const r = cp.spawnSync(process.execPath, args, { cwd: PLUGIN_DIR, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const pass = Number((out.match(/(?:ℹ|#)\s*pass\s+(\d+)/) || [])[1] || 0);
  const fail = Number((out.match(/(?:ℹ|#)\s*fail\s+(\d+)/) || [])[1] || 0);
  log(`  full suite: ${pass} pass, ${fail} fail`);
  if (fail !== 0 || pass === 0) { log("\nSUITE NOT GREEN"); process.exit(1); }

  // Tree-clean guard: ensure no mutation leaked into the working tree.
  const status = cp.spawnSync("git", ["status", "--porcelain", "lib/store.js", "bin/plan.js"],
    { cwd: PLUGIN_DIR, encoding: "utf8" }).stdout.trim();
  if (status) { log("\nWORKING TREE DIRTY after harness (mutation leaked):\n" + status); process.exit(1); }

  log("\n" + line("="));
  log(`HARNESS GREEN — fixtures ✓  G2/G3 red→green ✓  suite ${pass}/${pass} ✓  tree clean ✓`);
  log(line("="));
  process.exit(0);
}

try { main(); } catch (e) { log("\nHARNESS FAILED: " + e.message); process.exit(1); }
