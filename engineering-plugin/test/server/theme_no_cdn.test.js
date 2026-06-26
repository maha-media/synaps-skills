/*
 * theme_no_cdn.test.js — DT-4 acceptance: the generated theme.css and the
 * themed shell never introduce an external URL, @font-face references only
 * bundled /_assets/fonts/*.woff2, and a malformed theme.json degrades the site
 * (never 500). Proves the no-CDN + never-break tenets for the theme path.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { withServer } = require("../harness/runner.js");

function writeTheme(repoRoot, obj) {
  fs.writeFileSync(path.join(repoRoot, ".plans", "theme.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
}
function rawGet(base, p) {
  return new Promise((resolve, reject) => {
    const r = http.request(new URL(p, base), { method: "GET" }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); r.end();
  });
}

// every bundled pairing → its theme.css must be 100% local.
const PAIRINGS = [
  { display: "Cormorant Garamond", ui: "Outfit" },
  { display: "Space Grotesk", ui: "Inter" },
  { display: "JetBrains Mono", ui: "Inter" },
  { display: "Fraunces", ui: "Work Sans" },
  { display: "Archivo", ui: "Archivo" },
  { display: "system-serif", ui: "system-mono" },
];

test("generated theme.css has zero external URLs + @font-face only /_assets/fonts/* (every pairing)", async () => {
  for (const fonts of PAIRINGS) {
    await withServer(async (ctx) => {
      writeTheme(ctx.repoRoot, { schema: "engtheme/1", title: "T", palette: { accent: "#7aa2f7" }, fonts });
      const res = await rawGet(ctx.base, "/_assets/theme.css");
      assert.equal(res.status, 200, "theme.css served for " + JSON.stringify(fonts));
      assert.ok(!/https?:\/\//i.test(res.text), "no http(s) URLs for " + JSON.stringify(fonts));
      assert.ok(!/fonts\.googleapis|gstatic/i.test(res.text), "no font CDN for " + JSON.stringify(fonts));
      // every src:url(...) must be a bundled local woff2
      const urls = res.text.match(/url\(["']?([^"')]+)["']?\)/g) || [];
      for (const u of urls) {
        assert.match(u, /\/_assets\/fonts\/[a-z0-9-]+\.woff2/i, "font url is bundled local: " + u);
      }
    });
  }
});

test("themed shell (served /) has zero external URLs", async () => {
  await withServer(async (ctx) => {
    writeTheme(ctx.repoRoot, { schema: "engtheme/1", title: "Zeta", monogram: "Z", palette: { accent: "#9ece6a" }, fonts: { display: "Fraunces", ui: "Work Sans" } });
    const res = await ctx.client.get("/");
    assert.equal(res.status, 200);
    assert.ok(!/https?:\/\//i.test(res.text), "themed shell has no external URLs");
  });
});

test("malformed theme.json → site degrades (200s, never 500)", async () => {
  await withServer(async (ctx) => {
    writeTheme(ctx.repoRoot, "{ this is not valid json ::: ");
    const shell = await ctx.client.get("/");
    assert.equal(shell.status, 200, "shell still renders");
    const api = await ctx.client.get("/api/theme");
    assert.equal(api.status, 200, "api still 200");
    assert.ok(["inferred", "default"].indexOf(api.json._source) !== -1, "degrades to inferred/default");
    const css = await rawGet(ctx.base, "/_assets/theme.css");
    assert.equal(css.status, 200, "theme.css still 200");
    assert.match(css.text, /--gold:/i, "still emits a palette");
  });
});

test("a theme.json with every field malicious still yields safe, local CSS", async () => {
  await withServer(async (ctx) => {
    writeTheme(ctx.repoRoot, {
      schema: "engtheme/1",
      title: "<script>alert(1)</script>",
      tagline: "</style><script>x</script>",
      monogram: "<b>",
      palette: { accent: "url(http://evil/x)", bg: "expression(alert(1))", text: "#fff" },
      fonts: { display: "../../etc/passwd", ui: "javascript:alert(1)" },
    });
    const css = await rawGet(ctx.base, "/_assets/theme.css");
    assert.ok(!/https?:\/\//i.test(css.text), "no injected URL");
    assert.ok(!/expression|javascript:|<script/i.test(css.text), "no injected CSS/JS");
    assert.match(css.text, /--gold:\s*#d4a574/i, "accent fell back to default");
    const shell = await ctx.client.get("/");
    // identity text is HTML-escaped in the shell (no live script tag in body)
    const body = shell.text.split("</head>")[1] || shell.text;
    assert.ok(!/<script>alert/i.test(body), "title not injected as live markup");
  });
});
