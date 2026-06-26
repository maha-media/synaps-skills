/*
 * server_record_gitignore.test.js — S4: the runtime server record + lock must
 * never be committed. Asserts .server.json and .server.lock are in the managed
 * block, and that git status stays clean after a host + teardown cycle.
 */
"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const store = require("../../lib/store.js");
const life = require("../../lib/server_lifecycle.js");

const repos = new Set();
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-rec-gi-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  repos.add(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of repos) { try { await life.stopServer(dir); } catch (_) {} }
  for (const dir of repos) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  repos.clear();
});

test(".server.json and .server.lock are in the managed gitignore block", () => {
  const repo = tmpRepo();
  store.ensurePlansGitignore(repo);
  const txt = fs.readFileSync(path.join(repo, ".plans", ".gitignore"), "utf8");
  assert.ok(txt.includes(".server.json"), "block should list .server.json");
  assert.ok(txt.includes(".server.lock"), "block should list .server.lock");
});

test("git status stays clean after a server host + teardown (record/lock untracked)", async () => {
  const repo = tmpRepo();
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(repo, ".plans", "x.plan.html"), "<html></html>");
  store.ensurePlansGitignore(repo);
  git("add", "-A");
  git("commit", "-qm", "base");
  // host a server (writes .server.json + transient .server.lock) then tear down
  await life.ensureServer(repo);
  assert.ok(fs.existsSync(life.recordPath(repo)), ".server.json should exist while hosting");
  const dirtyWhileUp = git("status", "--porcelain").trim();
  assert.equal(dirtyWhileUp, "", "git status must be clean while the server record exists: " + dirtyWhileUp);
  await life.stopServer(repo);
  const dirtyAfter = git("status", "--porcelain").trim();
  assert.equal(dirtyAfter, "", "git status must be clean after teardown: " + dirtyAfter);
});
