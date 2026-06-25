"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withServer } = require("../harness/runner.js");
const { DomProbe } = require("../harness/domprobe.js");

// P4-SEC-6 / §7.3: stored-XSS via a plan section md OR a human note text must be
// neutralized — content is data, never executed.

test("stored-XSS in a human note is sanitized/inert on render", async () => {
  await withServer(async (ctx) => {
    ctx.writePlan({ schema: "engplan/1", kind: "plan", slug: "xss", title: "XSS", status: "drafting", sections: [{ id: "s", heading: "S", type: "prose", md: "ok" }] });
    const payload = '<script>alert(document.cookie)</script><img src=x onerror=alert(1)>';
    const posted = await ctx.client.post("/api/notes", { plan_id: "xss", section_id: "s", type: "comment", actor: "human", text: payload });
    assert.equal(posted.status, 200);
    const got = await ctx.client.get("/api/notes?plan=xss");
    const ev = got.json.events.find((e) => e.id === posted.json.id);
    assert.ok(ev, "note round-trips");
    // render with the malicious event present
    const probe = new DomProbe();
    probe.render({ schema: "engplan/1", kind: "plan", slug: "xss", title: "XSS", status: "drafting", sections: [{ id: "s", heading: "S", type: "prose", md: "ok" }] }, { events: got.json.events });
    assert.equal(probe.hasExecutableScript(), false, "no live <script> element in DOM");
    const notes = probe.noteTexts("s");
    assert.equal(notes[0].text, payload, "note text preserved verbatim as inert textContent");
    assert.ok(!/<script\b/i.test(notes[0].html), "note html has no executable script");
    assert.ok(!/onerror=/i.test(notes[0].html), "note html has no inline handler");
  });
});

test("stored-XSS in a plan section md is sanitized on render", () => {
  const probe = new DomProbe();
  probe.render({ schema: "engplan/1", kind: "plan", slug: "xss2", title: "X", status: "drafting", sections: [
    { id: "s", heading: "S", type: "prose", md: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) <svg onload=alert(1)>' },
  ] });
  const html = probe.section("s").querySelector(".section-body").innerHTML;
  // dangerous raw tags must be neutralized (escaped to text, not live elements)
  assert.ok(!/<img\b/i.test(html), "no live <img> element");
  assert.ok(!/<svg\b/i.test(html), "no live <svg> element");
  assert.ok(!/<script\b/i.test(html), "no live <script> element");
  assert.ok(!/href=["']?javascript:/i.test(html), "no javascript: href attribute");
  assert.equal(probe.hasExecutableScript(), false, "no script element");
});
