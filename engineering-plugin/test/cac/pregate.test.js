/*
 * pregate.test.js — S-CAC-1 RED→GREEN wall proof for lib/cac/pregate.js (§7).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { preCompact } = require("../../lib/cac/pregate.js");

function safeCtx(overrides) {
  return Object.assign(
    {
      event: "commit.landed",
      tree_clean: true,
      tool_in_flight: false,
      subagent_running: false,
      gate_green: true,
    },
    overrides || {}
  );
}

test("S-CAC-1: pressure true mid-write (dirty tree) → preCompact DENIES, then flip clean → ALLOWS", () => {
  // RED: context pressure is true but we are mid-write (dirty tree). The wall
  // must deny — compaction is physically impossible mid-operation.
  const mid = preCompact(safeCtx({ tree_clean: false, event: "commit.landed" }));
  assert.equal(mid.allow, false);
  assert.match(mid.reason, /tree|safe/i);

  // GREEN: the commit lands — tree is clean at a declared safe point with a
  // green gate. The wall now allows compaction.
  const landed = preCompact(safeCtx());
  assert.equal(landed.allow, true);
  assert.match(landed.reason, /permitted/);
});

test("gate-not-green → denied even at a safe point with a clean tree", () => {
  const r = preCompact(safeCtx({ gate_green: false }));
  assert.equal(r.allow, false);
  assert.match(r.reason, /gate/i);
});

test("subagent_running → denied", () => {
  const r = preCompact(safeCtx({ subagent_running: true }));
  assert.equal(r.allow, false);
  assert.match(r.reason, /subagent/i);
});

test("tool_in_flight → denied", () => {
  const r = preCompact(safeCtx({ tool_in_flight: true }));
  assert.equal(r.allow, false);
  assert.match(r.reason, /tool/i);
});

test("not at a recognized §4 boundary → denied", () => {
  const r = preCompact(safeCtx({ event: "file.saved" }));
  assert.equal(r.allow, false);
  assert.match(r.reason, /safe-point boundary/i);
});

test("allowed ONLY in the fully-safe case (all triad conditions hold)", () => {
  assert.equal(preCompact(safeCtx()).allow, true);
  // Any single broken condition flips allow to false.
  assert.equal(preCompact(safeCtx({ tree_clean: false })).allow, false);
  assert.equal(preCompact(safeCtx({ gate_green: false })).allow, false);
  assert.equal(preCompact(safeCtx({ tool_in_flight: true })).allow, false);
  assert.equal(preCompact(safeCtx({ subagent_running: true })).allow, false);
  assert.equal(preCompact(safeCtx({ event: "nope" })).allow, false);
});

test("live tree probe via injected git runner (hermetic) — dirty blocks, clean allows", () => {
  const dirtyRunner = { run: () => ({ stdout: " M f.js\n", status: 0 }) };
  const cleanRunner = { run: () => ({ stdout: "", status: 0 }) };

  const dirty = preCompact({ event: "commit.landed", gate_green: true, repoRoot: "/repo", git: dirtyRunner });
  assert.equal(dirty.allow, false);
  assert.match(dirty.reason, /dirty tree/);

  const clean = preCompact({ event: "commit.landed", gate_green: true, repoRoot: "/repo", git: cleanRunner });
  assert.equal(clean.allow, true);
  assert.match(clean.reason, /probed via git/);
});
