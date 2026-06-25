/*
 * plugin_hooks.test.js — hook registration in .synaps-plugin/plugin.json.
 *
 * The synaps engine (v0.3.1) only supports: before_message, on_message_complete,
 * before_tool_call, after_tool_call, on_session_start, on_session_end. It does
 * NOT support the CAC compaction hooks (checkpoint.reached, pre-compact,
 * post-compact); declaring them made the whole extension fail to load, so they
 * were removed. This test pins the manifest to ONLY engine-supported kinds and
 * asserts the unsupported compaction hooks remain absent.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_JSON = path.join(__dirname, "..", "..", ".synaps-plugin", "plugin.json");

test("plugin.json is valid JSON", () => {
  const txt = fs.readFileSync(PLUGIN_JSON, "utf8");
  assert.doesNotThrow(() => JSON.parse(txt));
});

test("extension.hooks declares only engine-supported kinds; compaction hooks absent", () => {
  const json = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf8"));
  const names = json.extension.hooks.map((h) => h.hook);
  // Supported lifecycle hooks must be present.
  for (const h of ["on_session_start", "on_session_end"]) {
    assert.ok(names.includes(h), "expected supported hook registered: " + h);
  }
  // Engine v0.3.1 does not support compaction hooks — they must NOT be declared.
  for (const h of ["checkpoint.reached", "pre-compact", "post-compact"]) {
    assert.ok(!names.includes(h), "unsupported hook must be absent: " + h);
  }
  // Every declared hook must be an engine-supported kind.
  const SUPPORTED = new Set([
    "before_message", "on_message_complete", "before_tool_call",
    "after_tool_call", "on_session_start", "on_session_end",
  ]);
  for (const h of names) {
    assert.ok(SUPPORTED.has(h), "declared hook not supported by engine: " + h);
  }
});
