# Self-Healing Protocol

How the `web` skill remembers what works, what breaks, and how to fix it —
without polluting memory with noise.

## Storage

Three things, three lifecycles, one directory: `~/.synaps-cli/memory/web/`.

| Path              | Lifecycle | Source of truth for                                 |
|-------------------|-----------|-----------------------------------------------------|
| `notes/*.md`      | Curated   | Lessons, fixes, playbooks. Hand-editable, git-friendly. |
| `db/`             | Derived   | VelociRAG index. Rebuild any time from `notes/`.    |
| `failures.jsonl`  | Raw log   | Every operational failure. Append-only. Noisy.      |

Notes are **what we learned**. Failures are **what happened**. Don't conflate.

## Tag conventions (YAML frontmatter)

VelociRAG's tag tokenizer prefers hyphens over colons. Discipline is enforced
by `_lib/memory`. Every commit must include `kind-` plus at least one of
`domain-` / `op-`.

| Tag                    | Use when…                                          |
|------------------------|----------------------------------------------------|
| `kind-domain`          | A general note about a host                        |
| `kind-task`            | A playbook for a recurring multi-step task         |
| `kind-lesson`          | A general lesson, not host-specific                |
| `kind-fix`             | A documented fix for a specific failure mode       |
| `domain-<host>`        | dots → hyphens: `domain-github-com`                |
| `op-<capability>`      | `op-fetch`, `op-browser`, `op-search`, …           |
| `err-<class>`          | `err-http_403`, `err-timeout`, `err-selector_stale` |

Note: hyphens *between* tag parts (`kind-fix`), but the value itself keeps
its native form (`http_403` stays `http_403`).

## Note format

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
Set `Authorization: Bearer $GITHUB_TOKEN` header. Anon limit 60/hr, authed 5000/hr.
```

## Failure JSONL schema

```json
{"ts":"2026-04-26T12:00:00Z","host":"github.com","op":"fetch","exit":1,
 "err_class":"http_403","err":"403 Forbidden","cmd":"fetch https://...",
 "args":{"url":"...","render":false}}
```

Required: `ts`, `host`, `op`, `exit`, `err_class`. Everything else
best-effort. Readers must tolerate missing fields.

## Per-op contract

Every script in `scripts/<capability>/` follows this lifecycle:

```
PRE      _lib/memory.recall(query=intent, tags=["domain-<host>","op-<op>"])
         → emit hits to stderr (or surface in the script's structured output)

ACT      run the capability with timeout

POST
  ok    → exit 0; do NOT auto-write a memory
  fail  → _lib/memory.logFailure({host, op, err_class, err, ...})
        → if isStale(host, op, err_class): print "STALE: …" to stderr
        → exit non-zero with structured error JSON
```

Why no auto-write on success: memory pollution. The agent decides what's
worth remembering. Scripts only emit signal (failures and recall hits);
meaning is committed by the agent as `kind-fix` / `kind-lesson` notes.

## Agent-side rule

The top-level `SKILL.md` puts these on you:

1. **Always** call `velocirag search` (or `_lib/memory.recall`) before any web op.
2. **On failure**: re-recall with the error class; try the escalations from
   the relevant `docs/<cap>.md`; if you find a fix, **commit it**.
3. **On `STALE` warnings**: treat the existing playbook as suspect. Re-investigate.
4. **On `command not found` / `Cannot find module`**: don't commit a memory —
   run `bash ${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh --check` to diagnose, then
   without `--check` to repair. The plugin's deps are configuration drift,
   not knowledge — they belong in `setup.sh`, not in `notes/`.

## Staleness rule

For a tuple `(host, op, err_class)`:
- count failures in `failures.jsonl` within the last 7 days
- ≥ 2 same-class failures → staleness flag fires

`_lib/memory.isStale(host, op, errClass)` implements this. Scripts call it
in their POST hook on failure and warn on stderr.

## Multi-tag intersection

VelociRAG's `--tags A --tags B` returns the **union**. Our `_lib/memory.recall`
does AND-intersection client-side: it passes the first tag as a server-side
filter, then post-filters results in JS/Python for the rest. If you call
`velocirag` directly with multiple `--tags`, expect union semantics.

## Hard rules for `_lib/memory`

1. **Memory writes never fail an op.** Wrap in try/catch; swallow errors.
2. **Memory ops have a 5s timeout** (30s for reindex). Never block the
   actual capability.
3. **Commits write a `.md` file synchronously, then trigger an incremental
   reindex.** Default behaviour.
4. **Failure logging is automatic and unconditional.** Cheap, append-only.
5. **Scripts NEVER auto-commit memories.** Only the agent (acting on user
   intent) commits.
