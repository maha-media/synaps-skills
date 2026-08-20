"""reflection_prompt — the Hermes-style self-improvement prompt (THE IP).

Ported (not copied) from Hermes `agent/background_review.py:170-273` —
the _SKILL_REVIEW_PROMPT. We keep the *taxonomy*: be ACTIVE but disciplined,
prefer patching over creating, and refuse to capture noise.

The big asymmetry we are paying for: it is FAR worse to write a bad lesson
than to skip a good one. A bad lesson poisons every future run on every
ticker. A skipped lesson costs nothing — the same situation will recur.
Hence the don't-capture rules below are HARD filters, not soft hints.

Output contract: the LLM must reply with a SINGLE JSON object (no prose
around it) of this exact shape:

    {
      "action": "none" | "create" | "patch",
      "skill_name": "lowercase-hyphenated",     // for create/patch
      "rationale": "one sentence — why",
      "description": "one sentence, <=200 chars, no newlines",  // for create
      "body": "...full SKILL.md body, markdown..."              // for create
      "patch_body": "...new SKILL.md body to replace current..."// for patch
    }

`action=none` is the correct, expected default. Skill writes are RARE.
"""
from __future__ import annotations
import json
from typing import Any

# The taxonomy. These strings ARE the IP. Keep them stable.

DONT_CAPTURE_RULES = """\
DO NOT capture (these are noise, not lessons):
  1. TRANSIENT/ENVIRONMENTAL FAILURES — a finlens HTTP 401, a network blip,
     a missing API key, a subprocess timeout. These are operational facts,
     not analytical lessons. They will not recur the same way.
  2. NEGATIVE TOOL CLAIMS — "lens X returned no data for ticker Y",
     "endpoint returned empty payload". That is a data condition for ONE
     ticker on ONE day. It is not a reusable pattern. Do not save it.
  3. ONE-OFF TICKER-SPECIFIC TRIVIA — "NVDA's Q3 beat was driven by Hopper".
     A fact about one company at one moment is not a heuristic. The next
     run on a DIFFERENT ticker would not benefit.
  4. RESTATEMENTS OF THE EXISTING SKILL — if the lesson is already covered
     by the loaded skill's text, the answer is `none`. Do not paraphrase
     what is already on disk.
"""

DO_CAPTURE_RULES = """\
DO capture (only when ALL apply):
  A. REUSABLE — the lesson would improve the NEXT research run on ANY
     ticker, not just this one.
  B. ANALYTICAL — it is a pattern, a heuristic, a correction to the plan,
     or a missing step. It is not a fact about one company.
  C. DURABLE — it will still be true next month. Quarterly earnings noise
     is not durable. A flawed lens-ordering choice is.
  D. NOT ALREADY THERE — grep the skill body. If it's there, skip.
"""

PREFERENCE_ORDER = """\
Preference order (cheapest valid action wins):
  1. action=none           ← the default. A pass that does nothing is fine.
                              Most passes should land here.
  2. action=patch          ← if a reusable lesson refines the EXISTING skill,
                              return the FULL replacement body (idempotent
                              overwrite — the runner does not merge diffs).
  3. action=create         ← only if no existing skill covers this domain.
                              Use a class-level lowercase-hyphenated name.
"""

_OUTPUT_CONTRACT = """\
== Output protocol ==
Reply with a SINGLE JSON object. No prose, no markdown fences. Schema:

  {
    "action": "none" | "create" | "patch",
    "skill_name": "string (required if action != none)",
    "rationale": "one sentence",
    "description": "one sentence <=200 chars, no newlines  (create only)",
    "body": "...SKILL.md body markdown...                  (create only)",
    "patch_body": "...full replacement SKILL.md body...    (patch only)"
  }

If action=none you may omit all other fields except `rationale`.
"""


def build_reflection_system_prompt() -> str:
    return (
        "You are xcal's self-improvement reviewer. You read a "
        "completed research session and decide ONE question: is there a "
        "DURABLE, REUSABLE lesson worth writing to or patching into a "
        "skill?\n\n"
        "Bias hard toward `action=none`. Writing a bad lesson poisons every "
        "future run; skipping a good one costs nothing — it will recur.\n\n"
        f"{DONT_CAPTURE_RULES}\n{DO_CAPTURE_RULES}\n{PREFERENCE_ORDER}\n"
        f"{_OUTPUT_CONTRACT}"
    )


def build_reflection_user_message(session: dict[str, Any]) -> str:
    """Render the completed session for the reviewer. We pass the verdict
    + question + which skill was used + the loaded skill body so the
    reviewer can check the 'NOT ALREADY THERE' rule against the real text."""
    verdict = session.get("verdict") or {}
    skill_body = session.get("skill_body", "")
    skill_used = session.get("skill_used") or verdict.get("skill_used", "")
    payload = {
        "ticker": verdict.get("ticker"),
        "question": verdict.get("question"),
        "skill_used": skill_used,
        "lens_calls": verdict.get("lens_calls", []),
        "findings": verdict.get("findings", []),
        "synthesis": verdict.get("synthesis", ""),
    }
    return (
        f"== Loaded skill body ({skill_used}) ==\n"
        f"{skill_body}\n\n"
        f"== Completed research session ==\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


# ── output parsing ──────────────────────────────────────────────────────────
class ReflectionParseError(ValueError):
    """The reviewer LLM did not produce a parseable decision."""


_VALID_ACTIONS = {"none", "create", "patch"}


def parse_reflection_decision(text: str) -> dict[str, Any]:
    """Tolerant parser: accepts bare JSON or JSON wrapped in ```json fences.
    Validates the action vocabulary. Required fields per action are checked
    by the caller (reflect.py) — here we only normalise."""
    if not text or not text.strip():
        raise ReflectionParseError("empty reviewer output")
    s = text.strip()
    candidates: list[str] = [s]
    if "```" in s:
        for chunk in s.split("```"):
            c = chunk.strip()
            if c.startswith("json"):
                c = c[4:].strip()
            if c.startswith("{"):
                candidates.append(c)
    # also try last brace-balanced object
    if "{" in s and "}" in s:
        candidates.append(s[s.find("{"): s.rfind("}") + 1])
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        action = obj.get("action")
        if action not in _VALID_ACTIONS:
            raise ReflectionParseError(f"invalid action: {action!r}")
        return obj
    raise ReflectionParseError("no parseable JSON object in reviewer output")


__all__ = [
    "DONT_CAPTURE_RULES",
    "DO_CAPTURE_RULES",
    "PREFERENCE_ORDER",
    "build_reflection_system_prompt",
    "build_reflection_user_message",
    "parse_reflection_decision",
    "ReflectionParseError",
]
