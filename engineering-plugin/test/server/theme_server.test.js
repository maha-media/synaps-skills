/*
 * theme_server.test.js — DT-1: server theme surface.
 *   - GET /api/theme (token-gated) → resolved engtheme/1 + _source; 401 w/o token
 *   - GET /_assets/theme.css (pre-gate, generated) → text/css, resolved --accent,
 *     @font-face for USED families only, CSS-injection fixture stripped, no CDN
 *   - renderShell injects the theme title + identity block (no static Maha logo);
 *     links theme.css
 *   - a `theme` SSE event fires when .plans/theme.json changes
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { withServer, sleep } = require("../harness/runner.js");

function writeTheme(repoRoot, obj) {
  fs.writeFileSync(path.join(repoRoot, ".plans", "theme.json"), JSON.stringify(obj));
}
const VALID_THEME = {
  schema: "engtheme/1", title: "Synaps Engineering", tagline: "agentic toolkit",
  monogram: "SE", palette: { accent: "#7aa2f7" },
  fonts: { display: "Space Grotesk", ui: "Inter" }, generated_by: "llm",
};

// raw GET that returns {status, headers, text} WITHOUT a token.
function rawGet(base, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const r = http.request(u, { method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); r.end();
  });
}

test("GET /api/theme → 200 resolved theme + _source; 401 without token", async () => {
  await withServer(async (ctx) => {
    const res = await ctx.client.get("/api/theme");
    assert.equal(res.status, 200);
    assert.equal(res.json.schema, "engtheme/1");
    assert.ok(res.json.palette && res.json.palette.accent, "carries a palette");
    assert.ok(["file", "inferred", "default"].indexOf(res.json._source) !== -1, "tags _source");
    // token still required
    const noTok = await rawGet(ctx.base, "/api/theme");
    assert.equal(noTok.status, 401, "data route still gated");
  });
});

test("GET /api/theme reflects .plans/theme.json (file source)", async () => {
  await withServer(async (ctx) => {
    writeTheme(ctx.repoRoot, VALID_THEME);
    const res = await ctx.client.get("/api/theme");
    assert.equal(res.status, 200);
    assert.equal(res.json._source, "file");
    assert.equal(res.json.title, "Synaps Engineering");
    assert.equal(res.json.palette.accent, "#7aa2f7");
  });
});

test("GET /_assets/theme.css → 200 text/css, resolved --accent, @font-face for used families only (pre-gate)", async () => {
  await withServer(async (ctx) => {
    writeTheme(ctx.repoRoot, VALID_THEME);
    // pre-gate: served with NO token
    const res = await rawGet(ctx.base, "/_assets/theme.css");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/css/);
    assert.match(res.text, /--gold:\s*#7aa2f7/i, "emits the resolved accent");
    assert.match(res.text, /space-grotesk-latin\.woff2/, "@font-face for Space Grotesk");
    assert.match(res.text, /inter-latin\.woff2/, "@font-face for Inter");
    assert.ok(!/cormorant-garamond-latin\.woff2/.test(res.text), "no unused font face");
    assert.ok(!/https?:\/\//i.test(res.text), "no external URLs");
  });
});

test("GET /_assets/theme.css strips a CSS-injection color from theme.json", async () => {
  await withServer(async (ctx) => {
    writeTheme(ctx.repoRoot, {
      schema: "engtheme/1", title: "Evil",
      palette: { accent: "red;}body{background:url(http://evil/x)}" },
      fonts: { display: "Outfit", ui: "Outfit" },
    });
    const res = await rawGet(ctx.base, "/_assets/theme.css");
    assert.equal(res.status, 200);
    assert.ok(!/evil/i.test(res.text), "injection payload not echoed");
    assert.ok(!/red;}/.test(res.text), "raw injection string stripped");
    assert.match(res.text, /--gold:\s*#d4a574/i, "accent fell back to default gold");
  });
});

test("renderShell injects theme title + identity block, links theme.css, no static logo", async () => {
  await withServer(async (ctx) => {
    writeTheme(ctx.repoRoot, VALID_THEME);
    const res = await ctx.client.get("/");
    assert.equal(res.status, 200);
    const html = res.text;
    assert.match(html, /<title>[^<]*Synaps Engineering[^<]*<\/title>/, "tab title = theme title");
    assert.match(html, /id=["']brand-title["'][^>]*>\s*Synaps Engineering/, "identity wordmark");
    assert.match(html, /id=["']brand-monogram["'][^>]*>\s*SE/, "identity monogram");
    assert.match(html, /\/_assets\/theme\.css/, "links generated theme.css");
    assert.ok(!/mahamedia-logo\.svg/.test(html), "static Maha logo replaced by identity block");
  });
});

test("renderShell HTML-escapes theme identity text (no markup injection)", async () => {
  await withServer(async (ctx) => {
    // title is sanitized to text by parseTheme, but renderShell must still escape.
    writeTheme(ctx.repoRoot, {
      schema: "engtheme/1", title: 'Cool & "Neat" Project',
      palette: {}, fonts: { display: "Outfit", ui: "Outfit" },
    });
    const res = await ctx.client.get("/");
    assert.ok(!/<script/i.test(res.text.split("</head>")[1] || res.text), "no injected script in body");
    assert.match(res.text, /Cool &amp; (&quot;|")?Neat/, "ampersand escaped in identity");
  });
});

test("a `theme` SSE event fires when .plans/theme.json changes", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan({ schema: "engtheme/1" } && { schema: "engplan/1", kind: "plan", slug: "alpha", title: "T", status: "drafting", convergence: "none", sections: [{ id: "s1", heading: "S", type: "prose", md: "x" }] });
    const stream = ctx.sse("alpha");
    try {
      await sleep(120);
      writeTheme(ctx.repoRoot, VALID_THEME);
      const ev = await stream.waitFor((e) => e && e.type === "theme", 3000);
      assert.equal(ev.type, "theme", "theme event delivered");
    } finally { stream.close(); }
  });
});
