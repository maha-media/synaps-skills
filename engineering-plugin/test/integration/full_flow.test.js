/*
 * P4-6 — End-to-end integration (withServer).
 * writePlan(task-1, task-2 depends_on task-1) -> POST block on task-1 ->
 * /api/plans attention.blocking==1 -> POST /api/reconcile -> block handled ->
 * POST /api/events/:id/respond incorporated -> final event incorporated with
 * agent_response. Asserts no crash and events persisted on disk.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withServer } = require("../harness/runner.js");

const PLAN = {
  schema: "engplan/1",
  kind: "plan",
  slug: "flow",
  title: "Full flow plan",
  status: "in_progress",
  sections: [
    { id: "task-1", heading: "Task 1", type: "task" },
    { id: "task-2", heading: "Task 2", type: "task", depends_on: ["task-1"] },
  ],
};

test("full block -> reconcile -> respond flow end-to-end", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(PLAN);

    // 1. human posts a block on task-1
    const posted = await ctx.client.post("/api/notes", {
      plan_id: "flow", section_id: "task-1", type: "block",
      actor: "human", text: "halt task-1",
    });
    assert.equal(posted.status, 200);
    const eventId = posted.json.id;
    assert.ok(eventId, "event id assigned");
    assert.equal(posted.json.status, "open");

    // 2. /api/plans surfaces attention.blocking == 1
    const plans = await ctx.client.get("/api/plans");
    assert.equal(plans.status, 200);
    const entry = plans.json.find((p) => p.id === "flow");
    assert.ok(entry, "plan discovered");
    assert.equal(entry.attention.blocking, 1);

    // 3. trigger reconcile
    const rec = await ctx.client.post("/api/reconcile?plan=flow", {});
    assert.equal(rec.status, 200);
    assert.ok(Array.isArray(rec.json.events));
    assert.ok(rec.json.halted.includes("task-1"), "task-1 halted");
    assert.ok(rec.json.halted.includes("task-2"), "dependent task-2 halted");

    // 4. read notes — the block event has been handled (no longer open)
    const notes = await ctx.client.get("/api/notes?plan=flow");
    assert.equal(notes.status, 200);
    const handled = notes.json.events.find((e) => e.id === eventId);
    assert.ok(handled, "block event still present");
    assert.notEqual(handled.status, "open", "block acknowledged/handled");
    assert.equal(handled.agent_status, "blocked");
    assert.ok(handled.responded_at, "responded_at stamped");

    // 5. simulate resolution: respond incorporated + changed_sections
    const resp = await ctx.client.post(`/api/events/${eventId}/respond`, {
      plan_id: "flow",
      agent_status: "incorporated",
      agent_response: "Fixed the blocker on task-1.",
      changed_sections: ["task-1"],
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.json.status, "incorporated");
    assert.equal(resp.json.agent_status, "incorporated");
    assert.equal(resp.json.agent_response, "Fixed the blocker on task-1.");
    assert.deepEqual(resp.json.changed_sections, ["task-1"]);

    // 6. audit: events persisted on disk
    const file = path.join(ctx.repoRoot, ".plans", "flow.events.json");
    assert.ok(fs.existsSync(file), "events file persisted");
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
    const persisted = onDisk.find((e) => e.id === eventId);
    assert.ok(persisted, "event persisted to disk");
    assert.equal(persisted.status, "incorporated");
    assert.equal(persisted.agent_response, "Fixed the blocker on task-1.");

    // 7. after resolution, attention.blocking drops to 0
    const plans2 = await ctx.client.get("/api/plans");
    const entry2 = plans2.json.find((p) => p.id === "flow");
    assert.equal(entry2.attention.blocking, 0);
  });
});
