/*
 * write_confine.test.js — P4-SEC-4: lib/store.js allowedWriteTarget permits only
 * *.notes.json / *.events.json and agents.json under .plans/; everything else
 * (and any traversal) throws.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const store = require("../../lib/store.js");

function mkrepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "engplan-wc-"));
  fs.mkdirSync(path.join(repo, ".plans"), { recursive: true });
  return repo;
}

test("allowed filenames resolve inside .plans/", () => {
  const repo = mkrepo();
  try {
    for (const name of ["myplan.notes.json", "myplan.events.json", "agents.json"]) {
      const target = store.allowedWriteTarget(repo, name);
      assert.equal(path.dirname(target), path.join(repo, ".plans"));
      assert.equal(path.basename(target), name);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("disallowed filenames throw", () => {
  const repo = mkrepo();
  try {
    for (const name of ["myplan.json", "evil.txt", "plan.html", "config.yaml", "notes.json.bak", ".env"]) {
      assert.throws(() => store.allowedWriteTarget(repo, name), /not allowed/, "should reject " + name);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("traversal filenames throw", () => {
  const repo = mkrepo();
  try {
    for (const name of ["../escape.notes.json", "../../etc/passwd.events.json", "sub/x.notes.json"]) {
      assert.throws(() => store.allowedWriteTarget(repo, name), /not allowed|escapes/, "should reject " + name);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
