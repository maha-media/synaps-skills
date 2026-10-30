"""access — owner rule 27a's scanner (the harness should try its best to end
the turn, ask permission and halt work on a task before a command that
removes group write permission or makes a similar access change; an agent
once ran `chmod g-w ~/Projects ...`).

Owner rule 27a: before any command that changes who can read, write or run
something, or what the system lets an agent do, the agent does not run it:
it ends its turn and asks for the owner's yes. The guard's model score already
calls chmod "hard to reverse" and asks to confirm, but fleet auto-accept
passes a confirm, so this rule BLOCKS, decided locally with no model call.

scan_access(text, ctx) lists what the rule refuses in one shell text, read
with the rule-1 tokenizer (rule1._Parser: command level, wrappers such as
sudo/env/timeout/xargs unwrapped, find -exec, and the -c string of a shell,
ssh's remote command and eval's arguments scanned as scripts of their own):

  command  an access command (ALWAYS: users and groups, sudo/doas/pkexec/
           su, firewall tools, setcap, ssh-keygen/ssh-copy-id/ssh-add,
           `systemctl set-property|edit|revert`, systemd-run in any form
           but the 27c(5) memory-cap scope), or a mode/owner/ACL
           command (MODE: chmod chown chgrp setfacl chattr chacl, install
           with -m/-o/-g, mkdir with -m, rsync --chmod/--chown) unless
           every target resolves inside the session's own area (below)
  write    a redirect, tee, cp/mv/install/ln/rsync, dd of=, curl -o,
           wget -O, sed/perl -i, touch, truncate, mkdir, rm ... that names
           a protected path (PROTECTED), or a gated path whose new text
           sets a gated key (systemd units: a limit or access key; shell
           and service config: umask)
  code     the inline code of python -c, perl -e, node -e or ruby -e that
           names an access change (CODE_WORDS)

path_access(path, text, ctx) answers the same for a write, edit or
multi_edit target.

The own area (the only exception, 27a: files the agent itself created in
its own worktree or scratch): a MODE command passes only when it runs at
the top level (not in a nested script, not on a remote host, not through
xargs or find -exec), every target is a literal path (no variable, no
command substitution, no `{}`), and each target's realpath (globs
expanded) lies strictly below /var/tmp/<dir>/ or /tmp/<dir>/, or strictly
below the session cwd when that cwd is at least three levels below HOME
(a project checkout or worktree, never ~ or ~/Projects), and is not a
protected or gated path. When in doubt it blocks.

Limits (README): variables and control flow are not evaluated; a script
run from a file (python3 f.py, bash f.sh) is not read; heredoc bodies are
read only as the new text of a gated write; the code of interpreters other
than the four above is not read. Hits carry fixed tokens (a command name
from the lists below, a path class), never input text.
"""

from __future__ import annotations

import fnmatch
import glob as _glob
import json
import os
import re
from typing import Callable, NamedTuple

from . import rule1

ACCESS_MAX = 64  # one is enough to decide

# Commands that always change access (or run as another user).
ALWAYS = {
    # users and groups
    "usermod": "changes users or groups", "useradd": "changes users or groups",
    "userdel": "changes users or groups", "groupadd": "changes users or groups",
    "groupdel": "changes users or groups", "groupmod": "changes users or groups",
    "gpasswd": "changes users or groups", "adduser": "changes users or groups",
    "addgroup": "changes users or groups", "deluser": "changes users or groups",
    "delgroup": "changes users or groups", "passwd": "changes users or groups",
    "chpasswd": "changes users or groups", "chsh": "changes users or groups",
    "chfn": "changes users or groups", "chage": "changes users or groups",
    "vipw": "changes users or groups", "vigr": "changes users or groups",
    "newgrp": "runs as another group", "sg": "runs as another group",
    # privilege
    "sudo": "runs as root (owner rule 14)", "sudoedit": "runs as root (owner rule 14)",
    "doas": "runs as root (owner rule 14)", "pkexec": "runs as root (polkit)",
    "su": "runs as another user", "runuser": "runs as another user",
    "visudo": "edits sudoers",
    # firewall
    "ufw": "changes the firewall", "nft": "changes the firewall",
    "iptables": "changes the firewall", "ip6tables": "changes the firewall",
    "iptables-restore": "changes the firewall", "ip6tables-restore": "changes the firewall",
    "iptables-legacy": "changes the firewall", "ip6tables-legacy": "changes the firewall",
    "iptables-nft": "changes the firewall", "ip6tables-nft": "changes the firewall",
    "ebtables": "changes the firewall", "arptables": "changes the firewall",
    "firewall-cmd": "changes the firewall", "firewall-offline-cmd": "changes the firewall",
    # capabilities, labels
    "setcap": "changes file capabilities", "chcon": "changes security labels",
    "setsebool": "changes security policy", "semanage": "changes security policy",
    # ssh keys
    "ssh-keygen": "changes ssh keys", "ssh-copy-id": "changes authorized_keys",
    "ssh-add": "changes the ssh agent's keys",
}
# read-only forms of two of them
_IPTABLES = frozenset({"iptables", "ip6tables", "iptables-legacy", "ip6tables-legacy", "iptables-nft",
                       "ip6tables-nft", "ebtables", "arptables"})
_FIREWALL_CMD_READ = ("--list-", "--get-", "--query-", "--info-", "--state", "--version", "--help", "--zone",
                      "--permanent")


def _shorts(args: list) -> set:
    return {c for a in args if a.startswith("-") and not a.startswith("--") for c in a[1:]}


def _read_only(name: str, args: list) -> bool:
    """The read-only forms of some ALWAYS commands: listing keys, rules or
    firewall state. Everything else they do blocks."""
    shorts = _shorts(args)
    longs = [a for a in args if a.startswith("--")]
    words = [a for a in args if not a.startswith("-")]
    if name == "ssh-keygen":
        return bool(shorts & set("lFBy")) and not shorts & set("tpcRNsAkuOI")
    if name == "ssh-add":
        return bool(shorts & set("lL")) and not shorts & set("dDxXsetcSHhK")
    if name == "ufw":
        return bool(words) and (words[0] in ("status", "show", "version") or words[:2] in (["app", "list"],
                                                                                        ["app", "info"]))
    if name == "nft":
        return bool(words) and words[0] == "list" and not shorts & set("fi") and "--file" not in longs
    if name in _IPTABLES:
        return (bool(shorts & set("LSV")) or any(a in ("--list", "--list-rules", "--version") for a in longs)) \
            and not shorts & set("AIDRFXNPZE") and not any(
                a.split("=", 1)[0] in ("--append", "--insert", "--delete", "--replace", "--flush", "--zero",
                                       "--delete-chain", "--new-chain", "--policy", "--rename-chain")
                for a in longs)
    if name == "firewall-cmd":
        return bool(longs) and not shorts and all(a.startswith(_FIREWALL_CMD_READ) for a in longs) and any(
            a.startswith(("--list-", "--get-", "--query-", "--info-", "--state", "--version")) for a in longs)
    return False
_SYSTEMCTL_ACCESS = frozenset({"set-property", "edit", "revert"})
_SYSTEMCTL_VALUE = frozenset({"-H", "--host", "-M", "--machine", "-t", "--type", "-p", "--property",
                              "-s", "--signal", "--state", "-o", "--output", "-n", "--lines", "--root",
                              "--image", "--kill-whom", "--job-mode", "--what", "--timestamp",
                              "--drop-in", "--when", "--message", "--boot-loader-entry",
                              "--reboot-argument", "--marked", "--legend", "--preset-mode"})

