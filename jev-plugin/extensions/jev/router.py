"""router — before_tool_call on subagent_start / subagent.

When the foreground omitted `role`, `write_policy`, or `model`, ask Jev and
fill them via `modify`. Only ever *adds* fields the foreground left blank;
never overrides an explicit choice. Fails OPEN (continue) — routing is an
optimisation, not a security boundary.

Model tiering is opt-in via `router_models` ("small=<id>,medium=<id>"):
the plugin cannot see the runtime's authorised-model list, so a tier is only
applied when the user has mapped it to an exact, already-authorised id.
`frontier` always means "inherit the foreground model" (omit the field).
"""

from __future__ import annotations

import time

from .client import DecisionClient, JevError

SUBAGENT_TOOLS = {"subagent_start", "subagent"}
ROLES = {
    "planner": "Produce a plan or spec; no code changes",
    "implementer": "Write or change code to a described end",
    "tester": "Write or run tests; verify behaviour",
    "reviewer": "Read and critique code, docs, or a diff",
    "researcher": "Read, gather facts, summarise; no changes",
    "debugger": "Reproduce and fix a defect",
}
TIERS = {
    "small": "Mechanical, single-file, or lookup work: renames, listing, formatting, short summaries",
    "medium": "Multi-step but well-specified work: implement a described function, write tests for existing code, moderate debugging",
    "frontier": "Open-ended design, cross-cutting refactors, subtle concurrency/security bugs, deep reading across many files",
}


class RouterConfig:
    def __init__(self, cfg: dict) -> None:
        self.min_conf = float(cfg.get("router_min_conf", 0.8))
        self.read_only_at = float(cfg.get("router_read_only_at", 0.15))
        self.models: dict[str, str] = {}
        raw = str(cfg.get("router_models") or "").strip()
        for part in raw.split(","):
            if "=" in part:
                k, v = part.split("=", 1)
                k, v = k.strip().lower(), v.strip()
                if k in ("small", "medium") and v:
                    self.models[k] = v


def questions(want_model: bool) -> dict:
    q = {
        "role": {"type": "choice", "instructions": "Which worker role fits `task` best?", "criteria": ROLES},
        "needs_write": {
            "type": "noul",
            "instructions": "Does `task` require creating, editing, or deleting files in the repository?",
            "criteria": {"true": "Modifies files", "false": "Read-only: reading, searching, summarising, reviewing"},
        },
    }
    if want_model:
        q["tier"] = {
            "type": "choice",
            "instructions": "Which model tier should a foreman delegate `task` to, choosing the cheapest tier that can finish it well? When in doubt prefer the stronger tier.",
            "criteria": TIERS,
        }
    return q


def plan_fill(tool_input: dict, answers: dict, cfg: RouterConfig) -> tuple[dict, list[str]]:
    """Pure: decide which omitted fields to fill. Returns (fills, notes)."""
    fills: dict = {}
    notes: list[str] = []
    if not tool_input.get("role"):
        a = answers.get("role") or {}
        if a.get("choice") in ROLES and float(a.get("confidence", 0)) >= cfg.min_conf:
            fills["role"] = a["choice"]
            notes.append(f"role={a['choice']}({a['confidence']:.2f})")
    if not tool_input.get("write_policy"):
        p = float((answers.get("needs_write") or {}).get("noul", 1.0))
        if p <= cfg.read_only_at:
            fills["write_policy"] = {"mode": "read_only"}
            notes.append(f"write_policy=read_only(needs_write={p:.2f})")
    if not tool_input.get("model") and "tier" in answers and cfg.models:
        a = answers["tier"]
        tier = a.get("choice")
        if tier in cfg.models and float(a.get("confidence", 0)) >= cfg.min_conf:
            fills["model"] = cfg.models[tier]
            notes.append(f"model={cfg.models[tier]}(tier={tier},{a['confidence']:.2f})")
        else:
            notes.append(f"tier={tier}({float(a.get('confidence', 0)):.2f})→inherit")
    return fills, notes


def handle(params: dict, client: DecisionClient, cfg: RouterConfig, audit, log) -> dict:
    tool = params.get("tool_runtime_name") or params.get("tool_name") or ""
    tool_input = dict(params.get("tool_input") or {})
    task = str(tool_input.get("task") or "").strip()
    if not task:
        return {"action": "continue"}
    want_model = not tool_input.get("model") and bool(cfg.models)
    if tool_input.get("role") and tool_input.get("write_policy") and not want_model:
        return {"action": "continue"}

    state = {"task": task[:4000]}
    sp = tool_input.get("system_prompt")
    if isinstance(sp, str) and sp.strip():
        state["worker_system_prompt_head"] = sp[:600]

    t0 = time.monotonic()
    try:
        resp = client.decide(state, questions(want_model), op="router")
        fills, notes = plan_fill(tool_input, resp["answers"], cfg)
        ms = int((time.monotonic() - t0) * 1000)
        audit.write({"op": "router", "tool": tool, "fills": fills, "ms": ms, "model": resp.get("model"),
                     "usage": resp.get("usage"), "answers": resp["answers"], "task_head": task[:200]})
        if not fills:
            audit.bump("router.skip")
            log(f"router {tool}: no fill ({ms} ms) {' '.join(notes)}")
            return {"action": "continue"}
        audit.bump("router.fill")
        log(f"router {tool}: fill ({ms} ms) {' '.join(notes)}")
        tool_input.update(fills)
        return {"action": "modify", "input": tool_input}
    except (JevError, KeyError, TypeError, ValueError) as e:
        audit.bump("router.error")
        log(f"router {tool}: upstream error → continue ({e})")
        return {"action": "continue"}
