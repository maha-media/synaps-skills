/*
 * respond.test.js — P3-3: POST /api/events/:id/respond transitions an event to
 * incorporated with response + responded_at persisted; an illegal transition is
 * rejected with 400.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");

async function postNote(ctx, slug) {
  const r = await ctx.client.post("/api/notes", {
    plan_id: slug, section_id: "s1", type: "request_change", actor: "human", text: "please change",
  });
  assert.equal(r.status, 200);
  return r.json;
}

test("respond → incorporated, persisting response + responded_at + changed_sections", async () => {
  await withServer(async (ctx) => {
    const ev = await postNote(ctx, "plan1");
    const res = await ctx.client.post("/api/events/" + ev.id + "/respond", {
      plan_id: "plan1",
      agent_status: "incorporated",
      agent_response: "done, rewrote the section",
      changed_sections: ["s1"],
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "incorporated");
    assert.equal(res.json.agent_status, "incorporated");
    assert.equal(res.json.agent_response, "done, rewrote the section");
    assert.deepEqual(res.json.changed_sections, ["s1"]);
    assert.ok(res.json.responded_at, "responded_at timestamp persisted");

    // persisted to disk → visible on re-read
    const get = await ctx.client.get("/api/notes?plan=plan1");
    const stored = get.json.events.find((e) => e.id === ev.id);
    assert.equal(stored.status, "incorporated");
    assert.equal(stored.agent_response, "done, rewrote the section");
    assert.ok(stored.responded_at);
  });
});

test("illegal transition rejected with 400", async () => {
  await withServer(async (ctx) => {
    const ev = await postNote(ctx, "plan2");
    // first move to a terminal state
    const ok = await ctx.client.post("/api/events/" + ev.id + "/respond", {
      plan_id: "plan2", agent_status: "incorporated", agent_response: "x", changed_sections: [],
    });
    assert.equal(ok.status, 200);
    // now attempt an illegal transition out of a terminal state
    const bad = await ctx.client.post("/api/events/" + ev.id + "/respond", {
      plan_id: "plan2", agent_status: "rejected", agent_response: "nope", changed_sections: [],
    });
    assert.equal(bad.status, 400, "terminal→other must be rejected");
    assert.match(String(bad.json.error), /illegal transition/i);
  });
});
