"""Phase 2.3 — reflection loop (the Hermes organ) tests.

All LLM calls are mocked; no network; no real subprocess spawn unless the
test explicitly opts in.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from src.research import reflect, spool, skillstore, skill_loader
from src.research.llm import LLM
from src.research import loop as research_loop
from src.research.loop import LoopDeps, research_ticker
from src.research.router import Router
from src.research.reflection_prompt import (
    build_reflection_system_prompt,
    parse_reflection_decision,
    ReflectionParseError,
    DONT_CAPTURE_RULES,
)


REPO = Path(__file__).resolve().parents[1]


# ── helpers ─────────────────────────────────────────────────────────────────
@pytest.fixture
def isolated_dirs(tmp_path, monkeypatch):
    """Container-clean test sandbox: skills_dir + spool_dir in tmp."""
    skills = tmp_path / "skills"
    spool_d = tmp_path / "spool"
    skills.mkdir()
    spool_d.mkdir()
    # Seed quarterly-check (loop needs it)
    qc = skills / "quarterly-check"
    qc.mkdir()
    src = REPO / "skills" / "quarterly-check" / "SKILL.md"
    (qc / "SKILL.md").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(skills))
    monkeypatch.setenv("XCAL_SPOOL_DIR", str(spool_d))
    monkeypatch.delenv("XCAL_IN_REFLECTION", raising=False)
    return tmp_path


def _scripted_llm(responses):
    i = {"n": 0}

    def t(payload, headers, *, timeout=60):
        n = i["n"]
        if n >= len(responses):
            raise AssertionError("LLM called more times than scripted")
        i["n"] = n + 1
        return responses[n]
    return LLM(model="m", api_key="k", transport=t)


def _llm_text(text: str) -> LLM:
    return _scripted_llm([{"stop_reason": "end_turn",
                           "content": [{"type": "text", "text": text}]}])


# ── reflection_prompt ──────────────────────────────────────────────────────
def test_dont_capture_rules_present_in_system_prompt():
    p = build_reflection_system_prompt()
    # The rules ARE the IP — they must be in the prompt verbatim.
    assert "TRANSIENT/ENVIRONMENTAL FAILURES" in p
    assert "NEGATIVE TOOL CLAIMS" in p
    assert "ONE-OFF TICKER-SPECIFIC TRIVIA" in p
    assert "RESTATEMENTS OF THE EXISTING SKILL" in p
    assert "REUSABLE" in p and "DURABLE" in p
    # And the JSON output contract.
    assert '"action"' in p and "create" in p and "patch" in p


def test_parse_reflection_decision_bare_json():
    d = parse_reflection_decision('{"action":"none","rationale":"nothing"}')
    assert d["action"] == "none"


def test_parse_reflection_decision_fenced_json():
    s = "Some prose\n```json\n{\"action\":\"none\",\"rationale\":\"x\"}\n```\n"
    d = parse_reflection_decision(s)
    assert d["action"] == "none"


def test_parse_reflection_decision_rejects_bad_action():
    with pytest.raises(ReflectionParseError):
        parse_reflection_decision('{"action":"yolo"}')


def test_parse_reflection_decision_rejects_empty():
    with pytest.raises(ReflectionParseError):
        parse_reflection_decision("")


# ── DON'T-CAPTURE: transient failure → action=none ──────────────────────────
def test_reflection_skips_transient_error(isolated_dirs):
    """Deterministic skip: a session whose only signal is a finlens 401 +
    no findings is filtered BEFORE the LLM is called. No skill written."""
    session = {
        "skill_used": "quarterly-check",
        "skill_body": "...",
        "verdict": {
            "ticker": "NVDA", "question": "anything",
            "skill_used": "quarterly-check",
            "lens_calls": [
                {"call_id": "finlens:fundamentals#x", "lens": "fundamentals",
                 "status": "error", "latency_ms": 12,
                 "error": "HTTP 401 from upstream"}],
            "findings": [],
            "synthesis": "",
        },
    }
    # LLM that would BLOW UP if called — proves the prefilter fired.
    def boom(*a, **k):
        raise AssertionError("LLM should not be called for transient-only session")
    llm = LLM(model="m", api_key="k", transport=boom)

    result = reflect.run_reflection(session, llm=llm)
    assert result["action"] == "none"
    assert result["applied"] is False
    # No skill files written beyond the seeded quarterly-check.
    assert sorted(skillstore.list_skills()) == ["quarterly-check"]


def test_reflection_llm_says_none_for_negative_tool_claim(isolated_dirs):
    """Even when there's *some* successful lens but the only "lesson" the
    reviewer might draw is a negative tool claim, action=none and nothing
    is written."""
    session = {
        "skill_used": "quarterly-check",
        "skill_body": "body",
        "verdict": {
            "ticker": "NVDA", "question": "q",
            "skill_used": "quarterly-check",
            "lens_calls": [
                {"call_id": "finlens:fundamentals#a", "lens": "fundamentals",
                 "status": "ok", "latency_ms": 5, "error": None}],
            "findings": [{"claim": "Rev 60", "kind": "numeric", "value": 60.0,
                          "confidence": 0.5,
                          "citations": ["finlens:fundamentals#a"]}],
            "synthesis": "ok",
        },
    }
    llm = _llm_text(json.dumps({
        "action": "none",
        "rationale": "no durable reusable pattern — only ticker-specific facts",
    }))
    result = reflect.run_reflection(session, llm=llm)
    assert result == {"action": "none", "applied": False,
                      "reason": "no durable reusable pattern — only ticker-specific facts"}
    assert sorted(skillstore.list_skills()) == ["quarterly-check"]


# ── CAPTURE: genuine lesson → skill written ─────────────────────────────────
def test_reflection_writes_lesson(isolated_dirs):
    """A session with a real reusable lesson → skillstore.create called,
    skill appears on disk, skill_loader can read it back."""
    session = {
        "skill_used": "quarterly-check",
        "skill_body": "existing body",
        "verdict": {
            "ticker": "NVDA", "question": "q",
            "skill_used": "quarterly-check",
            "lens_calls": [
                {"call_id": "finlens:fundamentals#a", "lens": "fundamentals",
                 "status": "ok", "latency_ms": 5, "error": None}],
            "findings": [{"claim": "Rev 60", "kind": "numeric", "value": 60.0,
                          "confidence": 0.9,
                          "citations": ["finlens:fundamentals#a"]}],
            "synthesis": "constructive",
        },
    }
    llm = _llm_text(json.dumps({
        "action": "create",
        "skill_name": "guidance-vs-print",
        "description": "Compare quarter guidance to consensus before judging the print.",
        "body": "# Guidance vs Print\n\nWhen a beat coincides with a guide-down, the print is misleading. Always read guidance FIRST.\n",
        "rationale": "reusable analytical heuristic for ANY ticker",
    }))
    result = reflect.run_reflection(session, llm=llm)
    assert result["applied"] is True
    assert result["action"] == "create"
    assert result["skill_name"] == "guidance-vs-print"

    # On disk + loadable.
    assert "guidance-vs-print" in skillstore.list_skills()
    loaded = skill_loader.load_skill("guidance-vs-print")
    assert "Guidance vs Print" in loaded.body
    # Provenance recorded.
    s = skillstore.read("guidance-vs-print")
    assert s.meta.provenance == "background_review"


def test_reflection_patches_existing_skill(isolated_dirs):
    """action=patch overwrites the existing SKILL.md body."""
    session = {
        "skill_used": "quarterly-check",
        "skill_body": "original",
        "verdict": {"ticker": "NVDA", "question": "q",
                    "skill_used": "quarterly-check",
                    "lens_calls": [{"call_id": "x", "lens": "f",
                                    "status": "ok", "latency_ms": 1,
                                    "error": None}],
                    "findings": [{"claim": "c", "kind": "qualitative",
                                  "value": None, "confidence": 0.4,
                                  "citations": []}],
                    "synthesis": "ok"},
    }
    new_body = "# Quarterly Check (patched)\n\nAlways inspect guidance first.\n"
    llm = _llm_text(json.dumps({
        "action": "patch", "skill_name": "quarterly-check",
        "patch_body": new_body,
        "rationale": "missing step in plan",
    }))
    result = reflect.run_reflection(session, llm=llm)
    assert result == {"action": "patch", "applied": True,
                      "skill_name": "quarterly-check",
                      "reason": "missing step in plan"}
    assert "patched" in skill_loader.load_skill("quarterly-check").body


def test_reflection_rejects_malformed_create(isolated_dirs):
    """A create decision missing description/body must NOT write."""
    session = {
        "skill_used": "quarterly-check", "skill_body": "x",
        "verdict": {"ticker": "T", "question": "q",
                    "skill_used": "quarterly-check",
                    "lens_calls": [{"call_id": "x", "lens": "f",
                                    "status": "ok", "latency_ms": 1, "error": None}],
                    "findings": [{"claim": "c", "kind": "qualitative",
                                  "value": None, "confidence": 0.1,
                                  "citations": []}],
                    "synthesis": "s"},
    }
    llm = _llm_text(json.dumps({"action": "create", "skill_name": "broken",
                                "rationale": "x"}))
    result = reflect.run_reflection(session, llm=llm)
    assert result["applied"] is False
    assert "broken" not in skillstore.list_skills()


# ── RECURSION REFUSED ───────────────────────────────────────────────────────
def test_no_recursive_reflection_parent_refuses_to_spawn(isolated_dirs, monkeypatch):
    """If XCAL_IN_REFLECTION=1 is already in env, research_ticker must
    NOT spawn a child reflection. The verdict still finalizes."""
    monkeypatch.setenv("XCAL_REFLECT", "1")
    monkeypatch.setenv("XCAL_IN_REFLECTION", "1")

    spawned = []

    def must_not_spawn(sid):
        spawned.append(sid)

    responses = [{"stop_reason": "end_turn", "content": [{"type": "text",
        "text": json.dumps({"findings": [], "synthesis": "done"})}]}]
    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=Router(call_lens=lambda *a, **k: {"call_id": "x", "lens": "f",
                                                  "status": "ok", "latency_ms": 0,
                                                  "payload": {}}),
        axel_remember=lambda *a, **k: {"status": "ok", "output": "id", "error": None},
        max_iters=2,
        spawn_reflection=must_not_spawn,
    )
    v = research_ticker("nvda", "q", deps=deps)
    assert v.reflection["status"] == "refused"
    assert spawned == []


def test_no_recursive_reflection_helper():
    """reflect.refuse_if_recursing returns a refusal dict iff env is set."""
    os.environ.pop("XCAL_IN_REFLECTION", None)
    assert reflect.refuse_if_recursing() is None
    os.environ["XCAL_IN_REFLECTION"] = "1"
    try:
        r = reflect.refuse_if_recursing()
        assert r is not None and r["status"] == "refused"
    finally:
        os.environ.pop("XCAL_IN_REFLECTION", None)


# ── FIRE-AND-FORGET ─────────────────────────────────────────────────────────
def test_research_ticker_is_fire_and_forget(isolated_dirs, monkeypatch):
    """research_ticker spawns reflection detached and returns IMMEDIATELY.
    The injected spawn must be called exactly once with a valid sid; the
    verdict carries reflection.status='queued'."""
    monkeypatch.delenv("XCAL_IN_REFLECTION", raising=False)
    monkeypatch.setenv("XCAL_REFLECT", "1")

    calls = []

    def fake_spawn(sid):
        # Must be detached: we do NOT block, do NOT wait. Just record.
        calls.append(sid)

    responses = [{"stop_reason": "end_turn", "content": [{"type": "text",
        "text": json.dumps({
            "findings": [{"claim": "rev 1", "kind": "numeric", "value": 1.0,
                          "confidence": 0.5, "citations": ["finlens:f#a"]}],
            "synthesis": "done"})}]}]

    def call_lens(lens, ticker, **_):
        return {"call_id": "finlens:f#a", "lens": "f", "ticker": ticker,
                "status": "ok", "latency_ms": 1, "payload": {}}

    deps = LoopDeps(
        llm=_scripted_llm(responses),
        router=Router(call_lens=call_lens),
        axel_remember=lambda *a, **k: {"status": "ok", "output": "id", "error": None},
        max_iters=2,
        spawn_reflection=fake_spawn,
    )

    import time as _t
    t0 = _t.monotonic()
    v = research_ticker("nvda", "q", deps=deps)
    elapsed = _t.monotonic() - t0
    assert elapsed < 1.0  # fire-and-forget, no blocking
    assert v.reflection["status"] == "queued"
    sid = v.reflection["session_id"]
    assert len(calls) == 1 and calls[0] == sid
    # The spool record exists and contains the verdict.
    rec = spool.read(sid)
    assert rec["verdict"]["ticker"] == "NVDA"
    assert rec["skill_used"] == "quarterly-check"


def test_default_spawn_is_detached_popen(isolated_dirs, monkeypatch):
    """The default spawner uses Popen with start_new_session=True, DEVNULL
    stdio, no .wait/.communicate. Verifies fire-and-forget mechanics."""
    captured = {}

    class FakePopen:
        def __init__(self, argv, **kw):
            captured["argv"] = argv
            captured["kw"] = kw

    monkeypatch.setattr("subprocess.Popen", FakePopen)
    research_loop._default_spawn("r-test-1234")
    assert "--mode=reflect" in captured["argv"]
    assert "--session=r-test-1234" in captured["argv"]
    assert captured["kw"].get("start_new_session") is True
    assert captured["kw"]["env"]["XCAL_IN_REFLECTION"] == "1"
    assert captured["kw"]["stdout"] == subprocess.DEVNULL
    assert captured["kw"]["stderr"] == subprocess.DEVNULL


# ── WHITELIST ───────────────────────────────────────────────────────────────
def test_reflect_module_does_not_import_forbidden():
    """reflect.py must never touch finlens/router/loop/axel. Both runtime
    introspection AND source scan."""
    # 1. runtime: those names are not in reflect.py's module globals.
    forbidden_names = {"finlens_call", "axel_cli", "router", "loop"}
    g = vars(reflect)
    leaked = forbidden_names & set(g.keys())
    assert not leaked, f"reflect.py leaked forbidden names: {leaked}"

    # 2. source: explicit no import lines.
    src = Path(reflect.__file__).read_text(encoding="utf-8")
    # Scan only the top-level import region (everything up to first blank
    # line after the last import) — comments mentioning the names in the
    # whitelist enforcement code are OK.
    for line in src.splitlines():
        s = line.strip()
        if s.startswith("import ") or s.startswith("from "):
            assert "finlens" not in s, f"forbidden import: {line}"
            assert "axel_cli" not in s, f"forbidden import: {line}"
            assert "research.router" not in s and "from .router" not in s, \
                f"forbidden import: {line}"
            assert "research.loop" not in s and "from .loop" not in s, \
                f"forbidden import: {line}"


def test_assert_whitelist_runtime_guard():
    """_assert_whitelist must raise if a forbidden module is somehow bound
    into reflect's globals."""
    reflect._assert_whitelist()  # baseline: clean
    reflect.__dict__["finlens_call"] = object()  # simulate a smuggled binding
    try:
        with pytest.raises(RuntimeError, match="whitelist"):
            reflect._assert_whitelist()
    finally:
        reflect.__dict__.pop("finlens_call", None)


