/*
 * shell.js — sidebar: list plans with attention counters; live fleet roster.
 * Plan P1-4, P3-7, P5-3. Vanilla JS, no deps.
 */
(function () {
  "use strict";
  var tk = (typeof window !== "undefined" && window.__PLAN_TOKEN__) || "";
  function q(p) { return p + (tk ? (p.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(tk) : ""); }

  function renderList(plans) {
    var nav = document.getElementById("plan-list");
    if (!nav) return;
    nav.innerHTML = "<h2>Plans</h2>";
    plans.forEach(function (p) {
      var a = document.createElement("a");
      a.href = "/plan/" + encodeURIComponent(p.id) + (tk ? "?token=" + encodeURIComponent(tk) : "");
      a.textContent = p.title + " ";
      var attn = document.createElement("span");
      attn.className = "attn";
      var at = p.attention || {};
      if (at.blocking) { var b = document.createElement("span"); b.className = "b"; b.textContent = at.blocking; attn.appendChild(b); }
      if (at.unresolved) { var u = document.createElement("span"); u.className = "u"; u.textContent = at.unresolved; attn.appendChild(u); }
      if (at.needs_review) { var r = document.createElement("span"); r.className = "r"; r.textContent = at.needs_review; attn.appendChild(r); }
      a.appendChild(attn);
      nav.appendChild(a);
    });
  }

  function load() {
    fetch(q("/api/plans")).then(function (r) { return r.json(); }).then(renderList).catch(function () {});
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load);
    else load();
  }
})();
