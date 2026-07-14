# pria-tools-plugin

Synaps process-extension plugin that gives an **in-VM agent** (e.g. the Pria tutor) tools to search the user's **Pria IP Vault** (RAG/KAG) and **conversation history**, by calling Praxis's public REST API with an API key.

**Tier-1 prototype.** Touches no Pria backend code; consumes the existing public REST API only. stdlib only — no pip dependencies.

---

## Tools exposed

| Tool | Endpoint | Description |
|------|----------|-------------|
| `search_knowledge` | `POST /api/user/files/search-content` | Hybrid RAG/KAG vault search. Returns scored, citable snippets with `rag\|kag\|fused\|lexical` source labels. |
| `search_history` | `POST /api/user/histories` | Conversation history search. Returns recent dialogue snippets matching a free-text query. |

### `search_knowledge`
```json
{
  "query": "quantum gravity",
  "max_results": 10
}
```
Returns:
```json
{
  "results": [
    {
      "text": "Quantum gravity is the field of physics...",
      "score": 0.87,
      "source": "fused",
      "citation": "Physics Notes",
      "upload_id": "up1",
      "matched_entities": ["quantum gravity", "general relativity"],
      "chunk_index": 3
    }
  ],
  "count": 1
}
```

### `search_history`
```json
{
  "query": "how to deploy",
  "limit": 20
}
```
Returns:
```json
{
  "results": [
    {
      "id": "688b...",
      "created": "2025-07-01T12:00:00.000Z",
      "user_input": "How do I deploy a Flask app?",
      "ai_output": "You can deploy a Flask app using Gunicorn...",
      "assistant_name": "Pria Tutor",
      "model": "gpt-4o"
    }
  ],
  "count": 1
}
```

---

## Setup

### 1. Install
Drop this directory into `synaps-skills-jr/` alongside sibling plugins.

### 2. Configure API key

```bash
export PRIA_API_KEY="pria_<40 hex chars>"
```

Or set `pria_api_key` in the plugin config block (manifest `config.secret_env` fallback). **Never hardcode it.**

### 3. Optional: override base URL
```bash
# plugin config
pria_api_base: "https://pria.praxislxp.com"
```

---

## Auth flow

```
PRIA_API_KEY (pria_…)
   │
   ▼
POST /api/auth/api-key-signin   (x-api-key: <key>)
   │
   ▼  { token, profile }
JWT cached in memory
   │
   ▼
POST /api/user/files/search-content   (x-access-token: <jwt>)
POST /api/user/histories              (x-access-token: <jwt>)
   │
   ▼  On 401: re-exchange once, then fail cleanly
```

---

## Running tests

```bash
bash scripts/test.sh
# or just unit tests:
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

All HTTP is **mocked** — no live network calls during tests.

## Manual live smoke test

```bash
export PRIA_API_KEY="pria_..."
python3 scripts/smoke.py --query "machine learning" --limit 3
```

---

## File structure

```
pria-tools-plugin/
├── .synaps-plugin/
│   └── plugin.json           # manifest (protocol_version: 2, tools.register)
├── extensions/
│   ├── pria_tools.py         # RPC loop entry point
│   └── pria/
│       ├── __init__.py
│       ├── runtime.py        # read_frame / write_frame (Content-Length stdio)
│       ├── client.py         # PriaClient (urllib only, JWT exchange + caching)
│       ├── tools.py          # TOOL_SPECS + ToolHandler (normalize + dispatch)
│       └── app.py            # App (initialize / hook.handle / tool.call)
├── tests/
│   ├── test_runtime.py       # framing + handshake
│   ├── test_client.py        # JWT exchange, caching, re-auth, error paths
│   ├── test_search_knowledge.py  # normalization + error paths
│   └── test_search_history.py   # normalization + error paths
├── scripts/
│   ├── test.sh               # full test suite
│   ├── stdio_harness.py      # subprocess RPC smoke test
│   └── smoke.py              # manual live smoke test (NOT in CI)
└── docs/
    └── contracts.md          # API contract notes
```

---

## Fast-follow: Memory tools (v2)

The public `/api/user/memory` endpoints are legacy key/value stores — not meaningful for agent search in v1. A v2 iteration could expose:

- `get_memory` — read named memory entries
- `set_memory` — write structured memory (if the endpoint permits it for non-admin users)

Out of scope for this prototype.

---

## Error handling

All tool errors return `{ "error": "<type>", "detail": "<message>" }` — the RPC loop never crashes. Error types:

| Type | Cause |
|------|-------|
| `pria_api_key not configured` | No key in env or config |
| `authentication failed` | 401 after re-exchange |
| `rate_limit` | 429 from Pria (20 req/min per user) |
| `api_error (HTTP N)` | Non-200/401/429 response |
| `network_error` | URLError / OSError |
