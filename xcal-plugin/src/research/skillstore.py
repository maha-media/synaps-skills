"""skillstore — atomic, hardened SKILL.md writer (Python port of Rust skill_manage).

Security posture ported from #53 hardening:
  * NAME validation: lowercase alnum + hyphen, ≤64, no '.', '..', no path seps,
    no leading hyphen, not reserved. Directory-traversal-proof.
  * DESCRIPTION validation (Shady BLOCKER B1): no newlines, no '---',
    no leading/trailing whitespace, 1..=200 chars. Frontmatter is hand-built
    using only validated fields → no YAML-injection surface.
  * ATOMIC write: tmp file → write → flush+fsync → os.replace → fsync parent.
    Tmp cleaned on any failure.
  * DELETE = archive-move (BLOCKER B2): move to .archive/<name>-<utc>/, with
    SKILL.md → SKILL.md.archived rename so Axel's *.md indexer skips it.
    Tight-loop collision suffix -1,-2,... Never hard-delete.
  * SYMLINK refusal (H3): refuse if the skill dir or its parent is a symlink.
  * Sidecar .skill-meta.json: schema_version=1, provenance, created,
    last_updated. Forward-compat: unknown fields tolerated on read. Lazy
    default provenance = 'user' (NOT background_review).
  * usage_count is NOT stored here — Axel owns access counters.
"""
from __future__ import annotations
import json
import os
import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from . import config

# ── validation ──────────────────────────────────────────────────────────────
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_RESERVED_NAMES = {".archive", ".locks"}
_MAX_DESCRIPTION_LEN = 200
Provenance = Literal["user", "background_review"]


class SkillError(ValueError):
    """Raised for any validation or store-integrity failure."""


def _validate_name(name: str) -> None:
    if not isinstance(name, str) or not name:
        raise SkillError("skill name is empty")
    if len(name) > 64:
        raise SkillError("skill name >64 chars")
    if "\n" in name or "\r" in name:
        raise SkillError("skill name contains newline")
    if "---" in name:
        raise SkillError("skill name contains '---'")
    if "/" in name or "\\" in name or "\x00" in name:
        raise SkillError("skill name contains path separator or NUL")
    if name in (".", "..") or name.startswith("-"):
        raise SkillError(f"skill name not allowed: {name!r}")
    if name in _RESERVED_NAMES:
        raise SkillError(f"skill name is reserved: {name!r}")
    if not _NAME_RE.match(name):
        raise SkillError(f"skill name must be lowercase alnum + hyphen: {name!r}")


def _validate_description(desc: str) -> None:
    if not isinstance(desc, str):
        raise SkillError("description must be a string")
    if desc == "":
        raise SkillError("description is empty")
    if len(desc) > _MAX_DESCRIPTION_LEN:
        raise SkillError(f"description >{_MAX_DESCRIPTION_LEN} chars")
    if "\n" in desc or "\r" in desc:
        raise SkillError("description contains newline (frontmatter injection)")
    if "---" in desc:
        raise SkillError("description contains '---' (frontmatter injection)")
    if desc != desc.strip():
        raise SkillError("description has leading/trailing whitespace")


# ── paths ───────────────────────────────────────────────────────────────────
def _root() -> Path:
    r = config.skills_dir()
    r.mkdir(parents=True, exist_ok=True)
    return r


def _skill_dir(name: str) -> Path:
    return _root() / name


def _skill_md(name: str) -> Path:
    return _skill_dir(name) / "SKILL.md"


def _sidecar(name: str) -> Path:
    return _skill_dir(name) / ".skill-meta.json"


def _archive_root() -> Path:
    a = _root() / ".archive"
    a.mkdir(parents=True, exist_ok=True)
    return a


def _refuse_symlinks(p: Path) -> None:
    # Refuse if the target (if it exists) is a symlink, OR if any path component
    # we'll write into is a symlink. We don't follow links.
    if p.is_symlink():
        raise SkillError(f"refusing: path is a symlink: {p}")
    parent = p.parent
    if parent.exists() and parent.is_symlink():
        raise SkillError(f"refusing: parent is a symlink: {parent}")


