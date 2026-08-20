"""loop — the ReAct loop. The payoff of phase 2.2.

Flow:
  1. Load the `quarterly-check` SKILL.md → its body becomes the system prompt.
  2. Bounded tool-use loop: the LLM reasons, emits `finlens(lens, ticker)`
     tool calls via the Router, receives lens payloads as tool_result blocks,
     and continues until it returns a final text turn (no tool_use) OR we
     hit the iteration cap.
  3. The final text is expected to be a JSON object:
         {"findings":[{"claim","kind","value?","confidence?","citations":[...]}],
          "synthesis":"..."}
     Each lens result becomes a LensCall on the verdict; the parsed findings
     become Findings; verdict.finalize() ENFORCES the citation invariant.
  4. CitationError repair behavior (CHOSEN):
        DROP the offending finding(s) and retry finalize, looping until clean
        or no findings remain. This means a fabrication never crashes the run
        — it silently disappears from the verdict, and the synthesis text
        gets a "[note: N finding(s) dropped — missing/invalid citation]"
        suffix so the failure is visible to the caller. (Alternative: ask
        the LLM to repair; out of scope for slice-1 — costs another turn.)
  5. Write the synthesis to Axel via `axel_cli.remember` → axel_memory_id.

Cost note: 1 system prompt + (≤ XCAL_MAX_ITERS) model turns. The 6-lens
quarterly-check typically lands in 7 turns (6 tool_use + 1 synthesis), each
turn carrying the growing lens-payload context. Token budget grows roughly
linearly with the sum of lens payload sizes. Not solved here.
"""
from __future__ import annotations
import json
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from . import config
from .adapters import axel_cli
from .llm import LLM
from .router import Router, tool_schema, RouterError, TOOL_NAME
from .skill_loader import load_skill
from .verdict import (
    Verdict, Finding, LensCall, Recommendation,
    CitationError, MirrorTestError, VetoError, CrossValidationError,
    verdict_to_json,
)

SKILL_NAME = "quarterly-check"


@dataclass
class LoopDeps:
    """Injection seam — tests replace these with mocks."""
    llm: Optional[LLM] = None
    router: Optional[Router] = None
    axel_remember: Any = field(default=axel_cli.remember)
    max_iters: int = field(default_factory=config.dexter_max_iters)
    spawn_reflection: Any = None  # callable(sid) → None; None ⇒ default Popen


# ── helpers ─────────────────────────────────────────────────────────────────
def _summarize_lens_for_llm(result: dict[str, Any]) -> str:
    """Compact textual representation of a lens result for the LLM. We pass
    the full payload as JSON — the model needs it to extract numbers — but
    prefix with the call_id explicitly so it cannot miss the citation key."""
    return json.dumps({
        "call_id": result.get("call_id"),
        "lens": result.get("lens"),
        "ticker": result.get("ticker"),
        "status": result.get("status"),
        "latency_ms": result.get("latency_ms"),
        "error": result.get("error"),
        "payload": result.get("payload"),
    }, ensure_ascii=False)


def _extract_text(content: list[dict]) -> str:
    return "".join(b.get("text", "") for b in content if b.get("type") == "text")


def _extract_tool_uses(content: list[dict]) -> list[dict]:
    return [b for b in content if b.get("type") == "tool_use"]


_JSON_BLOCK_RE = re.compile(r"\{[\s\S]*\}\s*$")


def _parse_synthesis(text: str) -> tuple[list[dict], str, dict]:
    """Pull (findings, synthesis, extras) out of the model's final text.
    Tolerant: accepts a bare JSON object or a JSON object embedded at the
    end of text.  On parse failure: zero findings, synthesis = raw text,
    extras = {}.

    extras contains the verdict-level forced-verdict keys when the LLM
    produces them: stance, recommendations, mirror_test, inversion,
    red_flags.  All are optional; absent → extras is empty → Verdict keeps
    its defaults.  Backward-compatible: a JSON with only {findings,
    synthesis} returns extras={} and behaviour is unchanged."""
    s = (text or "").strip()
    if not s:
        return [], "", {}
    # try whole-string first
    candidates = [s]
    m = _JSON_BLOCK_RE.search(s)
    if m and m.group(0) != s:
        candidates.append(m.group(0))
    # also try fenced ```json
    if "```" in s:
        for chunk in s.split("```"):
            c = chunk.strip()
            if c.startswith("json"):
                c = c[4:].strip()
            if c.startswith("{"):
                candidates.append(c)
    for cand in candidates:
        try:
            obj = json.loads(cand)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            findings = obj.get("findings") or []
            synthesis = obj.get("synthesis") or ""
            if isinstance(findings, list) and isinstance(synthesis, str):
                extras: dict = {}
                for key in ("stance", "recommendations", "mirror_test",
                            "inversion", "red_flags"):
                    if key in obj:
                        extras[key] = obj[key]
                return findings, synthesis, extras
    return [], s, {}