# systemd-run (owner rules 27a and 27c(5)). Without --scope a systemd manager
# runs the job as a service: outside the session's process tree and its
# sandbox. 27c(5) lets an agent cap its own child processes with
# `systemd-run --user --scope` and the memory properties only; -E/--setenv
# is part of that form too (an environment variable is no access item in
# 27a). This check only ADDS asks, for every other form; the
# 27c(5) form gets no hit from it (whether a cap tightens stays the agent's
# duty, 27c(5)). Options are read as systemd-run's getopt reads them: an
# unambiguous prefix of a long option counts, a short cluster (-qGp X)
# splits, and options end at the first word that is not one, or at `--`.
# An expansion where an option can be, or one in a -p/-E value that can
# split into more words (_may_split), is unseen. The words after the
# options are the command it runs, scanned like any other, and the scripts
# that command runs are read as under a rule-1 wrapper (_unwrap,
# _Visitor._descend_runs).
_SYSRUN_LONG = {  # long option -> takes a value
    "help": False, "version": False, "no-ask-password": False, "user": False, "system": False,
    "host": True, "machine": True, "capsule": True, "scope": False, "unit": True, "property": True,
    "description": True, "slice": True, "slice-inherit": False, "expand-environment": True,
    "no-block": False, "remain-after-exit": False, "wait": False, "send-sighup": False,
    "service-type": True, "uid": True, "gid": True, "nice": True, "working-directory": True,
    "same-dir": False, "root-directory": True, "same-root-dir": False, "setenv": True, "pty": False,
    "pty-late": False, "pipe": False, "quiet": False, "verbose": False, "json": True, "collect": False,
    "shell": False, "job-mode": True, "ignore-failure": False, "background": True, "no-pager": False,
    "path-property": True, "socket-property": True, "on-active": True, "on-boot": True,
    "on-startup": True, "on-unit-active": True, "on-unit-inactive": True, "on-calendar": True,
    "on-timezone-change": False, "on-clock-change": False, "timer-property": True,
}
_SYSRUN_SHORT = {"h": "help", "H": "host", "M": "machine", "C": "capsule", "u": "unit", "p": "property",
                 "r": "remain-after-exit", "d": "same-dir", "R": "same-root-dir", "E": "setenv", "t": "pty",
                 "T": "pty-late", "P": "pipe", "q": "quiet", "v": "verbose", "G": "collect", "S": "shell"}
_SYSRUN_FORM = frozenset({"user", "scope", "quiet", "same-dir", "collect", "property", "setenv"})
_SYSRUN_PLACE = frozenset({"slice", "slice-inherit", "uid", "gid", "host", "machine", "capsule"})
_SYSRUN_NAMED = frozenset({"unit", "description"})
SYSRUN_MEMORY = frozenset({"MemoryMax", "MemoryHigh", "MemorySwapMax"})
# the reasons a systemd-run asks, in the order one is chosen (one hit each)
_SYSRUN_WHY = {
    "scope": "runs the job as a systemd service, outside the session's sandbox (no --scope)",
    "system": "runs the job under the system manager (no --user)",
    "place": "runs the job in another slice, as another user or group, or on another machine or host",
    "property": "sets a unit property other than a memory cap (MemoryMax, MemoryHigh, MemorySwapMax)",
    "named": "names its unit (--unit or --description), outside the 27c(5) memory-cap form",
    "other": "uses an option outside the 27c(5) memory-cap form",
    "unseen": "uses options the scan cannot see",
}


def _sysrun_long(name: str) -> str | None:
    if name in _SYSRUN_LONG:
        return name
    found = [n for n in _SYSRUN_LONG if name and n.startswith(name)]
    return found[0] if len(found) == 1 else None


# inside double quotes, the expansions that stay one word
_DQ_PLAIN = re.compile(r"\{(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)\}|[A-Za-z_][A-Za-z0-9_]*|[0-9]")
_EXPANDS = frozenset("_{([@*#?$!-")  # after `$` (or a letter or digit): an expansion


def _may_split(word, src: str | None) -> bool:
    """Can the expansions in this word make more than one word (and so add
    options)? One outside double quotes can; inside them only a plain
    $NAME, ${NAME} or positional ($1, ${10}) cannot. A word with no
    expansion never splits; one whose source cannot be read counts as
    splitting. Brace and glob expansion are not modelled (README limits)."""
    if rule1.OPAQUE not in str(word):
        return False
    start, end = getattr(word, "start", None), getattr(word, "end", None)
    if src is None or start is None or end is None or end <= start:
        return True
    s, i, quoted = src[start:end], 0, False
    while i < len(s):
        c = s[i]
        nxt = s[i + 1:i + 2]
        if c == "\\":
            i += 2
        elif c == "`":
            return True
        elif quoted:
            if c == '"':
                quoted = False
                i += 1
            elif c == "$" and _DQ_PLAIN.match(s, i + 1):
                i = _DQ_PLAIN.match(s, i + 1).end()
            elif c == "$" and nxt and (nxt.isalnum() or nxt in _EXPANDS):
                return True
            else:
                i += 1  # (a lone `$` is literal)
        elif c == "'":
            j = s.find("'", i + 1)
            if j < 0:
                return True
            i = j + 1
        elif c == '"':
            quoted = True
            i += 1
        elif c == "$" and nxt == "'":  # $'...': ANSI-C quoting, no expansion
            j = i + 2
            while j < len(s) and s[j] != "'":
                j += 2 if s[j] == "\\" else 1
            if j >= len(s):
                return True
            i = j + 1
        elif c == "$" and nxt == '"':
            quoted = True
            i += 2
        elif c == "$" and nxt and (nxt.isalnum() or nxt in _EXPANDS):
            return True  # an expansion outside double quotes
        else:
            i += 1
    return quoted  # an unclosed quote: unknown


def _sysrun_split(args: list, src: str | None = None) -> tuple[set, list]:
    """(the reasons this systemd-run asks: keys of _SYSRUN_WHY, empty for
    the 27c(5) form or a --help/--version that runs nothing; the command
    it runs). `src`: the text the words were read from (their spans), to
    tell whether an expansion in a -p/-E value can split (_may_split);
    None: every expansion there is unseen."""
    opts, reasons = [], set()
    k = 0
    while k < len(args):
        a = str(args[k])
        if a.startswith(rule1.OPAQUE):
            reasons.add("unseen")  # an expansion here can be an option
            break
        if a == "--":
            k += 1
            break
        if not a.startswith("-") or a == "-":
            break
        if a.startswith("--"):
            raw, eq, val = a[2:].partition("=")
            name = _sysrun_long(raw)
            holder = args[k]  # the word that holds the value
            if name is None:
                reasons.add("other")
            elif _SYSRUN_LONG[name]:
                if not eq:
                    k += 1
                    holder = args[k] if k < len(args) else None
                    val = "" if holder is None else str(holder)
                opts.append((name, val, holder))
            else:
                if eq:
                    reasons.add("other")  # systemd-run refuses a value here
                opts.append((name, None, None))
            k += 1
            continue
        for j in range(1, len(a)):
            name = _SYSRUN_SHORT.get(a[j])
            if name is None:
                reasons.add("other")
                continue
            if _SYSRUN_LONG[name]:
                val, holder = a[j + 1:], args[k]
                if not val:
                    k += 1
                    holder = args[k] if k < len(args) else None
                    val = "" if holder is None else str(holder)
                opts.append((name, val, holder))
                break
            opts.append((name, None, None))
        k += 1
    names = {n for n, _, _ in opts}
    if names & {"help", "version"}:
        return set(), []  # it prints and exits at that option; nothing runs
    if "scope" not in names:
        reasons.add("scope")
    if "user" not in names or "system" in names:
        reasons.add("system")
    if names & _SYSRUN_PLACE:
        reasons.add("place")
    if names & _SYSRUN_NAMED:
        reasons.add("named")
    if names - _SYSRUN_FORM - _SYSRUN_PLACE - _SYSRUN_NAMED - {"system"}:
        reasons.add("other")
    for name, val, holder in opts:
        split = val is not None and rule1.OPAQUE in val and _may_split(holder, src)
        if name == "property":
            key, eq, _ = str(val).partition("=")
            if rule1.OPAQUE in key:
                reasons.add("unseen")
                continue
            if split:
                reasons.add("unseen")
            if not eq or key not in SYSRUN_MEMORY:
                reasons.add("property")
        elif name == "setenv" and split:
            reasons.add("unseen")
    return reasons, list(args[k:])

# Mode, owner and ACL commands: the own-area exception applies.
MODE = frozenset({"chmod", "chown", "chgrp", "setfacl", "chattr", "chacl"})
_MODE_VALUE = {
    "chmod": frozenset(),
    "chown": frozenset(),
    "chgrp": frozenset(),
    "setfacl": frozenset({"-m", "-M", "-x", "-X"}),
    "chattr": frozenset({"-v", "-p"}),
    "chacl": frozenset(),
    "install": frozenset({"-m", "--mode", "-o", "--owner", "-g", "--group", "-t", "--target-directory",
                          "-S", "--suffix", "-Z"}),
    "mkdir": frozenset({"-m", "--mode", "-Z"}),
}
_CHMOD_MODE = re.compile(r"[0-7]{1,4}|(?:[ugoa]*(?:[-+=][rwxXstugo]*)+)(?:,[ugoa]*(?:[-+=][rwxXstugo]*)+)*")
_CHATTR_MODE = re.compile(r"[-+=][A-Za-z]+")

# Commands that write, copy, move or delete files: their operands are checked
# against the protected and gated paths.
WRITERS = frozenset({"tee", "truncate", "touch", "dd", "cp", "mv", "install", "ln", "rsync", "scp",
                     "curl", "wget", "sed", "gsed", "perl", "rm", "rmdir", "unlink", "shred", "mkdir",
                     "chmod", "chown", "chgrp", "setfacl", "chattr", "chacl", "patch", "unzip", "tar"})
