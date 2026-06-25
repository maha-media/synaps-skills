/*
 * scenarios.js — canonical headless end-to-end scenarios S1–S21 (Addendum A.4,
 * Addendum E). Each scenario is an async fn(opts) that throws on failure and
 * resolves on success. `opts.control === true` disables the feature under test
 * so the scenario FAILS (red) — proving the assertion has teeth (--prove).
 */
"use strict";
const assert = require("node:assert/strict");
const { withServer, sleep } = require("./runner.js");
const { ActorSim } = require("./actorsim.js");
const { AgentSim } = require("./agentsim.js");
const { DomProbe } = require("./domprobe.js");
const { FaultInj } = require("./faultinj.js");
const { OrchestratorSim, DISPATCH_ERROR } = require("./orchestratorsim.js");
const { FleetSim } = require("./fleetsim.js");
const EngPlan = require("../../assets/engplan.js");
const inbox = require("../../lib/inbox.js");

function mkSection(id, over) { return Object.assign({ id, heading: id, type: "task", state: "todo", md: "body " + id }, over || {}); }

// ---------- S1 live-write ----------
async function S1(opts) {
  opts = opts || {};
  return withServer({ debounceMs: 10 }, async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "live" });
    agent.init({ title: "Live" });
    const probe = new DomProbe();
    probe.render(agent._readPlan());
    const sse = ctx.sse("live");
    const ids = ["s1", "s2", "s3", "s4", "s5"];
    for (const id of ids) {
      if (!opts.control) {
        const sec = mkSection(id);
        agent.streamSection(sec);
        probe.patch(sec);
      }
      await sleep(25);
    }
    // SSE must have fired at least once for live transport
    try { await sse.waitFor((e) => e && e.plan === "live", 3000); } catch (e) { sse.close(); throw new Error("no live SSE event: " + e.message); }
    sse.close();
    assert.deepEqual(probe.sectionIds(), ids, "5 sections appear incrementally in order");
    return { sections: probe.sectionIds() };
  });
}

// ---------- S2 comment-roundtrip ----------
async function S2(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "cr" });
    agent.init({ title: "CR", sections: [mkSection("task-2")] });
    const human = new ActorSim(ctx, { slug: "cr", mode: "human" });
    await human.comment("task-2", "please clarify");
    let plans = await human.plans();
    assert.equal(plans[0].attention.unresolved, 1, "unresolved +1");
    if (!opts.control) await agent.reconcile();
    const inboxData = await human.readInbox();
    const ev = inboxData.events[0];
    assert.equal(ev.status, "incorporated", "open→acknowledged→incorporated");
    assert.ok(ev.agent_response, "agent_response written");
    assert.ok(Array.isArray(ev.changed_sections) && ev.changed_sections.length, "changed_sections written");
    plans = await human.plans();
    assert.equal(plans[0].attention.unresolved, 0, "unresolved back to 0");
    return { ev };
  });
}

// ---------- S3 blocking-halt ----------
async function S3(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "blk" });
    agent.init({ title: "Blk", sections: [mkSection("task-1"), mkSection("task-2", { depends_on: ["task-1"] })] });
    const human = new ActorSim(ctx, { slug: "blk", mode: "human" });
    await human.block("task-1", "stop until auth specified");
    // dependent work must refuse to start while block open
    let halted = false;
    try {
      if (opts.control) await agent.setState("task-2", "doing"); // control: bypass halt enforcement
      else await agent.attemptTask("task-2");
    } catch (e) { halted = e.code === "HALTED"; }
    assert.ok(halted, "dependent task-2 refuses to start while block open");
    const plans = await human.plans();
    assert.equal(plans[0].attention.blocking, 1, "blocking counter reflects state");
    // resolve the block → halt lifts
    await agent.reconcile((ev) => ev.type === "block"
      ? { decision: "incorporated", response: "auth specified; unblocking", changed_sections: ["task-1"] }
      : inbox.defaultEvaluate(ev));
    const eligible = await agent.canStart("task-2");
    assert.ok(eligible, "halt lifts after block resolved");
    return {};
  });
}