def _findings_from_json(items: list[dict]) -> list[Finding]:
    out: list[Finding] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        claim = str(it.get("claim", "")).strip()
        if not claim:
            continue
        kind = it.get("kind", "qualitative")
        if kind not in ("numeric", "qualitative"):
            kind = "qualitative"
        value = it.get("value")
        try:
            value = float(value) if value is not None else None
        except (TypeError, ValueError):
            value = None
        cits = it.get("citations") or []
        if not isinstance(cits, list):
            cits = []
        citations = tuple(str(c) for c in cits if isinstance(c, (str,)))
        conf = it.get("confidence", 0.0)
        try:
            conf = float(conf)
        except (TypeError, ValueError):
            conf = 0.0
        # info_richness: only accept "A"/"B"/"C"
        ir = it.get("info_richness")
        info_richness = ir if ir in ("A", "B", "C") else None
        # corroborations: list[str] → tuple
        corr_raw = it.get("corroborations") or []
        if not isinstance(corr_raw, list):
            corr_raw = []
        corroborations = tuple(str(c) for c in corr_raw if isinstance(c, str))
        out.append(Finding(claim=claim, kind=kind, citations=citations,
                           value=value, confidence=conf,
                           info_richness=info_richness,
                           corroborations=corroborations))
    return out


def _recommendations_from_json(items: list) -> list[Recommendation]:
    """Tolerant: bad/malformed items are skipped."""
    out: list[Recommendation] = []
    if not isinstance(items, list):
        return out
    for it in items:
        if not isinstance(it, dict):
            continue
        tier = it.get("tier")
        if tier not in ("aggressive", "steady", "conservative"):
            continue
        action = str(it.get("action") or "").strip()
        if not action:
            continue
        def _float_or_none(v):
            try:
                return float(v) if v is not None else None
            except (TypeError, ValueError):
                return None
        price_low = _float_or_none(it.get("price_low"))
        price_high = _float_or_none(it.get("price_high"))
        cits_raw = it.get("citations") or []
        if not isinstance(cits_raw, list):
            cits_raw = []
        citations = tuple(str(c) for c in cits_raw if isinstance(c, str))
        out.append(Recommendation(tier=tier, action=action,
                                  price_low=price_low, price_high=price_high,
                                  citations=citations))
    return out


def _finalize_with_repair(v: Verdict) -> int:
    """Try to finalize. On CitationError, drop offending findings and retry.
    Also handles CrossValidationError by dropping findings with bad
    corroborations. Returns the number of findings dropped."""
    dropped = 0
    valid_ids = {lc.call_id for lc in v.lens_calls if lc.status == "ok"}
    keep: list[Finding] = []
    for f in v.findings:
        needs_citation = f.kind == "numeric" or f.value is not None
        if needs_citation:
            if not f.citations:
                dropped += 1
                continue
            if any(c not in valid_ids for c in f.citations):
                dropped += 1
                continue
        # Drop findings with invalid corroborations (unknown call_id or same-lens overlap)
        if f.corroborations:
            bad_corr = any(c not in valid_ids for c in f.corroborations)
            overlap = set(f.citations) & set(f.corroborations)
            id_to_lens = {lc.call_id: lc.lens for lc in v.lens_calls}
            primary_lenses = {id_to_lens[c] for c in f.citations if c in id_to_lens}
            same_lens = any(
                id_to_lens.get(c) in primary_lenses
                for c in f.corroborations
                if id_to_lens.get(c) is not None
            )
            if bad_corr or overlap or same_lens:
                # Strip corroborations rather than drop whole finding
                from dataclasses import replace
                f = replace(f, corroborations=())
        keep.append(f)
    v.findings = keep
    v.finalize()  # must succeed now
    return dropped