_COPIERS = frozenset({"cp", "mv", "install", "ln", "rsync", "scp"})
_WRITER_VALUE = {
    "cp": frozenset({"-t", "--target-directory", "-S", "--suffix"}),
    "mv": frozenset({"-t", "--target-directory", "-S", "--suffix"}),
    "ln": frozenset({"-t", "--target-directory", "-S", "--suffix"}),
    "install": _MODE_VALUE["install"],
    "rsync": frozenset({"-e", "--rsh", "-f", "--filter", "--exclude", "--include", "-T", "--temp-dir",
                        "--exclude-from", "--include-from", "--files-from", "--log-file", "--partial-dir",
                        "--backup-dir", "--suffix", "--compare-dest", "--copy-dest", "--link-dest",
                        "--rsync-path", "--password-file", "--port", "-B", "--block-size", "--timeout",
                        "--bwlimit", "--max-size", "--min-size", "--chmod", "--chown", "--usermap",
                        "--groupmap", "--info", "--debug", "--out-format", "-M", "--remote-option"}),
    "scp": frozenset({"-c", "-F", "-i", "-J", "-l", "-o", "-P", "-S"}),
    "tee": frozenset(),
    "truncate": frozenset({"-s", "--size", "-r", "--reference"}),
    "touch": frozenset({"-d", "--date", "-t", "-r", "--reference"}),
    "curl": frozenset({"-H", "--header", "-d", "--data", "-X", "--request", "-u", "--user", "-A",
                       "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar",
                       "-F", "--form", "-m", "--max-time", "--connect-timeout", "-w", "--write-out",
                       "-x", "--proxy", "--retry", "-K", "--config", "-r", "--range", "-T",
                       "--upload-file", "--data-binary", "--data-raw", "--data-urlencode", "-o", "--output"}),
    "wget": frozenset({"-a", "--append-output", "-o", "--output-file", "-e", "--execute", "-t",
                       "--tries", "-T", "--timeout", "-U", "--user-agent", "--header", "-i",
                       "--input-file", "-P", "--directory-prefix", "-O", "--output-document"}),
    "sed": frozenset({"-e", "--expression", "-f", "--file", "-l", "--line-length"}),
    "gsed": frozenset({"-e", "--expression", "-f", "--file", "-l", "--line-length"}),
    "perl": frozenset({"-e", "-E", "-I", "-M", "-m"}),
    "mkdir": _MODE_VALUE["mkdir"],
    "tar": frozenset({"-f", "--file", "-T", "--files-from", "-X", "--exclude-from", "-C", "--directory"}),
    "unzip": frozenset({"-x", "-P", "-d"}),
    "patch": frozenset({"-p", "-F", "--fuzz", "-B", "--prefix", "-D", "--ifdef", "-r",
                        "--reject-file", "-z", "--suffix", "-V", "-i", "--input"}),
}
# options whose value is a DESTINATION
_DEST_OPTIONS = frozenset({"-t", "--target-directory", "-o", "--output", "-O", "--output-document",
                           "-C", "--directory", "-d", "-P", "--directory-prefix"})
_DEST_OPTION_CMDS = {
    "-t": frozenset({"cp", "mv", "ln", "install"}), "--target-directory": frozenset({"cp", "mv", "ln", "install"}),
    "-o": frozenset({"curl"}), "--output": frozenset({"curl"}),
    "-O": frozenset({"wget"}), "--output-document": frozenset({"wget"}),
    "-C": frozenset({"tar"}), "--directory": frozenset({"tar"}),
    "-d": frozenset({"unzip"}), "-P": frozenset({"wget"}), "--directory-prefix": frozenset({"wget"}),
}

# Inline code that names an access change.
CODE_WORDS = re.compile(
    r"(?<![A-Za-z0-9_-])(?:l?chmod|l?chown|fchmod|fchown|lchmod|chflags|lchflags|chgrp|setfacl|chattr|"
    r"usermod|useradd|groupadd|gpasswd|visudo|sudoers|sudo|pkexec|polkit|iptables|ip6tables|nft|ufw|"
    r"firewall-cmd|set-property|setcap|authorized_keys|ssh-keygen|ssh-copy-id)(?:Sync)?(?![A-Za-z0-9_-])")
# Inline code that names a protected path (any use: a write is not told
# apart from a read; when in doubt, block).
CODE_PATHS = re.compile(
    r"\.ssh(?![A-Za-z0-9_-])|authorized_keys|sudoers|polkit|/etc/(?:passwd|group|shadow|gshadow|subuid|subgid|"
    r"security|pam\.d|login\.defs|ufw|nftables|iptables|firewalld)|\.synaps-cli/(?:sandbox|memory/jev|"
    r"plugins/jev/config)|sandbox-mode|/systemd/")


def _code_hit(code: str) -> str | None:
    if CODE_WORDS.search(code):
        return "inline code names an access change"
    if CODE_PATHS.search(code):
        return "inline code names a protected path"
    return None


def _umask_opens(mode: str) -> bool:
    """A umask that leaves group or other write on for new files (numeric
    without both 0o020 and 0o002, or a symbolic one granting w)."""
    if rule1.OPAQUE in mode:
        return True
    if re.fullmatch(r"[0-7]{1,4}", mode):
        return int(mode, 8) & 0o022 != 0o022
    return "w" in mode


_INLINE = {"perl": frozenset({"-e", "-E"}), "node": frozenset({"-e", "--eval", "-p", "--print"}),
           "nodejs": frozenset({"-e", "--eval", "-p", "--print"}), "ruby": frozenset({"-e"})}

# Raw words that make a call the scan could not finish a block (fail closed
# where it matters, open where nothing access-related appears).
RAW_WORDS = re.compile(
    r"(?<![A-Za-z0-9_.-])(?:chmod|chown|chgrp|setfacl|chattr|chacl|usermod|useradd|userdel|groupadd|"
    r"groupdel|groupmod|gpasswd|newgrp|visudo|sudoers|sudo|doas|pkexec|polkit|ufw|nft|iptables|"
    r"ip6tables|firewall-cmd|set-property|setcap|authorized_keys|ssh-keygen|ssh-copy-id|ssh-add|umask|"
    r"systemd-run)"
    r"(?![A-Za-z0-9_-])|\.ssh/|/systemd/|\.synaps-cli/sandbox")

# Gated keys.
SYSTEMD_KEYS = re.compile(
    r"(?:(?<![A-Za-z])|(?<=\\[nt]))(?:Slice|Memory[A-Za-z]*|CPU[A-Za-z]*|IO[A-Za-z]*|TasksMax|UMask|User|Group|"
    r"DynamicUser|SupplementaryGroups|ReadWritePaths|ReadOnlyPaths|InaccessiblePaths|ProtectHome|"
    r"ProtectSystem|PrivateTmp|NoNewPrivileges|CapabilityBoundingSet|AmbientCapabilities|Delegate)"
    r"\s*=")
# (a key right after a printf/echo -e escape such as `\n` counts too)
UMASK_KEY = re.compile(r"(?i)(?:(?<![A-Za-z0-9_])|(?<=\\[nt]))umask(?![A-Za-z0-9_])")
SYNAPS_CONFIG_KEYS = re.compile(r"(?i)umask|sandbox|landlock")
GATE_READ_MAX = 256 * 1024


class AccessHit(NamedTuple):
    kind: str      # command | write | code
    token: str     # a fixed command name or path class
    line: int      # 1-based line of the (outer) command
    descent: bool  # in a nested script or a remote command
    why: str       # a fixed reason


class AccessLimit(ValueError):
    """The scan stopped at a shape limit (its message is a fixed text)."""


class _Enough(Exception):
    pass


class Context:
    """Where paths resolve: the session cwd (None when the host sent none),
    HOME, and the file-system reads the scan may make (realpath, glob, a
    bounded read of a copy's source). Injected for tests."""

    def __init__(self, cwd: str | None, home: str | None = None, *,
                 realpath: Callable[[str], str] = os.path.realpath,
                 globber: Callable[[str], list] = _glob.glob,
                 reader: Callable[[str], str | None] | None = None,
                 exists: Callable[[str], bool] | None = None,
                 isdir: Callable[[str], bool] | None = None,
                 perm: Callable[[str], int | None] | None = None,
                 sandbox_mode: str = "manual") -> None:
        self.cwd = cwd if isinstance(cwd, str) and os.path.isabs(cwd) else None
        home = os.environ.get("HOME") if home is None else home
        self.home = home if isinstance(home, str) and os.path.isabs(home) and home != "/" else None
        self.realpath = realpath
        self.globber = globber
        self.reader = reader or _read_head
        self.exists = exists or os.path.lexists
        self.perm = perm or _perm_bits
        self.isdir = isdir or os.path.isdir
        self.sandbox_mode = sandbox_mode if sandbox_mode in ("manual", "auto") else "manual"
        self.text = ""
        try:
            self.cwd_real = realpath(self.cwd) if self.cwd else None
            self.home_real = realpath(self.home) if self.home else None
        except (OSError, ValueError):
            self.cwd_real = self.home_real = None


