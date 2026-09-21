---
name: jev-decide
description: Use when a task is many small decisions — triage, classify, route, score, yes/no checks — or when the Jev safety gate asks for confirmation. Batched calibrated decisions via jev_decide in ~0.4 s.
---

# jev-decide — calibrated decisions for the harness

TypeSafe **Jev** is a *System One* model: it never writes, it only picks from
answers you define and tells you how sure it is. This plugin integrates it
through harness hooks and four explicit tools:
`jev_decide`, `jev_select`, `jev_status`, and `jev_verify`.

| Surface | What it does | You need to… |
|---|---|---|
| **Guard** (`before_tool_call`) | Scores every `bash`/`write`/`edit`/`read` call for risk, secret exposure, workspace escape → `continue` / `confirm` / `block` | Nothing. If a call pauses for confirmation, that is the gate working. Prefer confined, reversible commands. |
| **Router** (`subagent_start`) | Fills `role` / `write_policy` (and `model` if a tier map is configured) when you omit them | Omit fields you don't have an opinion on. Explicit values are never overridden. |
| **Compress** (`after_tool_call`, opt-in) | Elides the middle of large *routine* bash outputs at ingestion; never touches failures | Nothing. The marker tells you what was cut and how to get it back. |
| **`jev_decide`** tool | Ask many typed questions about one `state` in one request | Read the rest of this page. |
| **`jev_select`** tool | Batch supplied-ID candidate choices | Use for uncertain choices, not execution or authorization. |
| **`jev_verify`** tool | Preserve required IDs and advise optional-check priority (default off) | Supply task, changes and checks; see the example below. |
| **`jev_status`** tool | Session accounting: calls, tokens, cost, verdict counts | Call it when asked about cost or when a verdict looks wrong. |
| **`/jev`** slash command (user-side) | `/jev key <apikey_…>` · `/jev status` · `/jev test` | If the user types `key …`/`status`/`help` as plain text, they meant `/jev …` — point them at it. |

## When to reach for `jev_decide`

Any time you notice you are about to reason item-by-item through a list:

- sort N emails / issues / files / forum posts into buckets
- decide which of K options applies to each record
- score things on a rubric (quality 0–4, urgency, relevance to the goal)
- yes/no checks at scale ("does this diff touch auth?", "is this event actionable?")
- pick which worker/agent/tool should handle each incoming card

It is **not** for writing, explaining, or anything needing free text.

## The three question types

```json
{
  "state": <string | object | array>,
  "questions": {
    "is_urgent": { "type": "noul",   "instructions": "Does `subject` convey urgency?",
                   "criteria": { "true": "time-sensitive", "false": "no urgency" } },
    "team":      { "type": "choice", "instructions": "Which team should handle this?",
                   "criteria": { "billing": "payments, refunds", "technical": "bugs, outages",
                                 "none": "no action needed" } },
    "anger":     { "type": "score",  "instructions": "How frustrated is the customer?",
                   "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```

Answers come back under the same keys:

- `noul` → `{"noul": 0.95}` — probability of *yes*
- `choice` → `{"choice": "billing", "probabilities": {...}, "confidence": 0.81}`
- `score` → `{"score": 1.05, "legend": {...}, "probabilities": {...}, "confidence": 0.92}` (can land between levels)

## Rules that decide whether it works

1. **Keys are invisible to the model.** `"safe_to_publish"` as a key does nothing. Put the whole question in `instructions`.
2. **Reference `state` fields in backticks** — `` "Is `resume` for the same person as `candidate`?" ``. For a list, name the item: ``"Is item id 3 in `state` urgent?"``.
3. **Describe every option.** `criteria` values are the rubric. `null` is allowed for self-explanatory options, but a one-line "when this applies" beats a bare label.
4. **Always include an escape hatch** — `"none"`, `"do_nothing"`, `"unclear"` — so the model is never forced into a wrong pick.
5. **Batch.** Up to 64 questions per call; latency barely moves. One `state`, many questions.
6. **Gate on confidence before acting.** Sketch:
   - `noul` ≥ 0.9 / ≤ 0.1 → act; near 0.5 → the model genuinely doesn't know, route to the user
   - `choice`/`score` `confidence` < 0.5 → don't act on it
   - when several levels/options lead to the *same* action, sum their `probabilities` instead of using `confidence`
