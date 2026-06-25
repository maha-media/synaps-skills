/*
 * P5-0 — tmux detection + pane address validation (lib/tmux).
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { detect, validPane } = require("../../lib/tmux/index.js");

test("detect reflects TMUX env presence", () => {
  assert.equal(detect({ TMUX: "x" }).inTmux, true);
  assert.equal(detect({ TMUX: "x" }).tmux, "x");
  assert.equal(detect({}).inTmux, false);
  assert.equal(detect({}).tmux, null);
});

test("validPane accepts session:window.pane addresses", () => {
  assert.equal(validPane("27:0.1"), true);
  assert.equal(validPane("main:1.0"), true);
  assert.equal(validPane("s_1-a:10.2"), true);
});

test("validPane rejects malformed / injection-y addresses", () => {
  assert.equal(validPane("bad"), false);
  assert.equal(validPane("$(rm)"), false);
  assert.equal(validPane("27:0"), false);
  assert.equal(validPane("27.0.1"), false);
  assert.equal(validPane(""), false);
  assert.equal(validPane(null), false);
  assert.equal(validPane("a b:0.1"), false);
});