def _perm_bits(path: str) -> int | None:
    """A path's permission bits (not following a symlink), None when there
    is nothing there, -1 when it cannot be read (never equal to a mode)."""
    try:
        return os.lstat(path).st_mode & 0o7777
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        return -1


def _read_head(path: str) -> str | None:
    try:
        with open(path, "rb") as f:
            return f.read(GATE_READ_MAX).decode("utf-8", "replace")
    except (OSError, ValueError):
        return None


# ── paths ─────────────────────────────────────────────────────────────────────

def _under(path: str, base: str) -> bool:
    return path == base or path.startswith(base.rstrip("/") + "/")


def _strictly_under(path: str, base: str) -> bool:
    return path != base and path.startswith(base.rstrip("/") + "/")


def _protected_tables(home: str | None):
    always = [("/etc/ssh", "ssh config"), ("/etc/sudoers", "sudoers"), ("/etc/sudoers.d", "sudoers"),
              ("/etc/sudo.conf", "sudoers"), ("/etc/doas.conf", "sudoers"),
              ("/etc/polkit-1", "polkit"), ("/usr/share/polkit-1", "polkit"), ("/var/lib/polkit-1", "polkit"),
              ("/etc/passwd", "users and groups"), ("/etc/group", "users and groups"),
              ("/etc/shadow", "users and groups"), ("/etc/gshadow", "users and groups"),
              ("/etc/subuid", "users and groups"), ("/etc/subgid", "users and groups"),
              ("/etc/security", "pam and limits"), ("/etc/pam.d", "pam and limits"),
              ("/etc/login.defs", "pam and limits"),
              ("/etc/ufw", "firewall config"), ("/etc/default/ufw", "firewall config"),
              ("/etc/nftables.conf", "firewall config"), ("/etc/iptables", "firewall config"),
              ("/etc/firewalld", "firewall config")]
    systemd = ["/etc/systemd", "/usr/lib/systemd", "/lib/systemd", "/run/systemd"]
    umask = ["/etc/profile", "/etc/profile.d", "/etc/bash.bashrc", "/etc/zsh", "/etc/environment"]
    synaps = []
    if home:
        always += [(os.path.join(home, ".ssh"), "~/.ssh"),
                   (os.path.join(home, ".synaps-cli", "plugins", "jev", "config"), "the jev guard's config"),
                   (os.path.join(home, ".synaps-cli", "memory", "jev"), "the jev guard's state and switch")]
        systemd += [os.path.join(home, ".config", "systemd"), os.path.join(home, ".local", "share", "systemd")]
        umask += [os.path.join(home, n) for n in (".bashrc", ".bash_profile", ".bash_login", ".profile",
                                                  ".zshrc", ".zprofile", ".zshenv", ".zlogin",
                                                  ".pam_environment", os.path.join(".config", "environment.d"))]
        synaps = [os.path.join(home, ".synaps-cli", "config")]
    return always, systemd, umask, synaps


def sandbox_dir(home: str) -> str:
    return os.path.join(home, ".synaps-cli", "sandbox")


def switch_path(home: str) -> str:
    """Owner rule 27b's switch: one word, manual or auto (module doc)."""
    return os.path.join(home, ".synaps-cli", "memory", "jev", "sandbox-mode")


def read_sandbox_mode(home: str | None) -> str:
    """auto only when the switch file holds exactly `auto` (whitespace
    ignored); missing, unreadable, too long or anything else is manual."""
    if not home:
        return "manual"
    try:
        with open(switch_path(home), "rb") as f:
            raw = f.read(65)
    except (OSError, ValueError):
        return "manual"
    try:
        word = raw.decode("ascii").strip()
    except UnicodeDecodeError:
        return "manual"
    return "auto" if word == "auto" and len(raw) <= 64 else "manual"


def classify(path: str, ctx: Context) -> tuple[str, str] | None:
    """(class, gate) for a protected or gated absolute path, else None.
    gate: '' (always protected), 'sandbox' (owner rule 27b), 'systemd',
    'umask' or 'synaps'."""
    for home in {ctx.home, ctx.home_real}:
        if home and _under(path, sandbox_dir(home)):
            return "synaps sandbox policy", "sandbox"
        always, systemd, umask, synaps = _protected_tables(home)
        for base, name in always:
            if _under(path, base):
                return name, ""
        for base in systemd:
            if _under(path, base):
                return "systemd unit", "systemd"
        for base in umask:
            if _under(path, base):
                return "shell or service config", "umask"
        for base in synaps:
            if _under(path, base):
                return "synaps config", "synaps"
    return None


def _gate_keys(gate: str):
    return {"systemd": SYSTEMD_KEYS, "umask": UMASK_KEY, "synaps": SYNAPS_CONFIG_KEYS}[gate]


def _gate_why(gate: str) -> str:
    return {"systemd": "sets a unit or slice limit or access key", "umask": "sets a umask",
            "synaps": "sets a umask or sandbox key"}[gate]


def _expand(raw: str, ctx: Context) -> str | None:
    """A literal path made absolute (~ and ~/ expanded, a relative path
    joined to the cwd), or None when it cannot be known. NOT normalised:
    `link/..` must go through realpath, which resolves the link first;
    the lexical form is _lex(path)."""
    if not raw or "\x00" in raw or rule1.OPAQUE in raw:
        return None
    if raw == "~" or raw.startswith("~/"):
        if not ctx.home:
            return None
        raw = ctx.home + raw[1:]
    elif raw.startswith("~"):
        return None  # ~user
    if not raw.startswith("/"):
        if not ctx.cwd:
            return None
        raw = os.path.join(ctx.cwd, raw)
    return raw


def _lex(path: str) -> str:
    return os.path.normpath(path)


BRACES_MAX = 64


def _braces(s: str) -> list | None:
    """bash brace expansion of comma lists ({a,b}, nested), at most
    BRACES_MAX words; None for a sequence ({1..3}) or past the cap."""
    depth, start = 0, None
    for i, c in enumerate(s):
        if c == "{":
            if depth == 0:
                start = i
            depth += 1
        elif c == "}" and depth:
            depth -= 1
            if depth == 0:
                body = s[start + 1:i]
                parts, d, last = [], 0, 0
                for j, b in enumerate(body):
                    if b == "{":
                        d += 1
                    elif b == "}":
                        d -= 1
                    elif b == "," and d == 0:
                        parts.append(body[last:j])
                        last = j + 1
                if not parts:
                    if ".." in body:
                        return None
                    continue  # a literal {word}
                parts.append(body[last:])
                out = []
                for p in parts:
                    rest = _braces(s[:start] + p + s[i + 1:])
                    if rest is None:
                        return None
                    out.extend(rest)
                    if len(out) > BRACES_MAX:
                        return None
                return out
    return [s]


def _bases(ctx: Context) -> list:
    """(base path, class, gate) for every protected or gated base."""
    out = []
    for home in {ctx.home, ctx.home_real}:
        always, systemd, umask, synaps = _protected_tables(home)
        if home:
            out.append((sandbox_dir(home), "synaps sandbox policy", "sandbox"))
        out += [(b, n, "") for b, n in always]
        out += [(b, "systemd unit", "systemd") for b in systemd]
        out += [(b, "shell or service config", "umask") for b in umask]
        out += [(b, "synaps config", "synaps") for b in synaps]
    return out


def _pattern_hit(path: str, ctx: Context) -> tuple[str, str] | None:
    """A glob pattern that could name a protected or gated path (or a
    directory above one): its existing matches, and each base whose
    components the pattern's components match as far as both go."""
    try:
        for m in ctx.globber(path)[:BRACES_MAX]:
            hit = classify(_lex(m), ctx) or (classify(_real(m, ctx) or "", ctx) if _real(m, ctx) else None)
            if hit is not None:
                return hit
    except (OSError, ValueError, re.error):
        return ("a path pattern", "")
    lex = _lex(path)
    first = _GLOB.search(lex)
    static = lex[:lex.rfind("/", 0, first.start()) + 1] if first else lex
    pattern = [p for p in lex[len(static):].split("/") if p]
    for base, name, gate in _bases(ctx):
        if not _under(base, static.rstrip("/") or "/"):
            continue
        rest = [p for p in base[len(static.rstrip("/")):].split("/") if p]
        n = min(len(rest), len(pattern))
        if all(fnmatch.fnmatchcase(rest[k], pattern[k]) for k in range(n)):
            return (name, gate if len(pattern) >= len(rest) else "")
    return None


