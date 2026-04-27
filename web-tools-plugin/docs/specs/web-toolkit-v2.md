# Web Toolkit v2 — Spec

Status: **Phase 0 locked, Phase 1 in progress** — 2026-04-26
Owner: JR Morton
Branch: `web-toolkit-v2`

## 1. Goal

Replace the current 5 separate skills (`browser-tools`, `exa-search`, `scholar`,
`transcribe`, `youtube`) with **one** umbrella skill — `web` — that acts as an
index to a swiss-army-knife of browser/web capabilities, backed by a
**self-healing long-term memory system**.

This is a complete remake. No backwards compatibility with the old skill names.

## 2. Non-goals

- Not building a new memory engine. We use [VelociRAG](https://github.com/HaseebKhalid1507/VelociRAG)
  to index a directory of markdown notes the agent writes.
- Not implementing MCP wiring inside the plugin (Synaps CLI does not yet speak
  MCP). We shell out to the `velocirag` CLI from scripts.
- Not designing a generic memory framework for *all* plugins now. We design the
  web-tools integration cleanly and document conventions so other plugins can
  follow the same pattern later.

### Why VelociRAG and not Memkoshi

We initially planned to use Memkoshi. After hands-on testing, Memkoshi turned
out to be a **conversation harvester** — its `commit` runs regex extraction
looking for patterns like "we chose X" / "I prefer Y", and drops anything it
doesn't recognise. A direct fix-memory like *"github.com fetch hits 403, set
Authorization header"* extracts to **zero memories**.

VelociRAG (the search engine *underneath* Memkoshi) is a perfect fit:
- Indexes a directory of markdown files with YAML frontmatter
- Multi-`--tags` filter on `search` and `query`
- Built-in `--stale N` query
- Markdown stays git-friendly, grep-able, human-readable
- 4-layer fusion search (vector + keyword + graph + metadata), ~3ms warm
- ONNX runtime, no PyTorch, no GPU

So the architecture comes back to almost exactly the markdown-with-YAML system
we sketched in the first brainstorm — with VelociRAG as the search layer.

> **Implementation state:** the web plugin imports nothing from memkoshi
> and has no reference to **stelline** (a memkoshi-only optional extra for
> session-jsonl harvesting). VelociRAG is shared as a transitive technology
> only — each system owns its own DB directory and there is no integration
> point, opt-in flag, or env var connecting them.

## 3. Architecture

### 3.1 Index skill + progressive disclosure

A small top-level `SKILL.md` (the **router**, ~150 lines) is always loaded.
Detailed per-capability docs in `docs/` are loaded on demand by the agent.
Mirrors Anthropic's progressive-disclosure pattern.

```
skills/web/SKILL.md          # always loaded
docs/                         # loaded on demand
  self-healing.md   memory.md
  fetch.md   browser.md   search.md   youtube.md
  scholar.md transcribe.md pdf.md     docs.md
  github.md  wiki.md
scripts/
  _lib/                       # shared: memory wrapper, output formatter
  fetch/    browser/    search/    youtube/
  scholar/  transcribe/ pdf/        docs/
  github/   wiki/
docs/specs/web-toolkit-v2.md  # this file
.synaps-plugin/plugin.json
```

(Top-level `install.sh` lives in the repo root, not the plugin — see §8.)

### 3.2 Memory storage (per-plugin)

```
~/.synaps-cli/memory/
└── web/                      # one root per plugin (clean isolation)
    ├── notes/                # .md files — source of truth, git-friendly
    │   ├── github-com-403-a3f9.md
    │   └── youtube-age-gate-7c12.md
    ├── db/                   # VelociRAG's index — derived, rebuildable
    └── failures.jsonl        # OUR file — raw failure log (append-only)
```

Three things, three lifecycles:
- `notes/` = curated memories (lessons, fixes, playbooks). Source of truth.
  Written by `_lib/memory.commit()`. Safe to edit by hand or check into git.
- `db/` = VelociRAG's vector + FTS5 + graph index. Derived from `notes/`.
  Rebuild any time with `velocirag index notes/ --db db/ -s web`.
- `failures.jsonl` = raw, noisy, append-only operational log. Used by self-heal
  logic to compute staleness and surface patterns. Not indexed by VelociRAG.

### 3.3 Note format (YAML frontmatter + markdown body)

```markdown
---
tags: [kind-fix, domain-github-com, op-fetch, err-http_403]
category: fix
status: active
title: github.com 403 fix
created: 2026-04-26
---

# github.com 403 fix

GitHub fetch returns 403 for anonymous requests on rate-limited routes.

## Fix
Set `Authorization: Bearer $GITHUB_TOKEN` header. Anon limit 60/hr,
authed 5000/hr.
```

VelociRAG's tag tokenizer doesn't love colons, so our tag convention is
**hyphenated**:

| Tag form              | Meaning                                       |
|-----------------------|-----------------------------------------------|
| `kind-domain`         | A general note about a host                   |
| `kind-task`           | A playbook for a recurring multi-step task    |
| `kind-lesson`         | A general lesson, not host-specific           |
| `kind-fix`            | A documented fix for a specific failure mode  |
| `domain-<host>`       | dots → hyphens, e.g. `domain-github-com`      |
| `op-<capability>`     | `op-fetch`, `op-browser`, …                   |
| `err-<class>`         | `err-http_403`, `err-timeout`, …              |

Note: hyphens between tag parts (`kind-fix`), but the `<class>` value itself
keeps its native form (`http_403` stays `http_403`).

### 3.4 Failure JSONL schema

```json
{"ts":"2026-04-26T12:00:00Z","host":"github.com","op":"fetch","exit":1,
 "err_class":"http_403","err":"403 Forbidden","cmd":"fetch https://...",
 "args":{"url":"...","render":false}}
```

Required: `ts`, `host`, `op`, `exit`, `err_class`. Everything else best-effort.

## 4. Self-healing protocol

### 4.1 Per-op contract

Every script implements PRE / ACT / POST:

```
PRE      _lib/memory.recall(query=intent, tags="domain-<host>,op-<op>")
         → emit hits to stderr (or surface in script's structured output)

ACT      run the capability with timeout

POST
  ok    → exit 0; do NOT auto-write a memory
  fail  → _lib/memory.logFailure({...})
        → if isStale(host, op, err_class): print "STALE" warning to stderr
        → exit non-zero with structured error JSON
```

Why no auto-write on success: avoids memory pollution. The agent decides what's
worth remembering. Scripts only emit signal (failures and recall hits);
meaning is committed by the agent as `kind-fix` / `kind-lesson` notes.

### 4.2 Agent-side rule

Top-level `SKILL.md` enforces:

1. **Always** call `memory.recall` (or `velocirag search`) before any web op.
   Scripts do it automatically; pay attention to what they surface.
2. **On failure**: re-recall with the err_class; try escalations from the
   relevant `docs/<cap>.md`; if you find a fix, **commit it**.
3. **On `STALE` warnings**: treat the existing playbook as suspect and
   re-investigate.

### 4.3 Staleness rule

For a tuple `(host, op, err_class)`:
- count failures in `failures.jsonl` within the last 7 days
- ≥ 2 same-class failures → staleness flag fires

Implemented in `_lib/memory.isStale()`.

## 5. Capabilities

Existing (ported, no behavior change in Phase 2):
- `browser` — Playwright/CDP automation
- `search` — Exa neural/keyword/deep
- `youtube` — transcript.js + yt-dlp
- `scholar` — OpenAlex
- `transcribe` — local Whisper

New (Phases 3–4):
- `fetch` — light HTTP + HTML→md, with `--render` escalation to `browser`
- `pdf` — text/metadata/page-range extraction
- `docs` — pandoc wrapper (DOCX/PPTX/EPUB → md)
- `github` — repo/file/issue/PR/code-search via API
- `wiki` — Wikipedia API

Cross-cutting:
- `memory` — thin wrapper around VelociRAG with namespace defaults

## 6. `_lib/memory` API contract

Both Node and Python implementations expose the same surface:

```
recall(query, opts?) -> Array<MemoryHit>          # [] on any failure
commit(text, opts?)  -> {path, indexed: bool}     # writes a .md file, optionally reindexes
logFailure(record)   -> void                      # always succeeds
recentFailures(host, op, sinceMs?) -> Array<rec>
isStale(host, op, errClass) -> bool
reindex()           -> bool                       # rebuild the velocirag index
```

`commit` opts: `{tags: string|string[], category?, status?, title?, kind?, reindex=true}`

Hard rules:
1. Memory writes never fail an op — wrap in try/catch, swallow errors.
2. Memory ops have a 5s timeout — never block the actual capability.
3. Commits write a `.md` file synchronously, reindex is optional but defaults on
   (cheap, mtime-incremental).
4. Tag intersection (AND) is done in the wrapper, not via VelociRAG (which
   unions multiple `--tags`). The wrapper passes one tag for filter and
   post-filters results for the rest.

## 7. Top-level `SKILL.md` skeleton

See `skills/web/SKILL.md` — kept intentionally small (~80 lines) so it always
fits comfortably in context.

## 8. Build phases

| # | Deliverable | Validates |
|---|-------------|-----------|
| **0** | This spec | Design |
| **1** | `install.sh` bootstraps velocirag; init `~/.synaps-cli/memory/web/{notes,db}`; write `_lib/memory.{js,py}` + failure logger; write `skills/web/SKILL.md` + `docs/self-healing.md` + `docs/memory.md` | Memory + protocol |
| **2** | Port existing 5 capabilities into new layout; wire PRE/POST hooks; no feature changes | Index pattern + scripts work |
| **3** | Add `fetch`, `pdf`, `docs` | Tier-1 new capabilities |
| **4** | Add `github`, `wiki` | Tier-2 specialists |
| **5** | Staleness escalation logic + agent-facing `web-status` summary command | Self-healing closes the loop |

## 9. Open questions / known risks

- **VelociRAG tag tokenization**: hyphens work, colons don't tokenize cleanly.
  Convention enforced by `_lib/memory`. If VelociRAG adds `--all-tags` (AND)
  semantics later, simplify the wrapper.
- **First-run cost**: VelociRAG pulls ONNX models (~80MB). One-time, acceptable.
- **Synaps + MCP**: Synaps CLI does not currently support MCP. If/when it does,
  `velocirag mcp` plugs in natively and our `_lib/memory` wrapper becomes
  redundant.
- **Reindex cost**: incremental (mtime-based) — adding a single note rebuilds
  only that file's chunks. Tested at <1s for small note sets. Revisit at >500
  notes.
- **No staging gate**: VelociRAG has no "approve before permanent" — files are
  in the repo or not. The agent writes intentionally; user reviews via file
  diff or git. Simpler than memkoshi's gate.
