---
name: memkoshi
description: Persistent memory across Synaps sessions. Use to recall prior decisions, preferences, and facts before answering; commit new decisions and learnings during work; hand off context between sessions. Backed by the Memkoshi CLI (staging gate, 4-layer search, pattern detection). Local-first, no cloud required.
---

# Memkoshi — agent memory for Synaps

Memkoshi gives Synaps agents persistent memory across sessions. Without it, every session starts cold. With it, you `recall` before answering, `commit` new decisions as you make them, and `handoff` state between sessions.

**Core mental model — two paths:**

- **Write path:** session text → `commit` → staged → `approve` → permanent + indexed
- **Read path:** query → 4-layer search (vector + BM25 + graph + metadata) → ranked results

The staging gate is deliberate: you don't want hallucinations becoming "memories." Always review before approving. For agent automation, the plugin ships a non-interactive `approve.sh` since the upstream `memkoshi review` is interactive-only.

## Setup

One-time install on the host — use the plugin's setup script (idempotent):

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/memkoshi/setup.sh
```

This installs memkoshi from git via pipx, **injects stelline by default** for
the richer write path (session intelligence on top of the regex extractor),
and runs `memkoshi init`. Pass `--no-stelline` to skip the extra, `--check`
to verify status without changing anything, or `--reinstall` to wipe and
rebuild the venv.

Manual fallback (if you can't run the script):

```bash
pipx install git+https://github.com/HaseebKhalid1507/memkoshi.git
pipx inject memkoshi git+https://github.com/HaseebKhalid1507/Stelline.git
memkoshi init
```

Default storage is `~/.memkoshi`. Override with `MEMKOSHI_STORAGE=/path/to/dir` or `--storage /path` on any command.

## When to use this skill

Load and consult memkoshi when:

- The user asks something that depends on **prior context** ("what did we decide about X?", "remember when…", "what's my preference for…")
- You're starting a non-trivial task and want to know if there's relevant **past work or decisions**
- You make a **decision worth remembering** (architectural choice, user preference, important fact, gotcha learned)
- A session is **ending** and you want the next session to pick up cleanly (handoff)
- The user explicitly mentions memory, recall, or "remember this"

Don't use it for ephemeral chatter, code that's already in the repo, or facts the user can trivially re-state. Memory is for things that would be expensive to rediscover.

## Read path — recall before answering

```bash
# Basic semantic search (vector + keyword + graph + metadata, fused)
memkoshi recall "database decision"

# Limit results
memkoshi recall "auth workflow" --limit 10

# Filter by category (preferences, decisions, events, facts, ...)
memkoshi recall "editor" --category preferences

# JSON output for programmatic parsing
memkoshi recall "deployment target" --json

# Show current state — handoff, recent sessions, totals
memkoshi boot
memkoshi context boot --budget 4096       # token-budgeted version
```

**Pattern: recall first.** When the user's question hints at prior context, run `memkoshi recall "<keywords>"` before composing your answer. If results come back, weave them in (and cite the memory ID). If empty, say so honestly rather than guessing.

## Write path — commit, review, approve

```bash
# Extract memories from a chunk of session text. Defaults to the local
# `hybrid` regex extractor (free, decent). It looks for decision-like patterns,
# preferences, factual claims — vague chatter extracts nothing, which is fine.
memkoshi commit "We decided to use PostgreSQL for the auth service because it's faster than MySQL. The user prefers Vim over VS Code."

# JSON output (good for agent parsing)
memkoshi commit "<text>" --json

# Higher-quality extraction with an LLM (costs API calls)
memkoshi commit "<text>" --extractor api --provider anthropic
memkoshi commit "<text>" --extractor api --provider openai --model gpt-4o-mini

# Read a long session transcript from disk
memkoshi commit --file ./session.txt
```

After commit, memories sit in **staging** until approved. Review them:

```bash
# Show staged memories (interactive — the upstream `review` prompts per-item;
# don't use this from an agent run, use approve.sh below)
memkoshi review

# Non-interactive approval helpers (shipped with this plugin)
${CLAUDE_PLUGIN_ROOT}/scripts/memkoshi/approve.sh --all                       # approve every staged memory
${CLAUDE_PLUGIN_ROOT}/scripts/memkoshi/approve.sh --id mem_396f122b           # approve one by ID
${CLAUDE_PLUGIN_ROOT}/scripts/memkoshi/approve.sh --reject mem_xxx --reason "hallucination"
${CLAUDE_PLUGIN_ROOT}/scripts/memkoshi/approve.sh --all --json                # JSON output
```

**Pattern: stage, then approve only what you'd defend.** When you commit during a session, the items go to staging. Either:

1. **Conservative (default):** show the user what was extracted (`memkoshi review` or list the JSON from `--json`) and ask before approving.
2. **Auto-approve:** if the user said "remember this" explicitly about a clear statement, run `approve.sh --all` immediately and tell them what was stored.

Never approve memories that look like hallucinations from the extractor — reject them with `--reject ID --reason "..."`.

## Handoff — state transfer between sessions

When a session is wrapping up but the work continues later:

```bash
memkoshi handoff set "Building auth API" \
  --progress "endpoints scaffolded, no tests yet" \
  --next "write integration tests" \
  --next "deploy to staging" \
  --priority 2

