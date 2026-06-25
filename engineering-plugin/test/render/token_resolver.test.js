/*
 * token_resolver.test.js — P-V3: regression for the CSP-blocked inline token.
 *
 * Because CSP forbids inline scripts, window.__PLAN_TOKEN__ may never be set in
 * the browser. The renderer must fall back to the ?token= query param so live
 * notes/SSE still authenticate. resolveToken order:
 *   window.__PLAN_TOKEN__ → URL ?token= → ctx.token → "".
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PlanRenderer = require("../../assets/plan.js");

function withFakeWindow(win, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, "window");
  const prev = global.window;
  global.window = win;
  try { return fn(); }
  finally {
    if (had) global.window = prev;
    else delete global.window;
  }
}

test("resolveToken falls back to ?token= when __PLAN_TOKEN__ is unset", () => {
  withFakeWindow({ location: { search: "?token=sekret123" } }, () => {
    assert.equal(PlanRenderer.resolveToken({}), "sekret123");
  });
});

test("resolveToken prefers window.__PLAN_TOKEN__ over the query param", () => {
  withFakeWindow({ __PLAN_TOKEN__: "injected", location: { search: "?token=fromurl" } }, () => {
    assert.equal(PlanRenderer.resolveToken({ token: "ctx" }), "injected");
  });
});

test("resolveToken falls back to ctx.token, then empty string", () => {
  withFakeWindow({ location: { search: "" } }, () => {
    assert.equal(PlanRenderer.resolveToken({ token: "ctxtok" }), "ctxtok");
    assert.equal(PlanRenderer.resolveToken({}), "");
  });
});

test("resolveToken is safe when window is undefined (Node)", () => {
  // no global.window here
  assert.equal(PlanRenderer.resolveToken({ token: "node" }), "node");
  assert.equal(PlanRenderer.resolveToken({}), "");
});
