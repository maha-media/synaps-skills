"""reflect — the reflection runner (Hermes organ, xcal edition).

This module runs INSIDE the reflection subprocess. It is deliberately
narrow: the only collaborators it is allowed to touch are

    src.research.llm           (one bounded LLM call)
    src.research.skillstore    (create/update SKILL.md)
    src.research.skill_loader  (read the current skill body)
    src.research.spool         (read the session record handed over)
    src.research.config        (env-driven paths/limits)
    src.research.reflection_prompt   (the IP — taxonomy + parser)

Forbidden imports (enforced both at runtime by `_assert_whitelist()` AND
by the whitelist test under tests/): finlens_call, router, loop, axel_cli.
A reflection MUST NOT call lenses, MUST NOT call axel, MUST NOT spawn
another reflection.

Recursion guard: the parent sets XCAL_IN_REFLECTION=1 in the child env
before Popen. `run_reflection()` is callable from anywhere, but the parent
(research_ticker) refuses to spawn a NEW reflection if that env is already
set. This pins the recursion counter to 0 — only one level deep, ever.
"""
from __future__ import annotations
import os
import sys
from typing import Any, Optional

from . import config
from . import skillstore
from . import skill_loader
from . import spool
from .llm import LLM, LLMError
from .reflection_prompt import (
    build_reflection_system_prompt,
    build_reflection_user_message,
    parse_reflection_decision,
    ReflectionParseError,
)


_WHITELIST = {
    "src.research.llm",
    "src.research.skillstore",
    "src.research.skill_loader",
    "src.research.spool",
    "src.research.config",
    "src.research.reflection_prompt",
    "src.research",
}
_FORBIDDEN = (
    "src.research.adapters.finlens_call",
    "src.research.adapters.axel_cli",
    "src.research.router",
    "src.research.loop",
)


def _assert_whitelist() -> None:
    """Sanity check at call time: none of the forbidden modules are imported
    BY this module's own namespace. (It's still possible for something else
    in the process to have imported them — but inside the reflection
    subprocess, where this matters, nothing else loads them.)"""
    g = globals()
    for mod in _FORBIDDEN:
        last = mod.rsplit(".", 1)[-1]
        if last in g:
            raise RuntimeError(
                f"reflection whitelist violation: {mod} present in reflect.py globals")


def _extract_text(content: list[dict]) -> str:
    return "".join(b.get("text", "") for b in content if b.get("type") == "text")


def _is_transient_only(verdict: dict[str, Any]) -> bool:
    """Cheap pre-filter: if EVERY lens call errored AND there are no
    findings, the session has nothing analytical to learn from. Skip the
    LLM call entirely. (The prompt would say `none` too, but this saves
    a turn — and is a deterministic safety net behind the don't-capture
    rules.)"""
    findings = verdict.get("findings") or []
    if findings:
        return False
    lens_calls = verdict.get("lens_calls") or []
    if not lens_calls:
        return True
    return all((lc.get("status") != "ok") for lc in lens_calls)


def _apply_decision(decision: dict[str, Any]) -> dict[str, Any]:
    """Translate a parsed decision into a skillstore call. Returns the
    result dict the runner will report back."""
    action = decision.get("action")
    rationale = str(decision.get("rationale", "")).strip()
    if action == "none":
        return {"action": "none", "applied": False,
                "reason": rationale or "no durable lesson"}

    name = str(decision.get("skill_name", "")).strip()
    if not name:
        return {"action": action, "applied": False,
                "reason": "missing skill_name"}

    if action == "create":
        desc = str(decision.get("description", "")).strip()
        body = str(decision.get("body", ""))
        if not desc or not body:
            return {"action": "create", "applied": False, "skill_name": name,
                    "reason": "create requires description + body"}
        try:
            skillstore.create(name, desc, body, provenance="background_review")
        except skillstore.SkillError as e:
            return {"action": "create", "applied": False, "skill_name": name,
                    "reason": f"skillstore rejected: {e}"}
        return {"action": "create", "applied": True, "skill_name": name,
                "reason": rationale or "new reusable lesson"}

    if action == "patch":
        new_body = decision.get("patch_body")
        if not isinstance(new_body, str) or not new_body.strip():
            return {"action": "patch", "applied": False, "skill_name": name,
                    "reason": "patch requires non-empty patch_body"}
        try:
            skillstore.update(name, body=new_body)
        except skillstore.SkillError as e:
            return {"action": "patch", "applied": False, "skill_name": name,
                    "reason": f"skillstore rejected: {e}"}
        return {"action": "patch", "applied": True, "skill_name": name,
                "reason": rationale or "skill refined"}

    return {"action": str(action), "applied": False,
            "reason": f"unknown action: {action!r}"}


def run_reflection(session: dict[str, Any],
                   *, llm: Optional[LLM] = None) -> dict[str, Any]:
    """The reflection entry point. Pure-ish: takes a session dict, returns
    a decision-result dict. `session` is the record produced by the parent
    in loop.py:_build_session_record (verdict, skill_used, skill_body)."""
    _assert_whitelist()

    verdict = session.get("verdict") or {}
    # Cheap deterministic skip: nothing happened worth reflecting on.
    if _is_transient_only(verdict):
        return {"action": "none", "applied": False,
                "reason": "all lens calls errored / no findings — transient run"}

    # Make sure the reviewer has the CURRENT skill body for the
    # "NOT ALREADY THERE" check, even if the parent omitted it.
    if not session.get("skill_body"):
        sk_name = session.get("skill_used") or verdict.get("skill_used", "")
        if sk_name:
            try:
                session["skill_body"] = skill_loader.load_skill(sk_name).body
            except Exception:  # noqa: BLE001
                session["skill_body"] = ""

    system = build_reflection_system_prompt()
    user = build_reflection_user_message(session)
    messages = [{"role": "user", "content": user}]

    client = llm or LLM()
    # ONE bounded LLM call. The iter cap is here defensively — the prompt
    # asks for a single JSON object, no tools, so one turn is enough.
    max_iters = config.reflect_max_iters()
    last_text = ""
    for _ in range(max_iters):
        try:
            resp = client.message(messages, system=system)
        except LLMError as e:
            return {"action": "none", "applied": False,
                    "reason": f"llm error: {e}"}
        last_text = _extract_text(resp.get("content") or [])
        if last_text.strip():
            break

    try:
        decision = parse_reflection_decision(last_text)
    except ReflectionParseError as e:
        return {"action": "none", "applied": False,
                "reason": f"unparseable reviewer output: {e}"}

    return _apply_decision(decision)


def run_from_session_id(sid: str) -> dict[str, Any]:
    """Subprocess entry: load session from spool, run reflection, return
    the result dict. The caller (main.py --mode=reflect) prints/exits."""
    rec = spool.consume(sid)
    return run_reflection(rec)


# ── refuse recursion ────────────────────────────────────────────────────────
def refuse_if_recursing() -> Optional[dict[str, Any]]:
    """Used by both the parent (before spawning) and the child (defensively):
    if XCAL_IN_REFLECTION is already set when we try to START a reflection
    spawn, refuse. Returns a refusal dict, or None to proceed."""
    if config.in_reflection():
        return {"status": "refused", "reason": "XCAL_IN_REFLECTION set — "
                "no recursive reflection"}
    return None


__all__ = ["run_reflection", "run_from_session_id", "refuse_if_recursing",
           "_assert_whitelist"]