def _ancestor_hit(raw: str, ctx: Context, kept: list | None = None) -> tuple[str, str] | None:
    """A path that holds a protected dir, the sandbox or a systemd unit dir
    below it (removing or moving it removes them), as (class, ''). kept:
    rsync --exclude patterns; a base they match (by its path below the
    destination, or its first part there) is left in place."""
    path = _expand(raw, ctx)
    if path is None:
        return None
    for p in {_lex(path), _real(path, ctx) or _lex(path)}:
        for base, name, gate in _bases(ctx):
            if gate in ("", "sandbox", "systemd") and _strictly_under(base, p):
                rel = base[len(p.rstrip("/")) + 1:]
                if kept and any(rule1.OPAQUE not in k and k.strip("/") and (
                        fnmatch.fnmatchcase(rel, k.strip("/")) or fnmatch.fnmatchcase(rel.split("/")[0], k.strip("/")))
                        for k in kept):
                    continue
                return (f"{name} (inside it)", "")
    return None


def _rsync_dry(args: list) -> bool:
    """rsync -n / --dry-run changes nothing."""
    for a in args:
        if a == "--":
            return False
        if a == "--dry-run" or (a.startswith("-") and not a.startswith("--") and "n" in a[1:]):
            return True
    return False


def _real(path: str, ctx: Context) -> str | None:
    try:
        return ctx.realpath(path)
    except (OSError, ValueError):
        return None


def _classify_raw(raw: str, ctx: Context) -> tuple[str, str] | None:
    path = _expand(raw, ctx)
    if path is None:
        return None
    words = _braces(path) if "{" in path else [path]
    if words is None:
        words = [path[:path.find("{")] + "*"]  # a {a..b} sequence: anything from there on
    for p in words:
        hit = classify(_lex(p), ctx)
        if hit is None:
            real = _real(p, ctx)
            hit = classify(real, ctx) if real else None
        if hit is None and _GLOB.search(p):
            hit = _pattern_hit(p, ctx)
        if hit is not None:
            return hit
    return None


def sandbox_decision(raw: str, op: str, ctx: Context) -> str:
    """Owner rule 27b for one path under ~/.synaps-cli/sandbox: 'pass',
    'auto' (passes; audited as access_auto) or 'block'. op: 'create' (the
    write tool, or cp/mv/install onto the path) or 'change' (anything else).
    MANUAL passes only creating a NEW sessions/<name>.conf directly in
    sessions/ (no file at that path now). AUTO passes any create, edit,
    replace or delete strictly below sessions/; a change to a file that
    exists is audited. Outside sessions/ (the OFF switch and the rest) it
    always blocks."""
    path = _expand(raw, ctx)
    if path is None or _GLOB.search(path) or "{" in path:
        return "block"
    real = _real(path, ctx)
    abs_path, path = path, _lex(path)
    homes = [h for h in {ctx.home, ctx.home_real} if h]

    def child(p: str | None, direct: bool) -> bool:
        if p is None:
            return False
        for h in homes:
            sessions = os.path.join(sandbox_dir(h), "sessions")
            if direct and os.path.dirname(p) == sessions:
                return True
            if not direct and _strictly_under(p, sessions):
                return True
        return False

    exists = ctx.exists(abs_path)
    if ctx.sandbox_mode == "auto":
        if child(path, False) and (real is None or child(real, False)):
            return "auto" if exists else "pass"
        return "block"
    if op != "create" or exists:
        return "block"
    if not (child(path, True) and (real is None or real == path or child(real, True))):
        return "block"
    name = os.path.basename(path)
    if not name.endswith(".conf") or name == ".conf" or name.startswith("."):
        return "block"
    return "pass"


_GLOB = re.compile(r"[*?\[]")


def _own(raw: str, ctx: Context) -> bool:
    """Is this literal target inside the session's own area (module doc)?"""
    path = _expand(raw, ctx)
    if path is None or "{}" in raw:
        return False
    targets = [path]
    if _GLOB.search(path):
        try:
            matched = ctx.globber(path)
        except (OSError, ValueError, re.error):
            return False
        targets = matched or [path]
    for t in targets:
        real = _real(t, ctx)
        if real is None or classify(real, ctx) is not None or classify(os.path.normpath(t), ctx) is not None:
            return False
        if not _own_real(real, ctx):
            return False
    return True


# the reasons a mode command blocks that the own-area exception could have
# covered (the guard then says how to name such files)
OWN_AREA_WHYS = frozenset({"changes access outside the session's own worktree or scratch",
                           "changes access on a target that is not a literal path",
                           "changes access on targets the scan cannot see"})
SCRATCH_ROOTS = ("/var/tmp", "/tmp")  # scratch is strictly below <root>/<dir>/


def _own_real(real: str, ctx: Context) -> bool:
    for tmp in SCRATCH_ROOTS:
        if _strictly_under(real, tmp):
            rest = real[len(tmp) + 1:].split("/")
            if rest[0] in ("", ".", ".."):
                continue
            # below a lane dir, or a file (never a directory) right in the root
            if len(rest) >= 2 or not ctx.isdir(real):
                return True
    cwd, home = ctx.cwd_real, ctx.home_real
    if home and _strictly_under(real, home):
        # owner rule 16a's project scratch (<project>/tmp/<dir>/...) and a
        # worktree (.../.worktrees/<name>/...): strictly below their <dir>
        parts = real[len(home.rstrip("/")) + 1:].split("/")
        for i, p in enumerate(parts):
            if ((p == "tmp" and i >= 2) or (p == ".worktrees" and i >= 1)) and len(parts) - i >= 3:
                return True
    if cwd and home and _strictly_under(cwd, home):
        depth = len(cwd[len(home.rstrip("/")) + 1:].split("/"))
        if depth >= 3 and _strictly_under(real, cwd):
            return True
    return False


# ── one simple command (the rule-1 parser's callback) ────────────────────────

def _basename(v: str) -> str:
    return v.rsplit("/", 1)[-1]


def _value(word, parser) -> str:
    """A word as a path: its dequoted value, or, when it expands $HOME /
    ${HOME} only, its source with HOME put in. Anything else unknown keeps
    rule1.OPAQUE (never a literal path)."""
    text = str(word)
    if rule1.OPAQUE not in text:
        return text
    start, end = getattr(word, "start", None), getattr(word, "end", None)
    if start is None or end is None or end <= start:
        return text
    raw = parser.s[start:end].replace('"', "").replace("'", "")
    raw = raw.replace("${HOME}", "\x01").replace("$HOME", "\x01")
    if "$" in raw or "`" in raw or "\\" in raw:
        return text
    home = parser.scan.on_command.ctx.home
    return raw.replace("\x01", home) if home else text


def _unwrap(argv: list, src: str | None = None) -> tuple[list, list, bool, list, list]:
    """(command argv, wrapper names, via xargs, systemd-run reasons, the
    words each systemd-run runs) as rule1._unwrap, keeping the wrapper
    names (sudo and doas are refused themselves). systemd-run is unwrapped
    here only, not among rule1's wrappers (the rule-1 scan is unchanged):
    its options give the reasons it asks (_sysrun_split, one set per
    systemd-run; `src` as there), the command it runs is scanned like any
    other, and the scripts that command runs are read as under a rule-1
    wrapper (_Visitor._descend_runs)."""
    names, via, runs, inners = [], False, [], []
    for _ in range(16):
        if not argv:
            break
        name = _basename(argv[0])
        if name == "systemd-run":
            reasons, argv = _sysrun_split(argv[1:], src)
            names.append(name)
            runs.append(reasons)
            inners.append(argv)
            continue
        spec = rule1.WRAPPERS.get(name)
        if spec is None:
            break
        names.append(name)
        via = via or name == "xargs"
        argv = rule1._skip_wrapper(name, argv[1:], spec, [])
    if argv and _basename(argv[0]) in ("busybox", "toybox") and len(argv) > 1:
        argv = argv[1:]
    return argv, names, via, runs, inners


