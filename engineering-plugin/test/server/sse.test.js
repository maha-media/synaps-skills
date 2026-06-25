/*
 * sse.test.js — P2-2 / P2-4: SSE stream delivers a data event when a note is
 * appended for the watched plan; the SSE connection cap rejects excess clients.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { withServer, sleep } = require("../harness/runner.js");

function plan(slug) {
  return {
    schema: "engplan/1", kind: "plan", slug, title: "T", status: "drafting",
    convergence: "none", sections: [{ id: "s1", heading: "S1", type: "prose", md: "x" }],
  };
}

// raw GET that resolves with the status code (used for the rejected stream).
function rawStatus(base, p, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    if (token) u.searchParams.set("token", token);
    const r = http.request(u, { method: "GET" }, (res) => {
      resolve({ status: res.statusCode });
      res.resume();
      res.destroy();
    });
    r.on("error", reject);
    r.end();
  });
}

test("SSE delivers a data event when a note is appended", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(plan("alpha"));
    const stream = ctx.sse("alpha");
    try {
      await sleep(120); // let the SSE connection register server-side
      const post = await ctx.client.post("/api/notes", {
        plan_id: "alpha", section_id: "s1", type: "comment", actor: "human", text: "hi there",
      });
      assert.equal(post.status, 200);
      const ev = await stream.waitFor((e) => e && e.type === "note", 3000);
      assert.equal(ev.plan, "alpha", "event carries plan slug");
      assert.equal(ev.event.text, "hi there");
    } finally {
      stream.close();
    }
  });
});

test("SSE connection cap rejects an excess connection (503)", async () => {
  await withServer({ serverOpts: { limits: { maxSseConnections: 1 } } }, async (ctx) => {
    ctx.writePlan(plan("beta"));
    const first = ctx.sse("beta");
    try {
      await sleep(120); // first connection occupies the single slot
      const res = await rawStatus(ctx.base, "/api/stream?plan=beta", ctx.token);
      assert.equal(res.status, 503, "excess SSE connection rejected with 503");
    } finally {
      first.close();
    }
  });
});
