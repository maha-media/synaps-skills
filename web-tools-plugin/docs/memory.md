# Memory Ops

Direct VelociRAG commands and the `_lib/memory` wrapper for the `web` plugin.

## Layout

```
~/.synaps-cli/memory/web/
├── notes/         # markdown files (source of truth, git-friendly)
├── db/            # VelociRAG index (derived)
└── failures.jsonl # raw operational log
```

Override the root with `WEB_MEMORY_ROOT=/some/path` if needed (rarely).

## Recall (search)

```bash
velocirag search "<query>" --db ~/.synaps-cli/memory/web/db -l 5
velocirag search "<query>" --db ~/.synaps-cli/memory/web/db --format json
velocirag search "<query>" --db ~/.synaps-cli/memory/web/db --tags domain-github-com
```

`velocirag query --tags A --tags B` does **union**, not intersection. For AND
semantics, use the wrapper (it post-filters):

```js
const m = require('${CLAUDE_PLUGIN_ROOT}/scripts/_lib/memory');
m.recall("403 forbidden", { tags: ["domain-github-com", "kind-fix"] });
```

```python
from _lib.memory import recall
recall("403 forbidden", tags=["domain-github-com", "kind-fix"])
```

## Commit (write a memory)

The wrapper writes a markdown file with YAML frontmatter and triggers an
incremental reindex:

```js
const m = require('${CLAUDE_PLUGIN_ROOT}/scripts/_lib/memory');
m.commit(
  "github.com fetch hits 403 anonymously → set Authorization Bearer GITHUB_TOKEN",
  {
    kind: "fix",
    tags: ["domain-github-com", "op-fetch", "err-http_403"],
    title: "github.com 403 fix"
  }
);
// → { path: "...notes/github-com-403-fix-a3f9.md", indexed: true }
```

```python
from _lib.memory import commit
commit(
  "github.com fetch hits 403 anonymously → set Authorization Bearer GITHUB_TOKEN",
  kind="fix",
  tags=["domain-github-com", "op-fetch", "err-http_403"],
  title="github.com 403 fix",
)
```

### Tag conventions (mandatory)

See `docs/self-healing.md` for the full table. Minimum: `kind-` + one of
`domain-` / `op-`.

### Good fix-memory examples

```
"github.com fetch hits 403 anonymously → set Authorization Bearer $GITHUB_TOKEN"
  kind=fix  tags=[domain-github-com, op-fetch, err-http_403]

"transcript.js bot-detection bypassed by --cookies-from-browser=chrome (logged-in)"
  kind=fix  tags=[domain-youtube-com, op-youtube-transcript, err-bot_detected]

"Cloudflare-protected sites need browser render, not raw fetch"
  kind=lesson  tags=[op-fetch, err-cloudflare]
```

## Manual note authoring

You can also write `.md` files directly under `~/.synaps-cli/memory/web/notes/`
and reindex:

```bash
cat > ~/.synaps-cli/memory/web/notes/cloudflare-lesson.md <<'EOF'
---
tags: [kind-lesson, op-fetch, err-cloudflare]
category: lesson
status: active
title: Cloudflare requires browser render
---

# Cloudflare requires browser render

Sites behind Cloudflare's bot protection cannot be reached with raw HTTP
fetch. Escalate to `fetch --render` (browser) or `browser` directly.
EOF

velocirag index ~/.synaps-cli/memory/web/notes \
  --db ~/.synaps-cli/memory/web/db -s web
```

## Stats / health

```bash
velocirag status --db ~/.synaps-cli/memory/web/db
velocirag health --db ~/.synaps-cli/memory/web/db
```

## Stale notes

VelociRAG can find stale notes (not accessed in N days):

```bash
velocirag query --db ~/.synaps-cli/memory/web/db --stale 30
```

That's notes that haven't been *recalled* recently. Different from operational
staleness in `failures.jsonl` (which tracks repeated failures of the same op).

## Failure log

The raw operational failure log is **separate from VelociRAG**:

```
~/.synaps-cli/memory/web/failures.jsonl
```

Inspect with normal tools:

```bash
tail -20 ~/.synaps-cli/memory/web/failures.jsonl
jq -c 'select(.host=="github.com")' ~/.synaps-cli/memory/web/failures.jsonl
```

## Programmatic API

From scripts, use the wrapper instead of shelling out yourself:

- Node: `require('../_lib/memory')`
- Python: `from _lib.memory import recall, commit, log_failure, is_stale, reindex`

Both expose: `recall`, `commit`, `log_failure` / `logFailure`,
`recent_failures` / `recentFailures`, `is_stale` / `isStale`, `reindex`.

Hard rules:
1. Memory ops never throw — they return `[]` / `false` / `{path:null}` on failure.
2. 5-second timeout on `recall` / `commit` write; 30s on `reindex`.
3. Scripts NEVER auto-commit. Only the agent commits, on user intent.