7. **Confidence ≠ accuracy, and it can be injected.** Text inside `state` can push the decision. Verify outcomes in code; don't let a 0.99 stand in for checking that the file exists.
8. **Limits:** `state` + longest question ≤ 32k tokens; whole request ≤ 64k; ≤255 options per choice; 2–10 levels per score. Text only — pre-render binaries/images.

## Working with the guard

- A `confirm` prompt names the numbers: `risk=2.70 conf=0.70 secrets=0.06 escapes_cwd=0.97`. If the user declines, do not retry the same call rephrased — change the approach (narrower path, `/tmp`, dry-run flag).
- If the guard says `could not evaluate … approve manually?` the API was unreachable; the gate fails closed on purpose.
- Thresholds live in plugin config (`extension.jev.guard_ask_at`, `…_min_conf`, `…_secrets_at`, `…_escape_at`). Suggest changes; don't work around them.

## Cost & latency (measured 2026-09-20, jev-1.13.0)

~350–480 ms per request regardless of question count; $0.042 per million *input* tokens, output free. A guarded tool call ≈ 640 tokens ≈ $0.00003. `jev_status` shows the running total.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `jev: no API key configured` (from `jev_decide`/`jev_status`) | plugin is inert | tell the user: run **`/jev key <apikey_…>`** in synaps (no restart), or `scripts/setup.sh --key …`; keys from https://typesafe.ai |
| every tool call asks for confirmation | upstream down / 429 / bad key → fail-closed | check `jev_status` `errors`; fix key or wait |
| `jev_decide: question 'x': …` | schema error | see rules above |
| HTTP 422 | criteria/state shape rejected upstream | reduce options, check types, shrink `state` |
| HTTP 429 / 529 | rate limit / overload | client retries once with backoff; batch more per call |

## See also

- API reference: https://docs.typesafe.ai/api · confidence: https://docs.typesafe.ai/confidence
- Plugin README: `jev-plugin/README.md` (install, config keys, design notes)

## First-choice delegation: `jev_select`

Batch uncertain test/file/tool/route candidate choices in one explicit call.
Supply `context` and `decisions: [{instruction, candidates: [{id, description}]}]`.
Up to 32 decisions, each 2–32 candidates; IDs are returned exactly or null with
a fallback reason. `__jev_abstain__` is reserved. Choices are advisory, never
permission to execute or evidence that tests ran. Skip obvious deterministic
choices and don't delegate detailed reasoning. Do not supply secrets.

Automatic bash failure triage is enabled with a key, independent of guard;
`/jev triage off` disables calls. Original output is retained, followed only by
bounded local category/diagnostic IDs when confident. Treat the advisory as
non-authoritative; inspect evidence yourself. Unknown/oversized/truncated/error
cases abstain, and recognized failures never compress. No automatic retry.
Use status for per-operation estimated Jev cost and triage cache/skip/abstain
counts, not invented savings. Worker-tier optimization and compaction are deferred.

### Experimental discovery advice (0.3)

Local `search_tools`/`search_skills` remains pure local by default. Discovery
recommendations are **off by default**, independent of guard, and **not
recommended as a savings technique yet**. `/jev discovery
on|off [--save]` opts into sending bounded, credential-pattern-redacted search
query and descriptors to Jev, with API cost; `/jev on` enables this too. No prior
goal, transcript or schemas are sent. Redaction is best-effort, not a secrecy
guarantee. Explicit Jev tools and no-key guidance remain available.