# ── atomic write ────────────────────────────────────────────────────────────
def _fsync_dir(d: Path) -> None:
    try:
        fd = os.open(str(d), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        # some filesystems / OSes (Windows) reject dir fsync — best effort.
        pass


def _atomic_write_text(path: Path, content: str) -> None:
    _refuse_symlinks(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=str(path.parent))
    tmp_path = Path(tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
        _fsync_dir(path.parent)
    except BaseException:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass
        raise


# ── frontmatter (hand-built, no YAML lib — fields are pre-validated) ────────
def _render_skill_md(name: str, description: str, body: str) -> str:
    # Trailing newline so the body is well-formed even when empty.
    body = body or ""
    if not body.endswith("\n"):
        body = body + "\n"
    return f"---\nname: {name}\ndescription: {description}\n---\n\n{body}"


def _parse_skill_md(text: str) -> tuple[str, str, str]:
    """Return (name, description, body). Strict parser — frontmatter must be
    the first thing in the file and contain ONLY name + description."""
    if not text.startswith("---\n"):
        raise SkillError("SKILL.md missing frontmatter")
    rest = text[4:]
    end = rest.find("\n---\n")
    if end == -1:
        raise SkillError("SKILL.md frontmatter not terminated")
    header = rest[:end]
    body = rest[end + 5:]
    if body.startswith("\n"):
        body = body[1:]
    name = ""
    desc = ""
    for line in header.splitlines():
        if line.startswith("name:"):
            name = line[5:].strip()
        elif line.startswith("description:"):
            desc = line[12:].strip()
    return name, desc, body


# ── sidecar ─────────────────────────────────────────────────────────────────
def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


@dataclass
class SkillMeta:
    schema_version: int = 1
    provenance: Provenance = "user"
    created: str = ""
    last_updated: str = ""

    def to_json(self) -> str:
        return json.dumps({
            "schema_version": self.schema_version,
            "provenance": self.provenance,
            "created": self.created,
            "last_updated": self.last_updated,
        }, ensure_ascii=False, indent=2)


def _load_meta(name: str) -> SkillMeta:
    """Forward-compat read: unknown fields ignored; missing fields defaulted."""
    p = _sidecar(name)
    if not p.exists():
        return SkillMeta(created=_utc_now(), last_updated=_utc_now())
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return SkillMeta(created=_utc_now(), last_updated=_utc_now())
    if not isinstance(raw, dict):
        return SkillMeta(created=_utc_now(), last_updated=_utc_now())
    return SkillMeta(
        schema_version=int(raw.get("schema_version", 1)),
        provenance=raw.get("provenance", "user") if raw.get("provenance") in ("user", "background_review") else "user",
        created=str(raw.get("created", "") or _utc_now()),
        last_updated=str(raw.get("last_updated", "") or _utc_now()),
    )


# ── public API ──────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Skill:
    name: str
    description: str
    body: str
    meta: SkillMeta


def create(name: str, description: str, body: str = "",
           provenance: Provenance = "user") -> Skill:
    _validate_name(name)
    _validate_description(description)
    sd = _skill_dir(name)
    _refuse_symlinks(sd)
    if sd.exists():
        raise SkillError(f"skill already exists: {name!r}")
    sd.mkdir(parents=True, exist_ok=False)
    try:
        now = _utc_now()
        meta = SkillMeta(provenance=provenance, created=now, last_updated=now)
        _atomic_write_text(_skill_md(name), _render_skill_md(name, description, body))
        _atomic_write_text(_sidecar(name), meta.to_json())
    except BaseException:
        # roll back the directory we just made if write failed
        shutil.rmtree(sd, ignore_errors=True)
        raise
    return Skill(name=name, description=description, body=body, meta=meta)


def read(name: str) -> Skill:
    _validate_name(name)
    p = _skill_md(name)
    if not p.exists():
        raise SkillError(f"skill not found: {name!r}")
    n, d, body = _parse_skill_md(p.read_text(encoding="utf-8"))
    if n != name:
        raise SkillError(f"frontmatter name {n!r} != dir {name!r}")
    return Skill(name=name, description=d, body=body, meta=_load_meta(name))


def update(name: str, description: Optional[str] = None,
           body: Optional[str] = None) -> Skill:
    _validate_name(name)
    if not _skill_md(name).exists():
        raise SkillError(f"skill not found: {name!r}")
    current = read(name)
    new_desc = current.description if description is None else description
    if description is not None:
        _validate_description(description)
    new_body = current.body if body is None else body
    meta = _load_meta(name)
    meta.last_updated = _utc_now()
    _atomic_write_text(_skill_md(name), _render_skill_md(name, new_desc, new_body))
    _atomic_write_text(_sidecar(name), meta.to_json())
    return Skill(name=name, description=new_desc, body=new_body, meta=meta)


def delete(name: str) -> Path:
    """Archive-move; never hard-delete. Returns the archive dir path."""
    _validate_name(name)
    sd = _skill_dir(name)
    if not sd.exists():
        raise SkillError(f"skill not found: {name!r}")
    _refuse_symlinks(sd)
    archive_root = _archive_root()
    base_ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    target = archive_root / f"{name}-{base_ts}"
    suffix = 0
    # Collision-proof: even if the wall clock returns the same microsecond
    # (or %f is too coarse on this fs), append -1, -2, ... to disambiguate.
    while target.exists():
        suffix += 1
        target = archive_root / f"{name}-{base_ts}-{suffix}"
    os.rename(sd, target)
    # Rename SKILL.md → SKILL.md.archived so Axel's *.md filter skips it.
    md = target / "SKILL.md"
    if md.exists():
        os.rename(md, target / "SKILL.md.archived")
    return target


def list_skills() -> list[str]:
    r = _root()
    out = []
    for child in sorted(r.iterdir()):
        if not child.is_dir() or child.is_symlink():
            continue
        if child.name.startswith("."):
            continue
        if (child / "SKILL.md").exists():
            out.append(child.name)
    return out
