/*
 * summary.js — Checkpoint-Aware Compaction (CAC) artifact-anchored summary.
 * Implements spec §6 "Artifact-anchored summary" (and §3 "why artifacts are
 * ground truth", §11 S-CAC-6).
 *
 * The compaction summary is REGENERATED from artifacts, never excerpted from
 * the conversation tail. Sources, in §6 priority order:
 *   1. Plan: embedded engplan/1 JSON from .plans/<slug>.plan.html
 *      (discovery.extractPlanJson + EngPlan.parseEngPlan for title/status/
 *      sections; raw `checkpoints[]` read off the raw object — the parser
 *      drops it, so we do NOT reimplement parsing).
 *   2. Git log: `git log --oneline <base>..HEAD` → what landed.
 *   3. Latest verdict(s) / open Plan Inbox events → outstanding work + grades.
 *   4. The resume token → active_phase, next_action, outstanding, loop intent.
 *
 * Rules (§6/§5.1):
 *   - The generic transcript summary (input.transcript) is appended as
 *     SECONDARY context only. ARTIFACTS WIN ON CONFLICT.
 *   - FAIL CLOSED: a summary without `next_action` is invalid — buildSummary
 *     THROWS when next_action is missing/empty (resume token absent or lacks it).
 *
 * All I/O is injectable so unit tests are hermetic. When raw artifacts are not
 * passed, they are read from disk (planHtml from .plans/<slug>.plan.html, token
 * via RT.read, git log via git.logOneline). Tests inject everything directly.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const discovery = require("../discovery.js");
const EngPlan = require("../../assets/engplan.js");
const RT = require("./resume_token.js");
const git = require("./git.js");

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function planHtmlPath(repoRoot, slug) {
  return path.join(repoRoot, ".plans", slug + ".plan.html");
}

/**
 * Resolve the raw embedded engplan/1 JSON object from the available sources.
 * Priority: input.planJson (raw object) > input.planHtml (extract) > disk read.
 * Returns the raw object (with any `checkpoints[]`) or null when unavailable.
 */
function resolveRawPlan(input) {
  if (input.planJson !== undefined && input.planJson !== null) {
    if (typeof input.planJson === "string") {
      const extracted = JSON.parse(input.planJson);
      return extracted;
    }
    if (!isObj(input.planJson)) {
      throw new Error("input.planJson must be an object or JSON string");
    }
    return input.planJson;
  }
  let html = input.planHtml;
  if (html === undefined || html === null) {
    if (!input.repoRoot || !input.slug) return null;
    const file = planHtmlPath(input.repoRoot, input.slug);
    try {
      html = fs.readFileSync(file, "utf8");
    } catch (_) {
      return null;
    }
  }
  if (typeof html !== "string") {
    throw new Error("input.planHtml must be a string");
  }
  return discovery.extractPlanJson(html);
}

/**
 * Normalize a raw checkpoints[] array (off the raw plan JSON) into a stable
 * shape: [{ id, status?, pass?, ...passthrough }]. Returns null when absent.
 */
function normalizeCheckpoints(raw) {
  if (!isObj(raw)) return null;
  if (!Array.isArray(raw.checkpoints)) return null;
  return raw.checkpoints.map((cp) => {
    if (typeof cp === "string") return { id: cp };
    if (isObj(cp)) {
      const out = {};
      if (typeof cp.id === "string") out.id = cp.id;
      if (cp.pass !== undefined) out.pass = cp.pass;
      if (cp.status !== undefined) out.status = cp.status;
      if (typeof cp.phase === "string") out.phase = cp.phase;
      if (typeof cp.note === "string") out.note = cp.note;
      return out;
    }
    return { id: String(cp) };
  });
}

/**
 * Resolve the normalized resume token from input.resumeToken (object) or by
 * reading .plans/<slug>.resume.json via RT.read. Returns null when neither is
 * available (caller fails closed on missing next_action).
 */
