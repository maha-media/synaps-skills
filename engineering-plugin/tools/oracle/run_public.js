/*
 * run_public.js — runs the public suite in the worktree (Builder-visible).
 * The public suite is the "sample cases"; the grade comes from the hidden suite.
 * Orchestrator infra. Stdlib only.
 */
"use strict";
const path = require("node:path");
const { runSuites } = require("./suite_runner.js");

const PUBLIC_DIR = path.join(__dirname, "..", "..", ".oracle", "public");

async function runPublic(opts) {
  opts = opts || {};
  return runSuites(opts.dir || PUBLIC_DIR, Object.assign({ lineage: "public" }, opts));
}

module.exports = { runPublic, PUBLIC_DIR };
