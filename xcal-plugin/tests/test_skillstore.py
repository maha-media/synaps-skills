"""Tests for skillstore — security-critical port of #53 hardening."""
from __future__ import annotations
import json
import os
import shutil
from pathlib import Path

import pytest

from src.research import skillstore
from src.research.skillstore import SkillError


# ── fixtures ────────────────────────────────────────────────────────────────
@pytest.fixture(autouse=True)
def _isolated_skills_dir(tmp_path, monkeypatch):
    d = tmp_path / "skills"
    d.mkdir()
    monkeypatch.setenv("XCAL_SKILLS_DIR", str(d))
    yield d


# ── name validation (traversal + reserved) ──────────────────────────────────
@pytest.mark.parametrize("bad", [
    "",                # empty
    ".",               # current
    "..",              # parent — traversal
    "../etc",          # traversal
    "foo/bar",         # path sep
    "foo\\bar",        # path sep (win)
    "FooBar",          # uppercase
    "foo_bar",         # underscore (not allowed)
    "-leading",        # leading hyphen
    "x" * 65,          # >64
    ".archive",        # reserved
    ".locks",          # reserved
    "foo\nbar",        # newline
    "foo---bar",       # frontmatter marker
])
def test_name_rejected(bad):
    with pytest.raises(SkillError):
        skillstore.create(bad, "ok desc")


# ── description validation (Shady BLOCKER B1 — frontmatter injection) ──────
@pytest.mark.parametrize("bad", [
    "",                              # empty
    "x" * 201,                       # >200
    "ok\ninjected",                  # newline injection
    "ok\rinjected",                  # CR injection
    "before --- after",              # YAML separator
    " leading-ws",                   # leading whitespace
    "trailing-ws ",                  # trailing whitespace
])
def test_description_injection_rejected(bad):
    with pytest.raises(SkillError):
        skillstore.create("test-skill", bad)


def test_description_200_chars_ok():
    skillstore.create("edge", "x" * 200)
    assert skillstore.read("edge").description == "x" * 200


# ── round-trip ──────────────────────────────────────────────────────────────
def test_create_read_roundtrip():
    s = skillstore.create("my-skill", "a desc", "# Body\nhello\n")
    r = skillstore.read("my-skill")
    assert r.name == "my-skill"
    assert r.description == "a desc"
    assert "hello" in r.body
    assert s.meta.provenance == "user"   # default — NOT background_review
    assert r.meta.created and r.meta.last_updated


def test_create_existing_errors():
    skillstore.create("dup", "ok")
    with pytest.raises(SkillError):
        skillstore.create("dup", "ok")


def test_update_missing_errors():
    with pytest.raises(SkillError):
        skillstore.update("nope", description="x")


def test_update_preserves_description_when_absent():
    skillstore.create("u", "original desc", "body1")
    skillstore.update("u", body="body2")
    r = skillstore.read("u")
    assert r.description == "original desc"
    assert "body2" in r.body


def test_update_rejects_empty_description():
    skillstore.create("u2", "original")
    with pytest.raises(SkillError):
        skillstore.update("u2", description="")


# ── sidecar forward-compat ──────────────────────────────────────────────────
def test_sidecar_missing_field_tolerated(_isolated_skills_dir):
    skillstore.create("s", "d")
    sidecar = _isolated_skills_dir / "s" / ".skill-meta.json"
    sidecar.write_text(json.dumps({
        "schema_version": 1,
        # missing provenance, missing created — must default
        "unknown_future_field": "yolo",
    }))
    r = skillstore.read("s")
    assert r.meta.provenance == "user"
    assert r.meta.created  # defaulted


# ── archive collision (Shady BLOCKER B2) ────────────────────────────────────
def test_delete_archives_and_collision_yields_distinct_dirs(_isolated_skills_dir):
    archives = []
    for i in range(2):
        skillstore.create("collide", "d")
        archives.append(skillstore.delete("collide"))
    assert archives[0] != archives[1]
    assert archives[0].exists() and archives[1].exists()
    # SKILL.md renamed so Axel's *.md filter skips it
    assert (archives[0] / "SKILL.md.archived").exists()
    assert not (archives[0] / "SKILL.md").exists()


def test_delete_tight_loop_collision(_isolated_skills_dir):
    """Hammer delete in a tight loop — must produce N distinct archive dirs
    even if %f microsecond timestamps repeat."""
    seen = set()
    for _ in range(5):
        skillstore.create("loop", "d")
        seen.add(str(skillstore.delete("loop")))
    assert len(seen) == 5


def test_delete_never_hard_deletes(_isolated_skills_dir):
    skillstore.create("keep", "d", "important body")
    archive = skillstore.delete("keep")
    body = (archive / "SKILL.md.archived").read_text()
    assert "important body" in body


# ── symlink refusal (Shady H3) ──────────────────────────────────────────────
def test_create_refuses_symlinked_parent(_isolated_skills_dir, tmp_path):
    real = tmp_path / "real-skills"
    real.mkdir()
    # Replace the skills root with a symlink to `real`
    link = _isolated_skills_dir
    shutil.rmtree(link)
    os.symlink(real, link)
    # Now skills_dir() resolves to a symlink — refuse.
    with pytest.raises(SkillError, match="symlink"):
        skillstore.create("foo", "d")


def test_create_refuses_when_skill_dir_is_symlink(_isolated_skills_dir, tmp_path):
    target = tmp_path / "elsewhere"
    target.mkdir()
    os.symlink(target, _isolated_skills_dir / "linked")
    with pytest.raises(SkillError, match="symlink"):
        skillstore.create("linked", "d")


# ── list ────────────────────────────────────────────────────────────────────
def test_list_skips_archive_and_dotfiles():
    skillstore.create("a", "x")
    skillstore.create("b", "y")
    skillstore.delete("a")
    assert skillstore.list_skills() == ["b"]


# ── atomic write: no .tmp- leftovers on success ────────────────────────────
def test_no_tmp_leftover(_isolated_skills_dir):
    skillstore.create("clean", "d", "body")
    leftovers = list((_isolated_skills_dir / "clean").glob(".tmp-*"))
    assert leftovers == []
