"""skill_loader — read-only SKILL.md loader for the agent loop.

Distinct from `skillstore` (which owns create/update/delete + validation).
Here we only READ: parse the frontmatter via skillstore's own parser to
avoid duplicating validation logic.
"""
from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path

from . import config
from .skillstore import _parse_skill_md, SkillError


@dataclass(frozen=True)
class LoadedSkill:
    name: str
    description: str
    body: str
    path: Path


def load_skill(name: str) -> LoadedSkill:
    if not name:
        raise SkillError("skill name is empty")
    p = config.skills_dir() / name / "SKILL.md"
    if not p.exists():
        raise SkillError(f"skill not found: {name!r} (looked for {p})")
    text = p.read_text(encoding="utf-8")
    fm_name, desc, body = _parse_skill_md(text)
    if fm_name != name:
        raise SkillError(f"frontmatter name {fm_name!r} != dir {name!r}")
    return LoadedSkill(name=name, description=desc, body=body, path=p)
