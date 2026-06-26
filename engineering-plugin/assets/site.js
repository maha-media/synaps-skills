/*
 * site.js — The Plan Site SPA: brand chrome, persistent sidebar, client-side
 * router, cooler plan-detail view, live wiring. Vanilla JS, no deps, no CDN.
 *
 * Universal module: in the browser it auto-boots and owns the shell; in Node
 * tests it is required and exercised with an injected `document`. The sidebar
 * and detail logic are pure functions so they can be asserted headlessly.
 *
 * Reuses the existing PlanRenderer (plan.js) for section rendering + the Plan
 * Inbox UI — restyled by site.css, not rewritten.  Plan PS-2..PS-5.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(typeof require === "function" ? require("./plan.js") : null);
  } else {
    root.PlanSite = factory(root.PlanRenderer);
  }
})(typeof self !== "undefined" ? self : this, function (PlanRenderer) {
  "use strict";

  var KIND_GLYPH = { plan: "◆", spec: "✦", note: "•" };
  function kindGlyph(kind) { return KIND_GLYPH[kind] || "◇"; }

  // ---- token (resolver order: injected global → URL ?token= → opts) ----
  function resolveToken(opts) {
    if (PlanRenderer && PlanRenderer.resolveToken) return PlanRenderer.resolveToken(opts || {});
    if (typeof window !== "undefined") {
      if (window.__PLAN_TOKEN__) return window.__PLAN_TOKEN__;
      try {
        var qt = window.location && window.location.search &&
          new URLSearchParams(window.location.search).get("token");
        if (qt) return qt;
      } catch (_) {}
    }
    return (opts && opts.token) || "";
  }
  function withToken(p, tk) { return p + (tk ? (p.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(tk) : ""); }

  // ---- pure helpers (unit-tested headless) ----
  function filterPlans(plans, query) {
    var q = String(query || "").trim().toLowerCase();
    if (!q) return plans.slice();
    return plans.filter(function (p) {
      return [p.title, p.id, p.kind, p.status]
        .map(function (x) { return String(x || "").toLowerCase(); })
        .some(function (x) { return x.indexOf(q) !== -1; });
    });
  }

  function el(d, tag, attrs, text) {
    var n = d.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "class") n.className = attrs[k];
      else if (k === "dataset") Object.keys(attrs[k]).forEach(function (dk) { n.dataset[dk] = attrs[k][dk]; });
      else n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = String(text);
    return n;
  }

  function attentionChips(d, attn) {
    var box = el(d, "span", { class: "attn" });
    attn = attn || {};
    if (attn.blocking) box.appendChild(el(d, "span", { class: "b", title: "blocking" }, attn.blocking));
    if (attn.unresolved) box.appendChild(el(d, "span", { class: "u", title: "unresolved" }, attn.unresolved));
    if (attn.needs_review) box.appendChild(el(d, "span", { class: "r", title: "needs review" }, attn.needs_review));
    return box;
  }

  // renderSidebar(d, container, plans, opts) — fills `container` with one row
  // per plan: kind glyph + title + status pill + attention chips. opts:
  // { token, activeId, query, onSelect }. Returns the number of rows rendered.
  function renderSidebar(d, container, plans, opts) {
    opts = opts || {};
    var tk = opts.token != null ? opts.token : resolveToken(opts);
    var list = filterPlans(plans || [], opts.query || "");
    container.innerHTML = "";
    list.forEach(function (p) {
      var href = withToken("/plan/" + encodeURIComponent(p.id), tk);
      var a = el(d, "a", { class: "plan-row" + (p.id === opts.activeId ? " active" : ""), href: href, dataset: { planId: p.id } });
      a.appendChild(el(d, "span", { class: "kind-glyph type-" + (p.kind || "plan") }, kindGlyph(p.kind)));
      var meta = el(d, "span", { class: "row-meta" });
      meta.appendChild(el(d, "span", { class: "row-title" }, p.title || p.id));
      var pills = el(d, "span", { class: "row-pills" });
      pills.appendChild(el(d, "span", { class: "badge badge-status badge-state-" + statusToState(p.status) }, p.status || "—"));
      pills.appendChild(attentionChips(d, p.attention));
      meta.appendChild(pills);
      a.appendChild(meta);
      if (opts.onSelect && a.addEventListener) a.addEventListener("click", function (ev) { opts.onSelect(p, ev); });
      container.appendChild(a);
    });
    return list.length;
  }

  // map plan/section status → a state class for the brand pill palette
  function statusToState(status) {
    switch (String(status || "")) {
      case "in_progress": case "drafting": case "doing": return "doing";
      case "done": case "approved": case "complete": return "done";
      case "blocked": case "halted": return "blocked";
      default: return "todo";
    }
  }

  // ---- progress (done tasks / total tasks) computed client-side ----
  function planProgress(plan) {
    var tasks = (plan && plan.sections || []).filter(function (s) { return s.type === "task"; });
    var done = tasks.filter(function (s) { return s.state === "done"; }).length;
    return { done: done, total: tasks.length, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0 };
  }

  // ---- browser boot (PS-2: render the persistent sidebar; PS-3 adds routing) ----
  function api(p, tk) { return withToken(p, tk); }

  function boot() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    var d = document;
    var tk = resolveToken({});
    var nav = d.getElementById("plan-list");
    var search = d.getElementById("plan-search");
    var appEl = d.getElementById("app");
    var plans = [];

    function activeId() {
      var m = String(window.location.pathname || "").match(/^\/plan\/([^/?#]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    }
    function paint() {
      if (!nav) return;
      renderSidebar(d, nav, plans, { token: tk, activeId: activeId(), query: search ? search.value : "" });
    }
    function loadPlans() {
      return fetch(api("/api/plans", tk))
        .then(function (r) { return r.json(); })
        .then(function (list) { plans = Array.isArray(list) ? list : []; paint(); })
        .catch(function () {});
    }
    if (search && search.addEventListener) search.addEventListener("input", paint);
    if (appEl && !activeId() && !appEl.querySelector(".plan-header")) {
      appEl.innerHTML = '<div class="empty-state"><p>Select a plan from the sidebar.</p></div>';
    }
    loadPlans();
    // expose for the PS-3 router to reuse
    window.__planSite = { reloadPlans: loadPlans, repaint: paint, getPlans: function () { return plans; } };
  }

  if (typeof document !== "undefined" && typeof window !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  return {
    kindGlyph: kindGlyph,
    filterPlans: filterPlans,
    renderSidebar: renderSidebar,
    attentionChips: attentionChips,
    statusToState: statusToState,
    planProgress: planProgress,
    resolveToken: resolveToken,
    withToken: withToken,
    boot: boot,
  };
});
