#!/usr/bin/env node
/**
 * github — Typed GitHub API wrapper.
 *
 * Subcommands:
 *   repo OWNER/REPO            Show repo metadata
 *   file OWNER/REPO PATH       Fetch a file's contents (raw, decoded)
 *   tree OWNER/REPO [--ref R]  List the repo tree (default branch unless --ref)
 *   issue OWNER/REPO NUMBER    Show a single issue
 *   issues OWNER/REPO [opts]   List issues
 *   pr OWNER/REPO NUMBER       Show a single PR
 *   prs OWNER/REPO [opts]      List PRs
 *   search-code QUERY [opts]   Code search
 *   search-repos QUERY [opts]  Repo search
 *   user LOGIN                 User profile
 *   rate                       Show rate-limit status
 *
 * Auth: set GITHUB_TOKEN to a Personal Access Token. Anon is 60/h.
 *
 * Exit codes:
 *   0  success
 *   1  network / parse failure
 *   2  HTTP non-2xx
 *   3  bad args
 */
import { extractHost, recallAndEmit, failAndExit } from "../_lib/hooks.mjs";

const HOST = "api.github.com";
const OP = "github";

const USER_AGENT = "Mozilla/5.0 (compatible; web-tools/0.3 github; +https://github.com/maha-media/synaps-skills)";
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === "--help" || command === "-h") {
  printHelp();
  process.exit(command ? 0 : 1);
}

// PRE — recall by host + op
recallAndEmit(`github ${command}: ${args[0] || ""}`, { host: HOST, op: OP });

try {
  switch (command) {
    case "repo":         await cmdRepo(args); break;
    case "file":         await cmdFile(args); break;
    case "tree":         await cmdTree(args); break;
    case "issue":        await cmdIssue(args); break;
    case "issues":       await cmdIssues(args); break;
    case "pr":           await cmdPR(args); break;
    case "prs":          await cmdPRs(args); break;
    case "search-code":  await cmdSearch("code", args); break;
    case "search-repos": await cmdSearch("repositories", args); break;
    case "user":         await cmdUser(args); break;
    case "rate":         await cmdRate(); break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(3);
  }
} catch (e) {
  failAndExit({
    host: HOST, op: OP, err: e,
    cmd: `github ${command} ${args.join(" ")}`.slice(0, 200),
    args: { command, args: args.slice(0, 5) },
  });
}

// ── core API ──────────────────────────────────────────────────────────────

async function gh(pathOrUrl, opts = {}) {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://api.github.com${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  const headers = {
    "Accept": opts.accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  if (opts.headers) Object.assign(headers, opts.headers);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30_000);
  let resp;
  try {
    resp = await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }

  // Surface rate-limit info for transparency
  const rl = resp.headers.get("x-ratelimit-remaining");
  if (rl !== null && parseInt(rl, 10) < 5 && !process.env.WEB_HOOKS_QUIET) {
    console.error(`[github] rate-limit warning: ${rl} requests remaining (reset ${new Date(parseInt(resp.headers.get("x-ratelimit-reset") || "0", 10) * 1000).toISOString()})`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    let extra = "";
    try { extra = JSON.parse(text).message || ""; } catch {}
    const msg = `HTTP ${resp.status} ${resp.statusText} — ${extra || text.slice(0, 200)}`;
    const e = new Error(msg);
    e.statusCode = resp.status;
    throw e;
  }

  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  if (opts.raw) return await resp.text();
  if (ct.includes("json")) return await resp.json();
  return await resp.text();
}

function parseRepo(arg) {
  if (!arg) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing OWNER/REPO argument"),
      err_class: "bad_args", exit: 3 });
  }
  // Accept: owner/repo, https://github.com/owner/repo[/...]
  const m = arg.match(/^(?:https?:\/\/(?:www\.)?github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/);
  if (!m) {
    failAndExit({ host: HOST, op: OP,
      err: new Error(`Invalid OWNER/REPO: '${arg}'`),
      err_class: "bad_args", exit: 3 });
  }
  return { owner: m[1], repo: m[2] };
}