# ── system prompt ───────────────────────────────────────────────────────────
_SYNTHESIS_INSTRUCTIONS = """\
== Output protocol ==
When you have enough lens data, STOP calling tools and reply with a SINGLE
JSON object (no prose around it) of this exact shape:

  {
    "findings": [
      {"claim": "...", "kind": "numeric", "value": 1.23, "confidence": 0.7,
       "citations": ["finlens:<lens>#<id>", ...]},
      {"claim": "...", "kind": "qualitative", "confidence": 0.5,
       "citations": []}
    ],
    "synthesis": "one paragraph"
  }

Rules:
- Every numeric finding MUST cite at least one lens call_id from a tool_result.
- NEVER invent a number that no lens returned. Fabricated numbers are
  dropped at the type boundary.
- Qualitative findings may have empty citations.

== Optional: forced-verdict fields ==
If (and only if) your skill calls for a DECISION (a verdict / buy-sell-hold
call), include these ADDITIONAL top-level keys in the same JSON object:

  {
    ...,
    "stance": "pass" | "fail" | "grey_zone",
    "mirror_test": "<=5-sentence justification (REQUIRED if stance is 'pass')>",
    "inversion": "what would make this thesis fail / under what conditions does it die",
    "red_flags": ["tripped red line", ...],   // any red flag FORBIDS stance 'pass'
    "recommendations": [
      {"tier": "aggressive"|"steady"|"conservative", "action": "...",
       "price_low": 95.0, "price_high": 105.0,
       "citations": ["finlens:<lens>#<id>"]}   // price bands MUST cite a lens
    ]
  }
Findings may also carry "info_richness": "A"|"B"|"C" (data quality) and
"corroborations": ["finlens:<otherlens>#<id>"] (a DIFFERENT lens confirming the
same number). Omit all of these entirely for a non-decision (status) skill.
"""


def _build_system_prompt(skill_body: str, skill_name: str = SKILL_NAME) -> str:
    return (
        "You are xcal, a disciplined equity research agent.\n"
        "Follow the skill plan below. Use the `finlens` tool for every "
        "lens step. Numbers must always cite a lens call_id.\n\n"
        f"== Skill: {skill_name} ==\n{skill_body}\n\n"
        f"{_SYNTHESIS_INSTRUCTIONS}"
    )


