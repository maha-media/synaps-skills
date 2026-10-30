"""jev's log routing: notices for stderr, routine lines for jev.log.

The host forwards an extension's stderr to synaps.log, but only the first
128 KiB per extension process; past that it counts the bytes and logs the
count at exit. One guard line per tool call used that up in about 23
minutes, and every later warning was lost. So:

  * a NOTICE (`Notice`, made by `notice()` or `decision()`) goes to stderr
    and to jev.log: start/stop, activation, transport and key state, crashes,
    framing errors, relay trouble, failed writes, failed evaluations (a
    timeout, a spent hook budget, a transport error) and guard decisions
    that block or warn;
  * every other line is ROUTINE: per-call decisions that continue or
    confirm, skips and fold notes. It goes to jev.log only (config
    `log_routine = file`, the default), to both as before (`stderr`) or
    nowhere (`off`).

A notice that can repeat on every call (an evaluation error through an API
outage, the same block retried, relay flapping, the same crash) still could
use the budget up, so the notices of a running extension pass a `Limiter`:
the first of a key reaches stderr; its repeats within LIMIT_WINDOW_S go to
jev.log only, counted; when the window ends, ONE summary line ("… repeated N
more times in the last M min"), and on a change of state (a line that
`clears` the key: an answer after evaluation errors) ONE "… recovered after
N errors" line. The key is a category set by the caller (`key=`), else the
text with its timings dropped, so different texts each reach stderr. Keys
of one FAMILY (`family=`: the guard's evaluation errors, one key per
category; handler crashes, one per signature; relay states) share ONE
window: the first of each key still reaches stderr at once, but the window
ends in one summary with the counts per key, and "recovered" is said once
an episode (until a window passes quiet), not once a window.
Lifecycle, activation, key and transport lines do not pass the limiter.

README "Logs" has the full table. jev.log is <base>/memory/jev/jev.log,
next to the audit file (base: $SYNAPS_BASE_DIR, else ~/.synaps-cli), mode
0600 in a 0700 dir, one line per write, rotated at LOG_FILE_MAX into
jev.log.1 … jev.log.LOG_FILE_KEEP. Writing is best-effort: a failure drops
and counts the line (`dropped`), never raises. A line break in a message is
escaped (`\\n`), so one entry is one stamped line and a message cannot forge
a line of its own.
"""
from __future__ import annotations

import errno
import fcntl
import os
import re
import stat
import time
from pathlib import Path

from .audit import synaps_base_dir

PREFIX = "[jev] "
LINE_MAX = 4000             # bytes per file line, newline included (as StderrLog)
HOLD_MAX = 64               # lines one frame may hold until its reply is out (as StderrLog)
LOG_FILE_MAX = 2 * 1024 * 1024
LOG_FILE_KEEP = 3           # jev.log.1 … jev.log.3
LOG_ROUTINES = ("file", "stderr", "off")
NOTICE_ACTIONS = frozenset({"block", "warn"})
LIMIT_WINDOW_S = 600.0      # a notice's repeats within this go to jev.log only
LIMIT_KEYS_MAX = 256        # keys followed at once; past it the oldest goes (with its summary)
LABEL_MAX = 100             # characters of a line kept to name it in a summary
COUNTS_MAX = 200            # characters of a family summary's counts per key; the rest "+N more"

_FLAGS = (os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW
          | os.O_NONBLOCK)  # NONBLOCK: a FIFO planted at the path fails (ENXIO), never waits
_TIMINGS = re.compile(r"\d+ ms\b")
# Every control character but tab, and the Unicode line breaks (str.splitlines
# splits on \v \f \x1c-\x1e \x85 \u2028 \u2029 too): one entry, one line.
_ESCAPES = {c: f"\\x{c:02x}" for c in (*range(0x20), 0x7f, 0x85) if c != 0x09}
_ESCAPES.update({0x0a: "\\n", 0x0d: "\\r", 0x2028: "\\u2028", 0x2029: "\\u2029"})


