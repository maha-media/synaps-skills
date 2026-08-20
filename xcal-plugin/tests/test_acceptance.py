"""PHASE 2.4 — Slice-1 ACCEPTANCE TESTS.

End-to-end proofs of the spec's load-bearing invariants. The LLM hop is
fixtured (scripted transcript) because the xcal deploy-time
ANTHROPIC_API_KEY isn't wired here; everything else is real or gated:

  * finlens grounding   — REAL when XCAL_LIVE_FINLENS=1 (else fixture).
  * skillstore write    — REAL (filesystem).
  * axel index/search   — REAL when XCAL_LIVE_AXEL=1 (else load-back proof).

The fabrication-guard AC is deterministic — no network at all. It proves
the citation invariant at the type boundary regardless of the LLM.
"""
from __future__ import annotations
import json
import os
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

from src.research import loop as research_loop
from src.research import reflect as research_reflect
from src.research import skill_loader, skillstore, spool, config as rc
from src.research.llm import LLM
from src.research.loop import LoopDeps, research_ticker
from src.research.router import Router
from src.research.verdict import verdict_to_json


REPO = Path(__file__).resolve().parents[1]
TICKER = os.environ.get("XCAL_ACCEPT_TICKER", "NVDA")


# ── shared helpers ─────────────────────────────────────────────────────────
def _scripted_llm(responses):
    i = {"n": 0}

    def t(payload, headers, *, timeout=60):
        n = i["n"]
        if n >= len(responses):
            raise AssertionError("LLM called more times than scripted")
        i["n"] = n + 1
        return responses[n]
    return LLM(model="acceptance", api_key="fixture", transport=t)


def _seed_skill(tmp_path, monkeypatch) -> Path:
    skills = tmp_path / "skills"
    qc = skills / "quarterly-check"
    qc.mkdir(parents=True)
    src = REPO / "skills" / "quarterly-check" / "SKILL.md"
    (qc / "SKILL.md").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(skills))
    return skills


def _fixture_lens_table():
    return {
        "fundamentals": {"call_id": "finlens:fundamentals#F1",
                         "lens": "fundamentals", "ticker": TICKER,
                         "status": "ok", "latency_ms": 5,
                         "payload": {"rev_y": 60.9, "fcf_margin": 0.42}},
        "technicals":   {"call_id": "finlens:technicals#T1",
                         "lens": "technicals", "ticker": TICKER,
                         "status": "ok", "latency_ms": 4,
                         "payload": {"trend": "up", "rsi": 61.0}},
        "insider":      {"call_id": "finlens:insider#I1",
                         "lens": "insider", "ticker": TICKER,
                         "status": "ok", "latency_ms": 3,
                         "payload": {"net_buy_30d": -1.2}},
    }


def _router_from_table(table):
    def call_lens(lens, ticker, **_):
        r = dict(table[lens]); r.setdefault("ticker", ticker.upper()); return r
    return Router(call_lens=call_lens)


# ════════════════════════════════════════════════════════════════════════════
# AC1 — CITED VERDICT
# ════════════════════════════════════════════════════════════════════════════
def _ac1_responses(call_id_fund: str, call_id_tech: str):
    """Scripted LLM transcript: 2 finlens tool calls, then a synthesis
    JSON whose numeric findings cite the returned call_ids."""
    return [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": TICKER}}]},
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u2", "name": "finlens",
             "input": {"lens": "technicals", "ticker": TICKER}}]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps({
            "findings": [
                {"claim": f"{TICKER} FCF margin", "kind": "numeric",
                 "value": 0.42, "confidence": 0.8,
                 "citations": [call_id_fund]},
                {"claim": f"{TICKER} RSI elevated", "kind": "numeric",
                 "value": 61.0, "confidence": 0.6,
                 "citations": [call_id_tech]},
                {"claim": "trend is constructive", "kind": "qualitative",
                 "citations": [call_id_tech], "confidence": 0.5},
            ],
            "synthesis": f"{TICKER} setup is risk-on, supported by fundamentals.",
        })}]},
    ]