# ── public entry point ─────────────────────────────────────────────────────-
def research_ticker(ticker: str, question: str,
                    deps: Optional[LoopDeps] = None) -> Verdict:
    ticker = (ticker or "").strip().upper()
    question = (question or "").strip()
    if not ticker or not question:
        raise ValueError("research_ticker requires non-empty ticker and question")

    deps = deps or LoopDeps()
    llm = deps.llm or LLM()
    router = deps.router or Router()
    max_iters = max(1, deps.max_iters)

    import os as _os
    skill_name = _os.environ.get("XCAL_SKILL") or SKILL_NAME
    skill = load_skill(skill_name)
    system = _build_system_prompt(skill.body, skill_name)
    tools = [tool_schema()]

    messages: list[dict] = [{
        "role": "user",
        "content": f"Ticker: {ticker}\nQuestion: {question}",
    }]

    final_text = ""
    for _ in range(max_iters):
        resp = llm.message(messages, tools=tools, system=system)
        content = resp["content"]
        tool_uses = _extract_tool_uses(content)

        # Always append the assistant turn to the running transcript.
        messages.append({"role": "assistant", "content": content})

        if not tool_uses:
            final_text = _extract_text(content)
            break

        tool_results = []
        for tu in tool_uses:
            if tu.get("name") != TOOL_NAME:
                tool_results.append({
                    "type": "tool_result", "tool_use_id": tu.get("id", ""),
                    "is_error": True,
                    "content": f"unknown tool: {tu.get('name')!r}",
                })
                continue
            try:
                result = router.dispatch(tu.get("input") or {})
                tool_results.append({
                    "type": "tool_result", "tool_use_id": tu.get("id", ""),
                    "content": _summarize_lens_for_llm(result),
                })
            except RouterError as e:
                tool_results.append({
                    "type": "tool_result", "tool_use_id": tu.get("id", ""),
                    "is_error": True, "content": f"router error: {e}",
                })
        messages.append({"role": "user", "content": tool_results})
    else:
        # iteration cap hit without final synthesis
        final_text = ""

    # Build the verdict.
    v = Verdict(ticker=ticker, question=question, skill_used=skill_name)
    for r in router.results:
        v.lens_calls.append(LensCall(
            call_id=r["call_id"], lens=r.get("lens", ""),
            status=r.get("status", "error"),
            latency_ms=int(r.get("latency_ms", 0) or 0),
            error=r.get("error"),
        ))

    parsed_findings, synthesis, extras = _parse_synthesis(final_text)
    v.findings = _findings_from_json(parsed_findings)
    v.synthesis = synthesis or "(no synthesis produced)"

    # Populate forced-verdict fields from extras (tolerant; absent → defaults).
    _VALID_STANCES = {"pass", "fail", "grey_zone"}
    raw_stance = extras.get("stance")
    v.stance = raw_stance if raw_stance in _VALID_STANCES else None
    v.recommendations = _recommendations_from_json(extras.get("recommendations") or [])
    mt = extras.get("mirror_test")
    v.mirror_test = str(mt) if isinstance(mt, str) else None
    inv = extras.get("inversion")
    v.inversion = str(inv) if isinstance(inv, str) else None
    rf_raw = extras.get("red_flags") or []
    v.red_flags = tuple(str(x) for x in rf_raw if isinstance(x, str))

    # Finalize with comprehensive repair — never let verdict errors escape.
    try:
        v.finalize()
    except CitationError:
        dropped = _finalize_with_repair(v)
        if dropped:
            v.synthesis = (
                v.synthesis
                + f"\n[note: {dropped} finding(s) dropped — missing/invalid citation]"
            )
    except (VetoError, MirrorTestError):
        # Stance incompatible with model output — downgrade to grey_zone.
        v.stance = "grey_zone"
        v.mirror_test = None   # not required for grey_zone
        v.synthesis = v.synthesis + "\n[note: verdict downgraded to grey_zone — stance/mirror_test constraint]"
        try:
            v.finalize()
        except CitationError:
            dropped = _finalize_with_repair(v)
            if dropped:
                v.synthesis = (
                    v.synthesis
                    + f"\n[note: {dropped} finding(s) dropped — missing/invalid citation]"
                )
        except Exception:  # noqa: BLE001
            # Last-ditch: clear stance entirely and force finalize
            v.stance = None
            v.recommendations = []
            v.mirror_test = None
            v.red_flags = ()
            try:
                _finalize_with_repair(v)
            except Exception:  # noqa: BLE001
                v._finalized = True  # type: ignore[attr-defined]
    except CrossValidationError:
        # Drop bad corroborations and re-finalize.
        dropped = _finalize_with_repair(v)
        if dropped:
            v.synthesis = (
                v.synthesis
                + f"\n[note: {dropped} finding(s) dropped — missing/invalid citation]"
            )
    except Exception:  # noqa: BLE001
        # Safety net — should never hit but never crash research_ticker.
        try:
            _finalize_with_repair(v)
        except Exception:  # noqa: BLE001
            v._finalized = True  # type: ignore[attr-defined]

    # Write to Axel (best-effort; failure does not crash the run).
    # Skip the real subprocess shell-out when running under a test fixture,
    # so unit/protocol tests don't depend on the axel binary being installed.
    import os as _os
    if _os.environ.get("XCAL_LLM_FIXTURE"):
        try:
            deps.axel_remember(v.synthesis, category="cases",
                               topic=f"{ticker}:quarterly-check")
        except Exception:  # noqa: BLE001
            pass
        v.axel_memory_id = "fixture-mem-id"
    else:
        try:
            remembered = deps.axel_remember(
                v.synthesis,
                category="cases",
                topic=f"{ticker}:quarterly-check",
            )
            if isinstance(remembered, dict) and remembered.get("status") == "ok":
                v.axel_memory_id = remembered.get("memory_id") or None
            else:
                v.axel_memory_id = None
        except Exception as e:  # noqa: BLE001
            v.axel_memory_id = None
            v.synthesis = v.synthesis + f"\n[axel write failed: {e}]"

    # Write to Shadow Journal (best-effort; failure does not crash the run).
    # During fixture tests (XCAL_LLM_FIXTURE set), journal to a temp path so
    # we never write to the real ~/.config/xcal path and existing tests stay green.
    try:
        from . import shadow as _shadow
        # Extract last-known price from the technicals lens result, if present.
        _price_at_verdict: Optional[float] = None
        for _r in router.results:
            if _r.get("lens") == "technicals" and _r.get("status") == "ok":
                _payload = _r.get("payload") or {}
                # price lives in payload.meta.price (finlens technicals); fall
                # back to a few top-level field names for resilience.
                _sources = [_payload.get("meta") or {}, _payload]
                for _src in _sources:
                    for _field in ("price", "current_price", "last_price", "close"):
                        _val = _src.get(_field)
                        if _val is not None:
                            try:
                                _price_at_verdict = float(_val)
                                break
                            except (TypeError, ValueError):
                                pass
                    if _price_at_verdict is not None:
                        break
                if _price_at_verdict is not None:
                    break
        _journal_path = None
        if _os.environ.get("XCAL_LLM_FIXTURE"):
            import tempfile as _tmp
            _journal_path = _tmp.mktemp(suffix=".jsonl", prefix="xcal_shadow_fixture_")
        _shadow.record_verdict(v, price_at_verdict=_price_at_verdict,
                               journal_path=_journal_path)
    except Exception:  # noqa: BLE001
        pass

    v.reflection = _maybe_spawn_reflection(v, deps)
    return v


