/*
 * plugin_hooks.test.js — CAC §7 hook registration in .synaps-plugin/plugin.json.
 * Asserts the three new hooks are registered additively (existing lifecycle
 * hooks preserved, file remains valid JSON).
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

test("extension.hooks contains the three §7 CAC hooks and the two lifecycle hooks", () => {
  const json = JSON.parse(fs.readFileSync(PLUGIN_JSON, "utf8"));
  const names = json.extension.hooks.map((h) => h.hook);
  for (const h of ["on_session_start", "on_session_end", "checkpoint.reached", "pre-compact", "post-compact"]) {
    assert.ok(names.includes(h), "expected hook registered: " + h);
  }
});