function resolveResumeToken(input) {
  if (input.resumeToken !== undefined && input.resumeToken !== null) {
    // Validate/normalize through the canonical resume-token validator.
    return RT.validate(input.resumeToken);
  }
  if (input.repoRoot && input.slug) {
    try {
      return RT.read(input.repoRoot, input.slug);
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Resolve landed commits (newest first) from injected logLines or git.logOneline.
 */
function resolveLandedCommits(input) {
  if (input.logLines !== undefined && input.logLines !== null) {
    if (!isStringArray(input.logLines)) {
      throw new Error("input.logLines must be an array of strings");
    }
    return input.logLines.map((l) => l.trim()).filter((l) => l.length > 0);
  }
  if (input.repoRoot && (typeof input.base === "string" || input.git)) {
    const range = typeof input.base === "string" && input.base.length > 0
      ? input.base + "..HEAD"
      : undefined;
    try {
      return git.logOneline(input.repoRoot, range, input.git || {});
    } catch (_) {
      return [];
    }
  }
  return [];
}

/**
 * Resolve outstanding work + grades from verdict(s) and inbox events.
 * Returns { outstanding[], grades[] }. Verdict may be a single object or an
 * array; inboxEvents is an array of plan-inbox-ish event objects.
 */
function resolveVerdicts(input) {
  const outstanding = [];
  const grades = [];

  const verdicts = [];
  if (input.verdict !== undefined && input.verdict !== null) {
    if (Array.isArray(input.verdict)) {
      for (const v of input.verdict) verdicts.push(v);
    } else {
      verdicts.push(input.verdict);
    }
  }
  for (let v of verdicts) {
    if (typeof v === "string") {
      try { v = JSON.parse(v); } catch (_) { continue; }
    }
    if (!isObj(v)) continue;
    if (typeof v.grade === "string" || typeof v.grade === "number") {
      grades.push({
        grade: v.grade,
        slug: typeof v.slug === "string" ? v.slug : undefined,
        verdict: typeof v.verdict === "string" ? v.verdict : undefined,
      });
    } else if (typeof v.verdict === "string") {
      grades.push({ verdict: v.verdict, slug: typeof v.slug === "string" ? v.slug : undefined });
    }
    if (isStringArray(v.outstanding)) {
      for (const o of v.outstanding) outstanding.push(o);
    }
    if (isStringArray(v.survivors)) {
      for (const s of v.survivors) outstanding.push(s);
    }
  }

  if (Array.isArray(input.inboxEvents)) {
    for (const ev of input.inboxEvents) {
      if (!isObj(ev)) continue;
      // Open events contribute their summary/title as outstanding work.
      const open = ev.status === undefined || ev.status === "open" || ev.resolved === false;
      if (open) {
        const text = typeof ev.summary === "string" ? ev.summary
          : typeof ev.title === "string" ? ev.title
          : typeof ev.message === "string" ? ev.message : null;
        if (text) outstanding.push(text);
      }
    }
  }

  return { outstanding, grades };
}

function dedupePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

/**
 * Build the artifact-anchored compaction summary (§6).
 *
 * @param {object} input
 *   - repoRoot, slug          : for disk fallback reads
 *   - planHtml / planJson     : raw plan artifact (html string or engplan/1 obj)
 *   - logLines / base         : landed commits (or git log range base)
 *   - git                     : injectable runner opts forwarded to git.logOneline
 *   - verdict                 : verdict object/array/json-string (grades + outstanding)
 *   - inboxEvents             : open Plan Inbox events (outstanding work)
 *   - resumeToken             : resume/1 token object (active_phase/next_action/loop)
 *   - transcript              : SECONDARY generic summary (string or {active_phase,text})
 * @returns {{ object: object, markdown: string }}
 * @throws if next_action is missing/empty (fail closed, §6/§5.1).
 */
function buildSummary(input) {
  if (!isObj(input)) throw new Error("buildSummary(input): input must be an object");

  const token = resolveResumeToken(input);

  // FAIL CLOSED: a summary without the next action is invalid (§6/§5.1).
  const nextAction = token && typeof token.next_action === "string" ? token.next_action.trim() : "";
  if (nextAction.length === 0) {
    throw new Error(
      "buildSummary: missing next_action — refusing to build summary (fail closed, §6/§5.1)"
    );
  }

  const rawPlan = resolveRawPlan(input);
  let plan = null;
  if (rawPlan !== null) {
    try {
      plan = EngPlan.parseEngPlan(rawPlan);
    } catch (_) {
      plan = null; // invalid plan JSON: degrade gracefully, token still drives.
    }
  }
  const checkpoints = normalizeCheckpoints(rawPlan);

  const landedCommits = resolveLandedCommits(input);
  const { outstanding: verdictOutstanding, grades } = resolveVerdicts(input);

  // ARTIFACTS WIN ON CONFLICT: active_phase comes from the resume token (§5.1),
  // never from the transcript. Detect + record (but do not apply) any conflict.
  const artifactPhase = token.active_phase;

  let transcriptText = null;
  let transcriptPhase = null;
  if (input.transcript !== undefined && input.transcript !== null) {
    if (typeof input.transcript === "string") {
      transcriptText = input.transcript;
    } else if (isObj(input.transcript)) {
      transcriptText = typeof input.transcript.text === "string" ? input.transcript.text : null;
      transcriptPhase = typeof input.transcript.active_phase === "string"
        ? input.transcript.active_phase : null;
    } else {
      throw new Error("input.transcript must be a string or object");
    }
  }

  const conflicts = [];
  if (transcriptPhase && transcriptPhase !== artifactPhase) {
    conflicts.push(
      "transcript claims active_phase " + JSON.stringify(transcriptPhase) +
        " but artifacts say " + JSON.stringify(artifactPhase) + " (artifacts win)"
    );
  }

  // Outstanding work: union of token.outstanding + verdict/inbox outstanding.
  const outstanding = dedupePreserveOrder([
    ...(isStringArray(token.outstanding) ? token.outstanding : []),
    ...verdictOutstanding,
  ]);

  const object = {
    slug: token.slug,
    title: plan ? plan.title : null,
    plan_status: plan ? plan.status : null,
    active_phase: artifactPhase, // ARTIFACTS WIN — never the transcript's claim.
    last_checkpoint: token.last_checkpoint,
    next_action: nextAction,
    outstanding: outstanding,
    landed_commits: landedCommits,
    loop: { kind: token.loop.kind, continue: token.loop.continue },
  };
  if (checkpoints !== null) object.checkpoints = checkpoints;
  if (grades.length > 0) object.grades = grades;
  if (conflicts.length > 0) object.conflicts = conflicts;
  if (transcriptText !== null) object.transcript = transcriptText; // SECONDARY only.

  return { object: object, markdown: renderMarkdown(object) };
}

/**
 * Render the structured summary object to markdown. The active_phase,
 * next_action, and outstanding items are always surfaced (continuity-critical).
 */
function renderMarkdown(o) {
  const lines = [];
  const titlePart = o.title ? " — " + o.title : "";
  lines.push("# Checkpoint compaction summary: " + o.slug + titlePart);
  lines.push("");
  lines.push("- **Plan status:** " + (o.plan_status || "(unknown)"));
  lines.push("- **Active phase:** " + o.active_phase);
  lines.push("- **Last checkpoint:** " + o.last_checkpoint);
  lines.push("- **Next action:** " + o.next_action);
  lines.push(
    "- **Loop:** " + o.loop.kind + " (continue=" + String(o.loop.continue) + ")"
  );
  lines.push("");

  lines.push("## Outstanding");
  if (o.outstanding.length === 0) {
    lines.push("- (none)");
  } else {
    for (const item of o.outstanding) lines.push("- " + item);
  }
  lines.push("");

  lines.push("## Landed commits");
  if (o.landed_commits.length === 0) {
    lines.push("- (none)");
  } else {
    for (const c of o.landed_commits) lines.push("- " + c);
  }
  lines.push("");

  if (Array.isArray(o.checkpoints)) {
    lines.push("## Checkpoints");
    if (o.checkpoints.length === 0) {
      lines.push("- (none)");
    } else {
      for (const cp of o.checkpoints) {
        const status = cp.pass === true ? "pass"
          : cp.pass === false ? "fail"
          : cp.status !== undefined ? String(cp.status) : "?";
        lines.push("- " + (cp.id || "(unnamed)") + ": " + status);
      }
    }
    lines.push("");
  }

  if (Array.isArray(o.grades) && o.grades.length > 0) {
    lines.push("## Grades");
    for (const g of o.grades) {
      const parts = [];
      if (g.grade !== undefined) parts.push("grade=" + String(g.grade));
      if (g.verdict !== undefined) parts.push("verdict=" + String(g.verdict));
      if (g.slug !== undefined) parts.push("slug=" + String(g.slug));
      lines.push("- " + parts.join(" "));
    }
    lines.push("");
  }

  if (Array.isArray(o.conflicts) && o.conflicts.length > 0) {
    lines.push("## Conflicts (artifacts win)");
    for (const c of o.conflicts) lines.push("- " + c);
    lines.push("");
  }

  if (typeof o.transcript === "string" && o.transcript.length > 0) {
    lines.push("## Transcript (secondary context only)");
    lines.push("");
    lines.push(o.transcript);
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

module.exports = { buildSummary, renderMarkdown };