def _commands(words: list, src: str | None = None) -> list:
    """(argv, wrappers, via_xargs, from_find, systemd-run reasons, the words
    each systemd-run runs) for each command a simple command runs: the main
    one, and find's -exec commands. `src`: the text the words were read
    from (_sysrun_split)."""
    k = 0
    while k < len(words) and rule1.ASSIGN.match(words[k]):
        k += 1
    out = []
    argv, names, via, runs, inners = _unwrap(words[k:], src)
    out.append((argv, names, via, False, runs, inners))
    if argv and _basename(argv[0]) == "find":
        j = 1
        while j < len(argv):
            if argv[j] in rule1.FIND_EXEC:
                e = j + 1
                sub = []
                while e < len(argv) and argv[e] not in (";", "+"):
                    sub.append(argv[e])
                    e += 1
                sub, sub_names, sub_via, sub_runs, sub_inners = _unwrap(sub, src)
                out.append((sub, sub_names, sub_via, True, sub_runs, sub_inners))
                j = e
            j += 1
    return out


def _operands(name: str, args: list, values: frozenset) -> tuple[list, list]:
    """(operands, (option, value) pairs) of a command's arguments: words not
    starting with '-' (all after '--'), option values skipped and kept."""
    ops, pairs = [], []
    k, done = 0, False
    while k < len(args):
        a = args[k]
        if done or not a.startswith("-") or a == "-":
            ops.append(a)
            k += 1
            continue
        if a == "--":
            done = True
            k += 1
            continue
        if a.startswith("--") and "=" in a:
            opt, val = a.split("=", 1)
            pairs.append((opt, val))
            k += 1
            continue
        if a in values and k + 1 < len(args):
            pairs.append((a, args[k + 1]))
            k += 2
            continue
        # a short-option cluster ending in a value option (-m755, -tDIR)
        if not a.startswith("--") and len(a) > 2 and a[:2] in values:
            pairs.append((a[:2], a[2:]))
        k += 1
    return ops, pairs