class Line(str):
    """A routine log line (jev.log only, by default). `clears`: a limiter key
    (prefix) whose error state this line ends, e.g. a guard answer after
    evaluation errors."""
    key: str | None = None
    label: str | None = None
    repeat: str | None = None
    clears: str | None = None
    family: str | None = None


class Notice(Line):
    """A log line for stderr (synaps.log) as well as jev.log. For the
    limiter: `key` groups its repeats (default: the text, timings dropped),
    `label` names it in a summary (default: the key, cut), `repeat` is the
    text a repeat writes to jev.log (default: the line). `family`: the name
    of a family of keys with one window, one summary and one recovery line;
    `label` then names this key in their counts."""


def _line(cls: type, text: str, **attrs) -> Line:
    line = cls(text)
    for name, value in attrs.items():
        if value is not None:
            setattr(line, name, value)
    return line


def routine(line: str, *, clears: str | None = None) -> Line:
    return _line(Line, line, clears=clears)


def notice(line: str, when: bool = True, *, key: str | None = None, label: str | None = None,
           repeat: str | None = None, clears: str | None = None, family: str | None = None) -> Line:
    """`line` as a Notice when `when`, else as a routine line."""
    if when:
        return _line(Notice, line, key=key, label=label, repeat=repeat, clears=clears, family=family)
    return routine(line, clears=clears)


def decision(action: str, line: str, *, clears: str | None = None) -> Line:
    """A guard decision line: a notice when the call is blocked, or when a
    rule in warn mode fired (warn logs and counts only); routine otherwise."""
    return notice(line, action in NOTICE_ACTIONS, clears=clears)


def default_key(line: str) -> str:
    return _TIMINGS.sub("… ms", str(line))


def _cut(text: str) -> str:
    return text if len(text) <= LABEL_MAX else text[:LABEL_MAX] + "…"