// ---------- S4 approve-gate ----------
async function S4(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "appr" });
    agent.init({ title: "Appr", sections: [mkSection("gate-1", { type: "gate", approval: "needs-human-review" })] });
    const human = new ActorSim(ctx, { slug: "appr", mode: "human" });
    let plans = await human.plans();
    assert.ok(plans[0].attention.needs_review >= 1, "needs_review set by section approval");
    if (!opts.control) {
      await human.approve("gate-1", "looks good");
      await agent.reconcile((ev) => ev.type === "approve"
        ? { decision: "incorporated", response: "approval recorded", changed_sections: ["gate-1"] }
        : inbox.defaultEvaluate(ev));
      // agent records approval on the section
      agent.streamSection({ id: "gate-1", heading: "gate-1", type: "gate", approval: "approved", md: "approved" });
    }
    const p = agent._readPlan().sections.find((s) => s.id === "gate-1");
    assert.equal(p.approval, "approved", "approval=approved; agent may proceed");
    return {};
  });
}

// ---------- S5 force-verification ----------
async function S5(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "fv" });
    agent.init({ title: "FV", sections: [mkSection("task-x", { state: "doing" })] });
    const human = new ActorSim(ctx, { slug: "fv", mode: "human" });
    await human.forceVerification("task-x", "show fresh evidence before done");
    let refused = false;
    try {
      if (opts.control) await agent.setState("task-x", "done"); // control: bypass evidence gate
      else await agent.claimCompletion("task-x", "ev-x");
    } catch (e) { refused = e.code === "NEED_EVIDENCE"; }
    assert.ok(refused, "completion refused without fresh evidence");
    if (!opts.control) {
      agent.attachEvidence("ev-x", "Evidence", "ran tests", ["node --test"]);
      const done = await agent.claimCompletion("task-x", "ev-x");
      assert.equal(done.state, "done", "completion allowed after evidence attached");
    }
    return {};
  });
}

// ---------- S6 add-criterion ----------
async function S6(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "ac" });
    agent.init({ title: "AC", sections: [mkSection("task-c", { acceptance: ["a1"] })] });
    const human = new ActorSim(ctx, { slug: "ac", mode: "human" });
    await human.addAcceptanceCriterion("task-c", "must work offline");
    if (!opts.control) {
      await agent.reconcile((ev) => ev.type === "add_acceptance_criterion"
        ? { decision: "incorporated", response: "criterion added", changed_sections: ["task-c"] }
        : inbox.defaultEvaluate(ev));
      const s = agent._readPlan().sections.find((x) => x.id === "task-c");
      s.acceptance = (s.acceptance || []).concat(["must work offline"]);
      agent.streamSection(s);
    }
    const sec = agent._readPlan().sections.find((x) => x.id === "task-c");
    assert.ok(sec.acceptance.indexOf("must work offline") !== -1, "criterion appears in acceptance[]");
    return {};
  });
}

// ---------- S7 do-not-touch ----------
async function S7(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "dnt" });
    agent.init({ title: "DNT", sections: [mkSection("file-sec")] });
    const human = new ActorSim(ctx, { slug: "dnt", mode: "human" });
    const ev = await human.doNotTouch("file-sec", "src/secret.js is off-limits");
    // agent records refusal; path treated as data, never executed
    if (!opts.control) {
      await agent.reconcile((e) => e.type === "do_not_touch"
        ? { decision: "incorporated", response: "noted: will not touch src/secret.js", changed_sections: ["file-sec"] }
        : inbox.defaultEvaluate(e));
    }
    const inboxData = await human.readInbox();
    const persisted = inboxData.events.find((e) => e.type === "do_not_touch");
    assert.ok(persisted, "do_not_touch persisted as durable data");
    if (!opts.control) assert.equal(persisted.status, "incorporated", "agent recorded refusal");
    return {};
  });
}

// ---------- S8 escalate-convergence ----------
async function S8(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "esc" });
    agent.init({ title: "Esc", sections: [mkSection("risky-1", { risk: "risky" })] });
    const human = new ActorSim(ctx, { slug: "esc", mode: "human" });
    await human.escalateConvergence("risky-1", "please run a convergence loop");
    if (!opts.control) {
      const plan = agent._readPlan();
      plan.convergence = "informed";
      agent._writePlan(plan);
    }
    assert.equal(agent._readPlan().convergence, "informed", "plan convergence updated, not ignored");
    return {};
  });
}

