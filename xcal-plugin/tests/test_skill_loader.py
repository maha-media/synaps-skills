import os
from pathlib import Path

import pytest

from src.research import skill_loader
from src.research.skillstore import SkillError


def _seed_skill(root: Path, name="quarterly-check", desc="d", body="body"):
    d = root / name
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {desc}\n---\n\n{body}\n",
        encoding="utf-8",
    )


def test_load_existing_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(tmp_path))
    _seed_skill(tmp_path, body="# Plan\nstep 1")
    s = skill_loader.load_skill("quarterly-check")
    assert s.name == "quarterly-check"
    assert s.description == "d"
    assert "step 1" in s.body
    assert s.path.exists()


def test_load_missing_skill(tmp_path, monkeypatch):
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(tmp_path))
    with pytest.raises(SkillError, match="not found"):
        skill_loader.load_skill("nope")


def test_load_seed_quarterly_check(monkeypatch):
    """Loads the actual seed shipped in the repo."""
    repo = Path(__file__).resolve().parents[1]
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(repo / "skills"))
    s = skill_loader.load_skill("quarterly-check")
    assert s.name == "quarterly-check"
    assert "Quarterly Check" in s.body


def test_load_seed_value_research(monkeypatch):
    """Heist target #5: the four-master value-research methodology skill loads
    and encodes the 7-module sequence + the forced-verdict discipline gates."""
    repo = Path(__file__).resolve().parents[1]
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(repo / "skills"))
    s = skill_loader.load_skill("value-research")
    assert s.name == "value-research"
    assert s.path.exists()
    body = s.body
    # the four masters are all represented
    for master in ("Duan", "Buffett", "Munger", "Li Lu"):
        assert master in body, f"missing master: {master}"
    # the discipline gates the heist installed must be referenced
    for gate in ("stance", "mirror_test", "red_flag", "info_richness",
                 "corroboration", "inversion"):
        assert gate in body, f"missing discipline gate: {gate}"
    # it forces a verdict — the whole point
    assert "No fence-sitting" in body or "force a verdict" in body.lower() \
        or "Force a `stance`" in body
