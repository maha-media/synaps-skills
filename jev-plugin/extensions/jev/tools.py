"""tools — model-callable tools: jev_decide and jev_status."""

from __future__ import annotations

import json

from .client import DecisionClient, JevError


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
        "`criteria` options → choice + probabilities + confidence), `score` (rate on 2–10 ordered "
        "`criteria` levels → score + probabilities + confidence). Question keys are NOT seen by the model: "
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
    "description": "Report the Jev plugin state: whether an API key is configured (and how to set one), plus this session's calls, tokens, cost, mean latency, guard verdict counts, router fills, compression elisions, errors.",
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
        audit.bump("decide.error")
        raise ToolError(f"jev_decide: upstream error: {e}") from e
    audit.bump("decide.ok")
    usage = resp.get("usage") or {}
    out = {
        "model": resp.get("model"),
        "answers": resp.get("answers"),
        "usage": usage,
        "cost_usd": round(int(usage.get("input_tokens") or 0) * 0.042 / 1e6, 6),
    }
    audit.write({"op": "decide", "n_questions": len(q), "usage": usage, "model": resp.get("model")})
    return {"content": json.dumps(out, separators=(",", ":"))}


def call_status(client: DecisionClient | None, audit, features: dict, key_source: str = "none") -> dict:
    if client is None:
        from . import keys  # local import keeps tools.py free of file-system concerns otherwise
        snap = {
            "active": False,
            "reason": "no API key configured",
            "how_to_fix": [
                "In synaps: /jev key <apikey_…>  (validates, saves, activates — no restart)",
                "From a shell: <plugin>/scripts/setup.sh --key <apikey_…>",
                f"Or export TYPESAFE_API_KEY before launching synaps",
            ],
            "key_store": str(keys.plugin_config_path()),
            "get_a_key": keys.GET_KEY_URL,
            "features": features,
        }
        return {"content": json.dumps(snap, indent=1)}
    snap = client.stats.snapshot()
    snap["active"] = True
    snap["key_source"] = key_source
    snap["features"] = features
    snap["counters"] = dict(audit.counters)
    snap["audit_file"] = str(audit.path) if audit.path else None
    return {"content": json.dumps(snap, indent=1)}
