/*
 * notes.test.js — P3-1: POST /api/notes appends a well-formed event (id +
 * created_at); GET /api/notes?plan=<id> returns it; oversized body → 413;
 * per-plan event cap enforced.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { withServer } = require("../harness/runner.js");

test("POST appends event with id+created_at; GET returns it", async () => {
  await withServer(async (ctx) => {
    const post = await ctx.client.post("/api/notes", {
      plan_id: "myplan", section_id: "s1", type: "comment", actor: "human", text: "first note",
    });
    assert.equal(post.status, 200);
    assert.ok(post.json.id, "appended event has an id");
    assert.ok(post.json.created_at, "appended event has created_at");
    assert.equal(post.json.text, "first note");
    assert.equal(post.json.status, "open");

    const get = await ctx.client.get("/api/notes?plan=myplan");
    assert.equal(get.status, 200);
    assert.ok(Array.isArray(get.json.events));
    assert.equal(get.json.events.length, 1);
    assert.equal(get.json.events[0].id, post.json.id);
  });
});

test("oversized POST body rejected with 413", async () => {
  await withServer(async (ctx) => {
    // default maxBodyBytes is 256 KiB; send well over it.
    const huge = "x".repeat(300 * 1024);
    const body = JSON.stringify({ plan_id: "myplan", section_id: "s1", type: "comment", actor: "human", text: huge });
    const status = await new Promise((resolve, reject) => {
      const u = new URL("/api/notes", ctx.base);
      u.searchParams.set("token", ctx.token);
      const r = http.request(u, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on("error", reject);
      r.write(body);
      r.end();
    });
    assert.equal(status, 413, "oversized body must be rejected with 413");
  });
});

test("per-plan event cap enforced", async () => {
  await withServer({ serverOpts: { limits: { maxEventsPerPlan: 2 } } }, async (ctx) => {
    const mk = (n) => ctx.client.post("/api/notes", {
      plan_id: "capped", section_id: "s1", type: "comment", actor: "human", text: "n" + n,
    });
    assert.equal((await mk(1)).status, 200);
    assert.equal((await mk(2)).status, 200);
    const third = await mk(3);
    assert.equal(third.status, 413, "event past cap rejected with 413");
    assert.match(String(third.json.error), /cap/i);
  });
});