The query is substring keywords, not a task: generic words (memory/test/search),
unstated intent and equally plausible matches must abstain. Never infer intent
from order. `jev_advisory` is optional advice, **not activation/permission or
authority**. All discovery fields/candidates stay intact and machine-readable;
no filtering/reranking occurs. Confidence ≥0.8 only maps a supplied opaque
option to an exact returned ID. Invalid/oversized/truncated/exact-name results,
off/no-key, failures and abstentions leave output unchanged. Cache is session-
local, bounded to 128 digests/options; valid answers below 0.8 cache as
abstentions. Malformed/unknown/nonfinite answers, invalid probabilities and
errors remain uncacheable; no session ID means no cache. No raw payload audit. Check status for
`discovery.*` counters and per-operation Jev cost, not assumed savings.

Supplied held-out live evidence: 1/8 correct recommendations (12.5% coverage),
zero wrong confident results, seven abstentions (two expected); 8 calls, 4,421
input tokens, estimated $0.000185682, mean 375 ms. All evidence survived and the
cached repeat cost zero. Reversed PDF abstained despite the correct option first:
order sensitivity and limited keyword intent caution against accuracy/savings
claims. See README for retained initial 0.85 evidence and the synthetic report.
Follow-up is plugin-only evaluation, not new code: user-authorized task-aware
`jev_select` batches versus keyword advice, then opt-in authorized worker-tier
maps. Both need matched task-quality and total cost/latency baselines, including
misses, rework and fallbacks, before savings recommendations.

### Sparse routing and privacy (0.3.1)
Routing asks only omitted task-aware questions, with a session-local bounded LRU
for validated fills/abstentions. Explicit fields (even invalid ones) are never
repaired. Model inference requires the user's existing tier map; unknown/frontier
inherits. Oversize task/system prompts skip rather than truncate. Only redacted
bounded task/system prompt are sent, not conversation goals or unknown fields.
Redaction is best-effort and task sharing still costs API tokens on cache misses.
Router audit/logs omit text and decisions; status reports counters and estimated
Jev costs, not savings. The existing router toggle covers caching/sparsity;
discovery stays off by default. No worker authorization or scope changes.

## Explicit verification priority: `jev_verify`

Call `jev_verify` with this public synthetic input (optional advice requires
`/jev verification on`; the default-off call instead returns optionals for review):

```json
{
  "task": "Fix parser whitespace",
  "changes": ["Trim edge whitespace while preserving whitespace inside tokens."],
  "checks": [
    {"id": "parser-unit", "description": "Mandatory parser unit checks", "required": true},
    {"id": "parser-edge", "description": "Leading/trailing whitespace and empty-input edge cases", "required": false},
    {"id": "http", "description": "HTTP transport behavior unrelated to parser whitespace", "required": false}
  ]
}
```

| Result group | Meaning |
|---|---|
| `required_ids` | Caller-required list, preserved in input order without AI classification. |
| `recommended_optional_ids` | Confident priority advice: consider these optional checks earlier. |
| `lower_priority_optional_ids` | Confident lower priority, **not permission to skip**. |
| `review_optional_ids` | Unknown, low-confidence, malformed, unavailable or disabled advice; caller review needed. |

This does not force a full-suite waiver, preserves the caller-required list but
can't discover missing mandates. Honor project/user/CI requirements outside this
input too: structural preservation is **not proof that all required checks were
included**. No result group certifies coverage or execution.

Four tools are always advertised. `jev_verify({task, changes, checks})` accepts
bounded task/change summaries and checks `{id, description, required}`. Use it only
for uncertain optional-check priority, not execution or coverage certification.
Caller-required IDs are preserved, never classified by AI, but **caller flags are
not host-authoritative or exhaustive**: honor every project/user/CI mandatory
check regardless of candidates. `deferred != safe to skip`.

`/jev verification on|off [--save]` is independent of guard and defaults off.
`/jev off`/`/jev on` toggle all features including verification. Shared key setup:
`/jev key <apikey_…>`. Disabled/no-key calls preserve required IDs and put optionals
in review; required-only calls cost nothing. One batch prioritizes optionals at
confidence ≥0.8; unknown/malformed/low-confidence answers require review. No cache
because host `hosttool.call` supplies no trusted session identity. No
file access, shell commands, activation, or automatic hook calls. See README for
strict character/UTF-8 byte and batch limits; never supply secrets.
