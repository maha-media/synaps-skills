/*
 * skill_rules.test.js — CAC §8 skill instruction lint. Asserts each of the four
 * target SKILL.md files carries its mandated Checkpoint-and-yield rule.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SKILLS = path.join(__dirname, "..", "..", "skills");
function read(slug) { return fs.readFileSync(path.join(SKILLS, slug, "SKILL.md"), "utf8"); }

test("convergence-loop has the Checkpoint-and-yield rule (§8)", () => {
  const t = read("convergence-loop");
  assert.match(t, /## Checkpoint-and-yield \(CAC\)/);
  assert.match(t, /checkpoint\.reached/);
  assert.match(t, /resume token/);
  assert.match(t, /human-gated/);
});

test("incremental-implementation has the Checkpoint-and-yield rule (§8)", () => {
  const t = read("incremental-implementation");
  assert.match(t, /## Checkpoint-and-yield \(CAC\)/);
  assert.match(t, /checkpoint\.reached/);
  assert.match(t, /between\* checkpoints/);
});

test("verification-before-completion has the safe-point precondition rule (§8)", () => {
  const t = read("verification-before-completion");
  assert.match(t, /## Checkpoint-and-yield \(CAC\)/);
  assert.match(t, /gate is asserted \*\*green\*\*/);
  assert.match(t, /tree is clean/);
  assert.match(t, /resume token is written/);
});

test("planning-and-task-breakdown requires checkpoints[] (§8)", () => {
  const t = read("planning-and-task-breakdown");
  assert.match(t, /## Checkpoint-and-yield \(CAC\)/);
  assert.match(t, /`checkpoints\[\]`/);
  assert.match(t, /compaction schedule/);
  assert.match(t, /durable artifact/);
});