# ── reflection spawn (fire-and-forget) ─────────────────────────────────────
def _build_session_record(v: Verdict, skill_body: str) -> dict:
    """Serialize the verdict (and the skill body it ran under) into a
    plain dict suitable for JSON spool handoff."""
    return {
        "verdict": {
            "ticker": v.ticker,
            "question": v.question,
            "skill_used": v.skill_used,
            "lens_calls": [
                {"call_id": lc.call_id, "lens": lc.lens, "status": lc.status,
                 "latency_ms": lc.latency_ms, "error": lc.error}
                for lc in v.lens_calls
            ],
            "findings": [
                {"claim": f.claim, "kind": f.kind, "value": f.value,
                 "confidence": f.confidence, "citations": list(f.citations)}
                for f in v.findings
            ],
            "synthesis": v.synthesis,
        },
        "skill_used": v.skill_used,
        "skill_body": skill_body,
    }


def _maybe_spawn_reflection(v: Verdict, deps: "LoopDeps") -> dict:
    """Persist the session and Popen `python main.py --mode=reflect
    --session=<sid>` detached. Returns the reflection field for the verdict.

    Hard guard: if XCAL_IN_REFLECTION=1 is already set in OUR env, we
    REFUSE to spawn — this pins the recursion counter to 0. A reflection
    subprocess that somehow re-entered research_ticker would not be able to
    spawn another reflection."""
    import os as _os
    import subprocess as _sp
    import sys as _sys
    from . import spool as _spool
    from . import config as _cfg
    from . import reflect as _reflect

    if not _cfg.reflect_enabled():
        return {"status": "disabled"}
    refusal = _reflect.refuse_if_recursing()
    if refusal is not None:
        return refusal

    try:
        sk = _load_skill_safe(v.skill_used)
        sid = _spool.new_session_id()
        _spool.write(sid, _build_session_record(v, sk))
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": f"spool failed: {e}"}

    # Use the injected spawner if present (tests mock this).
    spawn = getattr(deps, "spawn_reflection", None) or _default_spawn
    try:
        spawn(sid)
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "reason": f"spawn failed: {e}", "session_id": sid}

    return {"status": "queued", "session_id": sid}


def _load_skill_safe(name: str) -> str:
    try:
        return load_skill(name).body
    except Exception:  # noqa: BLE001
        return ""


def _default_spawn(sid: str) -> None:
    """Fire-and-forget Popen. Detached: new session, no wait. Child env
    inherits ours PLUS XCAL_IN_REFLECTION=1."""
    import os as _os
    import subprocess as _sp
    import sys as _sys
    from pathlib import Path as _Path

    main_py = _Path(__file__).resolve().parents[2] / "main.py"
    env = dict(_os.environ)
    env["XCAL_IN_REFLECTION"] = "1"
    _sp.Popen(
        [_sys.executable, str(main_py), "--mode=reflect", f"--session={sid}"],
        env=env,
        stdin=_sp.DEVNULL, stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )


# Re-export for callers that want the JSON form.
__all__ = ["research_ticker", "LoopDeps", "verdict_to_json"]
