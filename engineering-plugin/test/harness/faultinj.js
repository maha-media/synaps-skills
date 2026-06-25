/*
 * faultinj.js — FaultInj adversarial driver (Addendum A.5, H-4). Actively tries
 * to break the system and asserts correct refusal/halt/sanitize (not crash).
 * Returns structured results so scenarios/tests can assert.
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

// raw HTTP request bypassing the token-aware client (to test auth/bounds).
function raw(base, method, p, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(p, base);
    const data = body == null ? null : (typeof body === "string" ? body : JSON.stringify(body));
    const r = http.request(u, { method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, text, json }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

class FaultInj {
  constructor(ctx) { this.ctx = ctx; this.base = ctx.base; this.token = ctx.token; this.repoRoot = ctx.repoRoot; }

  // missing token → 401
  async missingToken() { return raw(this.base, "GET", "/api/plans"); }
  async wrongToken() { return raw(this.base, "GET", "/api/plans?token=deadbeef"); }

  // path traversal write attempt via notes (plan_id traversal)
  async traversalNoteWrite() {
    return raw(this.base, "POST", "/api/notes?token=" + this.token, {
      plan_id: "../../../../etc/passwd", section_id: "x", type: "comment", actor: "human", text: "x",
    });
  }
  async traversalRead() {
    return raw(this.base, "GET", "/api/notes?plan=" + encodeURIComponent("../../etc/passwd") + "&token=" + this.token);
  }

  // oversized body
  async oversizedBody(slug) {
    const big = "x".repeat(1024 * 1024); // 1MB > 256KB cap
    return raw(this.base, "POST", "/api/notes?token=" + this.token, {
      plan_id: slug, section_id: "s", type: "comment", actor: "human", text: big,
    });
  }
  // malformed JSON
  async malformedJson(slug) {
    return raw(this.base, "POST", "/api/notes?token=" + this.token, "{not json", {});
  }
  // malformed event (bad type)
  async malformedEvent(slug) {
    return raw(this.base, "POST", "/api/notes?token=" + this.token, {
      plan_id: slug, section_id: "s", type: "not_a_real_action", actor: "human", text: "x",
    });
  }

  // Assert nothing was written outside .plans/ — checks the repo for stray files.
  noStrayWrites() {
    const plansDir = path.join(this.repoRoot, ".plans");
    const entries = fs.readdirSync(plansDir);
    // ensure no etc/passwd-like artifact was created in repoRoot
    const root = fs.readdirSync(this.repoRoot);
    return { plansEntries: entries, rootEntries: root };
  }
}

module.exports = { FaultInj, raw };
