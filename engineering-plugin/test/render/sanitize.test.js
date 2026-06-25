"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Sanitize = require("../../assets/sanitize.js");

test("XSS: <script> tag and content stripped", () => {
  const out = Sanitize.sanitizeHtml("<script>alert(1)</script>hello");
  assert.ok(!/<script/i.test(out), "no <script in: " + out);
  assert.ok(!/alert\(1\)/.test(out), "script content removed: " + out);
  assert.ok(/hello/.test(out));
});

test("XSS: <img onerror> neutralized", () => {
  const out = Sanitize.sanitizeHtml('<img src=x onerror=alert(1)>');
  assert.ok(!/onerror/i.test(out), "no onerror in: " + out);
  // img is not an allowed tag → dropped entirely
  assert.ok(!/<img/i.test(out), "no <img in: " + out);
});

test("XSS: javascript: href dropped", () => {
  const out = Sanitize.sanitizeHtml('<a href="javascript:alert(1)">x</a>');
  assert.ok(!/javascript:/i.test(out), "no javascript: in: " + out);
  // anchor itself survives but without the dangerous href
  assert.ok(/<a/i.test(out));
  assert.ok(!/href=/.test(out) || /href="[^"]*"/.test(out));
});

test("XSS: <svg onload> stripped", () => {
  const out = Sanitize.sanitizeHtml('<svg onload=alert(1)></svg>');
  assert.ok(!/<svg/i.test(out), "no <svg in: " + out);
  assert.ok(!/onload/i.test(out), "no onload in: " + out);
});

test("XSS: data: URL href dropped", () => {
  const out = Sanitize.sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
  assert.ok(!/data:text\/html/i.test(out), "no data: url in: " + out);
  assert.ok(!/<script/i.test(out));
});

test("XSS corpus combined produces nothing executable", () => {
  const corpus = [
    "<script>alert(1)</script>",
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<svg onload=alert(1)>',
    '<a href="data:text/html,foo">y</a>',
  ].join("\n");
  const out = Sanitize.sanitizeHtml(corpus);
  assert.ok(!/<script/i.test(out));
  assert.ok(!/onerror/i.test(out));
  assert.ok(!/onload/i.test(out));
  assert.ok(!/<svg/i.test(out));
  assert.ok(!/javascript:/i.test(out));
  assert.ok(!/data:text\/html/i.test(out));
});

// ---- standard markdown via renderMarkdown ----

test("markdown heading -> <h1>", () => {
  const out = Sanitize.renderMarkdown("# Title");
  assert.ok(/<h1>Title<\/h1>/.test(out), out);
});

test("markdown unordered list -> <ul><li>", () => {
  const out = Sanitize.renderMarkdown("- one\n- two");
  assert.ok(/<ul>/.test(out), out);
  assert.ok(/<li>one<\/li>/.test(out), out);
  assert.ok(/<li>two<\/li>/.test(out), out);
});

test("markdown inline code -> <code>", () => {
  const out = Sanitize.renderMarkdown("use `x` here");
  assert.ok(/<code>x<\/code>/.test(out), out);
});

test("markdown bold -> <strong>", () => {
  const out = Sanitize.renderMarkdown("this is **x** bold");
  assert.ok(/<strong>x<\/strong>/.test(out), out);
});

test("markdown link -> <a href=...>", () => {
  const out = Sanitize.renderMarkdown("[t](http://x)");
  assert.ok(/<a href="http:\/\/x">t<\/a>/.test(out), out);
});

test("markdown link with javascript: is neutralized end-to-end", () => {
  const out = Sanitize.renderMarkdown("[t](javascript:alert(1))");
  assert.ok(!/javascript:/i.test(out), out);
});
