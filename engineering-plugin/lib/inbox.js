/*
 * inbox.js — Plan Inbox lifecycle, reconcile loop, blocking semantics, and
 * attention counters. Spec §3.3, §3.5, §3.4, §3.8. Plan P3-4..P3-7.
 */
"use strict";
const EngPlan = require("../assets/engplan.js");

// ---- Attention counters (Decision G) ----
// blocking: open/acknowledged `block`
// unresolved: open/acknowledged comment|request_change|clarify
// needs_review: sections with approval==needs-human-review + open `approve` requests
function isOpenish(ev) { return ev.status === "open" || ev.status === "acknowledged"; }

function computeAttention(events, plan) {
  let blocking = 0, unresolved = 0, needs_review = 0, new_criteria = 0;
  (events || []).forEach((ev) => {
    if (!isOpenish(ev)) return;
    if (ev.type === "block") blocking++;
    else if (ev.type === "comment" || ev.type === "request_change" || ev.type === "clarify") unresolved++;
    else if (ev.type === "approve") needs_review++;
    else if (ev.type === "add_acceptance_criterion") new_criteria++;
  });
  if (plan && Array.isArray(plan.sections)) {
    plan.sections.forEach((s) => { if (s.approval === "needs-human-review") needs_review++; });
  }
  return {
    blocking, unresolved, needs_review, new_criteria,
    attention_needed: blocking + unresolved + needs_review + new_criteria,
  };
}

// Sections that currently carry an open/acknowledged block.
function blockedSections(events) {
  const set = new Set();
  (events || []).forEach((ev) => {
    if (ev.type === "block" && isOpenish(ev)) set.add(ev.section_id);
  });
  return set;
}

// Tasks halted because they (or a dependency) are blocked (spec §3.4, P3-6).
function haltedTasks(plan, events) {
  const blocked = blockedSections(events);
  const halted = new Set();
  if (!plan || !Array.isArray(plan.sections)) return halted;
  // direct block
  plan.sections.forEach((s) => { if (blocked.has(s.id)) halted.add(s.id); });
  // transitive via depends_on (a section depending on a blocked section is halted)
  let changed = true;
  while (changed) {
    changed = false;
    plan.sections.forEach((s) => {
      if (halted.has(s.id)) return;
      const deps = s.depends_on || [];
      if (deps.some((d) => halted.has(d) || blocked.has(d))) {
        halted.add(s.id);
        changed = true;
      }
    });
  }
  return halted;
}

// Is a given task eligible to start? Not if it or a dependency is halted.
function canStart(plan, events, sectionId) {
  return !haltedTasks(plan, events).has(sectionId);
}

/**
 * reconcile(plan, events, agentFns, opts) — spec §3.5.
 * For each open event ordered by created_at: acknowledge, evaluate, apply one of
 * incorporate|reject|defer|(raise)block; write agent_response + changed_sections.
 * agentFns.evaluate(ev, plan) -> { decision, response, changed_sections }
 *   decision ∈ incorporated|rejected|deferred|blocked
 * Returns { events, attention, halted }.
 */
function reconcile(plan, events, agentFns, opts) {
  opts = opts || {};
  const now = (opts.clock && opts.clock.now) ? opts.clock.now() : new Date().toISOString();
  const evaluate = (agentFns && agentFns.evaluate) || defaultEvaluate;

  const ordered = (events || []).slice().sort((a, b) => {
    const ca = a.created_at || "", cb = b.created_at || "";
    if (ca < cb) return -1; if (ca > cb) return 1; return 0;
  });

  const result = ordered.map((ev) => {
    // idempotent on resolved events
    if (EngPlan.isTerminal(ev.status)) return ev;
    let cur = ev;
    if (cur.status === "open") cur = EngPlan.transition(cur, "acknowledged");
    const verdict = evaluate(cur, plan) || { decision: "deferred", response: "deferred (no evaluator)", changed_sections: [] };
    let decision = verdict.decision;
    if (["incorporated", "rejected", "deferred", "blocked"].indexOf(decision) === -1) decision = "deferred";
    const next = EngPlan.transition(cur, decision);
    next.agent_status = decision === "blocked" ? "blocked" : decision;
    next.agent_response = verdict.response || "";
    next.changed_sections = Array.isArray(verdict.changed_sections) ? verdict.changed_sections.slice() : [];
    next.responded_at = now;
    return next;
  });

  return {
    events: result,
    attention: computeAttention(result, plan),
    halted: Array.from(haltedTasks(plan, result)),
  };
}

// Default deterministic evaluator: incorporate comments/criteria, keep blocks
// blocked unless caller resolves them, defer the rest. Used by tests/harness.
function defaultEvaluate(ev, plan) {
  switch (ev.type) {
    case "comment":
    case "clarify":
    case "request_change":
    case "add_acceptance_criterion":
      return { decision: "incorporated", response: "Incorporated " + ev.type + " on " + ev.section_id + ".", changed_sections: [ev.section_id] };
    case "block":
      return { decision: "blocked", response: "Acknowledged block on " + ev.section_id + "; halting dependents.", changed_sections: [ev.section_id] };
    case "approve":
      return { decision: "incorporated", response: "Approval recorded for " + ev.section_id + ".", changed_sections: [ev.section_id] };
    default:
      return { decision: "incorporated", response: "Handled " + ev.type + " on " + ev.section_id + ".", changed_sections: [ev.section_id] };
  }
}

module.exports = {
  computeAttention, blockedSections, haltedTasks, canStart, reconcile, defaultEvaluate,
};
