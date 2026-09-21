---
name: jev-decide
description: Use when a task is many small decisions — triage, classify, route, score, yes/no checks — or when the Jev safety gate asks for confirmation. Batched calibrated decisions via jev_decide in ~0.4 s.
---

# jev-decide — calibrated decisions for the harness

TypeSafe **Jev** is a *System One* model: it never writes, it only picks from
answers you define and tells you how sure it is. This plugin puts it in three
places in the Synaps harness and exposes it to you as a tool.

| Surface | What it does | You need to… |
|---|---|---|
| **Guard** (`before_tool_call`) | Scores every `bash`/`write`/`edit`/`read` call for risk, secret exposure, workspace escape → `continue` / `confirm` / `block` | Nothing. If a call pauses for confirmation, that is the gate working. Prefer confined, reversible commands. |
| **Router** (`subagent_start`) | Fills `role` / `write_policy` (and `model` if a tier map is configured) when you omit them | Omit fields you don't have an opinion on. Explicit values are never overridden. |
| **Compress** (`after_tool_call`, opt-in) | Elides the middle of large *routine* bash outputs at ingestion; never touches failures | Nothing. The marker tells you what was cut and how to get it back. |
| **`jev_decide`** tool | Ask many typed questions about one `state` in one request | Read the rest of this page. |
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
