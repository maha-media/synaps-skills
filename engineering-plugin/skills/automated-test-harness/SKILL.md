---
name: automated-test-harness
description: Use when proving behavior with an external test harness or oracle — ActorSim, AgentSim, DomProbe, FaultInj — instead of letting the coder assert its own success. Covers the harness mandate, the four zero-dep harness patterns, and adversarial separation.
---

# Automated Test Harness

*Where this fits: the **verify** stage of plan → implement → verify → review — the machinery that turns "I think it works" into externally-proven behavior.*

Behavior is proven by a harness that exercises the real system, not by the coder
re-asserting its own intentions. The harness is the instrument; the oracle is
the judge.

## The harness mandate (the henhouse rule)

**A builder cannot grade its own homework.** Tests written by the same lineage
that wrote the code prove only internal consistency — that the code does what its
author *thinks* it does — never external correctness. The henhouse cannot be
guarded by the fox.

- Behavior is established by an **external harness/oracle** that drives the real
  system through its real interfaces (HTTP, stdio RPC, rendered DOM) and asserts
  on observable outputs.
- The coder's own unit tests are still useful as regression coverage and as a
  statement of intent — but they are **evidence, not proof**. Correctness is
  gated on the harness/oracle verdict.
- See **code-review** (the reviewer consumes the `oracle/1` verdict, not the
  coder's green checkmark) and **verification-before-completion** (evidence
  before any success claim).

## The four harness patterns

All four are vanilla Node stdlib — **zero dependencies, no jsdom, no network
install**. Reference implementations live under `test/harness/`.

### 1. ActorSim — script a real actor's sequence against the system

**When:** you need to prove the system responds correctly to a realistic
sequence of user/operator/orchestrator actions over its real API. Reference:
`test/harness/actorsim.js` (emits all 14 Plan Inbox actions over HTTP, stamping
the correct `actor`).

```js
class ActorSim {
  constructor(ctx, opts) { this.client = ctx.client; this.slug = opts.slug; this.mode = opts.mode; }
  get actor() { return this.mode; } // "human" | "orchestrator"
  async act(type, sectionId, text) {
    const res = await this.client.post("/api/notes", {
      plan_id: this.slug, section_id: sectionId, type, actor: this.actor, text: text || "",
    });
    if (res.status !== 200) throw new Error(`act ${type} failed: ${res.status}`);
    return res.json;
  }
}
// usage: await new ActorSim(ctx, { slug, mode: "human" }).act("request_change", "s1", "fix X");
```

### 2. AgentSim — simulate an agent/orchestrator driving the system

**When:** you need a deterministic stand-in for the agent that *writes* the work
— live-streaming plan sections, running the **Plan Inbox** reconcile loop,
writing agent responses, flipping task states. Reference:
`test/harness/agentsim.js`.

```js
class AgentSim {
  constructor(ctx, opts) { this.client = ctx.client; this.repoRoot = ctx.repoRoot; this.slug = opts.slug; }
  async respond(eventId, sectionId, text) {            // agent answers an inbox event
    return this.client.post("/api/respond", { plan_id: this.slug, section_id: sectionId, event_id: eventId, text });
  }
  async reconcile() {                                  // poll the inbox, act on open events
    const inbox = (await this.client.get(`/api/notes?plan=${this.slug}`)).json;
    return inbox.filter((e) => e.status === "open");
  }
}
```

### 3. DomProbe — assert on rendered DOM via an injected document shim

**When:** you need to prove the renderer produces the right structure/badges/
affordances **and emits no executable script** — without a real browser.
References: `test/harness/dom.js` (headless DOM shim) and
`test/harness/domprobe.js`.

```js
const { makeDocument, makeWindow } = require("./dom.js");
const PlanRenderer = require("../../assets/plan.js");

class DomProbe {
  constructor() {
    this.doc = makeDocument(); this.window = makeWindow(this.doc);
    this.app = this.doc.createElement("div"); this.app.setAttribute("id", "app");
    this.doc.body.appendChild(this.app);
  }
  render(plan) { this.plan = PlanRenderer.renderPlan(this.app, plan, { document: this.doc }); return this; }
  badges(id) { return this.app.querySelector(`[data-section-id="${id}"]`).querySelectorAll(".badge").map((b) => b.textContent); }
  hasExecutableScript() { return /<script\b/i.test(this.app.serialize()); } // must be false — XSS gate
}
```

### 4. FaultInj — inject faults and assert refusal, not crash

**When:** you need to prove the system *refuses/halts/sanitizes* under abuse —
missing/wrong token, path traversal, oversized body, malformed JSON, dropped
connections, caps exceeded — rather than crashing or leaking. Reference:
`test/harness/faultinj.js`, which uses a **raw** HTTP client that bypasses the
token-aware wrapper to test the auth and bounds directly.

```js
function raw(base, method, p, body) { /* http.request, resolves {status,text,json}, status:0 on reset */ }

class FaultInj {
  constructor(ctx) { this.base = ctx.base; this.token = ctx.token; }
  missingToken()  { return raw(this.base, "GET",  "/api/plans"); }                       // expect 401
  traversal()     { return raw(this.base, "POST", `/api/notes?token=${this.token}`, {     // expect 400/403, no escape
                      plan_id: "../../../../etc/passwd", section_id: "x", type: "comment", actor: "human", text: "x" }); }
  oversizedBody(slug) { return raw(this.base, "POST", `/api/notes?token=${this.token}`, {  // expect 413 (>256KB cap)
                      plan_id: slug, section_id: "s", type: "comment", actor: "human", text: "x".repeat(1024 * 1024) }); }
}
```

FaultInj mirrors the **oracle mutation operators** (`tools/oracle/mutate.js`):
each operator faults exactly one guard — `status-404-to-200`, `sse-cap-disable`,
`event-cap-off`, `schema-check-drop`, `bind-any-interface`,
`actor-validation-drop` — and the harness suite **must kill every mutant**.
A surviving mutant indicts the suite (`tools/oracle/mutation_gate.js`), not the
code.

## Adversarial separation

The harness/oracle must originate **outside the builder's lineage**, or the
henhouse rule is violated by construction:

- **Independent authorship.** The hidden suite, mutants, and generators are
  authored by a designer lineage distinct from the builder
  (`tools/oracle/lineage.js` enforces `designer !== builder`).
- **Write-segregation.** Oracle material under `.oracle/**` is write-segregated
  from the builder's workspace — the entity under test has no write path to the
  tests that judge it.
- **Commit-reveal ordering.** The designer commits a salted hash of the hidden
  bundle **before** the builder freezes its implementation, and reveals only
  after (`tools/oracle/commit_reveal.js`: `commit < freeze < reveal`). A bundle
  weakened after freeze fails to verify.
- **Verdict-only egress.** The sandbox's only output channel is the structured
  `oracle/1` verdict (`tools/oracle/verdict.js`) — tiny, schema-checked, secret-
  scanned — so no source, stdout, or network can smuggle out a pass.

## Related skills

- **verification-before-completion** — the harness produces the evidence this gate demands.
- **code-review** — consumes the resulting `oracle/1` verdict at the merge gate.
- **test-driven-development** — the red→green discipline each harness assertion follows.
- **security-review** — owns the write-segregation, commit-reveal, and verdict-egress controls.