def test_AC1_cited_verdict_offline_fixture(tmp_path, monkeypatch):
    """OFFLINE: finlens via fixture, LLM via fixture. Every numeric finding
    must cite a real LensCall.call_id; verdict_to_json must succeed."""
    _seed_skill(tmp_path, monkeypatch)
    table = _fixture_lens_table()
    deps = LoopDeps(
        llm=_scripted_llm(_ac1_responses(table["fundamentals"]["call_id"],
                                          table["technicals"]["call_id"])),
        router=_router_from_table(table),
        axel_remember=lambda *a, **kw: {"status": "ok", "output": "mem-ac1",
                                        "error": None},
        max_iters=6,
    )
    v = research_ticker(TICKER, "Is the Q3 setup risk-on?", deps=deps)

    assert v._finalized, "verdict must be finalized"
    assert v.ticker == TICKER
    valid_ids = {lc.call_id for lc in v.lens_calls if lc.status == "ok"}
    assert valid_ids, "must have at least one OK lens call"
    numeric = [f for f in v.findings if f.kind == "numeric"]
    assert numeric, "AC1 transcript carries numeric findings"
    for f in numeric:
        assert f.citations, f"numeric finding missing citation: {f.claim}"
        for c in f.citations:
            assert c in valid_ids, f"citation {c!r} not in lens_calls"

    j = verdict_to_json(v)
    blob = json.loads(j)
    assert blob["ticker"] == TICKER and blob["findings"]


@pytest.mark.skipif(os.environ.get("XCAL_LIVE_FINLENS") != "1",
                    reason="set XCAL_LIVE_FINLENS=1 to run live finlens AC1")
def test_AC1_cited_verdict_live_finlens(tmp_path, monkeypatch):
    """LIVE: real finlens subprocess via the production adapter. LLM is
    still fixtured (no deploy ANTHROPIC_API_KEY here). We pick up the REAL
    call_ids out of the router AFTER the first two tool calls and feed them
    into the synthesis turn — that's why we use a two-phase scripted LLM:
    the synthesis response is built dynamically from router.results."""
    _seed_skill(tmp_path, monkeypatch)
    # No fixture — use real call_lens. The Router default does that when
    # XCAL_FINLENS_FIXTURE is unset.
    monkeypatch.delenv("XCAL_FINLENS_FIXTURE", raising=False)
    router = Router()  # real finlens subprocess
    captured = {"calls": []}

    # Capture call_ids as they appear so the synthesis can cite them.
    orig_dispatch = router.dispatch

    def spy(inp):
        r = orig_dispatch(inp)
        captured["calls"].append(r)
        return r
    router.dispatch = spy  # type: ignore[method-assign]

    # The LLM transport must produce the synthesis turn AFTER the two
    # tool_use turns; by then captured["calls"] has the real call_ids.
    state = {"n": 0}

    def transport(payload, headers, *, timeout=60):
        n = state["n"]; state["n"] = n + 1
        if n == 0:
            return {"stop_reason": "tool_use", "content": [
                {"type": "tool_use", "id": "u1", "name": "finlens",
                 "input": {"lens": "fundamentals", "ticker": TICKER}}]}
        if n == 1:
            return {"stop_reason": "tool_use", "content": [
                {"type": "tool_use", "id": "u2", "name": "finlens",
                 "input": {"lens": "technicals", "ticker": TICKER}}]}
        # synthesis using whatever real call_ids came back (cite all OK ones)
        ok = [c for c in captured["calls"] if c.get("status") == "ok"]
        if not ok:
            return {"stop_reason": "end_turn", "content": [{"type": "text",
                "text": json.dumps({"findings": [], "synthesis": "no ok lens"})}]}
        findings = []
        for c in ok:
            findings.append({"claim": f"{c['lens']} ran", "kind": "qualitative",
                             "citations": [c["call_id"]], "confidence": 0.4})
        return {"stop_reason": "end_turn", "content": [{"type": "text",
            "text": json.dumps({"findings": findings,
                                "synthesis": f"{TICKER} live finlens OK."})}]}

    deps = LoopDeps(
        llm=LLM(model="acceptance", api_key="fixture", transport=transport),
        router=router,
        axel_remember=lambda *a, **kw: {"status": "ok", "output": "live-ac1",
                                        "error": None},
        max_iters=6,
    )
    v = research_ticker(TICKER, "Is the Q3 setup risk-on?", deps=deps)
    assert v._finalized
    ok_ids = {lc.call_id for lc in v.lens_calls if lc.status == "ok"}
    # We must have run at least one real lens successfully OR cleanly degraded.
    # Either way, the invariant must hold: every cited id is in lens_calls.
    all_ids = {lc.call_id for lc in v.lens_calls}
    for f in v.findings:
        for c in f.citations:
            assert c in all_ids, f"citation {c} not in lens_calls"
    # Serialization succeeds.
    assert json.loads(verdict_to_json(v))["ticker"] == TICKER


