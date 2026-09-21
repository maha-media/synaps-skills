"""tools — model-callable tools: jev_decide, jev_select and jev_status."""

from __future__ import annotations

from .audit import classify_choice, explain_error

import json

from .client import DecisionClient, JevError, usage_tokens


class ToolError(Exception):
    """Surfaced to the runtime as a JSON-RPC error → normal tool failure."""

MAX_QUESTIONS = 64
VALID_TYPES = {"noul", "choice", "score"}

DECIDE_SPEC = {
    "name": "jev_decide",
    "description": (
        "Ask TypeSafe Jev (a fast, calibrated System One decision model — it never writes, only picks) "
        "one or many typed questions about a `state`, in a single ~0.4 s request. Use it for batched "
        "classification, triage, routing, scoring, and yes/no checks instead of reasoning through them "
        "one at a time. Question types: `noul` (yes/no → probability 0–1), `choice` (pick one of ≤255 "
        "`criteria` object (ID → description), NOT a list → choice + probabilities + confidence), `score` (rate on 2–10 ordered "
        "`criteria` ordered list, NOT an object → score + probabilities + confidence). Question keys are NOT seen by the model: "
        "put all meaning in `instructions`/`criteria`. Reference fields of `state` in backticks. Include a "
        "'none of these' / 'do nothing' option where sensible and gate on confidence before acting."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "state": {
                "description": "The content to evaluate: a string, or a JSON object/array (records, a log, the current situation).",
                "type": ["string", "object", "array"],
            },
            "questions": {
                "type": "object",
                "description": "Map of your own question id → {type, instructions, criteria}. Up to 64 per call.",
                "additionalProperties": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": ["noul", "choice", "score"]},
                        "instructions": {"type": ["string", "object", "array"]},
                        "criteria": {"type": ["object", "array"]},
                    },
                    "required": ["type", "instructions"],
                },
            },
        },
        "required": ["state", "questions"],
    },
}

STATUS_SPEC = {
    "name": "jev_status",
    "description": "Report the Jev plugin state: whether an API key is configured (and how to set one), plus this session's calls, tokens, cost, mean latency, guard verdict counts, router call/cache/questions/skip/fill/abstain/error counters, compression call/questions/skip/keep/fold/error counters and successful-fold input/output/saved byte totals, evidence call/questions/skip/inspect_first/later/review/error counters, verification call/questions/skip/recommend/defer/review/error counters, reports call/questions/cache/skip/advice/abstain/error counters, diagnose call/questions/skip/investigate/contradicted/inspect/later/review/error counters (no cache), triage and discovery skip/cache/recommend/abstain/error counters, per-operation estimated Jev cost/tokens/latency, errors. No savings estimate.",
    "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
}


def validate_questions(q) -> str | None:
    if not isinstance(q, dict) or not q:
        return "questions must be a non-empty object"
    if len(q) > MAX_QUESTIONS:
        return f"too many questions ({len(q)} > {MAX_QUESTIONS}); split into batches"
    for k, v in q.items():
        if not isinstance(v, dict):
            return f"question {k!r} must be an object"
        t = v.get("type")
        if t not in VALID_TYPES:
            return f"question {k!r}: type must be one of {sorted(VALID_TYPES)}"
        if "instructions" not in v:
            return f"question {k!r}: instructions required"
        c = v.get("criteria")
        if t == "choice" and (not isinstance(c, dict) or len(c) < 2 or len(c) > 255):
            return f"question {k!r}: choice criteria must be an object with 2–255 options"
        if t == "score" and (not isinstance(c, list) or len(c) < 2 or len(c) > 10):
            return f"question {k!r}: score criteria must be a list of 2–10 ordered levels"
    return None


def call_decide(tool_input: dict, client: DecisionClient, audit) -> dict:
    state = tool_input.get("state")
    q = tool_input.get("questions")
    err = validate_questions(q)
    if err:
        raise ToolError(f"jev_decide: {err}")
    if state in (None, ""):
        raise ToolError("jev_decide: state is required")
    try:
        resp = client.decide(state, q, op="decide")
    except JevError as e:
        explain_error(audit, "decide", e)
        audit.bump("decide.error")
        raise ToolError(f"jev_decide: upstream error: {e}") from e
    for name, question in q.items():
        answers = resp.get("answers")
        audit.explain("decide", classify_choice(answers.get(name) if isinstance(answers, dict) else None,
                      question["criteria"], 0) if question["type"] == "choice" else "review")
    audit.bump("decide.ok")
    usage = resp.get("usage")
    tokens = usage_tokens(resp)
    out = {
        "model": resp.get("model"),
        "answers": resp.get("answers"),
        "usage": usage,
        "cost_usd": None if tokens is None else round(tokens * 0.042 / 1e6, 6),
    }
    audit.write({"op": "decide", "n_questions": len(q), "usage": usage, "model": resp.get("model")})
    return {"content": json.dumps(out, separators=(",", ":"))}


