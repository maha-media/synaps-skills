# pria-black-box-plugin

Pria Black Box — the bake-off champion observability instrument for Pria answers.

## What it does

Turns Pria's lazy-fetch history flags + RAG/KAG retrieval segments + reasoning
endpoints into an **auditable provenance API** for agents.

Given a history ID (or "most recent"), `trace_answer` reconstructs exactly:

- **Which digital twin** answered (assistant name + id + model)
- **The exact RAG/KAG evidence chunks** used: filename, chunk index, score, retrieval
  mode (RAG|KAG), original length, and the stored text (Pria's confidentiality
  placeholder is preserved exactly — never expanded)
- **Confidentiality flags**: Pria pre-redacts chunks that exceed the preview cap;
  `confidential: true` is surfaced per-segment
- **Optional reasoning telemetry**: thinking rounds, per-round duration and model
  (opt-in via `include_reasoning=true` — bulky and sensitive)
- **Source-health warnings**: whether the source files cited are still indexed/healthy
  right now, overlaid from `POST /api/user/uploads/files-with-issues`
- **Performance telemetry**: latencyMs, ragDurationMs, credits, cached tokens

## Tools

| Tool | Description |
|------|-------------|
| `trace_answer` | Full provenance TracePacket for one history turn |
| `list_traceable_answers` | Recent history rows with observability flags |
| `answer_confidence` | Compact grounding summary (source count, avg score, health) |

## Auth

Identical to `pria-tools-plugin`: `pria_...` key →
`POST /api/auth/api-key-signin` (header `x-api-key`) → JWT →
`x-access-token` on all calls. Token cached in memory, re-exchanged on 401.
Key from env `PRIA_API_KEY` or plugin config. Never hardcoded, logged, or printed.

## Endpoints used (all READ)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/user/histories` | List + observability flags |
| GET  | `/api/user/history/{id}/ragSearch` | Lazy RAG/KAG segments |
| GET  | `/api/user/history/{id}/thinking` | Lazy reasoning array |
| POST | `/api/user/uploads/files-with-issues` | Source-health overlay |

## Running tests

```bash
cd ~/Projects/synaps-skills-jr/pria-black-box-plugin
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Or via the full harness:

```bash
bash scripts/test.sh
```

## Live smoke test (manual, READ-ONLY)

```bash
PRIA_API_KEY=pria_... python3 scripts/smoke.py --base https://priastaging.praxislxp.com
```

## Safety

- Read-only. No mutations, no writes, no LLM calls.
- Confidential chunk text preserved exactly as Pria returns it (placeholder only).
- API key never appears in logs, errors, output, or on disk.
- All HTTP mocked in tests — no live calls during CI.