# ════════════════════════════════════════════════════════════════════════════
# AC2 — NO FABRICATION ESCAPES  (deterministic, no network)
# ════════════════════════════════════════════════════════════════════════════
def test_AC2_fabricated_numeric_is_dropped(tmp_path, monkeypatch):
    """The invariant: a numeric finding with NO citation cannot reach the
    JSON output. The fabricated finding is dropped, the verdict still
    finalizes, the synthesis carries the 'N finding(s) dropped' note,
    and the serialized verdict contains ONLY cited numbers."""
    _seed_skill(tmp_path, monkeypatch)
    table = _fixture_lens_table()
    fund_id = table["fundamentals"]["call_id"]

    responses = [
        {"stop_reason": "tool_use", "content": [
            {"type": "tool_use", "id": "u1", "name": "finlens",
             "input": {"lens": "fundamentals", "ticker": TICKER}}]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps({
            "findings": [
                # Properly cited — should survive.
                {"claim": "FCF margin healthy", "kind": "numeric",
                 "value": 0.42, "confidence": 0.8, "citations": [fund_id]},
                # FABRICATION ATTEMPT: numeric, NO citation. Must be dropped.
                {"claim": "Mystery PE of 999", "kind": "numeric",
                 "value": 999.0, "confidence": 0.9, "citations": []},
                # FABRICATION ATTEMPT 2: cites a call_id that doesn't exist.
                {"claim": "Phantom revenue 12345", "kind": "numeric",
                 "value": 12345.0, "confidence": 0.5,
                 "citations": ["finlens:fundamentals#GHOST"]},
                # Qualitative — no citation needed.
                {"claim": "Stable narrative", "kind": "qualitative",
                 "citations": [], "confidence": 0.4},
            ],
            "synthesis": f"{TICKER} is fine.",
        })}]},
    ]

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=_router_from_table(table),
        axel_remember=lambda *a, **kw: {"status": "ok", "output": "mem-ac2",
                                        "error": None},
        max_iters=4,
    )
    v = research_ticker(TICKER, "Is the Q3 setup risk-on?", deps=deps)

    assert v._finalized, "verdict must finalize even with fabrication attempts"
    # 1 cited numeric + 1 qualitative survive; the 2 fabrications are gone.
    claims = {f.claim for f in v.findings}
    assert "FCF margin healthy" in claims
    assert "Stable narrative" in claims
    assert "Mystery PE of 999" not in claims
    assert "Phantom revenue 12345" not in claims

    # Synthesis carries the dropped-finding note.
    assert "dropped" in v.synthesis.lower()
    assert "2" in v.synthesis  # 2 findings dropped

    # And in the JSON: no '999' or '12345' should appear anywhere.
    blob = verdict_to_json(v)
    parsed = json.loads(blob)
    assert not any(f.get("value") == 999.0 for f in parsed["findings"])
    assert not any(f.get("value") == 12345.0 for f in parsed["findings"])
    # Defense-in-depth string scan of the serialized findings:
    findings_blob = json.dumps(parsed["findings"])
    assert "999" not in findings_blob
    assert "12345" not in findings_blob


# ════════════════════════════════════════════════════════════════════════════
# AC3 — SELF-IMPROVEMENT LOOP CLOSED
# ════════════════════════════════════════════════════════════════════════════
_UNIQUE_PHRASE = "DEXTER-ACCEPTANCE-CANARY-zR7"   # for axel search needle
_AC3_SKILL_NAME = "acceptance-lesson"


def _ac3_lesson_decision_json() -> str:
    return json.dumps({
        "action": "create",
        "skill_name": _AC3_SKILL_NAME,
        "rationale": "Reusable contrarian-sentiment ordering lesson",
        "description": "Run sentiment AFTER fundamentals when contrarian.",
        "body": (
            "# Acceptance Lesson\n\n"
            f"Marker: {_UNIQUE_PHRASE}\n\n"
            "## Lesson\n"
            "When sentiment contradicts fundamentals, weight fundamentals\n"
            "first — sentiment is contrarian-only on quarterly checks.\n"
        ),
    })


def _ac3_session_record() -> dict:
    return {
        "verdict": {
            "ticker": TICKER, "question": "Q?",
            "skill_used": "quarterly-check",
            "lens_calls": [
                {"call_id": "finlens:fundamentals#F1", "lens": "fundamentals",
                 "status": "ok", "latency_ms": 5, "error": None},
            ],
            "findings": [{"claim": "fundamentals strong", "kind": "qualitative",
                          "value": None, "confidence": 0.6, "citations": []}],
            "synthesis": "fundamentals strong; sentiment contrarian.",
        },
        "skill_used": "quarterly-check",
        "skill_body": "(existing quarterly-check body — no sentiment-order rule)",
    }


