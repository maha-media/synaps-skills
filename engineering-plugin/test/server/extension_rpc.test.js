/*
 * extension_rpc.test.js — S3: record-aware extension RPC over stdio.
 *  - plan/serve goes through ensureServer → reuses a live repo server (same
 *    url as the sidecar / CLI) instead of always starting a per-session one
 *  - plan/down and plan/status RPCs added and exercised
 *  - initialize / hook.handle / shutdown handshake unchanged
 *  - shutdown only tears down a server THIS process hosts (never a reused one)
 * Every host reaped in afterEach (no orphans).
 */
"use strict";
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");

const { runStdioExtension, createServer } = require("../../extensions/plans_server.js");
const life = require("../../lib/server_lifecycle.js");

const repos = new Set();
function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-rpc-s3-"));
  fs.mkdirSync(path.join(dir, ".plans"), { recursive: true });
  repos.add(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of repos) { try { await life.stopServer(dir); } catch (_) {} }
  for (const dir of repos) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  repos.clear();
});

// Drive the LSP-style framed stdio. Returns { send(msg), next(id) }.
function driver(repoRoot, opts) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  const waiters = [];
  let buf = Buffer.alloc(0);
  output.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) break;
      const m = buf.slice(0, sep).toString("ascii").match(/content-length:\s*(\d+)/i);
      if (!m) { buf = buf.slice(sep + 4); continue; }
      const len = parseInt(m[1], 10);
      if (buf.length < sep + 4 + len) break;
      const msg = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString("utf8"));
      buf = buf.slice(sep + 4 + len);
      replies.push(msg);
      waiters.splice(0).forEach((w) => w(msg));
    }
  });
  const handle = runStdioExtension(Object.assign({ input, output, repoRoot, exit: false }, opts || {}));
  function send(msg) {
    const data = Buffer.from(JSON.stringify(msg), "utf8");
    input.write("Content-Length: " + data.length + "\r\n\r\n");
    input.write(data);
  }
  function nextById(id) {
    const found = replies.find((r) => r.id === id);
    if (found) return Promise.resolve(found);
    return new Promise((res) => waiters.push(function w(m) { if (m.id === id) res(m); else waiters.push(w); }));
  }
  return { send, nextById, handle, input, output };
}

test("initialize / hook.handle / shutdown handshake unchanged", async () => {
  const repo = tmpRepo();
  const d = driver(repo);
  d.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const init = await d.nextById(1);
  assert.equal(init.result.name, "plans-server");
  assert.equal(init.result.protocol_version, 1);
  d.send({ jsonrpc: "2.0", id: 2, method: "hook.handle", params: {} });
  assert.equal((await d.nextById(2)).result.action, "continue");
  d.send({ jsonrpc: "2.0", id: 3, method: "shutdown" });
  assert.equal((await d.nextById(3)).result.ok, true);
});

test("on_session_start hook auto-hosts the repo server (no explicit plan/serve)", async () => {
  const repo = tmpRepo();
  const d = driver(repo);
  // No live server yet.
  assert.equal((await life.serverStatus(repo)).state, "down");
  // Synaps fires the session-start lifecycle hook.
  d.send({ jsonrpc: "2.0", id: 1, method: "hook.handle", params: { kind: "on_session_start" } });
  assert.equal((await d.nextById(1)).result.action, "continue");
  // The extension hosted the server as a side effect → now running.
  const st = await life.serverStatus(repo);
  assert.equal(st.state, "running");
});

test("on_session_end hook tears down a server THIS process hosts", async () => {
  const repo = tmpRepo();
  const d = driver(repo);
  d.send({ jsonrpc: "2.0", id: 1, method: "hook.handle", params: { kind: "on_session_start" } });
  await d.nextById(1);
  assert.equal((await life.serverStatus(repo)).state, "running");
  d.send({ jsonrpc: "2.0", id: 2, method: "hook.handle", params: { kind: "on_session_end" } });
  assert.equal((await d.nextById(2)).result.action, "continue");
  assert.equal((await life.serverStatus(repo)).state, "down");
});

test("on_session_end NEVER kills a foreign owner's server (reuser only)", async () => {
  const repo = tmpRepo();
  const owner = await life.ensureServer(repo); // foreign owner hosts
  const d = driver(repo);
  // session-start reuses the live server (hosts nothing)
  d.send({ jsonrpc: "2.0", id: 1, method: "hook.handle", params: { kind: "on_session_start" } });
  await d.nextById(1);
  // session-end must NOT tear down the foreign server
  d.send({ jsonrpc: "2.0", id: 2, method: "hook.handle", params: { kind: "on_session_end" } });
  await d.nextById(2);
  const st = await life.serverStatus(repo);
  assert.equal(st.state, "running");
  assert.equal(st.pid, owner.pid);
});

test("plan/serve reuses a live repo server (same url as the record)", async () => {
  const repo = tmpRepo();
  // A server is already hosted (e.g. by the sidecar) → recorded.
  const pre = await life.ensureServer(repo);
  const d = driver(repo);
  d.send({ jsonrpc: "2.0", id: 1, method: "plan/serve" });
  const r = await d.nextById(1);
  assert.equal(r.result.url, pre.url);
  assert.equal(r.result.port, pre.port);
  assert.equal(r.result.reused, true);
});

test("plan/status and plan/down RPCs", async () => {
  const repo = tmpRepo();
  const d = driver(repo);
  // hosts in-process (no live server yet)
  d.send({ jsonrpc: "2.0", id: 1, method: "plan/serve" });
  const served = await d.nextById(1);
  assert.equal(served.result.reused, false);
  d.send({ jsonrpc: "2.0", id: 2, method: "plan/status" });
  assert.equal((await d.nextById(2)).result.state, "running");
  d.send({ jsonrpc: "2.0", id: 3, method: "plan/down" });
  assert.equal((await d.nextById(3)).result.stopped, true);
  d.send({ jsonrpc: "2.0", id: 4, method: "plan/status" });
  assert.equal((await d.nextById(4)).result.state, "down");
});

test("shutdown tears down a server THIS process hosts but NOT a reused one", async () => {
  const repo = tmpRepo();
  // foreign owner hosts the live server
  const owner = await life.ensureServer(repo);
  const d = driver(repo);
  d.send({ jsonrpc: "2.0", id: 1, method: "plan/serve" }); // reuses
  assert.equal((await d.nextById(1)).result.reused, true);
  d.send({ jsonrpc: "2.0", id: 2, method: "shutdown" });
  await d.nextById(2);
  // the foreign server must still be alive + recorded (not killed by the reuser)
  const st = await life.serverStatus(repo);
  assert.equal(st.state, "running");
  assert.equal(st.pid, owner.pid);
});
