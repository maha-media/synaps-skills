/*
 * spec_plan_collision.test.js — regression: a spec and a plan sharing one slug
 * (the documented spec+plan pair from spec-driven-development) must get
 * DISTINCT ids in discovery, resolve to DISTINCT documents, and receive
 * file-change broadcasts on their own SSE channels.
 *
 * Bug: discovery keyed both artifacts by bare slug → two sidebar rows with the
 * same id, both resolving (first-match-wins) to the same file.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");

function artifact(slug, kind, title) {
  return {
    schema: "engplan/1", kind, slug, title, status: "drafting",
    convergence: "none", created_at: null, updated_at: null,
    sections: [{ id: "s1", heading: "First", type: "prose", md: kind + " body" }],
  };
}

test("spec+plan sharing a slug get distinct discovery ids", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(artifact("gamma", "plan", "Gamma Plan"));
    ctx.writePlan(artifact("gamma", "spec", "Gamma Spec"));

    const res = await ctx.client.get("/api/plans");
    assert.equal(res.status, 200);
    assert.equal(res.json.length, 2, "both artifacts discovered");
    const ids = res.json.map((e) => e.id).sort();
    assert.deepEqual(ids, ["gamma", "gamma.spec"],
      "plan keeps bare slug; spec is kind-qualified");
    const byId = Object.fromEntries(res.json.map((e) => [e.id, e]));
    assert.equal(byId["gamma"].kind, "plan");
    assert.equal(byId["gamma.spec"].kind, "spec");
  });
});

test("kind-qualified ids resolve to distinct documents", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(artifact("gamma", "plan", "Gamma Plan"));
    ctx.writePlan(artifact("gamma", "spec", "Gamma Spec"));

    const planDoc = await ctx.client.get("/api/plan/gamma");
    assert.equal(planDoc.status, 200);
    assert.equal(planDoc.json.kind, "plan");
    assert.equal(planDoc.json.title, "Gamma Plan");

    const specDoc = await ctx.client.get("/api/plan/gamma.spec");
    assert.equal(specDoc.status, 200);
    assert.equal(specDoc.json.kind, "spec");
    assert.equal(specDoc.json.title, "Gamma Spec");

    // /plan/:id standalone file route (non-HTML accept) — distinct too
    const planFile = await ctx.client.get("/plan/gamma");
    const specFile = await ctx.client.get("/plan/gamma.spec");
    assert.equal(planFile.status, 200);
    assert.equal(specFile.status, 200);
    assert.ok(planFile.text.includes("Gamma Plan"));
    assert.ok(specFile.text.includes("Gamma Spec"));
    assert.notEqual(planFile.text, specFile.text);
  });
});

test("single-artifact repos keep bare-slug ids (backward compat)", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan(artifact("solo", "plan", "Solo Plan"));
    ctx.writePlan(artifact("lonespec", "spec", "Lone Spec"));

    const res = await ctx.client.get("/api/plans");
    const ids = res.json.map((e) => e.id).sort();
    assert.deepEqual(ids, ["lonespec.spec", "solo"]);

    // a lone plan resolves by bare slug exactly as before
    const doc = await ctx.client.get("/api/plan/solo");
    assert.equal(doc.status, 200);
    assert.equal(doc.json.kind, "plan");
    // a lone spec resolves by its qualified id
    const spec = await ctx.client.get("/api/plan/lonespec.spec");
    assert.equal(spec.status, 200);
    assert.equal(spec.json.kind, "spec");
  });
});

test("spec file changes broadcast on the kind-qualified SSE channel", async () => {
  await withServer({ debounceMs: 10 }, async (ctx) => {
    ctx.writePlan(artifact("gamma", "plan", "Gamma Plan"));
    ctx.writePlan(artifact("gamma", "spec", "Gamma Spec"));

    const sse = ctx.sse("gamma.spec");
    await new Promise((r) => setTimeout(r, 100)); // let the stream attach

    // rewrite the spec → watcher should broadcast on channel "gamma.spec"
    ctx.writePlan(artifact("gamma", "spec", "Gamma Spec v2"));

    const hit = await sse.waitFor(
      (e) => e && e.plan === "gamma.spec" && e.type === "filechange", 3000
    ).catch(() => null);
    sse.close();
    assert.ok(hit, "expected a filechange event on the gamma.spec channel, got: " + JSON.stringify(sse.events));
  });
});