# ── main.py --mode=reflect entrypoint ───────────────────────────────────────
def test_main_reflect_mode_runs_and_exits(isolated_dirs, monkeypatch):
    """Spawn the actual subprocess: it should read the spool record, run
    the (here, mocked-via-fixture) LLM, and exit 0 with a JSON result on
    stdout. Uses XCAL_LLM_FIXTURE — no network."""
    sid = spool.new_session_id()
    spool.write(sid, {
        "skill_used": "quarterly-check",
        "skill_body": "...",
        "verdict": {
            "ticker": "NVDA", "question": "q",
            "skill_used": "quarterly-check",
            "lens_calls": [{"call_id": "finlens:f#a", "lens": "f",
                            "status": "ok", "latency_ms": 1, "error": None}],
            "findings": [{"claim": "c", "kind": "qualitative",
                          "value": None, "confidence": 0.3, "citations": []}],
            "synthesis": "s",
        },
    })

    fixture_path = isolated_dirs / "llm_fixture.json"
    fixture_path.write_text(json.dumps([{
        "stop_reason": "end_turn",
        "content": [{"type": "text", "text": json.dumps({
            "action": "none", "rationale": "nothing reusable here"})}],
    }]))

    env = dict(os.environ)
    env["XCAL_LLM_FIXTURE"] = str(fixture_path)
    env["XCAL_SKILLS_DIR"] = str(isolated_dirs / "skills")
    env["XCAL_SPOOL_DIR"] = str(isolated_dirs / "spool")
    env["XCAL_IN_REFLECTION"] = "1"

    main_py = REPO / "main.py"
    proc = subprocess.run(
        [sys.executable, str(main_py), "--mode=reflect", f"--session={sid}"],
        env=env, capture_output=True, text=True, timeout=20,
    )
    assert proc.returncode == 0, f"stderr: {proc.stderr}"
    out = json.loads(proc.stdout.strip().splitlines()[-1])
    assert out["action"] == "none"
    assert out["applied"] is False


# ── no hardcoded /home paths in src/ ────────────────────────────────────────
def test_no_hardcoded_home_paths_in_src():
    import subprocess as _sp
    src = REPO / "src"
    r = _sp.run(["grep", "-rn", "/home/", str(src)], capture_output=True, text=True)
    assert r.stdout.strip() == "", f"hardcoded /home/ paths found:\n{r.stdout}"
