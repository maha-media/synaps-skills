"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const PJ = path.join(__dirname, "..", "..", ".synaps-plugin", "plugin.json");

test("plugin.json is valid JSON and declares extension+commands+assets (P4-3)", () => {
  const pj = JSON.parse(fs.readFileSync(PJ, "utf8"));
  assert.equal(pj.name, "engineering");
  assert.ok(pj.extension, "extension declared");
  assert.equal(pj.extension.runtime, "process");
  assert.equal(pj.extension.command, "node");
  assert.deepEqual(pj.extension.args, ["extensions/plans_server.js"]);
  assert.ok(Array.isArray(pj.commands) && pj.commands.find((c) => c.name === "plan"), "plan command declared");
  assert.ok(Array.isArray(pj.extension.assets) && pj.extension.assets.includes("assets/plan.js"), "assets declared");
});

test("declared assets exist on disk (P4-3)", () => {
  const pj = JSON.parse(fs.readFileSync(PJ, "utf8"));
  for (const a of pj.extension.assets) {
    assert.ok(fs.existsSync(path.join(__dirname, "..", "..", a)), "missing asset: " + a);
  }
});

test("extension entrypoint loads without throwing (smoke) (P4-3)", () => {
  const ext = require("../../extensions/plans_server.js");
  assert.equal(typeof ext.createServer, "function");
});
