/*
 * dom.js — minimal headless DOM shim (no jsdom, no network install). Enough for
 * the renderer (plan.js) + DomProbe to run and be asserted in node --test.
 * Supports: createElement, getElementById, querySelector(All), classList,
 * dataset, textContent, innerHTML (stored leaf), appendChild, replaceChild,
 * addEventListener/dispatchEvent('click'), serialize().  Plan H-0/H-1.
 */
"use strict";

function escAttr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

class ClassList {
  constructor(node) { this.node = node; }
  _set() { return new Set((this.node._className || "").split(/\s+/).filter(Boolean)); }
  _save(s) { this.node._className = Array.from(s).join(" "); }
  add(c) { const s = this._set(); s.add(c); this._save(s); }
  remove(c) { const s = this._set(); s.delete(c); this._save(s); }
  contains(c) { return this._set().has(c); }
  toggle(c) { const s = this._set(); if (s.has(c)) s.delete(c); else s.add(c); this._save(s); }
}

class Node {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this._className = "";
    this._text = null;       // when set directly
    this._innerHTML = null;  // sanitized leaf string
    this.dataset = {};
    this._listeners = {};
    this._plan = null; this._ctx = null;
  }
  get classList() { return new ClassList(this); }
  set className(v) { this._className = String(v); }
  get className() { return this._className; }
  get children() { return this.childNodes.filter((n) => n instanceof Node); }
  get firstChild() { return this.childNodes[0] || null; }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === "class") this._className = String(v);
    if (k.indexOf("data-") === 0) this.dataset[camel(k.slice(5))] = String(v);
  }
  getAttribute(k) {
    if (k === "class") return this._className || null;
    return k in this.attributes ? this.attributes[k] : null;
  }
  hasAttribute(k) { return k in this.attributes || (k === "class" && !!this._className); }

  appendChild(node) {
    node.parentNode = this;
    this._innerHTML = null;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) {
    const i = this.childNodes.indexOf(node);
    if (i !== -1) this.childNodes.splice(i, 1);
    node.parentNode = null;
    return node;
  }
  replaceChild(nw, old) {
    const i = this.childNodes.indexOf(old);
    if (i !== -1) { this.childNodes[i] = nw; nw.parentNode = this; old.parentNode = null; }
    return old;
  }

  set textContent(v) { this._text = String(v); this.childNodes = []; this._innerHTML = null; }
  get textContent() {
    if (this._text != null) return this._text;
    if (this._innerHTML != null) return stripTags(this._innerHTML);
    return this.childNodes.map((n) => (n instanceof Node ? n.textContent : String(n))).join("");
  }
  set innerHTML(v) {
    this.childNodes = []; this._text = null;
    this._innerHTML = v === "" ? null : String(v);
  }
  get innerHTML() {
    if (this._innerHTML != null) return this._innerHTML;
    return this.childNodes.map((n) => (n instanceof Node ? n.serialize() : escapeText(String(n)))).join("");
  }

  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  dispatchEvent(ev) { (this._listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; }
  click() { this.dispatchEvent({ type: "click", target: this }); }

  // --- selectors ---
  querySelector(sel) { return this._query(sel, false)[0] || null; }
  querySelectorAll(sel) { return this._query(sel, true); }
  _query(sel, all) {
    const groups = sel.split(",").map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const g of groups) {
      const parts = g.split(/\s+/).filter(Boolean).map(parseSimple);
      collect(this, parts, 0, out, all);
      if (!all && out.length) break;
    }
    return all ? out : out.slice(0, 1);
  }

  serialize() {
    const tag = this.tagName.toLowerCase();
    let attrs = "";
    if (this._className) attrs += ' class="' + escAttr(this._className) + '"';
    for (const k of Object.keys(this.attributes)) {
      if (k === "class") continue;
      attrs += " " + k + '="' + escAttr(this.attributes[k]) + '"';
    }
    for (const dk of Object.keys(this.dataset)) {
      const attrName = "data-" + dk.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
      if (!(attrName in this.attributes)) attrs += " " + attrName + '="' + escAttr(this.dataset[dk]) + '"';
    }
    return "<" + tag + attrs + ">" + this.innerHTML + "</" + tag + ">";
  }
}

function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function escapeText(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function stripTags(s) { return String(s).replace(/<[^>]*>/g, ""); }

function parseSimple(token) {
  // tag, .class(es), [attr] or [attr="v"], #id
  const m = { tag: null, classes: [], attrs: [], id: null };
  const re = /([.#]?[a-zA-Z0-9_-]+)|(\[[^\]]+\])/g;
  let x;
  while ((x = re.exec(token)) !== null) {
    const t = x[1] || x[2];
    if (t[0] === ".") m.classes.push(t.slice(1));
    else if (t[0] === "#") m.id = t.slice(1);
    else if (t[0] === "[") {
      const am = t.slice(1, -1).match(/^([^=~|^$*]+)(?:([~|^$*]?)=["']?([^"']*)["']?)?$/);
      if (am) m.attrs.push({ name: am[1].trim(), op: am[2], val: am[3] });
    } else m.tag = t.toLowerCase();
  }
  return m;
}

function matchSimple(node, m) {
  if (!(node instanceof Node)) return false;
  if (m.tag && node.tagName.toLowerCase() !== m.tag) return false;
  if (m.id && node.getAttribute("id") !== m.id) return false;
  for (const c of m.classes) if (!node.classList.contains(c)) return false;
  for (const a of m.attrs) {
    const v = node.getAttribute(a.name) ?? (node.dataset[camel(a.name.replace(/^data-/, ""))]);
    if (a.val === undefined || a.val === null || a.op === undefined) {
      if (v == null && !node.hasAttribute(a.name)) {
        const dk = camel(a.name.replace(/^data-/, ""));
        if (!(dk in node.dataset)) return false;
      }
    }
    if (a.val !== undefined && a.val !== "") { if (String(v) !== a.val) return false; }
  }
  return true;
}

function collect(node, parts, depth, out, all) {
  for (const child of node.childNodes) {
    if (!(child instanceof Node)) continue;
    if (matchSimple(child, parts[depth])) {
      if (depth === parts.length - 1) { out.push(child); }
      else { collect(child, parts, depth + 1, out, all); }
    }
    // descendant combinator: also try matching same part deeper
    collect(child, parts, depth, out, all);
    if (!all && out.length) return;
  }
}

class Document extends Node {
  constructor() { super(null, "#document"); this.ownerDocument = this; this.readyState = "complete"; this._byId = {}; }
  createElement(tag) { return new Node(this, tag); }
  createTextNode(t) { const n = new Node(this, "#text"); n._text = String(t); return n; }
  getElementById(id) {
    let found = null;
    const walk = (n) => { for (const c of n.childNodes) { if (c instanceof Node) { if (c.getAttribute("id") === id) { found = c; return; } walk(c); if (found) return; } } };
    walk(this);
    return found;
  }
}

function makeDocument() {
  const doc = new Document();
  const html = doc.createElement("html");
  const body = doc.createElement("body");
  html.appendChild(body);
  doc.appendChild(html);
  doc.body = body;
  return doc;
}

// Provide a window-like object with localStorage + EventSource stub.
function makeWindow(doc) {
  const store = {};
  return {
    document: doc,
    __PLAN_TOKEN__: "",
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    },
  };
}

module.exports = { makeDocument, makeWindow, Node, Document };
