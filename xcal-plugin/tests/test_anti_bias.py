"""Anti-Bias Rig tests — heist target #3.

Covers: info_richness (A/B/C + invalid), Munger inversion round-trip,
red-flag veto (pass blocked, fail/None fine), backward-compat with
forced-verdict gate, and bare Verdict still finalizes/serializes.
"""
import json
import pytest

from src.research.verdict import (
    Finding,
    LensCall,
    Recommendation,
    Verdict,
    VetoError,
    verdict_to_json,
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _ok_lens(call_id: str = "c1", lens: str = "fundamental") -> LensCall:
    return LensCall(call_id=call_id, lens=lens, status="ok", latency_ms=10)


def _bare_verdict(**kw) -> Verdict:
    return Verdict(ticker="AAAA", question="Buy?", **kw)


# ── info_richness: valid grades accepted ──────────────────────────────────────

@pytest.mark.parametrize("grade", ["A", "B", "C"])
def test_info_richness_valid_grades_accepted(grade):
    f = Finding(claim="Revenue grew 20%", kind="numeric",
                citations=("c1",), value=20.0, info_richness=grade)
    v = _bare_verdict(lens_calls=[_ok_lens()], findings=[f])
    v.finalize()  # must not raise


@pytest.mark.parametrize("grade", ["A", "B", "C"])
def test_info_richness_serialized(grade):
    f = Finding(claim="Revenue grew 20%", kind="numeric",
                citations=("c1",), value=20.0, info_richness=grade)
    v = _bare_verdict(lens_calls=[_ok_lens()], findings=[f])
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert data["findings"][0]["info_richness"] == grade


# ── info_richness: invalid grade raises ValueError ────────────────────────────

@pytest.mark.parametrize("bad", ["D", "a", "", "AA", "1"])
def test_info_richness_invalid_raises(bad):
    f = Finding(claim="Claim", kind="qualitative", info_richness=bad)
    v = _bare_verdict(findings=[f])
    with pytest.raises(ValueError):
        v.finalize()


# ── info_richness: None is allowed (backward-compat) ─────────────────────────

def test_info_richness_none_allowed():
    f = Finding(claim="Qualitative claim", kind="qualitative")
    assert f.info_richness is None
    v = _bare_verdict(findings=[f])
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert data["findings"][0]["info_richness"] is None


# ── inversion: round-trips through JSON ──────────────────────────────────────

def test_inversion_round_trips():
    inv = "If rates stay elevated for 3 years, the debt stack implodes."
    v = _bare_verdict(inversion=inv)
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert data["inversion"] == inv


def test_inversion_none_default():
    v = _bare_verdict()
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert data["inversion"] is None


# ── red_flags + stance="pass" → VetoError ────────────────────────────────────

def test_red_flags_with_pass_raises_veto():
    # mirror_test valid (would normally let a pass through),
    # but red_flags must veto regardless.
    v = _bare_verdict(
        stance="pass",
        mirror_test="Bears say valuation is stretched. Noted.",
        red_flags=("management integrity concern",),
    )
    with pytest.raises(VetoError, match="management integrity concern"):
        v.finalize()


def test_red_flags_multiple_with_pass_raises_veto():
    v = _bare_verdict(
        stance="pass",
        mirror_test="Bears say rates kill margins. Acknowledged.",
        red_flags=("accounting irregularity", "related-party loans"),
    )
    with pytest.raises(VetoError):
        v.finalize()


# ── red_flags + stance="fail" → finalizes fine ───────────────────────────────

def test_red_flags_with_fail_finalizes():
    v = _bare_verdict(
        stance="fail",
        red_flags=("accounting irregularity",),
    )
    v.finalize()  # must not raise
    data = json.loads(verdict_to_json(v))
    assert data["red_flags"] == ["accounting irregularity"]


# ── red_flags + stance=None → finalizes fine ─────────────────────────────────

def test_red_flags_with_no_stance_finalizes():
    v = _bare_verdict(red_flags=("management integrity concern",))
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert data["red_flags"] == ["management integrity concern"]


# ── red_flags=() + stance="pass" (valid mirror_test) → still passes ──────────

def test_empty_red_flags_pass_still_finalizes():
    v = _bare_verdict(
        stance="pass",
        mirror_test="Bears argue competitive moat is eroding. Disagree.",
        red_flags=(),
    )
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert data["red_flags"] == []
    assert data["stance"] == "pass"


# ── red_flags tuple → list in JSON ───────────────────────────────────────────

def test_red_flags_tuple_serialized_as_list():
    v = _bare_verdict(red_flags=("flag_a", "flag_b"), stance="fail")
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert isinstance(data["red_flags"], list)
    assert data["red_flags"] == ["flag_a", "flag_b"]


# ── fully bare Verdict finalizes and serializes ───────────────────────────────

def test_bare_verdict_finalizes():
    v = _bare_verdict()
    v.finalize()


def test_bare_verdict_serializes():
    v = _bare_verdict()
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert data["ticker"] == "AAAA"
    assert data["inversion"] is None
    assert data["red_flags"] == []
    assert data["findings"] == []


# ── VetoError is a subclass of ValueError ────────────────────────────────────

def test_veto_error_is_value_error():
    assert issubclass(VetoError, ValueError)


# ── all three mechanisms together ────────────────────────────────────────────

def test_full_anti_bias_rig_happy_path():
    lc1 = _ok_lens("c1", "fundamental")
    lc2 = _ok_lens("c2", "macro")
    f = Finding(
        claim="FCF yield 8%",
        kind="numeric",
        citations=("c1",),
        value=8.0,
        corroborations=("c2",),
        info_richness="A",
    )
    v = Verdict(
        ticker="BRKB",
        question="Allocate?",
        lens_calls=[lc1, lc2],
        findings=[f],
        stance="fail",
        mirror_test=None,
        inversion="If macro deteriorates severely the thesis breaks.",
        red_flags=("management integrity concern",),
    )
    v.finalize()
    data = json.loads(verdict_to_json(v))
    assert data["findings"][0]["info_richness"] == "A"
    assert data["inversion"] == "If macro deteriorates severely the thesis breaks."
    assert data["red_flags"] == ["management integrity concern"]