class _Visitor:
    """rule1._Scan.on_command: called with each simple command."""

    def __init__(self, ctx: Context, found: list) -> None:
        self.ctx = ctx
        self.found = found

    def hit(self, parser, kind: str, token: str, offset: int, why: str) -> None:
        h = AccessHit(kind, token, parser.line_at(offset), parser.descent > 0, why)
        if h not in self.found:
            self.found.append(h)
            if len(self.found) >= ACCESS_MAX:
                raise _Enough()

    def __call__(self, parser, cmd) -> None:
        nested = parser.descent > 0
        remote = getattr(parser, "remote", False)
        at0 = cmd.start or 0
        # redirects: the command's output written into a path
        for op, fd, target, at in cmd.redirs:
            if op in rule1.INPUT_OPS and op not in ("<>",):
                continue
            if op in (">&", "<&") and (str(target).isdigit() or target == "-"):
                continue
            self._dest(parser, _value(target, parser), at, None, op)
        if not cmd.words:
            return
        self._cd(parser, cmd)
        for argv, wrappers, via, from_find, runs, inners in _commands(cmd.words, parser.s):
            head_word = cmd.words[0]
            at = getattr(head_word, "start", at0)
            for w in wrappers:
                if w in ALWAYS:
                    self.hit(parser, "command", w, at, ALWAYS[w])
            for reasons in runs:
                why = next((text for key, text in _SYSRUN_WHY.items() if key in reasons), None)
                if why is not None:
                    self.hit(parser, "command", "systemd-run", at, why)
            self._descend_runs(parser, inners, at)
            if not argv:
                continue
            head = argv[0]
            if rule1.OPAQUE in head:
                continue
            at = getattr(head, "start", at)
            name = _basename(head)
            args = argv[1:]
            if name in ALWAYS:
                if _read_only(name, args):
                    continue
                self.hit(parser, "command", name, at, ALWAYS[name])
                continue
            if name == "systemctl":
                ops, _ = _operands(name, args, _SYSTEMCTL_VALUE)
                if ops and ops[0] in _SYSTEMCTL_ACCESS:
                    self.hit(parser, "command", f"systemctl {ops[0]}", at, "changes unit or slice limits")
                continue
            if name == "umask":
                ops = [a for a in args if not a.startswith("-")]
                if ops and _umask_opens(ops[0]):
                    self.hit(parser, "command", "umask", at, "sets a umask that lets group or others write new files")
                continue
            if rule1.PY.fullmatch(name):
                mode, code = rule1._py_mode(args)
                if mode == "c" and code is not None and _code_hit(str(code)):
                    self.hit(parser, "code", "python -c", at, _code_hit(str(code)))
                continue
            if name in _INLINE:
                for k, a in enumerate(args):
                    if a in _INLINE[name] and k + 1 < len(args) and _code_hit(str(args[k + 1])):
                        self.hit(parser, "code", f"{name} -e", at, _code_hit(str(args[k + 1])))
                        break
                if name != "perl":
                    continue
            self._mode(parser, name, args, at, nested, remote, via, from_find)
            if name in WRITERS:
                self._writer(parser, name, args, at)

    def _descend_runs(self, parser, inners, at) -> None:
        """Read the scripts a systemd-run's command runs as rule 1's parser
        reads them after a wrapper (rule1._Parser.finish): the strings of
        the wrappers inside it (env -S, flock -c, watch), a shell's -c
        string, ssh's remote command, eval's arguments and su/runuser/script
        -c, each as a nested script (a descent). rule1 itself never unwraps
        systemd-run, so scan_rule1 is unchanged; the parity with a rule-1
        wrapper is pinned by the tests."""
        for inner in inners:
            strings: list = []
            resolved = rule1._resolve(inner, strings)
            for text in strings:
                parser.descend(text, at)
            for argv, _via, _main in resolved:
                head = argv[0]
                if rule1.OPAQUE in head:
                    continue
                name, args = _basename(head), argv[1:]
                where = getattr(head, "start", at)
                if name in rule1.SHELLS:
                    mode, k = rule1._sh_mode(args)
                    if mode == "c" and k < len(args):
                        parser.descend(args[k], where)
                elif name == "ssh":
                    k = 0
                    while k < len(args) and args[k].startswith("-") and len(args[k]) > 1:
                        a = args[k]
                        k += 2 if (len(a) == 2 and a[-1] in rule1.SSH_ARG) else 1
                    if k + 1 < len(args):
                        parser.descend(" ".join(args[k + 1:]), where, remote=True)
                elif name == "eval" and args:
                    parser.descend(" ".join(args), where)
                elif name in ("su", "runuser", "script"):
                    text = rule1._command_string(args)
                    if text:
                        parser.descend(text, where)

    # mode, owner and ACL changes
    def _mode(self, parser, name, args, at, nested, remote, via, from_find) -> None:
        values = _MODE_VALUE.get(name)
        if name in MODE:
            pass
        elif name in ("install", "mkdir"):
            _, pairs = _operands(name, args, values)
            letters = "mog" if name == "install" else "m"
            clustered = any(a.startswith("-") and not a.startswith("--") and any(c in a[1:] for c in letters)
                            for a in args if a != "--")
            if not clustered and not any(opt in ("-m", "--mode", "-o", "--owner", "-g", "--group")
                                         for opt, _ in pairs):
                return
            if self._no_change(parser, name, args):
                return
        elif name == "rsync":
            _, pairs = _operands(name, args, _WRITER_VALUE["rsync"])
            if not any(opt in ("--chmod", "--chown", "--usermap", "--groupmap") for opt, _ in pairs):
                return
            values = _WRITER_VALUE["rsync"]
        else:
            return
        ops, pairs = _operands(name, args, values)
        token = name if name in MODE else f"{name} {'--chmod/--chown' if name == 'rsync' else '-m/-o/-g'}"
        if name == "chmod":
            if ops and not any(opt == "--reference" for opt, _ in pairs):
                if _CHMOD_MODE.fullmatch(ops[0]):
                    ops = ops[1:]
            # a mode such as -w or -x reads as an option: it is never a target
        elif name in ("chown", "chgrp"):
            if ops and not any(opt == "--reference" for opt, _ in pairs):
                ops = ops[1:]
        elif name == "chattr":
            ops = [o for o in ops if not _CHATTR_MODE.fullmatch(o)]
        elif name == "chacl":
            ops = ops[1:] if ops and not any(a in ("-b", "-d", "-R", "-D", "-B", "-l") for a in args) else ops
        elif name == "rsync":
            ops = ops[-1:]  # the destination
        elif name == "install":
            dest = [v for opt, v in pairs if opt in ("-t", "--target-directory")]
            ops = dest or (ops if "-d" in args or "--directory" in args else ops[-1:])
        if remote:
            self.hit(parser, "command", token, at, "changes access on a remote host")
            return
        if nested:
            self.hit(parser, "command", token, at, "changes access inside a nested script")
            return
        if via or from_find:
            self.hit(parser, "command", token, at,
                     "changes access on targets that xargs or find adds at run time")
            return
        if name == "setfacl" and (any(opt == "--restore" for opt, _ in pairs) or "--restore" in args):
            self.hit(parser, "command", token, at, "changes access on targets named in a file")
            return
        if any(a in ("-L", "-H") for a in args) and name in ("chmod", "chown", "chgrp", "setfacl"):
            self.hit(parser, "command", token, at, "changes access through followed symlinks")
            return
        if not ops:
            self.hit(parser, "command", token, at, "changes access on targets the scan cannot see")
            return
        for raw in ops:
            value = _value(raw, parser)
            if rule1.OPAQUE in value or not _own(value, self.ctx):
                why = ("changes access on a target that is not a literal path" if rule1.OPAQUE in value
                       else "changes access outside the session's own worktree or scratch")
                self.hit(parser, "command", token, at, why)
                return

    def _no_change(self, parser, name, args) -> bool:
        """mkdir -m / install -m that changes no existing access: a numeric
        mode with no group or other write and no special bit, no owner or
        group, and for install each target new or already at that mode
        (mkdir -m never changes a directory that exists)."""
        letters = {"m": "mode", "t": "tdir", "S": None, "Z": None} if name == "install" else {"m": "mode", "Z": None}
        got = {"mode": None, "tdir": None}
        ops, dflag, k = [], False, 0
        while k < len(args):
            a = args[k]
            if a == "--":
                ops += args[k + 1:]
                break
            if a.startswith("--"):
                opt, eq, val = a.partition("=")
                if opt in ("--owner", "--group", "--preserve-context"):
                    return False
                if opt == "--directory":
                    dflag = True
                elif opt in ("--mode", "--target-directory", "--suffix", "--context"):
                    if not eq:
                        k += 1
                        val = args[k] if k < len(args) else ""
                    if opt == "--mode":
                        got["mode"] = val
                    elif opt == "--target-directory":
                        got["tdir"] = val
            elif a.startswith("-") and a != "-":
                for j, c in enumerate(a[1:], 1):
                    if name == "install" and c in "og":
                        return False
                    if name == "install" and c == "d":
                        dflag = True
                    if c in letters:
                        val = a[j + 1:]
                        if not val:
                            k += 1
                            val = args[k] if k < len(args) else ""
                        if letters[c]:
                            got[letters[c]] = val
                        break
            else:
                ops.append(a)
            k += 1
        mode = got["mode"]
        if mode is None or rule1.OPAQUE in str(mode) or not re.fullmatch(r"[0-7]{1,4}", str(mode)) \
                or int(str(mode), 8) & 0o7022:
            return False
        if name == "mkdir":
            return True
        vals = [_value(o, parser) for o in ops]
        tdir = got["tdir"]
        if any(rule1.OPAQUE in v for v in vals) or (tdir is not None and rule1.OPAQUE in _value(tdir, parser)):
            return False
        if dflag:
            targets = vals
        elif tdir is not None:
            targets = [os.path.join(_value(tdir, parser), os.path.basename(v.rstrip("/"))) for v in vals]
        elif len(vals) >= 2:
            dest = _expand(vals[-1], self.ctx)
            if dest is not None and self.ctx.isdir(dest):
                targets = [os.path.join(dest, os.path.basename(v.rstrip("/"))) for v in vals[:-1]]
            elif len(vals) == 2:
                targets = [vals[-1]]
            else:
                return False
        else:
            return False
        for t in targets:
            path = _expand(t, self.ctx)
            if path is None or _GLOB.search(path):
                return False
            bits = self.ctx.perm(path)
            if bits is not None and bits != int(str(mode), 8):
                return False
        return bool(targets)

    def _cd(self, parser, cmd) -> None:
        """Follow `cd`/`pushd` to a literal directory that exists, at the top
        level only, so later relative targets resolve where they will run.
        Anything else that moves the shell (popd, cd in a subshell, a nested
        script, a pipeline or to a path not known now) makes relative
        targets unknown for the rest of the text (they then block)."""
        words = list(cmd.words)
        k = 0
        while k < len(words) and rule1.ASSIGN.match(words[k]):
            k += 1
        argv = words[k:]
        while argv and argv[0] in ("builtin", "command"):
            argv = argv[1:]
        if not argv or argv[0] not in ("cd", "pushd", "popd", "chdir"):
            return
        top = parser.descent == 0 and parser.scan.depth == 1 and not cmd.pipe_in
        args = [a for a in argv[1:] if a == "-" or not a.startswith("-")]
        target = None
        if top and argv[0] in ("cd", "pushd") and len(args) <= 1:
            raw = _value(args[0], parser) if args else "~"
            if raw != "-" and rule1.OPAQUE not in raw:
                path = _expand(raw, self.ctx)
                real = _real(path, self.ctx) if path else None
                if real and self.ctx.isdir(real):
                    target = real
        self.ctx.cwd = target

    # writes into protected and gated paths
    def _writer(self, parser, name, args, at) -> None:
        if name in ("sed", "gsed") and rule1._sed_in_place(args) is None:
            return  # sed without -i only reads its files
        if name == "perl" and not rule1._perl_in_place(args):
            return
        values = _WRITER_VALUE.get(name, frozenset())
        ops, pairs = _operands(name, args, values)
        dests = [v for opt, v in pairs if opt in _DEST_OPTIONS and name in _DEST_OPTION_CMDS.get(opt, ())]
        if name == "dd":
            dests += [o[3:] for o in ops if o.startswith("of=")]
            ops = [o[3:] for o in ops if o.startswith("if=")]
            sources = ops
        elif name in _COPIERS:
            if dests:
                sources = ops
            elif name == "install" and ("-d" in args or "--directory" in args):
                dests, sources = ops, []
            else:
                dests, sources = ops[-1:], ops[:-1]
        elif name == "curl" or name == "wget":
            sources = []
        else:
            dests, sources = dests + ops, []
        # removing or moving a directory that holds a protected dir, the
        # sandbox or a unit dir (rm -rf ~/.synaps-cli/sandbox/../)
        destructive = []
        if name in ("rm", "rmdir", "unlink", "shred"):
            destructive = dests
        elif name == "mv":
            destructive = sources
        elif name == "rsync" and any(a.startswith("--delete") or a == "--remove-source-files" for a in args) \
                and not _rsync_dry(args):
            destructive = dests + (sources if "--remove-source-files" in args else [])
        # rsync leaves what it excludes (unless --delete-excluded)
        kept = [v for opt, v in pairs if opt == "--exclude"] \
            if name == "rsync" and "--delete-excluded" not in args else []
        for raw in destructive:
            value = _value(raw, parser)
            hit = _ancestor_hit(value, self.ctx, kept)
            if hit is None:  # a gated directory itself (rm -rf ~/.config/systemd/user)
                gated = _classify_raw(value, self.ctx)
                path = _expand(value, self.ctx)
                if gated is not None and gated[1] in ("systemd", "umask", "synaps") and path is not None \
                        and self.ctx.isdir(path):
                    hit = gated
            if hit is not None:
                self.hit(parser, "write", hit[0], at, f"`{name}` removes or moves a directory that holds it")
                return
        # a protected path anywhere (a key copied out of ~/.ssh counts too)
        for raw in dests + sources:
            hit = _classify_raw(_value(raw, parser), self.ctx)
            if hit is not None and hit[1] == "":
                self.hit(parser, "write", hit[0], at, f"`{name}` touches a protected path")
                return
        # owner rule 27b: the sandbox dir
        for raw in sources:
            value = _value(raw, parser)
            hit = _classify_raw(value, self.ctx)
            if hit is not None and hit[1] == "sandbox" and name in ("mv", "rsync"):
                if self._sandbox(parser, value, "change", at, name):
                    return
        for raw in dests:
            value = _value(raw, parser)
            hit = _classify_raw(value, self.ctx)
            if hit is None:
                continue
            name_cls, gate = hit
            if gate == "sandbox":
                if name in ("cp", "mv", "install"):
                    targets = self._final_targets(value, [_value(s, parser) for s in sources])
                    if targets is None:
                        self._sandbox(parser, value, "change", at, name)
                        return
                    for t in targets:
                        if self._sandbox(parser, t, "create", at, name):
                            return
                elif self._sandbox(parser, value, "change", at, name):
                    return
                continue
            if self._gated_text(gate, [_value(s, parser) for s in sources]):
                self.hit(parser, "write", name_cls, at, f"`{name}` into it {_gate_why(gate)}")
                return
            if self._replaces_gated(name, args, value, gate, [_value(s, parser) for s in sources]):
                self.hit(parser, "write", name_cls, at, f"`{name}` replaces, edits or removes a file that {_gate_why(gate)}")
                return
        if name == "mv":  # moving a gated file away drops what it sets
            for raw in sources:
                value = _value(raw, parser)
                hit = _classify_raw(value, self.ctx)
                if hit is not None and hit[1] in ("systemd", "umask", "synaps") and self._gated_existing(value, hit[1]):
                    self.hit(parser, "write", hit[0], at, f"`mv` moves away a file that {_gate_why(hit[1])}")
                    return

    def _gated_existing(self, raw: str, gate: str) -> bool:
        """Does the file there now set a gated key (an unreadable file counts)?"""
        path = _expand(raw, self.ctx)
        if path is None:
            return True
        if self.ctx.isdir(path):
            return False
        body = self.ctx.reader(path)
        if body is None:
            return self.ctx.exists(path)
        return bool(_gate_keys(gate).search(body))

    def _replaces_gated(self, name, args, value, gate, sources) -> bool:
        """A write that truncates, replaces, edits in place or removes a gated
        file that sets a key now (appending and touching don't)."""
        if name in ("touch", "mkdir") or name in MODE or (name == "tee" and any(a in ("-a", "--append") for a in args)):
            return False  # (a mode command changes no text; the mode rule checks it)
        targets = [value]
        if name in ("cp", "mv", "install", "ln", "rsync", "scp"):
            final = self._final_targets(value, sources) if sources else None
            targets = final if final is not None else [value]
        return any(self._gated_existing(t, gate) for t in targets)

    def _final_targets(self, dest: str, sources: list) -> list | None:
        """The paths a cp/mv/install writes: dest/<basename> for each source
        when dest is a directory, else dest itself (one source). None when
        that cannot be known."""
        path = _expand(dest, self.ctx)
        if path is None or not sources:
            return None
        if self.ctx.isdir(path):
            out = []
            for s in sources:
                if rule1.OPAQUE in s or not s or _GLOB.search(s):
                    return None
                out.append(os.path.join(path, os.path.basename(s.rstrip("/"))))
            return out
        return [path] if len(sources) == 1 else None

    def _sandbox(self, parser, raw: str, op: str, at: int, name: str) -> bool:
        """Record 27b's answer for one sandbox path; True when it blocks."""
        decision = sandbox_decision(raw, op, self.ctx)
        if decision == "pass":
            return False
        if decision == "auto":
            self.hit(parser, "auto", "synaps sandbox policy", at,
                     f"`{name}` changes a session sandbox file (auto mode)")
            return False
        self.hit(parser, "sandbox", "synaps sandbox policy", at,
                 f"`{name}` {'replaces' if op == 'create' else 'changes'} a sandbox file")
        return True

    def _dest(self, parser, raw: str, at: int, sources, op: str = ">") -> None:
        hit = _classify_raw(raw, self.ctx)
        if hit is None:
            return
        name_cls, gate = hit
        if gate == "sandbox":
            self._sandbox(parser, raw, "change", at, "redirect")
            return
        if gate == "" or self._gated_text(gate, sources or []):
            why = "a redirect writes a protected path" if gate == "" else f"a redirect into it {_gate_why(gate)}"
            self.hit(parser, "write", name_cls, at, why)
        elif op not in (">>", "&>>") and self._gated_existing(raw, gate):
            self.hit(parser, "write", name_cls, at, f"a redirect replaces a file that {_gate_why(gate)}")

    def _gated_text(self, gate: str, sources: list) -> bool:
        """Does the new text set a gated key? The whole call's text (its
        heredoc bodies and quoted strings included), then each copied
        source; a source that cannot be read counts as setting one."""
        keys = _gate_keys(gate)
        if keys.search(self.ctx.text):
            return True
        for raw in sources:
            path = _expand(raw, self.ctx)
            if path is None:
                return True
            body = self.ctx.reader(path)
            if body is None:
                if self.ctx.isdir(path):
                    continue
                return True
            if keys.search(body):
                return True
        return False