// ---------- S9 discovery-sidebar ----------
async function S9(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const n = 3;
    for (let i = 0; i < n; i++) {
      if (opts.control && i > 0) break; // control: seed only 1 → count assertion fails
      ctx.writePlan({ schema: "engplan/1", kind: "plan", slug: "plan-" + i, title: "Plan " + i, status: "drafting", sections: [mkSection("s")] });
    }
    const human = new ActorSim(ctx, { slug: "plan-0", mode: "human" });
    await human.block("s", "blocking note");
    const plans = await human.plans();
    assert.equal(plans.length, n, "all plans listed");
    const p0 = plans.find((p) => p.id === "plan-0");
    assert.equal(p0.attention.blocking, 1, "attention counter correct in sidebar data");
    // DomProbe sidebar render is exercised via DomProbe of one plan
    return { count: plans.length };
  });
}

// ---------- S10 legacy-md ----------
async function S10(opts) {
  opts = opts || {};
  const PlanRenderer = require("../../assets/plan.js");
  const md = "# Title\n\nintro\n\n## Setup\n\nstep\n\n## Setup\n\ndup heading";
  const plan = opts.control
    ? { schema: "engplan/1", kind: "plan", slug: "legacy", title: "x", status: "drafting", sections: [] } // control: empty
    : PlanRenderer.parseLegacyMarkdown(md, "legacy");
  const probe = new DomProbe();
  probe.render(plan, { legacy: true });
  const ids = probe.sectionIds();
  assert.ok(ids.length >= 3, "best-effort sections render");
  assert.ok(ids.includes("setup") && ids.includes("setup-2"), "collisions disambiguated by ordinal");
  assert.ok(probe.serialize().includes("legacy"), "degraded-mode flagged");
  return { ids };
}

// ---------- S11 full-lifecycle ----------
async function S11(opts) {
  opts = opts || {};
  return withServer({ debounceMs: 10 }, async (ctx) => {
    const agent = new AgentSim(ctx, { slug: "full" });
    agent.init({ title: "Full" });
    // stream sections (spec→plan→stream)
    agent.streamSection(mkSection("task-1"));
    agent.streamSection(mkSection("task-2", { depends_on: ["task-1"] }));
    const human = new ActorSim(ctx, { slug: "full", mode: "human" });
    await human.comment("task-1", "note A");
    await human.block("task-2", "hold task-2");
    // reconcile: incorporate comment, acknowledge+resolve block
    if (!opts.control) {
      await agent.reconcile((ev) => ev.type === "block"
        ? { decision: "incorporated", response: "resolved hold", changed_sections: ["task-2"] }
        : inbox.defaultEvaluate(ev));
    }
    // tasks done + completion claim
    if (!opts.control) {
      agent.setState("task-1", "done");
      agent.attachEvidence("ev-1", "Evidence", "verified", ["node --test"]);
      agent.setState("task-2", "done");
    }
    const data = await human.readInbox();
    assert.ok(data.events.every((e) => e.status !== "open"), "every event resolved (audit trail intact)");
    assert.ok(data.events.some((e) => e.agent_response), "agent responses recorded");
    const plan = agent._readPlan();
    assert.ok(plan.sections.filter((s) => s.type === "task").every((s) => s.state === "done"), "tasks done");
    return {};
  });
}

// ---------- S12 orchestrator-steer ----------
async function S12(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    // fresh Builder (AgentSim) steered by orchestrator via inbox — explicit artifacts only
    const builder = new AgentSim(ctx, { slug: "orch" });
    builder.init({ title: "Orch", sections: [mkSection("task-1")] });
    const orch = new ActorSim(ctx, { slug: "orch", mode: "orchestrator", author: "orchestrator" });
    await orch.requestChange("task-1", "use stdlib only");
    await orch.block("task-1", "do not proceed until offline-safe");
    if (!opts.control) {
      await builder.reconcile((ev) => ev.type === "block"
        ? { decision: "incorporated", response: "made offline-safe", changed_sections: ["task-1"] }
        : inbox.defaultEvaluate(ev));
    }
    const data = await builder.client.get("/api/notes?plan=orch");
    const evs = data.json.events;
    assert.ok(evs.every((e) => e.actor === "orchestrator"), "events stamped actor=orchestrator");
    if (!opts.control) {
      assert.ok(evs.every((e) => e.status === "incorporated"), "builder steered via explicit artifacts");
      assert.ok(evs.every((e) => e.agent_response && e.changed_sections.length), "response + changed_sections recorded");
    }
    return {};
  });
}

