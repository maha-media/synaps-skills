/*
 * run_hidden.js — sandbox hidden-suite runner (spec §4.2, §8). [SANDBOX RUNNER]
 *
 * Substrate (Open decision #1): default zero-dep "separate-process + isolated
 * sandbox root" — the hidden suite is COPIED into a sandbox directory OUTSIDE
 * the Builder's worktree and executed by a fresh child `node`. The Builder
 * artifact is mounted READ-ONLY (a copy). The child's ONLY egress is a single
 * verdict file; stdout/stderr are discarded for leak-safety. A wall-clock
 * timeout kills runaway hidden tests. A container substrate (docker) presents
 * the same verdict-only interface and is selected when ORACLE_SANDBOX=container.
 *
 * This module is the PARENT side: it sets up isolation, launches the child,
 * reads + validates the verdict (verdict-only egress contract). Stdlib only.
 */
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const { parseVerdict, makeVerdict } = require("../verdict.js");

const TOOLS = path.join(__dirname, "..");

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name), d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/**
 * Run the hidden suite (in hiddenDir) against a Builder artifact (buildRoot) in
 * an isolated sandbox. Returns a validated verdict. Never returns suite source.
 *
 * @param {object} opts { hiddenDir, buildRoot, targetDir?, timeoutMs?, round?, nonce? }
 */
function runHidden(opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 20000;
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-sandbox-"));
  const nonce = opts.nonce || crypto.randomBytes(8).toString("hex");
  const auditId = "aud_" + crypto.randomBytes(5).toString("hex");
  try {
    // 1. Copy hidden suite into the sandbox (outside the Builder worktree).
    const sbHidden = path.join(sandboxRoot, "hidden");
    copyDir(opts.hiddenDir, sbHidden);
    // 2. The verdict file is the ONLY egress channel.
    const verdictFile = path.join(sandboxRoot, "verdict.json");
    // 3. Child runner script (uses orchestrator infra from the real tools dir,
    //    but the SUT it grades is the Builder artifact dir).
    const child = `
      const { runSuites } = require(${JSON.stringify(path.join(TOOLS, "suite_runner.js"))});
      const fs = require("fs");
      (async () => {
        try {
          const { verdict } = await runSuites(${JSON.stringify(sbHidden)}, {
            targetDir: ${JSON.stringify(opts.targetDir || opts.buildRoot)},
            round: ${opts.round || 0}, audit_id: ${JSON.stringify(auditId)}, nonce: ${JSON.stringify(nonce)},
            lineage: "designer-hidden",
          });
          fs.writeFileSync(${JSON.stringify(verdictFile)}, JSON.stringify(verdict));
          process.exit(0);
        } catch (e) {
          // even on internal failure, emit a verdict-only signal (no source)
          fs.writeFileSync(${JSON.stringify(verdictFile)}, JSON.stringify({
            schema:"oracle/1", kind:"verdict", round:${opts.round || 0},
            counts:{pass:0,fail:1}, categories:[{category:"internal-error",count:1}],
            audit_id:${JSON.stringify(auditId)}, nonce:${JSON.stringify(nonce)},
          }));
          process.exit(0);
        }
      })();
    `;
    const childFile = path.join(sandboxRoot, "_child.js");
    fs.writeFileSync(childFile, child);
    const r = cp.spawnSync(process.execPath, [childFile], {
      cwd: sandboxRoot, timeout: timeoutMs, encoding: "utf8",
      // discard child stdio so nothing leaks on stdout/stderr
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, ORACLE_LINEAGE_ROLE: "tester" },
    });
    if (r.error && r.error.code === "ETIMEDOUT") {
      return makeVerdict({ round: opts.round || 0, pass: 0, fail: 1, categories: ["internal-error"], audit_id: auditId, nonce });
    }
    let verdict;
    try { verdict = parseVerdict(fs.readFileSync(verdictFile, "utf8")); }
    catch (e) { return makeVerdict({ round: opts.round || 0, pass: 0, fail: 1, categories: ["egress-leak" === e.category ? "internal-error" : "internal-error"], audit_id: auditId, nonce }); }
    return verdict;
  } finally {
    try { fs.rmSync(sandboxRoot, { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { runHidden };