def scan_access(text: str, ctx: Context, found: list | None = None) -> list[AccessHit]:
    """The access hits in one shell text (at most ACCESS_MAX). Raises
    AccessLimit past a shape limit; `found` then holds the hits made."""
    found = [] if found is None else found
    if not text:
        return found
    if rule1.OPAQUE in text:
        text = text.replace(rule1.OPAQUE, " ")
    ctx.text = text
    cwd0 = ctx.cwd  # a `cd` in the text moves it (_Visitor._cd) for this text only
    scan = rule1._Scan([], int(len(text) * (1 + rule1.RESCAN_FACTOR)) + rule1.RESCAN_SLACK)
    scan.hits_max = 1 << 60  # rule-1's own hits never stop this scan
    scan.on_command = _Visitor(ctx, found)
    try:
        rule1._Parser(text, scan, 0, None).run()
    except _Enough:
        pass
    except RecursionError:
        raise AccessLimit("code nested too deeply") from None
    except rule1.Rule1Limit as e:  # a fixed text
        raise AccessLimit(str(e)) from None
    finally:
        ctx.cwd = cwd0
    return found


def _key_lines(body: str, gate: str) -> list:
    keys = _gate_keys(gate)
    return [line.strip() for line in body.splitlines() if keys.search(line)]


def _apply_edits(body: str, edits: list) -> str | None:
    """One file's multi_edit edits applied in order to its text now, or None
    when they cannot be followed here (an anchor mode other than exact, an
    anchor not found exactly once without `occurrence`, an unknown op)."""
    for e in edits:
        if not isinstance(e, dict):
            return None
        op, text = e.get("op"), e.get("text") if isinstance(e.get("text"), str) else ""
        skip = e.get("unless_present")
        if isinstance(skip, str) and skip and skip in body:
            continue
        if op == "append":
            body += text
            continue
        if op == "append_jsonl":
            try:
                body += json.dumps(e.get("value"), ensure_ascii=False) + "\n"
            except (TypeError, ValueError):
                return None
            continue
        if op not in ("replace", "insert_before", "insert_after") or e.get("anchor_mode", "exact") != "exact":
            return None
        anchor, nth = e.get("anchor"), e.get("occurrence")
        if not isinstance(anchor, str) or not anchor:
            return None
        if nth is None:
            if body.count(anchor) != 1:
                return None
            nth = 1
        if not isinstance(nth, int) or isinstance(nth, bool) or nth < 1:
            return None
        at = -1
        for _ in range(nth):
            at = body.find(anchor, at + 1)
            if at < 0:
                return None
        end = at + len(anchor)
        if op == "replace":
            body = body[:at] + text + body[end:]
        elif op == "insert_before":
            body = body[:at] + text + body[at:]
        else:
            body = body[:end] + text + body[end:]
    return body


def path_access(raw: str, text: str, ctx: Context, op: str = "change", old: str | None = None,
                tool: str = "write", edits: list | None = None) -> AccessHit | None:
    """A write, edit or multi_edit target: protected, or gated and either
    the new text sets a gated key or the change alters a line of the file
    that sets one now (a value-only edit, a key line dropped). op: 'create'
    for the write tool or a multi_edit create (27b: only a NEW session file
    passes in manual mode), else 'change'. tool: 'write' (text is the whole
    file), 'edit' (old is old_string) or 'multi_edit' (edits are this
    file's edits, in order). A kind 'auto' hit passes (27b auto mode;
    audited)."""
    hit = _classify_raw(raw, ctx)
    if hit is None:
        return None
    name, gate = hit
    if gate == "sandbox":
        decision = sandbox_decision(raw, op, ctx)
        if decision == "pass":
            return None
        if decision == "auto":
            return AccessHit("auto", name, 0, False, "changes a session sandbox file (auto mode)")
        return AccessHit("sandbox", name, 0, False,
                         "replaces a sandbox file" if op == "create" else "changes a sandbox file")
    if gate == "":
        return AccessHit("write", name, 0, False, "writes a protected path")
    if _gate_keys(gate).search(text or ""):
        return AccessHit("write", name, 0, False, f"the new text {_gate_why(gate)}")
    # what the file sets now must not change (an edit of a key's value only,
    # or a write or edit that drops a key line)
    path = _expand(raw, ctx)
    if path is None or ctx.isdir(path):
        return None
    body = ctx.reader(path)
    if body is None:
        if ctx.exists(path):
            return AccessHit("write", name, 0, False, "changes a gated file the scan cannot read")
        return None
    before = _key_lines(body, gate)
    if not before:
        return None
    if tool == "write":
        after = _key_lines(text or "", gate)
    elif tool == "edit" and isinstance(old, str) and old:
        if old not in body:
            return None
        after = _key_lines(body.replace(old, text or "", 1), gate)
    elif tool == "multi_edit" and isinstance(edits, list):
        new = _apply_edits(body, edits)
        after = _key_lines(new, gate) if new is not None else None
    else:  # an edit not followed here: the file sets a key now
        after = None
    if after != before:
        return AccessHit("write", name, 0, False, f"changes a file that {_gate_why(gate)}")
    return None
