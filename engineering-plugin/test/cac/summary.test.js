/*
 * summary.test.js — tests for lib/cac/summary.js (spec §6, S-CAC-6).
 * Hermetic: every artifact (plan JSON, git log lines, verdict, resume token,
 * transcript) is injected; no dependence on the live .plans/ or git history.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const summary = require("../../lib/cac/summary.js");

// --- fixtures -------------------------------------------------------------

function fixturePlanJson() {
  // A small but valid engplan/1 object, plus a raw `checkpoints[]` array that
  // the engplan parser drops (we read it off the raw object).
  return {
    schema: "engplan/1",
    kind: "plan",
    slug: "html-plan-ecosystem",
    title: "HTML Plan Ecosystem",
    status: "in_progress",
    convergence: "informed",
    sections: [
      { id: "P0", heading: "Bootstrap", type: "task", state: "done" },
      { id: "O5", heading: "Oracle survivors", type: "task", state: "doing" },
    ],
    checkpoints: [
      { id: "C-O3", pass: true },
      { id: "C-O4", pass: true },
      { id: "C-O5", pass: false, phase: "O5" },
    ],
  };
}

function fixturePlanHtml() {
  const json = JSON.stringify(fixturePlanJson());
  return (
    "<!doctype html><html><head>" +
    '<script id="plan" type="application/json">' + json + "</script>" +
    "</head><body>scrollback text that MUST be ignored</body></html>"
  );
}

function fixtureToken(overrides) {
  return Object.assign(
    {
      schema: "resume/1",
      slug: "html-plan-ecosystem",
      branch: "feat/html-plan-ecosystem",
      worktree: "/abs/path/.worktrees/x",
      active_phase: "O5",
      last_checkpoint: "C-O4",
      next_action: "fix oracle survivors: bad-request, too-many-streams; re-run self-play",
      head_commit: "b344bf1",
      outstanding: ["selfplay state=not-done, outstanding_finds=3, reveal_verified=false"],
      pending_subagents: [],
      loop: { kind: "convergence", continue: true },
      issued_at: "2026-06-25T14:46:00Z",
    },
    overrides || {}
  );
}

const LOG_LINES = [
  "b344bf1 oracle: land write-confinement guard",
  "a1b2c3d oracle: bad-request survivor fix",
];

const VERDICT = {
  slug: "html-plan-ecosystem",
  grade: "B+",
  verdict: "iterate",
  outstanding: ["too-many-streams survivor", "write-confinement-violation survivor"],
};

// --- tests ----------------------------------------------------------------

test("builds a summary from plan html + git log + verdict + resume token", () => {
  const { object, markdown } = summary.buildSummary({
    planHtml: fixturePlanHtml(),
    logLines: LOG_LINES,
    verdict: VERDICT,
    resumeToken: fixtureToken(),
  });

  // Structured object surfaces the continuity-critical fields.
  assert.equal(object.slug, "html-plan-ecosystem");
  assert.equal(object.title, "HTML Plan Ecosystem");
  assert.equal(object.plan_status, "in_progress");
  assert.equal(object.active_phase, "O5");
  assert.equal(object.last_checkpoint, "C-O4");
  assert.match(object.next_action, /fix oracle survivors/);
  assert.ok(object.outstanding.includes("selfplay state=not-done, outstanding_finds=3, reveal_verified=false"));
  assert.ok(object.outstanding.includes("too-many-streams survivor"));
  assert.deepEqual(object.landed_commits, LOG_LINES);
  assert.equal(object.loop.kind, "convergence");
  assert.equal(object.loop.continue, true);
  assert.ok(Array.isArray(object.grades) && object.grades.length === 1);
  assert.equal(object.grades[0].grade, "B+");

  // Markdown references active_phase, next_action, and outstanding items.
  assert.match(markdown, /Active phase:\*\* O5/);
  assert.match(markdown, /Next action:\*\* fix oracle survivors/);
  assert.match(markdown, /too-many-streams survivor/);
  assert.match(markdown, /b344bf1 oracle/);
});

test("FAIL CLOSED: missing next_action throws (token without it)", () => {
  const bad = fixtureToken();
  delete bad.next_action;
  assert.throws(
    () => summary.buildSummary({ planHtml: fixturePlanHtml(), logLines: LOG_LINES, resumeToken: bad }),
    /next_action/
  );
});

test("FAIL CLOSED: no resume token at all throws (fail closed)", () => {
  assert.throws(
    () => summary.buildSummary({ planHtml: fixturePlanHtml(), logLines: LOG_LINES }),
    /next_action/
  );
});

test("CONFLICT: transcript active_phase does not override artifacts (token wins)", () => {
  const { object, markdown } = summary.buildSummary({
    planHtml: fixturePlanHtml(),
    logLines: LOG_LINES,
    resumeToken: fixtureToken({ active_phase: "O5" }),
    transcript: { active_phase: "X", text: "the chat tail believed we were in phase X" },
  });

  // Artifacts win: active_phase is the token's "O5", never the transcript's "X".
  assert.equal(object.active_phase, "O5");
  assert.notEqual(object.active_phase, "X");
  assert.match(markdown, /Active phase:\*\* O5/);
  // Conflict is noted but never applied.
  assert.ok(Array.isArray(object.conflicts) && object.conflicts.length === 1);
  assert.match(object.conflicts[0], /artifacts win/);
  // Transcript retained only as secondary context.
  assert.equal(object.transcript, "the chat tail believed we were in phase X");
  assert.match(markdown, /secondary context only/);
});

test("landed_commits reflect the provided git log lines (trimmed, deduped of blanks)", () => {
  const { object } = summary.buildSummary({
    planJson: fixturePlanJson(),
    logLines: ["  ff00aa first  ", "", " bb11cc second "],
    resumeToken: fixtureToken(),
  });
  assert.deepEqual(object.landed_commits, ["ff00aa first", "bb11cc second"]);
});

test("checkpoints[] from raw plan JSON are surfaced when present", () => {
  const { object, markdown } = summary.buildSummary({
    planJson: fixturePlanJson(),
    logLines: LOG_LINES,
    resumeToken: fixtureToken(),
  });
  assert.ok(Array.isArray(object.checkpoints));
  assert.equal(object.checkpoints.length, 3);
  assert.deepEqual(object.checkpoints[2], { id: "C-O5", pass: false, phase: "O5" });
  assert.match(markdown, /C-O5: fail/);
  assert.match(markdown, /C-O4: pass/);
});

test("degrades gracefully when plan artifact absent (token still drives)", () => {
  const { object } = summary.buildSummary({
    logLines: LOG_LINES,
    resumeToken: fixtureToken(),
  });
  assert.equal(object.title, null);
  assert.equal(object.plan_status, null);
  assert.equal(object.active_phase, "O5");
  assert.equal(object.checkpoints, undefined);
});

test("accepts planJson as a JSON string and verdict array", () => {
  const { object } = summary.buildSummary({
    planJson: JSON.stringify(fixturePlanJson()),
    logLines: LOG_LINES,
    verdict: [VERDICT, { slug: "x", verdict: "pass" }],
    resumeToken: fixtureToken(),
  });
  assert.equal(object.title, "HTML Plan Ecosystem");
  assert.equal(object.grades.length, 2);
});

test("inboxEvents (open) contribute outstanding work", () => {
  const { object } = summary.buildSummary({
    planJson: fixturePlanJson(),
    logLines: LOG_LINES,
    inboxEvents: [
      { status: "open", summary: "reveal not yet verified" },
      { status: "resolved", summary: "already handled — ignored" },
    ],
    resumeToken: fixtureToken(),
  });
  assert.ok(object.outstanding.includes("reveal not yet verified"));
  assert.ok(!object.outstanding.includes("already handled — ignored"));
});