def test_AC3_offline_skill_written_and_reloadable(tmp_path, monkeypatch):
    """OFFLINE: reflection writes the lesson to XCAL_SKILLS_DIR, then
    skill_loader reads it back. Proves the write+read half of the loop
    without requiring the axel binary."""
    _seed_skill(tmp_path, monkeypatch)
    # Wipe any leftover (idempotent across runs).
    target = Path(monkeypatch.getenv("XCAL_SKILLS_DIR") if False else "") if False else None
    skills_dir = Path(os.environ["XCAL_SKILLS_DIR"])
    leftover = skills_dir / _AC3_SKILL_NAME
    if leftover.exists():
        shutil.rmtree(leftover)

    llm = _scripted_llm([{"stop_reason": "end_turn",
                          "content": [{"type": "text",
                                       "text": _ac3_lesson_decision_json()}]}])
    result = research_reflect.run_reflection(_ac3_session_record(), llm=llm)
    assert result["applied"] is True, f"reflection did not apply: {result}"
    assert result["action"] == "create"
    assert result["skill_name"] == _AC3_SKILL_NAME

    # Read it back via skill_loader — proves the file was written correctly.
    loaded = skill_loader.load_skill(_AC3_SKILL_NAME)
    assert _UNIQUE_PHRASE in loaded.body
    assert loaded.description.startswith("Run sentiment AFTER fundamentals")

    # And on-disk shape matches skillstore's contract.
    md_path = skills_dir / _AC3_SKILL_NAME / "SKILL.md"
    assert md_path.exists()
    assert _UNIQUE_PHRASE in md_path.read_text(encoding="utf-8")


@pytest.mark.skipif(os.environ.get("XCAL_LIVE_AXEL") != "1",
                    reason="set XCAL_LIVE_AXEL=1 to run live axel AC3")
def test_AC3_closed_loop_live_axel(tmp_path, monkeypatch):
    """LIVE: reflection writes a lesson skill into XCAL_SKILLS_DIR, then
    we point axel at that dir with a TEMP brain, index it, and search for
    the unique marker phrase — proving the just-written lesson is
    retrievable next run. This is THE closed-loop proof.

    We use a TEMP brain (via --brain) so we never touch ~/.config/axel/axel.r8
    or the shared sources.toml — no cleanup of user state required.
    """
    _seed_skill(tmp_path, monkeypatch)
    skills_dir = Path(os.environ["XCAL_SKILLS_DIR"])
    # idempotency
    leftover = skills_dir / _AC3_SKILL_NAME
    if leftover.exists():
        shutil.rmtree(leftover)

    # Step 1: reflection writes the skill.
    llm = _scripted_llm([{"stop_reason": "end_turn",
                          "content": [{"type": "text",
                                       "text": _ac3_lesson_decision_json()}]}])
    res = research_reflect.run_reflection(_ac3_session_record(), llm=llm)
    assert res["applied"], res

    # Step 2: index the skills dir into a temp brain.
    axel_bin = rc.axel_bin()
    assert os.path.exists(axel_bin) or shutil.which(axel_bin), \
        f"axel binary not found at {axel_bin}"
    brain = tmp_path / "accept.r8"
    init = subprocess.run([axel_bin, "--brain", str(brain), "init"],
                          capture_output=True, text=True, timeout=30)
    # axel init may not exist on all builds; if it fails, indexing will create.
    idx = subprocess.run([axel_bin, "--brain", str(brain),
                          "index", str(skills_dir)],
                         capture_output=True, text=True, timeout=60)
    assert idx.returncode == 0, \
        f"axel index failed: stderr={idx.stderr[:400]} stdout={idx.stdout[:400]}"

    # Step 3: search for the unique marker — must find the lesson.
    srch = subprocess.run([axel_bin, "--brain", str(brain),
                           "search", _UNIQUE_PHRASE, "--limit", "5", "--json"],
                          capture_output=True, text=True, timeout=30)
    assert srch.returncode == 0, f"axel search failed: {srch.stderr[:400]}"
    blob = srch.stdout.strip().splitlines()
    raw = blob[-1] if blob else ""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        pytest.fail(f"axel search returned non-JSON: {raw[:400]}")
    results = data.get("results") or []
    assert results, f"axel search found 0 results for marker; raw={raw[:400]}"
    # The lesson must appear — match by content (marker phrase) OR doc path.
    hit = False
    for r in results:
        s = json.dumps(r)
        if _UNIQUE_PHRASE in s or _AC3_SKILL_NAME in s:
            hit = True
            break
    assert hit, f"lesson not in search results: {results!r}"
    # Print evidence for the operator running this live.
    print(f"\n[AC3-LIVE] axel search '{_UNIQUE_PHRASE}' → {len(results)} hits, "
          f"first={results[0].get('doc_id', results[0])!r}")