memkoshi handoff show          # see current handoff
memkoshi handoff clear         # clear it
```

The next session's `memkoshi boot` will surface this as the first thing.

## Patterns & evolution — meta-memory

```bash
memkoshi patterns detect          # find behavioural patterns
memkoshi patterns insights        # human-readable recommendations
memkoshi patterns stats           # usage stats

memkoshi evolve status            # performance dashboard (recent score, trend)
memkoshi evolve hints             # improvement suggestions
memkoshi evolve score "<text>"    # score a session
```

These are pull-based — only run them when the user asks "how am I doing" / "what patterns" / "what should I improve."

## Maintenance

```bash
memkoshi stats                    # totals, categories, db size
memkoshi reindex                  # rebuild search index after manual edits
memkoshi serve --daemon           # warm VelociRAG in background (lower recall latency)
memkoshi serve-status
memkoshi serve-stop
```

For long agent sessions doing many recalls, `memkoshi serve --daemon` once at the start cuts cold-start latency on each query.

## Auto-injecting boot context at session start

Synaps' `-s/--system` flag accepts a file or string. Pipe boot context in:

```bash
synaps -s <(${CLAUDE_PLUGIN_ROOT}/scripts/memkoshi/boot-context.sh 2048)
```

The helper prints a header + `memkoshi context boot` output, gracefully falling back to install instructions if memkoshi isn't on PATH yet. Wire it into your shell as an alias if you want every session to start with memory primed:

```bash
alias snap='synaps -s <(/path/to/scripts/memkoshi/boot-context.sh 2048)'
```

## End-to-end smoke test

```bash
memkoshi init
memkoshi commit "We chose PostgreSQL over MySQL for auth — faster for our workload. User prefers Vim."
memkoshi review                                                   # see what got staged
${CLAUDE_PLUGIN_ROOT}/scripts/memkoshi/approve.sh --all --json    # approve all
memkoshi recall "database decision"                               # find it
memkoshi handoff set "next task" --progress "memory wired up" --next "write tests"
memkoshi boot                                                     # see boot context
```

## Gotchas

- The default `hybrid` extractor is regex-based and **misses a lot**. Vague sentences like "we talked about stuff" extract zero memories. That's by design — pattern-rich sentences (decisions, preferences, factual claims) extract well. Use `--extractor api` for higher recall when accuracy matters.
- `memkoshi recall` requires memories to be **approved** — staged memories aren't searched.
- First recall after install downloads embedding models (~100MB, all-MiniLM-L6-v2). Subsequent recalls are fast.
- Storage is per-user (`~/.memkoshi`). For project-scoped memory, set `MEMKOSHI_STORAGE=$PWD/.memkoshi` per-project.
- The MCP server (`memkoshi mcp-serve`) is for MCP-aware clients (Claude Desktop, Claude Code). Synaps doesn't run MCP servers — it calls the CLI directly via bash, which is what this skill does.

## Reference — full command surface

| Command | Purpose |
|---|---|
| `memkoshi init` | Initialise storage |
| `memkoshi commit [TEXT \| -f FILE] [--json] [-e hybrid\|pi\|api]` | Extract & stage memories |
| `memkoshi review [-n N]` | **Interactive** review (don't call from agent) |
| `approve.sh --all \| --id ID \| --reject ID --reason R [--json]` | **Non-interactive** approve/reject (this plugin) |
| `memkoshi recall QUERY [--category C] [-l N] [--json]` | Search memories |
| `memkoshi boot [--json]` | Quick boot summary |
| `memkoshi context boot [-b BUDGET] [--json]` | Token-budgeted boot context |
| `memkoshi handoff set TASK [-p ...] [-n ...]` / `show` / `clear` | Manage handoff state |
| `memkoshi patterns detect \| insights \| stats` | Behavioural patterns |
| `memkoshi evolve status \| hints \| score TEXT` | Session evolution scoring |
| `memkoshi stats` | Storage stats |
| `memkoshi reindex` | Rebuild search index |
| `memkoshi serve [--daemon]` / `serve-status` / `serve-stop` | Background search daemon |
| `memkoshi mcp-serve` | MCP server (for MCP clients, not Synaps) |

## Related

- **Memkoshi** — https://github.com/HaseebKhalid1507/memkoshi
- **VelociRAG** (read path) — https://github.com/HaseebKhalid1507/VelociRAG
- **Stelline** (write path, optional) — https://github.com/HaseebKhalid1507/Stelline