def call_status(client: DecisionClient | None, audit, features: dict, key_source: str = "none", *, policy=None, stats=None, compress_mode=None) -> dict:
    policy = policy or getattr(client, "policy", None)
    if client is None:
        from . import keys  # local import keeps tools.py free of file-system concerns otherwise
        snap = {
            "active": False,
            "compress_mode": compress_mode,
            "reason": "no API key configured",
            "how_to_fix": [
                "In synaps: /jev key <apikey_…>  (validates, saves, activates — no restart)",
                "From a shell: <plugin>/scripts/setup.sh --key <apikey_…>",
                f"Or export TYPESAFE_API_KEY before launching synaps",
            ],
            "key_store": str(keys.plugin_config_path()),
            "get_a_key": keys.GET_KEY_URL,
            "features": features,
            "counters": dict(audit.counters),
            "explanations": audit.explanations(),
        }
        if stats is not None:
            snap.update(stats.snapshot())
        if policy:
            snap["budget"] = policy.snapshot()
        return {"content": json.dumps(snap, indent=1)}
    snap = client.stats.snapshot()
    if policy:
        snap["budget"] = policy.snapshot()
    snap["active"] = True
    snap["compress_mode"] = compress_mode
    snap["key_source"] = key_source
    snap["features"] = features
    snap["counters"] = dict(audit.counters)
    snap["explanations"] = audit.explanations()
    snap["audit_file"] = str(audit.path) if audit.path else None
    return {"content": json.dumps(snap, indent=1)}

SELECT_SPEC = {
    "name": "jev_select",
    "description": "Batch uncertain tests/files/tools/routes choices in one request. Returns only supplied candidate IDs or null; advisory, not authorization or evidence tests ran. Skip obvious deterministic choices. No execution or activation.",
    "input_schema": {
        "type": "object", "additionalProperties": False,
        "required": ["context", "decisions"],
        "properties": {
            "context": {"type": "string", "minLength": 1, "maxLength": 5000},
            "decisions": {"type": "array", "minItems": 1, "maxItems": 32, "items": {
                "type": "object", "additionalProperties": False,
                "required": ["instruction", "candidates"], "properties": {
                    "instruction": {"type": "string", "minLength": 1, "maxLength": 500},
                    "candidates": {"type": "array", "minItems": 2, "maxItems": 32, "items": {
                        "type": "object", "additionalProperties": False, "required": ["id", "description"],
                        "properties": {"id": {"type": "string", "minLength": 1, "maxLength": 80},
                                       "description": {"type": "string", "minLength": 1, "maxLength": 300}}}}}}}}}
}
ABSTAIN = "__jev_abstain__"


def call_select(data, client, audit):
    from .triage import valid_choice

    def text(v, limit):
        return isinstance(v, str) and bool(v.strip()) and len(v) <= limit and not any(ord(c) < 32 for c in v if c not in "\n\t")

    if not isinstance(data, dict) or set(data) != {"context", "decisions"} or not text(data.get("context"), 5000):
        raise ToolError("jev_select: context must be a nonblank string <=5000 chars; context and decisions required")
    decisions = data["decisions"]
    if not isinstance(decisions, list) or not 1 <= len(decisions) <= 32:
        raise ToolError("jev_select: provide 1–32 decisions")
    questions, allowed = {}, []
    for i, d in enumerate(decisions):
        if not isinstance(d, dict) or set(d) != {"instruction", "candidates"} or not text(d.get("instruction"), 500):
            raise ToolError("jev_select: invalid instruction (1–500 chars)")
        candidates = d["candidates"]
        if not isinstance(candidates, list) or not 2 <= len(candidates) <= 32:
            raise ToolError("jev_select: provide 2–32 candidates per decision")
        criteria = {}
        for c in candidates:
            if (not isinstance(c, dict) or set(c) != {"id", "description"}
                    or not text(c.get("id"), 80) or not text(c.get("description"), 300)
                    or c["id"] == ABSTAIN or c["id"] in criteria):
                raise ToolError("jev_select: invalid, duplicate, or reserved candidate ID/description")
            criteria[c["id"]] = c["description"]
        allowed.append(set(criteria))
        criteria[ABSTAIN] = "Abstain: unclear, insufficient evidence, or none of the supplied candidates"
        questions[str(i)] = {"type": "choice", "instructions": d["instruction"], "criteria": criteria}
    if len(json.dumps(data, ensure_ascii=False)) > 50000:
        raise ToolError("jev_select: batch exceeds 50000 chars")
    try:
        response = client.decide(data["context"], questions, op="select")
        answers = response.get("answers", {})
        for q, question in questions.items():
            audit.explain("select", classify_choice(answers.get(q) if isinstance(answers, dict) else None, question["criteria"]))
        if not isinstance(answers, dict):
            answers = {}
        reason = "abstain_or_invalid_or_low_confidence"
    except Exception as error:
        explain_error(audit, "select", error)
        answers, reason = {}, "upstream_error"
    results = []
    for i, candidates in enumerate(allowed):
        selected = valid_choice(answers.get(str(i)), candidates)
        results.append({"id": selected, "fallback_reason": None if selected else reason})
    audit.bump("select.batch")
    return {"content": json.dumps({"advisory": True, "decisions": results}, ensure_ascii=False)}
