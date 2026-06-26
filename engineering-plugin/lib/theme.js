/*
 * theme.js — engtheme/1: dynamic per-repo Plan Site identity & theme (DT-0).
 *
 * Single source of truth for:
 *   - defaultTheme       the Maha-Media look as an engtheme/1 constant
 *   - FONT_REGISTRY      bundled local WOFF2 families + system stacks (no CDN)
 *   - parseTheme         never-throws, per-key validation + fallback (render path)
 *   - parseThemeStrict   same, but returns { theme, errors[] } for `plan theme`
 *   - inferTheme         bounded, no-network deterministic inference from a repo
 *   - resolveTheme       file(.plans/theme.json) → inferred → default (+ _source)
 *   - themeCss           sanitized :root emitter + @font-face for USED families
 *
 * Security: every color emitted into CSS passes a strict allowlist regex
 * (no CSS injection); title/tagline/monogram are sanitized to plain text (the
 * server HTML-escapes them at render). parseTheme/resolveTheme never throw on
 * the render path. Node stdlib only; zero external/network access.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- strict color allowlist (the ONLY values allowed into CSS) ----
// #rgb | #rrggbb | #rrggbbaa | rgb()/rgba() with NUMERIC args only.
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/;
function isColor(v) { return typeof v === "string" && (HEX.test(v.trim()) || RGB.test(v.trim())); }

// ---- bundled font library (local WOFF2; one variable file per family) ----
const FONT_FAMILIES = [
  { name: "Cormorant Garamond", file: "cormorant-garamond-latin.woff2", stack: 'Georgia,"Times New Roman",serif', weights: "300 700" },
  { name: "Outfit", file: "outfit-latin.woff2", stack: 'system-ui,-apple-system,"Segoe UI",Roboto,sans-serif', weights: "100 900" },
  { name: "Space Grotesk", file: "space-grotesk-latin.woff2", stack: "system-ui,sans-serif", weights: "300 700" },
  { name: "Inter", file: "inter-latin.woff2", stack: "system-ui,sans-serif", weights: "100 900" },
  { name: "JetBrains Mono", file: "jetbrains-mono-latin.woff2", stack: "ui-monospace,monospace", weights: "100 800" },
  { name: "Fraunces", file: "fraunces-latin.woff2", stack: "Georgia,serif", weights: "100 900" },
  { name: "Work Sans", file: "work-sans-latin.woff2", stack: "system-ui,sans-serif", weights: "100 900" },
  { name: "Archivo", file: "archivo-latin.woff2", stack: "system-ui,sans-serif", weights: "100 900" },
];
const SYSTEM_STACKS = [
  { id: "system-serif", stack: 'Georgia,"Times New Roman",serif' },
  { id: "system-sans", stack: "system-ui,-apple-system,Segoe UI,Roboto,sans-serif" },
  { id: "system-mono", stack: "ui-monospace,SFMono-Regular,Menlo,monospace" },
];

// registry keyed by lower-cased family name / system id.
const FONT_REGISTRY = (() => {
  const reg = {};
  for (const f of FONT_FAMILIES) {
    reg[f.name.toLowerCase()] = {
      name: f.name, file: "/_assets/fonts/" + f.file, stack: f.stack, weights: f.weights, system: false,
    };
  }
  for (const s of SYSTEM_STACKS) {
    reg[s.id] = { name: s.id, file: null, stack: s.stack, weights: null, system: true };
  }
  return reg;
})();

// Suggested pairings (advisory; the LLM may mix any display+ui).
const FONT_PAIRINGS = {
  editorial: { display: "Cormorant Garamond", ui: "Outfit" },
  geometric: { display: "Space Grotesk", ui: "Inter" },
  techno: { display: "JetBrains Mono", ui: "Inter" },
  expressive: { display: "Fraunces", ui: "Work Sans" },
  bold: { display: "Archivo", ui: "Archivo" },
  clean: { display: "Inter", ui: "Inter" },
};

const PALETTE_KEYS = ["bg", "surface", "surface2", "text", "muted", "border", "accent",
  "accentSoft", "stateTodo", "stateDoing", "stateDone", "stateBlocked", "warn", "review"];

// ---- the Maha-Media default theme (current look) ----
const defaultTheme = Object.freeze({
  schema: "engtheme/1",
  title: "Plans",
  tagline: "the engineering plan site",
  monogram: "◆",
  palette: Object.freeze({
    bg: "#0d0d0d", surface: "#1e1e1e", surface2: "#161616",
    text: "#f5f2eb", muted: "#b8b4aa", border: "rgba(245,242,235,.08)",
    accent: "#d4a574", accentSoft: "rgba(212,165,116,.12)",
    stateTodo: "#6a8296", stateDoing: "#d4a574", stateDone: "#7faf7f",
    stateBlocked: "#d47474", warn: "#d4a054", review: "#d48a74",
  }),
  fonts: Object.freeze({ display: "Cormorant Garamond", ui: "Outfit" }),
  generated_by: "default",
});

// ---- sanitizers ----
function sanitizeText(v, max) {
  if (typeof v !== "string") return "";
  // strip markup + control chars, collapse whitespace, clamp length.
  let s = v.replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}
function deriveMonogram(title) {
  const words = String(title || "").split(/[\s\-_]+/).filter(Boolean);
  if (!words.length) return "◆";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// resolve a requested font name → a registry entry (case-insensitive) or null.
function lookupFont(name) {
  if (typeof name !== "string") return null;
  return FONT_REGISTRY[name.trim().toLowerCase()] || null;
}

// ---- parse (never throws) ----
// returns a complete, valid engtheme/1 object using per-key fallback to default.
function parseTheme(obj) {
  const { theme } = parseThemeStrict(obj, { silent: true });
  return theme;
}

// strict variant — same repair logic, but collects human-readable errors.
function parseThemeStrict(obj, opts) {
  opts = opts || {};
  const errors = [];
  const src = (obj && typeof obj === "object") ? obj : {};

  if (src.schema !== "engtheme/1") {
    errors.push('schema must be "engtheme/1" (got ' + JSON.stringify(src.schema) + ")");
  }

  // title (required-ish): fall back to default if empty after sanitize.
  let title = sanitizeText(src.title, 80);
  if (!title) { if (src.title != null) errors.push("title empty/invalid → default"); title = defaultTheme.title; }
  else if (typeof src.title === "string" && src.title.length > 80) errors.push("title > 80 chars → clamped");

  // tagline (optional)
  let tagline;
  if (src.tagline == null) tagline = "";
  else { tagline = sanitizeText(src.tagline, 140); if (typeof src.tagline === "string" && src.tagline.length > 140) errors.push("tagline > 140 chars → clamped"); }

  // monogram (optional, ≤3, else derived from title initials)
  let monogram = sanitizeText(src.monogram, 3);
  if (!monogram) monogram = deriveMonogram(title);
  else if (typeof src.monogram === "string" && src.monogram.length > 3) errors.push("monogram > 3 chars → clamped");

  // palette — per-key strict color allowlist; bad/missing keys fall back.
  const palette = {};
  const inPal = (src.palette && typeof src.palette === "object") ? src.palette : {};
  for (const k of PALETTE_KEYS) {
    const v = inPal[k];
    if (v == null) { palette[k] = defaultTheme.palette[k]; continue; }
    if (isColor(v)) { palette[k] = String(v).trim(); }
    else { errors.push("palette." + k + " is not a strict color → default (" + JSON.stringify(v) + ")"); palette[k] = defaultTheme.palette[k]; }
  }

  // fonts — must resolve in the registry, else default pairing per role.
  const inFonts = (src.fonts && typeof src.fonts === "object") ? src.fonts : {};
  let display = lookupFont(inFonts.display);
  if (!display) { if (inFonts.display != null) errors.push("fonts.display unknown → default (" + JSON.stringify(inFonts.display) + ")"); display = lookupFont(defaultTheme.fonts.display); }
  let ui = lookupFont(inFonts.ui);
  if (!ui) { if (inFonts.ui != null) errors.push("fonts.ui unknown → default (" + JSON.stringify(inFonts.ui) + ")"); ui = lookupFont(defaultTheme.fonts.ui); }

  const generatedBy = ["llm", "inferred", "default", "human"].indexOf(src.generated_by) !== -1
    ? src.generated_by : "human";

  const theme = {
    schema: "engtheme/1",
    title, tagline, monogram,
    palette,
    fonts: { display: display.name, ui: ui.name },
    generated_by: generatedBy,
  };
  if (typeof src.generated_at === "string") theme.generated_at = sanitizeText(src.generated_at, 40);
  if (typeof src.rationale === "string") theme.rationale = sanitizeText(src.rationale, 400);

  return { theme, errors };
}

// ---- themeCss (sanitized emitter) ----
function hexToRgba(hex, alpha) {
  const m = hex.trim().match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
}

function fontFaceBlock(entry) {
  return [
    "@font-face{",
    'font-family:"' + entry.name + '";',
    'src:url("' + entry.file + '") format("woff2");',
    "font-weight:" + entry.weights + ";",
    "font-style:normal;font-display:swap;}",
  ].join("");
}
function fontCss(entry) {
  return entry.system ? entry.stack : '"' + entry.name + '",' + entry.stack;
}

// Emit :root vars + @font-face for ONLY the two used families. The theme is
// re-parsed defensively so a raw/unsanitized object can never inject CSS.
function themeCss(input) {
  const t = parseTheme(input);
  const p = t.palette;
  const display = lookupFont(t.fonts.display) || lookupFont(defaultTheme.fonts.display);
  const ui = lookupFont(t.fonts.ui) || lookupFont(defaultTheme.fonts.ui);

  const faces = [];
  const seen = new Set();
  for (const e of [display, ui]) {
    if (e.file && !seen.has(e.name)) { seen.add(e.name); faces.push(fontFaceBlock(e)); }
  }

  const goldLine = hexToRgba(p.accent, "0.22") || p.accentSoft;
  const root = [
    ":root{",
    "--bg:" + p.bg + ";",
    "--surface:" + p.surface + ";",
    "--surface-2:" + p.surface2 + ";",
    "--text:" + p.text + ";",
    "--muted:" + p.muted + ";",
    "--border:" + p.border + ";",
    "--gold:" + p.accent + ";",
    "--gold-soft:" + p.accentSoft + ";",
    "--gold-line:" + goldLine + ";",
    "--state-todo:" + p.stateTodo + ";",
    "--state-doing:" + p.stateDoing + ";",
    "--state-done:" + p.stateDone + ";",
    "--state-blocked:" + p.stateBlocked + ";",
    "--warn:" + p.warn + ";",
    "--review:" + p.review + ";",
    "--font-display:" + fontCss(display) + ";",
    "--font-ui:" + fontCss(ui) + ";",
    // legacy aliases referenced by plan.css / standalone files
    "--fg:var(--text);--accent:var(--gold);--bad:var(--state-blocked);",
    "--ok:var(--state-done);--panel:var(--surface);--panel-2:var(--surface-2);",
    "}",
  ].join("");

  return (faces.length ? faces.join("\n") + "\n" : "") + root + "\n";
}

// ---- inference (bounded, no network) ----
const ACCENTS = ["#d4a574", "#7aa2f7", "#9ece6a", "#bb9af7", "#e0af68", "#f7768e", "#73daca", "#ff9e64", "#7dcfff", "#e6a3c9"];

function titleCase(s) {
  return String(s).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
    .split(" ").map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" ");
}
function prettifyPkgName(name) {
  return titleCase(String(name).replace(/^@[^/]+\//, "").replace(/[-_./]+/g, " "));
}
function readFileSafe(p, max) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > (max || 256 * 1024)) return null;
    return fs.readFileSync(p, "utf8");
  } catch (_) { return null; }
}
function tryJson(txt) { try { return JSON.parse(txt); } catch (_) { return null; } }

function inferTitle(repoRoot) {
  // package.json name
  const pkg = tryJson(readFileSafe(path.join(repoRoot, "package.json")) || "");
  if (pkg && typeof pkg.name === "string" && pkg.name.trim()) {
    return { title: prettifyPkgName(pkg.name), tagline: typeof pkg.description === "string" ? pkg.description : "" };
  }
  // Cargo.toml [package] name
  const cargo = readFileSafe(path.join(repoRoot, "Cargo.toml"));
  if (cargo) {
    const m = cargo.match(/\[package\][\s\S]*?\bname\s*=\s*"([^"]+)"/);
    const d = cargo.match(/\[package\][\s\S]*?\bdescription\s*=\s*"([^"]+)"/);
    if (m) return { title: prettifyPkgName(m[1]), tagline: d ? d[1] : "" };
  }
  // pyproject.toml name
  const py = readFileSafe(path.join(repoRoot, "pyproject.toml"));
  if (py) {
    const m = py.match(/\bname\s*=\s*"([^"]+)"/);
    const d = py.match(/\bdescription\s*=\s*"([^"]+)"/);
    if (m) return { title: prettifyPkgName(m[1]), tagline: d ? d[1] : "" };
  }
  // README H1
  for (const r of ["README.md", "README.MD", "Readme.md", "README"]) {
    const txt = readFileSafe(path.join(repoRoot, r));
    if (txt) {
      const h1 = txt.match(/^#\s+(.+)$/m);
      if (h1) {
        const sub = txt.match(/^>\s+(.+)$/m);
        return { title: sanitizeText(h1[1], 80), tagline: sub ? sanitizeText(sub[1], 140) : "" };
      }
    }
  }
  // directory name
  return { title: titleCase(path.basename(repoRoot)) || "Plans", tagline: "" };
}

// Bounded scan for a dominant brand hex color from likely sources.
function inferAccent(repoRoot) {
  const IGNORE = new Set([".git", "node_modules", ".worktrees", "target", "__pycache__", "dist", "build", ".plans"]);
  const NAME_RE = /(theme.*\.css|tailwind\.config\.|\.svg$|\.css$)/i;
  let scanned = 0;
  const found = [];
  (function walk(dir, depth) {
    if (depth > 3 || scanned > 200 || found.length > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (found.length > 8 || scanned > 200) return;
      if (IGNORE.has(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && NAME_RE.test(ent.name)) {
        scanned++;
        const txt = readFileSafe(full, 128 * 1024);
        if (!txt) continue;
        const hexes = txt.match(/#[0-9a-fA-F]{6}\b/g) || [];
        for (const h of hexes) found.push(h.toLowerCase());
      }
    }
  })(repoRoot, 0);
  // first "vivid" hex (not near-black / near-white / near-grey)
  for (const h of found) {
    const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max < 40 || min > 220) continue;       // too dark / too light
    if (max - min < 24) continue;              // too grey
    return h;
  }
  return null;
}

// pick a deterministic accent from a stable identity key (project title) when
// no brand color is found. Hashing the identity — not the on-disk path — keeps
// the accent stable per project and varied across projects regardless of where
// the repo is checked out (e.g. random temp dirs).
function hashAccent(key) {
  const k = (key && String(key).trim()) || "repo";
  const h = crypto.createHash("sha1").update(k).digest();
  return ACCENTS[h[0] % ACCENTS.length];
}

function inferFonts(repoRoot) {
  // light language/keyword heuristic → a suggested pairing.
  if (readFileSafe(path.join(repoRoot, "Cargo.toml"))) return FONT_PAIRINGS.techno;
  if (readFileSafe(path.join(repoRoot, "go.mod"))) return FONT_PAIRINGS.techno;
  const pkg = tryJson(readFileSafe(path.join(repoRoot, "package.json")) || "");
  if (pkg) {
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    if (deps && (deps.next || deps.react || deps.vue || deps.svelte)) return FONT_PAIRINGS.geometric;
  }
  // docs-heavy repo → editorial
  if (readFileSafe(path.join(repoRoot, "mkdocs.yml")) || readFileSafe(path.join(repoRoot, "docusaurus.config.js"))) return FONT_PAIRINGS.editorial;
  return FONT_PAIRINGS.geometric;
}

function inferTheme(repoRoot) {
  let title = "Plans", tagline = "", accent = null, fonts = FONT_PAIRINGS.geometric;
  try { const t = inferTitle(repoRoot); title = t.title || title; tagline = t.tagline || ""; } catch (_) {}
  try { accent = inferAccent(repoRoot); } catch (_) {}
  try { fonts = inferFonts(repoRoot); } catch (_) {}
  if (!accent) accent = hashAccent(title);

  const palette = Object.assign({}, defaultTheme.palette, {
    accent,
    accentSoft: hexToRgba(accent, "0.12") || defaultTheme.palette.accentSoft,
    stateDoing: accent,
  });
  // parseTheme guarantees a complete, valid, sanitized result.
  const t = parseTheme({
    schema: "engtheme/1", title, tagline, palette, fonts, generated_by: "inferred",
  });
  t.generated_by = "inferred";
  return t;
}

// ---- resolution order: file → inferred → default ----
function resolveTheme(repoRoot) {
  // 1. .plans/theme.json (only when it parses as an engtheme/1 object)
  try {
    const f = path.join(repoRoot, ".plans", "theme.json");
    const txt = readFileSafe(f);
    if (txt != null) {
      const obj = tryJson(txt);
      if (obj && typeof obj === "object" && obj.schema === "engtheme/1") {
        const t = parseTheme(obj);
        t._source = "file";
        return t;
      }
    }
  } catch (_) {}
  // 2. deterministic inference (only if the repo gives us a real signal)
  try {
    if (hasRepoSignal(repoRoot)) {
      const t = inferTheme(repoRoot);
      t._source = "inferred";
      return t;
    }
  } catch (_) {}
  // 3. Maha default
  const d = parseTheme(defaultTheme);
  d.generated_by = "default";
  d._source = "default";
  return d;
}

// A "signal" = something that lets inference produce a distinct identity.
function hasRepoSignal(repoRoot) {
  for (const f of ["package.json", "Cargo.toml", "pyproject.toml", "README.md", "README.MD", "go.mod"]) {
    try { if (fs.existsSync(path.join(repoRoot, f))) return true; } catch (_) {}
  }
  return false;
}

module.exports = {
  defaultTheme,
  FONT_REGISTRY, FONT_FAMILIES, SYSTEM_STACKS, FONT_PAIRINGS,
  PALETTE_KEYS, isColor,
  parseTheme, parseThemeStrict, themeCss,
  inferTheme, inferAccent, inferTitle, resolveTheme,
};