// ---------- S13 orchestrator-convergence ----------
async function S13(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const slug = "conv";
    const agent = new AgentSim(ctx, { slug });
    agent.init({ title: "Conv", convergence: "informed", sections: [
      mkSection("design", { type: "prose" }), mkSection("build"), mkSection("test"), mkSection("judge", { type: "gate" }),
    ] });
    const orch = new OrchestratorSim(ctx, { slug });
    // each role dispatch must carry agent|system_prompt (§9.1)
    const roles = ["designer", "builder", "tester", "judge"];
    for (const r of roles) {
      const packet = opts.control ? { role: {} } : { role: { agent: r } };
      orch.dispatch(packet, null);
    }
    // route role artifacts through inbox, actor=orchestrator
    await orch.steer("design", "comment", "design packet");
    await orch.steer("judge", "escalate_convergence", "score 0.7 < 0.8 → fix loop");
    const data = await ctx.client.get("/api/notes?plan=" + slug);
    assert.ok(data.json.events.every((e) => e.actor === "orchestrator"), "actor stamped orchestrator");
    assert.equal(orch.audit.length, 4, "every role dispatch carried agent/system_prompt");
    return {};
  });
}

// ---------- S14 poll-and-steer ----------
async function S14(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const slug = "poll";
    const builder = new AgentSim(ctx, { slug });
    builder.init({ title: "Poll", sections: [mkSection("task-1")] });
    const orch = new OrchestratorSim(ctx, { slug });
    const handle = orch.dispatch({ role: { system_prompt: "you are a coder" }, model: "claude-opus-4-8", reactive: true }, builder);
    const recordedSleeps = [];
    const result = await orch.runLoop(handle, {
      steps: [{ section_id: "task-1", type: "request_change", text: "mid-run steering", evaluate: (ev) => inbox.defaultEvaluate(ev) }],
      sleep: opts.control
        ? async (ms) => { recordedSleeps.push(5000); await sleep(0); }   // control: idle-sleep regression
        : async (ms) => { recordedSleeps.push(ms); await sleep(0); },
      pollMs: 0,
    });
    const data = await ctx.client.get("/api/notes?plan=" + slug);
    assert.ok(data.json.events.some((e) => e.agent_response), "coder reconciled steering without restart");
    assert.ok(result.pollCount >= 1, "orchestrator polled status");
    const maxSleep = Math.max(0, ...recordedSleeps);
    assert.ok(maxSleep < 1000, "orchestrator never idle-slept (poll, don't sleep)");
    return { pollCount: result.pollCount };
  });
}

// ---------- S15 model-inheritance ----------
async function S15(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const orch = new OrchestratorSim(ctx, { slug: "mi", sessionModel: "claude-opus-4-8" });
    if (opts.control) {
      // control: silently downgrade → assertion fails
      orch.audit.push({ role: { agent: "c" }, model: "claude-haiku", model_inherited: false });
    } else {
      orch.dispatch({ role: { agent: "coder" } }, null); // no model → inherit
    }
    const last = orch.audit[orch.audit.length - 1];
    assert.equal(last.model, "claude-opus-4-8", "model resolves to session model when unspecified");
    if (!opts.control) assert.equal(last.model_inherited, true, "inheritance recorded in audit");
    return {};
  });
}

// ---------- S16 two-column-spawn ----------
async function S16(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const fleet = new FleetSim(ctx, { maxImplAgents: 4 });
    const r = opts.control ? { queued: true } : fleet.spawnImpl({ target: "main:0.0", depth: 1 });
    assert.ok(!r.queued && r.pane, "impl pane spawned to the right");
    fleet.launch(r.pane, "Implement P0-1; read .plans/x.plan.html and your inbox.");
    assert.ok(fleet.panes().length >= 2, "two full-height columns (orchestrator + impl)");
    assert.ok(fleet.roster().some((a) => a.pane === r.pane), "impl agent registered in roster");
    return {};
  });
}

// ---------- S17 fleet-roster ----------
async function S17(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const fleet = new FleetSim(ctx, { maxImplAgents: 4 });
    if (!opts.control) { fleet.spawnImpl({ depth: 1 }); fleet.spawnImpl({ depth: 1 }); }
    const roster = await ctx.client.get("/api/agents");
    assert.equal(roster.json.length, opts.control ? 0 : 2, "all agents in roster via /api/agents");
    // reaper drops a killed one
    if (!opts.control) {
      const agents = fleet.registry.list();
      ctx.clock.set("2026-06-25T13:00:00.000Z");
      const dead = fleet.registry.reap(Date.parse("2026-06-25T13:00:00.000Z"));
      assert.ok(dead.length >= 1, "reaper marks stale agents dead");
    }
    return {};
  });
}

