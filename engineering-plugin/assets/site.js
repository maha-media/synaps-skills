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

  // ---- routing (pure) ----
  function resolveRoute(pathname) {
    var p = String(pathname || "/");
    var hash = p.indexOf("#"); if (hash !== -1) p = p.slice(0, hash);
    var qi = p.indexOf("?"); if (qi !== -1) p = p.slice(0, qi);
    var m = p.match(/^\/plan\/([^/]+)\/?$/);
    if (m) { try { return { view: "plan", slug: decodeURIComponent(m[1]) }; } catch (_) { return { view: "plan", slug: m[1] }; } }
    return { view: "home", slug: null };
  }

  var SECTION_ICON = { prose: "¶", task: "☑", risk: "⚠", gate: "⛬", criteria: "✓", evidence: "❖", decision: "⚖" };
  function sectionIcon(type) { return SECTION_ICON[type] || "§"; }

  // Recompute + repaint the done/total progress bar from appEl._plan in place.
  // Module-scoped so the live (SSE) path and tests can both drive it.
  function refreshProgress(d, appEl) {
    var plan = appEl && appEl._plan;
    if (!plan) return null;
    var prog = planProgress(plan);
    var label = appEl.querySelector ? appEl.querySelector(".plan-progress .label") : null;
    var fill = appEl.querySelector ? appEl.querySelector(".plan-progress .bar i") : null;
    if (label) label.textContent = prog.done + " / " + prog.total + " tasks (" + prog.pct + "%)";
    if (fill) fill.setAttribute("style", "width:" + prog.pct + "%");
    return prog;
  }

  function stateDotClass(section) {
    if (section.halted) return "s-blocked";
    if (section.type === "task" && section.state) return "s-" + statusToState(section.state);
    return "";
  }

  // ---- cooler plan-detail view (reuses PlanRenderer.renderSection) ----
  function renderDetail(d, appEl, plan, opts) {
    opts = opts || {};
    var ctx = {
      slug: plan.slug, events: opts.events || [], halted: opts.halted || [],
      token: opts.token, fetch: opts.fetch, author: opts.author, EventSource: opts.EventSource,
    };
    appEl.innerHTML = "";

    // header: title (display serif via CSS) + status pill + kind + convergence
    var header = el(d, "header", { class: "plan-header" });
    header.appendChild(el(d, "h1", null, plan.title || plan.slug));
    header.appendChild(el(d, "span", { class: "badge badge-status badge-state-" + statusToState(plan.status) }, plan.status || "—"));
    if (plan.kind) header.appendChild(el(d, "span", { class: "badge badge-kind" }, plan.kind));
    if (plan.convergence && plan.convergence !== "none") header.appendChild(el(d, "span", { class: "badge badge-convergence" }, "convergence: " + plan.convergence));
    appEl.appendChild(header);

    // progress bar (done/total tasks)
    var prog = planProgress(plan);
    var pwrap = el(d, "div", { class: "plan-progress" });
    var bar = el(d, "div", { class: "bar" });
    var fill = el(d, "i"); fill.setAttribute("style", "width:" + prog.pct + "%");
    bar.appendChild(fill);
    pwrap.appendChild(bar);
    pwrap.appendChild(el(d, "span", { class: "label" }, prog.done + " / " + prog.total + " tasks (" + prog.pct + "%)"));
    appEl.appendChild(pwrap);

    // meta line
    var meta = el(d, "div", { class: "plan-meta" });
    if (plan.updated_at) meta.appendChild(el(d, "span", null, "updated " + String(plan.updated_at).slice(0, 10)));
    appEl.appendChild(meta);

    // two-column layout: sections + sticky section-jump nav
    var layout = el(d, "div", { class: "detail-layout" });
    var secCol = el(d, "div", { class: "sections", dataset: { slug: plan.slug } });
    var jump = el(d, "nav", { class: "section-jump", "aria-label": "Jump to section" });

    plan.sections.forEach(function (s) {
      // reuse the existing renderer for the section card + inbox UI
      var node = PlanRenderer
        ? PlanRenderer.renderSection(d, s, ctx)
        : el(d, "section", { class: "plan-section", dataset: { sectionId: s.id } }, s.heading);
      node.setAttribute("id", "sec-" + s.id);
      // type icon + collapse toggle into the section head (CSS positions them)
      var head = node.querySelector ? node.querySelector(".section-head") : null;
      if (head) {
        head.appendChild(el(d, "span", { class: "sec-icon", title: s.type }, sectionIcon(s.type)));
        var toggle = el(d, "button", { class: "collapse-toggle", type: "button", "aria-label": "collapse section" }, "▾");
        if (toggle.addEventListener) toggle.addEventListener("click", function () { node.classList.toggle("collapsed"); });
        head.appendChild(toggle);
      }
      secCol.appendChild(node);

      // jump entry
      var ja = el(d, "a", { href: "#sec-" + s.id, dataset: { sectionId: s.id } });
      ja.appendChild(el(d, "span", { class: "sec-icon" }, sectionIcon(s.type)));
      var dot = el(d, "span", { class: "state-dot " + stateDotClass(s) });
      ja.appendChild(dot);
      ja.appendChild(el(d, "span", { class: "jump-label" }, s.heading));
      if (ja.addEventListener) ja.addEventListener("click", function (ev) {
        if (ev && ev.preventDefault) ev.preventDefault();
        if (node.scrollIntoView) node.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      jump.appendChild(ja);
    });

    layout.appendChild(secCol);
    layout.appendChild(jump);
    appEl.appendChild(layout);
    appEl._plan = plan; appEl._ctx = ctx;
    return plan;
  }

  // ---- browser boot + router (PS-2 sidebar; PS-3 routing + detail) ----
  function api(p, tk) { return withToken(p, tk); }

  function boot() {
    if (typeof document === "undefined" || typeof window === "undefined") return;
    var d = document;
    var tk = resolveToken({});
    var nav = d.getElementById("plan-list");
    var search = d.getElementById("plan-search");
    var appEl = d.getElementById("app");
    var plans = [];
    var live = null; // active SSE subscription (PS-4)

    function paintSidebar() {
      if (!nav) return;
      var route = resolveRoute(window.location.pathname);
      renderSidebar(d, nav, plans, {
        token: tk, activeId: route.slug, query: search ? search.value : "",
        onSelect: function (p, ev) { if (ev && ev.preventDefault) ev.preventDefault(); navigate(withToken("/plan/" + encodeURIComponent(p.id), tk)); },
      });
    }
    function loadPlans() {
      return fetch(api("/api/plans", tk))
        .then(function (r) { return r.json(); })
        .then(function (list) { plans = Array.isArray(list) ? list : []; paintSidebar(); })
        .catch(function () {});
    }

    function teardownLive() { if (live) { try { live.close(); } catch (_) {} live = null; } }

    function renderRoute() {
      if (!appEl) return;
      var route = resolveRoute(window.location.pathname);
      teardownLive();
      paintSidebar();
      if (route.view === "home" || !route.slug) {
        appEl.innerHTML = '<div class="empty-state"><p>Select a plan from the sidebar.</p></div>';
        return;
      }
      appEl.innerHTML = '<div class="loading-state">Loading plan…</div>';
      Promise.all([
        fetch(api("/api/plan/" + encodeURIComponent(route.slug), tk)).then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)); }),
        fetch(api("/api/notes?plan=" + encodeURIComponent(route.slug), tk)).then(function (r) { return r.ok ? r.json() : { events: [] }; }).catch(function () { return { events: [] }; }),
      ]).then(function (res) {
        var plan = res[0]; var notes = res[1] || {};
        renderDetail(d, appEl, plan, { events: notes.events || [], token: tk, fetch: fetch });
        wireLive(route.slug, plan);
      }).catch(function (e) {
        appEl.innerHTML = '<div class="error-state">Could not load plan “' + escapeHtml(route.slug) + '”. ' + escapeHtml(String(e && e.message || e)) + '</div>';
      });
    }

    // PS-4: live SSE for the open plan (re-render section + progress + counters)
    function wireLive(slug, plan) {
      if (!PlanRenderer || !PlanRenderer.subscribeLive) return;
      live = PlanRenderer.subscribeLive(slug, function (patch) {
        if (!patch) return;
        if (patch.type === "filechange") {
          // artifact changed on disk — refetch the JSON + repaint detail
          fetch(api("/api/plan/" + encodeURIComponent(slug), tk))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (np) { if (np && resolveRoute(window.location.pathname).slug === slug) { renderDetail(d, appEl, np, { events: (appEl._ctx && appEl._ctx.events) || [], token: tk, fetch: fetch }); } })
            .catch(function () {});
          debouncedReloadPlans();
        } else if (patch.id && appEl._plan) {
          // direct section patch
          PlanRenderer.applySectionPatch(appEl._plan, patch, appEl, { document: d });
          refreshProgress(d, appEl);
        } else if (patch.type === "note" || patch.type === "respond" || patch.type === "reconcile") {
          debouncedReloadPlans();
        }
      }, { token: tk });
    }

    var reloadTimer = null;
    function debouncedReloadPlans() {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadPlans, 400);
    }

    function navigate(href) {
      try { window.history.pushState({}, "", href); } catch (_) { window.location.href = href; return; }
      renderRoute();
    }

    // intercept in-app navigation clicks (delegated)
    if (d.addEventListener) d.addEventListener("click", function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var t = ev.target;
      while (t && t.tagName !== "A") t = t.parentNode;
      if (!t || !t.getAttribute) return;
      var href = t.getAttribute("href");
      if (!href || href.charAt(0) === "#" || /^https?:|^mailto:/.test(href)) return;
      var route = resolveRoute(href);
      if (route.view === "plan" || href === "/" || href.indexOf("/?") === 0) {
        ev.preventDefault();
        navigate(href);
      }
    });
    if (window.addEventListener) window.addEventListener("popstate", renderRoute);
    if (search && search.addEventListener) search.addEventListener("input", paintSidebar);

    // responsive: toggle the sidebar rail on narrow viewports; close it after
    // a navigation so the chosen plan is visible.
    var railToggle = d.getElementById("rail-toggle");
    if (railToggle && railToggle.addEventListener) railToggle.addEventListener("click", function () {
      var open = d.body.classList.toggle("rail-open");
      railToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    function closeRail() { if (d.body && d.body.classList) { d.body.classList.remove("rail-open"); if (railToggle) railToggle.setAttribute("aria-expanded", "false"); } }
    var _navigate = navigate;
    navigate = function (href) { closeRail(); _navigate(href); };

    loadPlans().then(renderRoute);
    window.__planSite = { reloadPlans: loadPlans, navigate: navigate, renderRoute: renderRoute, getPlans: function () { return plans; } };
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

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
    resolveRoute: resolveRoute,
    sectionIcon: sectionIcon,
    renderDetail: renderDetail,
    refreshProgress: refreshProgress,
    boot: boot,
  };
});
