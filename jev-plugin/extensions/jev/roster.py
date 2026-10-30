"""roster — which sessions are fleet sessions (the rule-1 guard's scope).

A fleet session is one whose id is listed in the fleet's own files:

- <fleet>/roster.toml: `[master].session` and every `[[team]].foreman`;
- every team.toml under <fleet>/projects/ (searched recursively; lanes
  can live in subfolders): `foreman` and every `[[worker]].session`.

<fleet> is ~/.pria/fleet. A file is read again when its mtime, size or
inode changes; the projects tree is searched again at most every REWALK_S
seconds, or every MISS_REWALK_S when a session is not found (a lane just
added). Only the ids are kept, never other file content.

Fail closed: when a file cannot be read or parsed (roster.toml missing, a
bad team.toml, a projects tree that cannot be searched), every session is
in scope until the files read again. One host without a fleet at all
(<fleet> itself absent) is not a failure: there are no fleet sessions, so
scope `fleet` matches none (CI, a machine without the fleet). A missing or
empty session id is in scope whenever a fleet exists (provider-mediated
and worker frames carry none).
"""

from __future__ import annotations

import os
import stat
import time
import tomllib
from pathlib import Path

from .logs import Notice

FLEET_DIR = None        # None: ~/.pria/fleet. Tests point it at a scratch tree.
REWALK_S = 30.0         # look for new or removed team.toml files at most this often
MISS_REWALK_S = 2.0     # ... or this often when a session is not found
MAX_FILE_BYTES = 1 << 20
MAX_WALK_DIRS = 4096


class RosterError(Exception):
    """The roster could not be read. The message is a fixed text plus a
    path relative to the fleet dir, never file content."""


class _Vanished(Exception):
    """A team.toml found by the last search is gone: search again."""


def default_fleet_dir() -> Path:
    if FLEET_DIR:
        return Path(FLEET_DIR)
    return Path(os.path.expanduser("~")) / ".pria" / "fleet"


def _strings(*values) -> set:
    return {v.strip() for v in values if isinstance(v, str) and v.strip()}


def roster_ids(data: dict) -> set:
    master = data.get("master")
    if not isinstance(master, dict) or not _strings(master.get("session")):
        raise RosterError("roster.toml has no [master].session")
    ids = _strings(master.get("session"))
    teams = data.get("team")
    for team in teams if isinstance(teams, list) else []:
        if isinstance(team, dict):
            ids |= _strings(team.get("foreman"))
    return ids


def team_ids(data: dict) -> set:
    ids = _strings(data.get("foreman"))
    workers = data.get("worker")
    for worker in workers if isinstance(workers, list) else []:
        if isinstance(worker, dict):
            ids |= _strings(worker.get("session"))
    return ids


class FleetRoster:
    def __init__(self, fleet_dir=None, clock=time.monotonic) -> None:
        self.dir = Path(fleet_dir) if fleet_dir else default_fleet_dir()
        self.clock = clock
        self._cache: dict = {}      # path -> (stat key, ids)
        self._teams = None          # team.toml paths from the last search
        self._walked = None         # clock time of the last search
        self._state = None          # last state logged: "ok", "no fleet" or an error text

    # ── the one question the guard asks
    def lookup(self, session, log=None) -> tuple[bool, str]:
        """(in scope, why); why is listed, unlisted, no_session, unreadable
        or no_fleet. Never raises."""
        try:
            ids = self._ids(False)
            if ids is None:
                self._note("no fleet", log)
                return False, "no_fleet"
            if not (isinstance(session, str) and session.strip()):
                self._note("ok", log)
                return True, "no_session"
            key = session.strip()
            if key not in ids and (self._walked is None or self.clock() - self._walked >= MISS_REWALK_S):
                ids = self._ids(True)
                if ids is None:
                    self._note("no fleet", log)
                    return False, "no_fleet"
            self._note("ok", log)
            return (True, "listed") if key in ids else (False, "unlisted")
        except RosterError as e:
            self._note(str(e), log)
            return True, "unreadable"
        except Exception:  # noqa: BLE001 — any other failure fails closed too
            self._note("roster check failed", log)
            return True, "unreadable"

    def _note(self, state: str, log) -> None:
        """One log line per change of state (WARN while unreadable)."""
        previous, self._state = self._state, state
        if log is None or state == previous:
            return
        if state == "ok":
            if previous not in (None, "ok"):
                log(Notice(f"guard rule-1: fleet roster readable again ({self.dir})"))
        elif state == "no fleet":
            log(Notice(f"guard rule-1: no fleet on this host ({self.dir} absent): scope fleet matches no session"))
        else:
            log(Notice(f"guard rule-1: WARN fleet roster unreadable ({state}): rule 1 applies to every session "
                       "until it reads again"))

    # ── reading
    def _ids(self, force_walk: bool):
        try:
            st = os.stat(self.dir)
        except FileNotFoundError:
            return None
        except OSError:
            raise RosterError("fleet dir unreadable") from None
        if not stat.S_ISDIR(st.st_mode):
            raise RosterError("fleet dir is not a directory")
        for attempt in (0, 1):
            ids = set(self._file(self.dir / "roster.toml", roster_ids, required=True))
            now = self.clock()
            if force_walk or attempt or self._teams is None or now - self._walked >= REWALK_S:
                self._teams = self._walk(self.dir / "projects")
                self._walked = now
            try:
                for path in self._teams:
                    ids |= self._file(path, team_ids, required=False)
            except _Vanished:
                continue
            return ids
        raise RosterError("team files keep changing")

    def _rel(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.dir))
        except ValueError:
            return path.name

    def _file(self, path: Path, parse, *, required: bool) -> set:
        try:
            st = os.stat(path)
        except FileNotFoundError:
            if required:
                raise RosterError(f"{self._rel(path)} missing") from None
            raise _Vanished() from None
        except OSError:
            raise RosterError(f"{self._rel(path)} unreadable") from None
        key = (st.st_mtime_ns, st.st_size, st.st_ino)
        cached = self._cache.get(path)
        if cached is not None and cached[0] == key:
            return cached[1]
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_FILE_BYTES:
            raise RosterError(f"{self._rel(path)} is not a small regular file")
        try:
            with open(path, "rb") as f:
                raw = f.read(MAX_FILE_BYTES + 1)
        except OSError:
            raise RosterError(f"{self._rel(path)} unreadable") from None
        try:
            data = tomllib.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, tomllib.TOMLDecodeError):
            raise RosterError(f"cannot parse {self._rel(path)}") from None
        ids = frozenset(parse(data))
        self._cache[path] = (key, ids)
        return ids

    def _walk(self, projects: Path) -> list:
        if not projects.is_dir():
            raise RosterError("projects dir missing")
        found, dirs = [], 0

        def failed(error):
            raise RosterError("projects tree cannot be searched")

        for root, subdirs, files in os.walk(projects, onerror=failed):
            dirs += 1
            if dirs > MAX_WALK_DIRS:
                raise RosterError("projects tree too large to search")
            subdirs.sort()
            if "team.toml" in files:
                found.append(Path(root) / "team.toml")
        live = set(found)
        for path in list(self._cache):
            if path.name == "team.toml" and path not in live:
                del self._cache[path]
        return found
