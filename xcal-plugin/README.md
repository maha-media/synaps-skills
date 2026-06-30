# xcal-plugin

**xcal** — a self-improving financial-research agent. It runs a ReAct loop over
**deterministic `finlens` lenses**, enforces a **no-fabrication invariant** (every
number in a Verdict must cite the `LensCall` it came from), writes its findings to
**Axel** long-term memory, and uses a **Hermes-style reflection pass** to improve
its own skills between runs.

The plugin registers a single tool — `research_ticker(ticker, question)` — and
exposes it to Synaps via the standard JSON-RPC-over-stdio extension protocol
(`main.py`). 98 tests cover the loop, citation guard, router, reflection,
skill loader, and the Anthropic API-key + OAuth identity-first LLM client.

## The 5-step flow

1. **Plan** — load a `SKILL.md` plan for the question class (router picks the skill).
2. **Lenses** — call `finlens` lenses (the deterministic engine) for every datum.
3. **Cite** — each `Finding` carries the `LensCall` id that produced its number;
   `Verdict.finalize()` raises `CitationError` if anything is uncited.
4. **Remember** — persist the finalized verdict + structured findings to Axel.
5. **Reflect** — a Hermes-style pass critiques the run and proposes diffs to the
   skill file, so the next run is sharper. Reflections are gated by tests.

The invariant: **no number reaches the user that didn't come from a lens call.**

## Setup

```bash
bash scripts/setup.sh         # creates .venv, installs requirements.txt
bash scripts/setup.sh --check # verifies .venv and runs the test suite (pytest -q)
```

Or via Synaps:

```
xcal-setup
xcal-check
```

## Entrypoint

The extension entrypoint is `main.py`, launched via the plugin's venv python:

```
.venv/bin/python main.py
```

Synaps loaders that auto-detect `main.py` will pick it up directly; environments
that need an explicit command should invoke the above (paths relative to the
plugin dir — no absolutes).

## Environment variables

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key. If absent, xcal falls back to the OAuth identity-first handshake (`auth.json`). |
| `XCAL_MODEL` | Override the default Claude model id. |
| `XCAL_FINLENS_HOME` | Path to the `finlens` install (the deterministic lens engine — see Integration Notes). |
| `AXEL_BIN` | Path to the `axel` CLI for memory persistence. |
| `XCAL_SKILLS_DIR` | Override the skills directory (defaults to the bundled `skills/`). |

## Layout

```
xcal-plugin/
├── .synaps-plugin/plugin.json   # manifest (metadata + xcal-setup / xcal-check commands)
├── main.py                      # JSON-RPC stdio extension entrypoint
├── src/research/                # ReAct loop, verdict, router, reflection, adapters
├── skills/quarterly-check/      # seed skill (SKILL.md plan)
├── tests/                       # 98 pytest tests
├── scripts/setup.sh             # venv build + --check
└── requirements.txt
```

## Integration notes (for JR)

1. **`finlens` is a hard dependency.** xcal does not fetch market data itself —
   every number comes from `finlens` lens calls (that's the whole point of the
   citation guard). Point `XCAL_FINLENS_HOME` at the `finlens` install. If it
   isn't already in your tree, it needs to land alongside this plugin.

2. **Memory uses Axel.** Your repo already has `axel-memory-manager-plugin` and
   `memkoshi-plugin`, so the memory substrate is likely already present on
   your side — xcal will write through it via `AXEL_BIN`.

3. **LLM client is Anthropic-first.** `src/research/llm.py` speaks the
   Anthropic API (API-key path) and the OAuth identity-first handshake. For a
   Pria / OpenAI / Codex setup, either provide an `ANTHROPIC_API_KEY`, or add
   an OpenAI adapter behind the same `LLMClient` interface (the abstraction is
   already in place — the test suite for it lives in `tests/test_llm*.py`).

## Author

Haseeb Khalid (0x04am) — <https://github.com/HaseebKhalid1507>