def _times(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


class _Key:
    __slots__ = ("name", "n", "total")

    def __init__(self, name: str) -> None:
        self.name = name        # in a family's counts
        self.n = 0              # repeats not yet reported
        self.total = 1          # errors since the state was last ok


class _Window:
    """One key's window, or a family's: one start, one summary and one
    recovery line for all its keys."""
    __slots__ = ("start", "label", "family", "keys", "ok", "ok_said")

    def __init__(self, start: float, label: str, family: bool) -> None:
        self.start = start      # this window's start
        self.label = label
        self.family = family
        self.keys: dict[str, _Key] = {}
        self.ok = False         # cleared since the last error
        self.ok_said = False    # this episode's recovery line said; an episode ends with a quiet window

    def counts(self, field: str) -> tuple[int, str]:
        """The sum of `field` over the keys, and for a family " (name ×n, …)",
        the most first, within COUNTS_MAX characters."""
        ranked = sorted((k for k in self.keys.values() if getattr(k, field)), key=lambda k: -getattr(k, field))
        total = sum(getattr(k, field) for k in ranked)
        if not self.family or not ranked:
            return total, ""
        shown, size = [], 0
        for k in ranked:
            item = f"{k.name} ×{getattr(k, field)}"
            if shown and size + len(item) > COUNTS_MAX:
                break
            shown.append(item)
            size += len(item) + 2
        rest = len(ranked) - len(shown)
        return total, " (" + ", ".join(shown) + (f", +{rest} more" if rest else "") + ")"


class Limiter:
    """Says which notices reach stderr; no I/O. `line` → True: write it to
    stderr (and jev.log); False: a repeat, jev.log only (its `repeat` text),
    counted in `limited`. The lines it owes (summaries, recoveries; counted
    in `summaries`) wait in `take()`; a window that ended is closed by the
    next call or `tick()`, every open one by `close()`. Windows are kept in
    start order, so a tick looks at the oldest only."""

    def __init__(self, *, window_s: float = LIMIT_WINDOW_S, max_keys: int = LIMIT_KEYS_MAX,
                 clock=time.monotonic) -> None:
        self.window_s = window_s
        self.max_keys = max_keys
        self.clock = clock
        self.limited = 0
        self.summaries = 0
        self._windows: dict[tuple[str, str], _Window] = {}  # ("family", name) or ("key", key)
        self._index: dict[str, tuple[str, str]] = {}        # every key followed → its window
        self._pending: list[str] = []

    def __len__(self) -> int:
        return len(self._index)

    def __call__(self, line: str) -> bool:
        now = self.clock()
        self._expire(now)
        clears = getattr(line, "clears", None)
        if clears:
            self._clear(clears)
        if not isinstance(line, Notice):
            return True
        key = line.key or default_key(line)
        where = self._index.get(key)
        if where is not None:
            window = self._windows[where]
            state = window.keys[key]
            state.n += 1
            state.total += 1
            window.ok = False
            self.limited += 1
            return False
        if len(self._index) >= self.max_keys:
            self._close(next(iter(self._windows)), now)
        family = line.family
        where = ("family", family) if family else ("key", key)
        window = self._windows.get(where)
        if window is None:
            window = self._windows[where] = _Window(now, _cut(family or line.label or key), bool(family))
        window.keys[key] = _Key(_cut(line.label or key))
        window.ok = False
        self._index[key] = where
        return True

    def tick(self) -> None:
        self._expire(self.clock())

    def holds(self, key: str) -> bool:
        """Whether a notice with `key` would be a repeat now (jev.log only):
        a caller can skip building a long text that only its first needs."""
        self._expire(self.clock())
        return key in self._index

    def close(self) -> None:
        now = self.clock()
        while self._windows:
            self._close(next(iter(self._windows)), now)

    def take(self) -> list[str]:
        pending, self._pending = self._pending, []
        return pending

    def _say(self, text: str) -> None:
        self._pending.append(Notice(text))
        self.summaries += 1

    def _expire(self, now: float) -> None:
        while self._windows:
            where = next(iter(self._windows))
            window = self._windows[where]
            if now - window.start < self.window_s:
                return
            del self._windows[where]
            if self._end(window, now):  # still repeating: a new window, the same episode
                window.start = now
                self._windows[where] = window
            else:                       # a quiet window: closed, its keys are firsts again
                self._forget(window)

    def _close(self, where: tuple[str, str], now: float) -> None:
        window = self._windows.pop(where)
        self._end(window, now)
        self._forget(window)

    def _forget(self, window: _Window) -> None:
        for key in window.keys:
            self._index.pop(key, None)

    def _end(self, window: _Window, now: float) -> bool:
        """A window's end: its unreported repeats in one line (a family's
        counted per key). False: there were none."""
        n, counts = window.counts("n")
        if not n:
            return False
        minutes = max(1, round((now - window.start) / 60))
        self._say(f"{window.label}: repeated {_times(n, 'more time')} in the last {minutes} min{counts} "
                  "(each in jev.log)" + ("; ok again" if window.ok else ""))
        for state in window.keys.values():
            state.n = 0
        return True

    def _clear(self, prefix: str) -> None:
        """An ok after errors: ONE recovery line an episode, for a whole family;
        a later recovery in the episode is the summary's "; ok again"."""
        for window in self._windows.values():
            if window.ok or not any(key.startswith(prefix) for key in window.keys):
                continue
            if not window.ok_said:
                total, counts = window.counts("total")
                self._say(f"{window.label}: recovered after {_times(total, 'error')}{counts}")
                window.ok_said = True
                for state in window.keys.values():
                    state.n = 0
            for state in window.keys.values():
                state.total = 0
            window.ok = True


def default_path() -> Path:
    return synaps_base_dir() / "memory" / "jev" / "jev.log"


def _makedirs(directory: str) -> None:
    """Create the missing dirs, each 0700 (os.makedirs gives intermediates 0777 & ~umask)."""
    missing = []
    while directory and not os.path.isdir(directory):
        missing.append(directory)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    for d in reversed(missing):
        try:
            os.mkdir(d, 0o700)
        except FileExistsError:
            pass


class FileLog:
    """Appends log lines to `path`. Each line is formatted when logged
    ("<local time> <pid> [jev] <msg>", line breaks and other controls in
    `msg` escaped), at most LINE_MAX bytes, and written with one O_APPEND
    write on its own open, so writers in several jev processes (one per
    session) interleave whole lines. While a frame is being handled its
    lines are held (at most `hold_max`, the rest dropped) and written after
    its reply, as StderrLog does. `path` None: nothing is written or counted
    (before main() sets it). `lines` counts written lines, `dropped` lost
    ones; nothing here raises."""

    def __init__(self, path=None, *, max_bytes: int = LOG_FILE_MAX, keep: int = LOG_FILE_KEEP,
                 hold_max: int = HOLD_MAX) -> None:
        self.path = Path(path) if path is not None else None
        self.max_bytes = max_bytes
        self.keep = keep
        self.hold_max = hold_max
        self.lines = 0
        self.dropped = 0
        self._held: list[bytes] | None = None

    def __call__(self, msg: str) -> None:
        if self.path is None:
            return
        try:
            line = self._format(msg)
        except Exception:  # noqa: BLE001 — logging must not raise
            self.dropped += 1
            return
        if self._held is None:
            self._emit(line)
        elif len(self._held) < self.hold_max:
            self._held.append(line)
        else:
            self.dropped += 1

    def hold(self) -> None:
        self._held = []

    def release(self) -> None:
        held, self._held = self._held or [], None
        for line in held:
            self._emit(line)

    @staticmethod
    def _format(msg: str) -> bytes:
        now = time.time()
        local = time.localtime(now)
        stamp = (time.strftime("%Y-%m-%dT%H:%M:%S", local) + f".{int(now % 1 * 1000):03d}"
                 + time.strftime("%z", local))
        text = str(msg).translate(_ESCAPES)
        line = f"{stamp} {os.getpid()} {PREFIX}{text}".encode("utf-8", "replace")[:LINE_MAX - 1]
        return line.decode("utf-8", "ignore").encode("utf-8") + b"\n"

    def _emit(self, line: bytes) -> None:
        if self.path is None:
            return
        try:
            ok = self._append(line)
        except Exception:  # noqa: BLE001 — unwritable dir, full disk, anything: drop it
            ok = False
        if ok:
            self.lines += 1
        else:
            self.dropped += 1

    def _open(self) -> int:
        path = os.fspath(self.path)
        try:
            fd = os.open(path, _FLAGS, 0o600)
        except FileNotFoundError:
            _makedirs(os.path.dirname(path))
            fd = os.open(path, _FLAGS, 0o600)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise OSError(errno.EINVAL, "jev.log is not a regular file")
            if stat.S_IMODE(st.st_mode) & 0o077:
                os.fchmod(fd, 0o600)
        except BaseException:
            os.close(fd)
            raise
        return fd

    def _append(self, line: bytes) -> bool:
        fd = self._open()
        try:
            size = os.fstat(fd).st_size
            if size and size + len(line) > self.max_bytes:
                fd = self._rotate(fd)
            return os.write(fd, line) == len(line)
        finally:
            os.close(fd)

    def _rotate(self, fd: int) -> int:
        """jev.log → .1 → … → .keep (the oldest goes), under an exclusive
        lock on the full file, then a fresh jev.log; returns its fd and
        closes `fd`. Another process rotating right now (lock busy): the line
        goes to the file already open, which is kept as .1. The file already
        rotated by another process (the path is a new inode): no shift, just
        the fresh file. If this raises, `fd` is still open (the caller
        closes it)."""
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return fd
        path = os.fspath(self.path)
        try:
            current, mine = os.stat(path, follow_symlinks=False), os.fstat(fd)
            if (current.st_dev, current.st_ino) == (mine.st_dev, mine.st_ino):
                for i in range(self.keep - 1, 0, -1):
                    try:
                        os.replace(f"{path}.{i}", f"{path}.{i + 1}")
                    except FileNotFoundError:
                        pass
                os.replace(path, f"{path}.1")
        except FileNotFoundError:
            pass  # moved away meanwhile: open a fresh one
        fresh = self._open()
        os.close(fd)  # also releases the lock
        return fresh
