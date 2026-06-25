/*
 * checkpoint_sse.test.js — CAC §7 producer over the live SSE bus. The
 * `checkpoint.reached` safe-point event reaches the watched plan's SSE stream,
 * both via the new POST /api/checkpoint route and the broadcastPlan producer.
 * Mirrors test/server/sse.test.js structure.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer, sleep } = require("../harness/runner.js");

function plan(slug) {
  return {
    schema: "engplan/1", kind: "plan", slug, title: "T", status: "drafting",
    convergence: "none", sections: [{ id: "s1", heading: "S1", type: "prose", md: "x" }],
  };
}

test("checkpoint.reached delivered over SSE via POST /api/checkpoint", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(plan("alpha"));
    const stream = ctx.sse("alpha");
    try {
      await sleep(120); // let the SSE connection register server-side
      const post = await ctx.client.post("/api/checkpoint", {
        slug: "alpha", phase: "O5", checkpoint: "C-O4", head_commit: "b344bf1",
      });
      assert.equal(post.status, 200);
      const ev = await stream.waitFor((e) => e && e.type === "checkpoint.reached", 3000);
      assert.equal(ev.plan, "alpha", "event carries plan slug");
      assert.equal(ev.slug, "alpha");
      assert.equal(ev.phase, "O5");
      assert.equal(ev.checkpoint, "C-O4");
      assert.equal(ev.head_commit, "b344bf1");
    } finally {
      stream.close();
    }
  });
});

test("checkpoint.reached delivered over SSE via broadcastPlan producer", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(plan("beta"));
    const stream = ctx.sse("beta");
    try {
      await sleep(120);
      const cacHooks = require("../../lib/cac/hooks.js");
      ctx.srv.broadcastPlan("beta", cacHooks.checkpointReachedEvent({
        slug: "beta", phase: "P2", checkpoint: "C1", head_commit: "deadbee",
      }));
      const ev = await stream.waitFor((e) => e && e.type === "checkpoint.reached", 3000);
      assert.equal(ev.slug, "beta");
      assert.equal(ev.phase, "P2");
      assert.equal(ev.checkpoint, "C1");
      assert.equal(ev.head_commit, "deadbee");
    } finally {
      stream.close();
    }
  });
});

test("POST /api/checkpoint rejects a body missing required fields (400)", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(plan("gamma"));
    const res = await ctx.client.post("/api/checkpoint", { slug: "gamma", phase: "P1" });
    assert.equal(res.status, 400);
  });
});
