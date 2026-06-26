/*
 * sidecar.test.js — S1: provides.sidecar v2 frame exchange. Feeds init +
 * trigger + shutdown over injected stdio streams and asserts hello, a
 * url-bearing status/insert_text on trigger, and clean parent-bound teardown
 * (server closed, record removed, no orphan). Every host reaped in afterEach.
 */
"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { PassThrough } = require("stream");

const { runSidecar } = require("../../bin/plans-sidecar.js");
const life = require("../../lib/server_lifecycle.js");

const repos = new Set();
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-s1-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  repos.add(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of repos) { try { await life.stopServer(dir); } catch (_) {} }
  for (const dir of repos) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  repos.clear();
});

// Collect output frames; expose waitFor(predicate).
function harness(repoRoot) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = [];
  const waiters = [];
  let buf = "";
  output.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const f = JSON.parse(line);
      frames.push(f);
      waiters.splice(0).forEach((w) => w(f));
    }
  });
  const handle = runSidecar({ input, output, repoRoot, exit: false });
  return {
    frames, handle,
    send: (obj) => input.write(JSON.stringify(obj) + "\n"),
    endInput: () => input.end(),
    waitFor(pred, ms) {
      return new Promise((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error("frame timeout")), ms || 3000);
        const check = (f) => { if (pred(f)) { clearTimeout(t); resolve(f); } else waiters.push(check); };
        waiters.push(check);
      });
    },
  };
}

function getHealth(port, token) {
  return new Promise((resolve) => {
    http.get("http://127.0.0.1:" + port + "/api/health?token=" + token, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") }));
    }).on("error", () => resolve({ status: 0 }));
  });
}

test("sidecar emits hello on start and a url-bearing insert_text/status on trigger{plans}", async () => {
  const repo = tmpRepo();
  const h = harness(repo);

  // hello is emitted synchronously at start.
  const hello = await h.waitFor((f) => f.type === "hello");
  assert.equal(hello.protocol_version, 2);
  assert.ok(hello.capabilities.includes("status"));

  h.send({ type: "init", config: { protocol_version: 2 } });
  await h.waitFor((f) => f.type === "status" && f.state === "idle");

  h.send({ type: "trigger", name: "plans" });
  const ins = await h.waitFor((f) => f.type === "insert_text");
  assert.match(ins.text, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/, "insert_text carries the loopback url+token");
  const serving = await h.waitFor((f) => f.type === "custom" && f.event_type === "plans.serving");
  assert.equal(serving.payload.hosted, true);

  // The advertised server is actually live + healthy.
  const rec = life.readRecord(repo);
  assert.ok(rec && rec.port, "record written on host");
  const hr = await getHealth(rec.port, rec.token);
  assert.equal(hr.status, 200);
});

test("shutdown closes the hosted server and removes the record (no orphan, no stale record)", async () => {
  const repo = tmpRepo();
  const h = harness(repo);
  await h.waitFor((f) => f.type === "hello");
  h.send({ type: "trigger", name: "plans" });
  await h.waitFor((f) => f.type === "insert_text");
  const rec = life.readRecord(repo);
  assert.ok(rec, "record present while hosting");

  await h.handle.shutdown();
  assert.equal(life.readRecord(repo), null, "record removed on shutdown");
  // The port is closed: health no longer answers.
  const hr = await getHealth(rec.port, rec.token);
  assert.notEqual(hr.status, 200, "server no longer listening after shutdown");
  assert.equal(life._HOSTED.has(path.resolve(repo)), false, "no in-process server left hosting");
});

test("parent EOF (stdin close) tears the sidecar down (parent-bound lifetime)", async () => {
  const repo = tmpRepo();
  const h = harness(repo);
  await h.waitFor((f) => f.type === "hello");
  h.send({ type: "trigger", name: "plans" });
  await h.waitFor((f) => f.type === "insert_text");
  const rec = life.readRecord(repo);

  h.endInput(); // simulate parent death closing our stdin
  await h.waitFor((f) => f.type === "status" && f.state === "stopped", 3000);
  // allow stopServer to settle
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(life.readRecord(repo), null, "record reaped after parent EOF");
  const hr = await getHealth(rec.port, rec.token);
  assert.notEqual(hr.status, 200, "server died with its parent");
});
