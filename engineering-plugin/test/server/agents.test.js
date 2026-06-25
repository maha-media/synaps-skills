/*
 * P5-1 — Agent registry (lib/registry) directly AND via withServer endpoints.
 * register/list/heartbeat/reap + parseAgent boundary rejections; POST/GET/DELETE
 * /api/agents.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Registry, parseAgent } = require("../../lib/registry/index.js");
const { withServer } = require("../harness/runner.js");

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "reg-"));
  fs.mkdirSync(path.join(d, ".plans"), { recursive: true });
  return d;
}
function rmrf(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

// ---- parseAgent boundary parsing ----
test("parseAgent rejects malformed / oversized payloads", () => {
  assert.throws(() => parseAgent(null), /agent must be object/);
  assert.throws(() => parseAgent({ role: "wizard" }), /bad role/);
  assert.throws(() => parseAgent({ depth: -1 }), /bad depth/);
  assert.throws(() => parseAgent({ depth: 65 }), /bad depth/);
  assert.throws(() => parseAgent({ depth: "deep" }), /bad depth/);
  assert.throws(() => parseAgent({ status: "zombie" }), /bad status/);
  const huge = "x".repeat(513);
  assert.throws(() => parseAgent({ model: huge }), /field too long/);
});

test("parseAgent accepts a well-formed agent with defaults", () => {
  const a = parseAgent({ role: "impl", pane: "s:0.1", model: "claude-opus-4-8" });
  assert.equal(a.role, "impl");
  assert.equal(a.pane, "s:0.1");
  assert.equal(a.depth, 0);
  assert.equal(a.status, "spawning");
  assert.equal(a.model, "claude-opus-4-8");
});

// ---- Registry CRUD + heartbeat + reap ----
test("register -> list includes agent with declared fields", () => {
  const repo = tmpRepo();
  try {
    const reg = new Registry(repo, { clock: { now: () => "2026-01-01T00:00:00.000Z" } });
    const agent = reg.register({
      role: "impl", pane: "s:0.1", depth: 1,
      model: "claude-opus-4-8", worktree: "/wt/feature",
    });
    assert.ok(agent.id, "id assigned");
    const list = reg.list();
    assert.equal(list.length, 1);
    const a = list[0];
    assert.equal(a.id, agent.id);
    assert.equal(a.pane, "s:0.1");
    assert.equal(a.role, "impl");
    assert.equal(a.depth, 1);
    assert.equal(a.model, "claude-opus-4-8");
    assert.equal(a.worktree, "/wt/feature");
    assert.equal(a.last_heartbeat, "2026-01-01T00:00:00.000Z");
  } finally { rmrf(repo); }
});

test("heartbeat updates last_heartbeat", () => {
  const repo = tmpRepo();
  try {
    let t = 0;
    const times = ["2026-01-01T00:00:00.000Z", "2026-01-01T00:05:00.000Z"];
    const reg = new Registry(repo, { clock: { now: () => times[t++] } });
    const agent = reg.register({ role: "impl" });
    assert.equal(reg.list()[0].last_heartbeat, "2026-01-01T00:00:00.000Z");
    reg.heartbeat(agent.id, { status: "working" });
    const a = reg.list()[0];
    assert.equal(a.last_heartbeat, "2026-01-01T00:05:00.000Z");
    assert.equal(a.status, "working");
  } finally { rmrf(repo); }
});

test("reap marks agents dead after heartbeat timeout (clock/nowMs)", () => {
  const repo = tmpRepo();
  try {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const reg = new Registry(repo, {
      clock: { now: () => "2026-01-01T00:00:00.000Z" },
      limits: { heartbeatTimeoutMs: 30000 },
    });
    const agent = reg.register({ role: "impl" });

    // within timeout: not reaped
    let dead = reg.reap(base + 1000);
    assert.equal(dead.length, 0);
    assert.equal(reg.list()[0].status, "spawning");

    // beyond timeout: marked dead
    dead = reg.reap(base + 40000);
    assert.equal(dead.length, 1);
    assert.equal(dead[0].id, agent.id);
    assert.equal(reg.list()[0].status, "dead");
  } finally { rmrf(repo); }
});

test("register enforces agent cap", () => {
  const repo = tmpRepo();
  try {
    const reg = new Registry(repo, {
      clock: { now: () => "2026-01-01T00:00:00.000Z" },
      limits: { maxAgents: 1 },
    });
    reg.register({ role: "impl" });
    assert.throws(() => reg.register({ role: "sub" }), /cap exceeded/);
  } finally { rmrf(repo); }
});

// ---- HTTP endpoints ----
test("POST registers, GET lists, DELETE removes via /api/agents", async () => {
  await withServer(async (ctx) => {
    const reg = await ctx.client.post("/api/agents", {
      role: "impl", pane: "s:0.1", model: "claude-opus-4-8",
    });
    assert.equal(reg.status, 200);
    const id = reg.json.id;
    assert.ok(id);

    const list = await ctx.client.get("/api/agents");
    assert.equal(list.status, 200);
    assert.ok(list.json.some((a) => a.id === id));

    const del = await ctx.client.del(`/api/agents/${id}`);
    assert.equal(del.status, 200);

    const after = await ctx.client.get("/api/agents");
    assert.equal(after.json.some((a) => a.id === id), false);
  });
});

test("POST /api/agents rejects malformed payload (bad role)", async () => {
  await withServer(async (ctx) => {
    const bad = await ctx.client.post("/api/agents", { role: "wizard" });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /bad role/);
  });
});
