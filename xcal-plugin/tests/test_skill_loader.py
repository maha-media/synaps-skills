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