function popValue(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function popFlag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

// ── commands ──────────────────────────────────────────────────────────────

async function cmdRepo(a) {
  const { owner, repo } = parseRepo(a[0]);
  const r = await gh(`/repos/${owner}/${repo}`);
  print({
    full_name: r.full_name,
    description: r.description,
    homepage: r.homepage,
    stars: r.stargazers_count,
    forks: r.forks_count,
    open_issues: r.open_issues_count,
    language: r.language,
    license: r.license?.spdx_id,
    default_branch: r.default_branch,
    pushed_at: r.pushed_at,
    archived: r.archived,
    disabled: r.disabled,
    topics: r.topics,
    url: r.html_url,
  });
}

async function cmdFile(a) {
  const { owner, repo } = parseRepo(a[0]);
  const path = a[1];
  if (!path) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing PATH argument"), err_class: "bad_args", exit: 3 });
  }
  const ref = popValue(a, "--ref");
  const url = `/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const r = await gh(url);
  if (Array.isArray(r)) {
    // It's a directory
    for (const e of r) {
      console.log(`${e.type.padEnd(7)} ${(e.size || 0).toString().padStart(8)}  ${e.path}`);
    }
    return;
  }
  if (r.type !== "file") {
    failAndExit({ host: HOST, op: OP,
      err: new Error(`Path is a ${r.type}, not a file`),
      err_class: "not_a_file" });
  }
  if (r.encoding !== "base64") {
    failAndExit({ host: HOST, op: OP,
      err: new Error(`Unexpected encoding: ${r.encoding}`),
      err_class: "encoding" });
  }
  const buf = Buffer.from(r.content, "base64");
  process.stdout.write(buf);
}

async function cmdTree(a) {
  const { owner, repo } = parseRepo(a[0]);
  let ref = popValue(a, "--ref");
  if (!ref) {
    const repoMeta = await gh(`/repos/${owner}/${repo}`);
    ref = repoMeta.default_branch;
  }
  const r = await gh(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (r.truncated) console.error("[github] tree truncated by API; consider narrowing scope");
  for (const e of r.tree) {
    if (e.type === "blob") {
      console.log(`${(e.size || 0).toString().padStart(8)}  ${e.path}`);
    }
  }
}

async function cmdIssue(a) {
  const { owner, repo } = parseRepo(a[0]);
  const num = a[1];
  if (!num || !/^\d+$/.test(num)) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing issue NUMBER"), err_class: "bad_args", exit: 3 });
  }
  const r = await gh(`/repos/${owner}/${repo}/issues/${num}`);
  print({
    number: r.number,
    title: r.title,
    state: r.state,
    state_reason: r.state_reason,
    labels: (r.labels || []).map(l => l.name).join(", "),
    author: r.user?.login,
    assignees: (r.assignees || []).map(u => u.login).join(", "),
    created_at: r.created_at,
    updated_at: r.updated_at,
    closed_at: r.closed_at,
    comments: r.comments,
    url: r.html_url,
  });
  if (r.body) {
    console.log("\n--- body ---");
    console.log(r.body);
  }
}

async function cmdIssues(a) {
  const { owner, repo } = parseRepo(a[0]);
  const state = popValue(a, "--state") || "open";
  const labels = popValue(a, "--labels");
  const limit = parseInt(popValue(a, "--limit") || "20", 10);
  const params = new URLSearchParams({ state, per_page: String(Math.min(limit, 100)) });
  if (labels) params.set("labels", labels);
  const r = await gh(`/repos/${owner}/${repo}/issues?${params}`);
  for (const i of r.slice(0, limit)) {
    if (i.pull_request) continue; // /issues includes PRs; skip
    const lbl = (i.labels || []).map(l => l.name).join(",");
    console.log(`#${i.number}  [${i.state}]  ${i.title}${lbl ? "  (" + lbl + ")" : ""}`);
  }
}

async function cmdPR(a) {
  const { owner, repo } = parseRepo(a[0]);
  const num = a[1];
  if (!num || !/^\d+$/.test(num)) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing PR NUMBER"), err_class: "bad_args", exit: 3 });
  }
  const r = await gh(`/repos/${owner}/${repo}/pulls/${num}`);
  print({
    number: r.number,
    title: r.title,
    state: r.state,
    draft: r.draft,
    merged: r.merged,
    mergeable: r.mergeable,
    base: `${r.base?.repo?.full_name}:${r.base?.ref}`,
    head: `${r.head?.repo?.full_name}:${r.head?.ref}`,
    author: r.user?.login,
    additions: r.additions,
    deletions: r.deletions,
    changed_files: r.changed_files,
    commits: r.commits,
    created_at: r.created_at,
    merged_at: r.merged_at,
    url: r.html_url,
  });
  if (r.body) {
    console.log("\n--- body ---");
    console.log(r.body);
  }
}

