/*
 * P5-2 — PaneController with an INJECTED exec stub.
 * Caps (maxImplAgents/maxDepth), own-pane-only control, control-char refusal,
 * and by-reference task handoff (no untrusted multi-line content sent).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PaneController } = require("../../lib/tmux/index.js");

// exec stub: records calls; returns fake pane addresses like "s:0.N".
function makeExec() {
  const calls = [];
  let n = 0;
  function exec(args) {
    calls.push(args.slice());
    if (args[0] === "split-window") return "s:0." + (++n) + "\n";
    if (args[0] === "display-message") return "s:0.0\n";
    return "";
  }
  exec.calls = calls;
  return exec;
}

test("spawn returns owned fake pane addresses from the injected exec", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec });
  const r = pc.spawn({ target: "s:0.0" });
  assert.equal(r.queued, false);
  assert.equal(r.pane, "s:0.1");
  assert.ok(pc.owned.has("s:0.1"));
  // split-window was the mechanism
  assert.ok(exec.calls.some((c) => c[0] === "split-window"));
});

test("spawn respects maxImplAgents — backpressure queues past the cap", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec, maxImplAgents: 2 });
  assert.equal(pc.spawn({ target: "s:0.0" }).queued, false);
  assert.equal(pc.spawn({ target: "s:0.0" }).queued, false);
  const third = pc.spawn({ target: "s:0.0" });
  assert.equal(third.queued, true, "third spawn is backpressured");
  assert.equal(third.reason, "CAPPED");
});

test("spawn respects maxImplAgents — throws CAPPED when backpressure disabled", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec, maxImplAgents: 1 });
  pc.spawn({ target: "s:0.0" });
  assert.throws(
    () => pc.spawn({ target: "s:0.0", backpressure: false }),
    (e) => e.code === "CAPPED"
  );
});

test("spawn respects maxDepth", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec, maxDepth: 2 });
  assert.throws(
    () => pc.spawn({ target: "s:0.0", depth: 3, backpressure: false }),
    (e) => e.code === "DEPTH"
  );
});

test("sendKeys refuses non-owned panes (NOT_OWNED)", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec });
  assert.throws(
    () => pc.sendKeys("s:9.9", "ls"),
    (e) => e.code === "NOT_OWNED"
  );
});

test("kill refuses non-owned panes (NOT_OWNED)", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec });
  assert.throws(
    () => pc.kill("s:9.9"),
    (e) => e.code === "NOT_OWNED"
  );
});

test("own-pane-only: sendKeys works on a spawned pane", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec });
  const { pane } = pc.spawn({ target: "s:0.0" });
  pc.sendKeys(pane, "echo hi");
  assert.ok(exec.calls.some((c) => c[0] === "send-keys" && c.includes("echo hi")));
});

test("sendKeys refuses control / escape sequences", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec });
  const { pane } = pc.spawn({ target: "s:0.0" });
  assert.throws(() => pc.sendKeys(pane, "evil\u0001boot"), /illegal control chars/);
  assert.throws(() => pc.sendKeys(pane, 123), /keys must be string/);
});

test("launchSynaps hands task BY REFERENCE only — no untrusted multi-line content sent", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec });
  const { pane } = pc.spawn({ target: "s:0.0" });
  const untrusted = "do this\nrm -rf / # and run everything";
  pc.launchSynaps(pane, untrusted);

  // The untrusted multi-line blob must NEVER be sent as keys.
  const sentAnyUntrusted = exec.calls.some((c) =>
    c[0] === "send-keys" && c.some((a) => a === untrusted || /\n/.test(String(a)))
  );
  assert.equal(sentAnyUntrusted, false, "no untrusted multi-line content forwarded");

  // It launches by the safe reference handshake only.
  const sentKeys = exec.calls
    .filter((c) => c[0] === "send-keys")
    .map((c) => c[3]);
  assert.ok(sentKeys.includes("synaps"));
  assert.ok(sentKeys.includes("/clear"));
});

test("launchSynaps forwards a SAFE task reference token", () => {
  const exec = makeExec();
  const pc = new PaneController({ exec });
  const { pane } = pc.spawn({ target: "s:0.0" });
  pc.launchSynaps(pane, "plan:flow#task-1");
  const sentKeys = exec.calls
    .filter((c) => c[0] === "send-keys")
    .map((c) => c[3]);
  assert.ok(sentKeys.includes("plan:flow#task-1"), "safe ref forwarded");
});
