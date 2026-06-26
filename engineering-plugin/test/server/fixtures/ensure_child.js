#!/usr/bin/env node
/*
 * ensure_child.js — S5 race fixture. Calls ensureServer(repoRoot) and prints a
 * single JSON line {hosted,reused,port,pid}. A HOSTING child stays alive (keeps
 * its listener up so siblings can reuse it); a REUSING child exits immediately.
 *
 *   argv[2] = repoRoot
 *   env LOCK=off → bypass the O_EXCL lock (RED stub: proves the race is real)
 */
"use strict";
const path = require("path");
const life = require(path.join(__dirname, "..", "..", "..", "lib", "server_lifecycle.js"));

async function main() {
  const repoRoot = process.argv[2];
  let r;
  if (process.env.LOCK === "off") {
    // RED stub: no lock, no double-check — read record, else host. Two of these
    // racing both see "no record" and both host → duplicate listeners.
    const rec = life.readRecord(repoRoot);
    if (rec && (await life.verifyLive(rec))) {
      r = { url: rec.url, port: rec.port, pid: rec.pid, reused: true, hosted: false };
    } else {
      const { createServer } = require(path.join(__dirname, "..", "..", "..", "extensions", "plans_server.js"));
      const server = await new Promise((res) => {
        const s = createServer({ repoRoot, pluginDir: path.join(__dirname, "..", "..", "..") , startedAt: new Date().toISOString() });
        s.listen(() => res(s));
      });
      life.writeRecord(repoRoot, { pid: process.pid, port: server.port, token: server.token, url: server.url, started_at: server.startedAt, plans_dir: path.join(repoRoot, ".plans") });
      r = { url: server.url, port: server.port, pid: process.pid, reused: false, hosted: true, _server: server };
    }
  } else {
    r = await life.ensureServer(repoRoot);
  }
  process.stdout.write(JSON.stringify({ hosted: !!r.hosted, reused: !!r.reused, port: r.port, pid: r.pid }) + "\n");
  if (r.hosted) {
    // Stay alive so siblings can reuse our listener. Parent kills us.
    setInterval(() => {}, 1 << 30);
  } else {
    process.exit(0);
  }
}
main().catch((e) => { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