async function cmdPRs(a) {
  const { owner, repo } = parseRepo(a[0]);
  const state = popValue(a, "--state") || "open";
  const limit = parseInt(popValue(a, "--limit") || "20", 10);
  const params = new URLSearchParams({ state, per_page: String(Math.min(limit, 100)) });
  const r = await gh(`/repos/${owner}/${repo}/pulls?${params}`);
  for (const p of r.slice(0, limit)) {
    console.log(`#${p.number}  [${p.draft ? "draft" : p.state}]  ${p.title}  by @${p.user?.login}`);
  }
}

async function cmdSearch(kind, a) {
  const limit = parseInt(popValue(a, "--limit") || "10", 10);
  const language = popValue(a, "--language");
  const repo = popValue(a, "--repo");
  let q = a.join(" ");
  if (!q) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing search query"), err_class: "bad_args", exit: 3 });
  }
  if (language) q += ` language:${language}`;
  if (repo)     q += ` repo:${repo}`;
  const params = new URLSearchParams({ q, per_page: String(Math.min(limit, 100)) });
  const r = await gh(`/search/${kind}?${params}`);
  console.error(`[github] total_count=${r.total_count}${r.incomplete_results ? " (incomplete)" : ""}`);
  for (const item of (r.items || []).slice(0, limit)) {
    if (kind === "code") {
      console.log(`${item.repository?.full_name}: ${item.path}`);
      console.log(`  ${item.html_url}`);
    } else if (kind === "repositories") {
      console.log(`${item.full_name}  ★${item.stargazers_count}  ${item.language || "?"}`);
      if (item.description) console.log(`  ${item.description}`);
      console.log(`  ${item.html_url}`);
    }
  }
}

async function cmdUser(a) {
  const login = a[0];
  if (!login) {
    failAndExit({ host: HOST, op: OP,
      err: new Error("Missing user LOGIN"), err_class: "bad_args", exit: 3 });
  }
  const r = await gh(`/users/${encodeURIComponent(login)}`);
  print({
    login: r.login,
    name: r.name,
    bio: r.bio,
    location: r.location,
    company: r.company,
    public_repos: r.public_repos,
    followers: r.followers,
    following: r.following,
    created_at: r.created_at,
    url: r.html_url,
  });
}

async function cmdRate() {
  const r = await gh(`/rate_limit`);
  console.log(`Authenticated: ${TOKEN ? "yes" : "no"}`);
  for (const [resource, info] of Object.entries(r.resources)) {
    console.log(`${resource.padEnd(15)} used=${info.used}  remaining=${info.remaining}/${info.limit}  resets=${new Date(info.reset * 1000).toISOString()}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function print(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "" ||
        (Array.isArray(v) && v.length === 0)) continue;
    if (Array.isArray(v)) {
      console.log(`${k}: ${v.join(", ")}`);
    } else if (typeof v === "object") {
      console.log(`${k}: ${JSON.stringify(v)}`);
    } else {
      console.log(`${k}: ${v}`);
    }
  }
}

function printHelp() {
  console.log("Usage: github.js <command> [args]");
  console.log("");
  console.log("Commands:");
  console.log("  repo OWNER/REPO              Show repo metadata");
  console.log("  file OWNER/REPO PATH [--ref R]  Fetch file (or list dir)");
  console.log("  tree OWNER/REPO [--ref R]    Recursive tree (blobs only)");
  console.log("  issue OWNER/REPO NUMBER      Show one issue");
  console.log("  issues OWNER/REPO [--state STATE] [--labels A,B] [--limit N]");
  console.log("  pr OWNER/REPO NUMBER         Show one PR");
  console.log("  prs OWNER/REPO [--state STATE] [--limit N]");
  console.log("  search-code QUERY [--repo OWNER/REPO] [--language LANG] [--limit N]");
  console.log("  search-repos QUERY [--language LANG] [--limit N]");
  console.log("  user LOGIN                   User profile");
  console.log("  rate                         Show rate-limit status");
  console.log("");
  console.log("Auth: set GITHUB_TOKEN (or GH_TOKEN) for 5000 req/h. Anon = 60/h.");
}