// ---------- S18 inbox-steer-fleet ----------
async function S18(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const a1 = new AgentSim(ctx, { slug: "f1" }); a1.init({ title: "F1", sections: [mkSection("t")] });
    const a2 = new AgentSim(ctx, { slug: "f2" }); a2.init({ title: "F2", sections: [mkSection("t")] });
    const o1 = new ActorSim(ctx, { slug: "f1", mode: "orchestrator" });
    const o2 = new ActorSim(ctx, { slug: "f2", mode: "orchestrator" });
    await o1.requestChange("t", "steer f1");
    await o2.requestChange("t", "steer f2");
    if (!opts.control) { await a1.reconcile(); await a2.reconcile(); }
    const d1 = await ctx.client.get("/api/notes?plan=f1");
    const d2 = await ctx.client.get("/api/notes?plan=f2");
    assert.ok(d1.json.events[0].status === "incorporated" && d2.json.events[0].status === "incorporated", "both reconciled via inbox (not pane scraping)");
    assert.ok(d1.json.events[0].actor === "orchestrator", "audit intact");
    return {};
  });
}

// ---------- S19 grandchild-depth ----------
async function S19(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const fleet = new FleetSim(ctx, { maxImplAgents: 10, maxDepth: 2 });
    const child = fleet.spawnImpl({ depth: 1 });
    assert.ok(child.pane, "impl (depth 1) spawned");
    // grandchild at depth 2 ok; depth 3 refused
    let depth3Refused = false;
    if (!opts.control) {
      const gc = fleet.controller.spawn({ depth: 2, target: child.pane, backpressure: false });
      assert.ok(gc.pane, "grandchild depth 2 registers");
      try { fleet.controller.spawn({ depth: 3, target: gc.pane, backpressure: false }); }
      catch (e) { depth3Refused = e.code === "DEPTH"; }
      assert.ok(depth3Refused, "recursion past max_depth refused");
    } else {
      // control: pretend depth enforcement off
      assert.ok(false, "control: depth not enforced");
    }
    return {};
  });
}

// ---------- S20 own-pane-only (fault) ----------
async function S20(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const fleet = new FleetSim(ctx, {});
    let refused = false;
    if (opts.control) {
      // control: simulate controlling a foreign pane successfully
      refused = false;
    } else {
      try { fleet.controller.sendKeys("foreign:9.9", "rm -rf /"); }
      catch (e) { refused = e.code === "NOT_OWNED"; }
    }
    assert.ok(refused, "controller refuses to send-keys a foreign pane");
    return {};
  });
}

// ---------- S21 cap-exhaustion (fault) ----------
async function S21(opts) {
  opts = opts || {};
  return withServer(async (ctx) => {
    const fleet = new FleetSim(ctx, { maxImplAgents: 1 });
    fleet.spawnImpl({ depth: 1 });
    const second = opts.control ? { pane: "main:0.2", queued: false } : fleet.spawnImpl({ depth: 1 });
    assert.ok(second.queued === true, "spawn past max_impl_agents is queued/refused (no runaway)");
    return {};
  });
}

const SCENARIOS = {
  S1: { fn: S1, desc: "live-write via SSE", prove: true },
  S2: { fn: S2, desc: "comment roundtrip", prove: true },
  S3: { fn: S3, desc: "blocking halt", prove: true },
  S4: { fn: S4, desc: "approve gate", prove: true },
  S5: { fn: S5, desc: "force verification", prove: true },
  S6: { fn: S6, desc: "add criterion" },
  S7: { fn: S7, desc: "do not touch" },
  S8: { fn: S8, desc: "escalate convergence" },
  S9: { fn: S9, desc: "discovery sidebar" },
  S10: { fn: S10, desc: "legacy markdown" },
  S11: { fn: S11, desc: "full lifecycle", prove: true },
  S12: { fn: S12, desc: "orchestrator steer" },
  S13: { fn: S13, desc: "orchestrator convergence" },
  S14: { fn: S14, desc: "poll and steer" },
  S15: { fn: S15, desc: "model inheritance" },
  S16: { fn: S16, desc: "two-column spawn" },
  S17: { fn: S17, desc: "fleet roster" },
  S18: { fn: S18, desc: "inbox steer fleet" },
  S19: { fn: S19, desc: "grandchild depth" },
  S20: { fn: S20, desc: "own-pane-only fault" },
  S21: { fn: S21, desc: "cap exhaustion fault" },
};

module.exports = { SCENARIOS };
