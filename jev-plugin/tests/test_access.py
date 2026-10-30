#!/usr/bin/env python3
"""The access rule (and its sandbox switch): access.scan_access /
path_access / sandbox_decision and its wiring (guard.access_check and the
extension's before_tool_call order). Offline; every command is TEXT given
to the scanner, never executed. Paths live in a temporary HOME.

    PYTHONDONTWRITEBYTECODE=1 python3 -B -m unittest discover -s tests -p 'test_access.py' -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))
import jev_test_home  # noqa: F401,E402  (keeps the suite out of the real Allow-once store)
sys.path.insert(0, HERE)

from jev import access, guard, host_profile, rule1  # noqa: E402
from jev import audit as audit_mod  # noqa: E402

CANARY = "CANARY_ac27a"
HEAD = "jev: blocked by the access rule (decided locally, no model call). This changes access."
SANDBOX_NOTE = "(sandbox: this can widen a sandbox; the owner's yes)"


class HomeCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="jev-access-", dir=os.environ.get("TMPDIR") or "/var/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"
        self.shallow = self.home / "workspace"                        # a workspace dir (the profile names it; ignored)
        self.work = self.shallow / "Org" / "repo"                     # depth 3 below HOME: an own-area cwd
        self.scratch = Path(self.tmp.name) / "scratch"                # stands in for /var/tmp/<lane>
        self.sessions = self.home / ".synaps-cli" / "sandbox" / "sessions"
        self.units = self.home / ".config" / "systemd" / "user"
        for d in (self.work / "scripts", self.shallow, self.sessions, self.units, self.home / ".ssh",
                  self.home / ".synaps-cli" / "memory" / "jev", self.scratch):
            d.mkdir(parents=True, exist_ok=True)
        (self.work / "scripts" / "run.sh").write_text("echo hi\n")
        (self.sessions / "old.conf").write_text("mode = enforce\n")
        (self.home / ".bashrc").write_text("# rc\n")
        (Path(self.tmp.name) / "plain.slice").write_text("[Unit]\nDescription=x\n")
        (Path(self.tmp.name) / "limit.slice").write_text("[Slice]\nCPUQuota=50%\n")
        # the temp HOME may itself sit below /var/tmp; only self.scratch_root counts as scratch here
        self.scratch_root = Path(self.tmp.name) / "scratch-root"
        (self.scratch_root / "lane").mkdir(parents=True)
        (self.scratch_root / "lane" / "run.sh").write_text("x")
        patcher = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        # the host profile names a workspace (a fact the guard ignores); the scratch root stands in for the OS temp roots
        self.profile = host_profile.HostProfile(
            {"workspace": {"root": str(self.shallow)}}, home=str(self.home),
            platform=host_profile.Platform(temp_roots=(str(self.scratch_root),)))
        use = host_profile.HostProfile.use(self.profile)
        use.__enter__()
        self.addCleanup(use.__exit__, None, None, None)

    def ctx(self, cwd=None, mode="manual"):
        return access.Context(str(cwd or self.work), str(self.home), sandbox_mode=mode)

    def scan(self, text, cwd=None, mode="manual"):
        return access.scan_access(text, self.ctx(cwd, mode))

    def blocking(self, text, cwd=None, mode="manual"):
        return [h for h in self.scan(text, cwd, mode) if h.kind != "auto"]


class Commands(HomeCase):
    def test_the_incident_blocks(self):
        hits = self.blocking("chmod g-w ~/workspace ~/workspace/example", cwd=self.work)
        self.assertEqual([(h.kind, h.token) for h in hits], [("command", "chmod")])
        self.assertIn("outside the session's own worktree or scratch", hits[0].why)

    def test_always_commands(self):
        for text, token in [("sudo systemctl restart x", "sudo"), ("usermod -aG docker user", "usermod"),
                            ("gpasswd -a user g", "gpasswd"), ("ufw allow 22", "ufw"),
                            ("iptables -A INPUT -j DROP", "iptables"), ("iptables -L -F", "iptables"),
                            ("nft add rule inet f c drop", "nft"), ("nft -f rules.nft", "nft"),
                            ("firewall-cmd --add-port=1/tcp", "firewall-cmd"),
                            ("ssh-keygen -R host", "ssh-keygen"), ("ssh-add -D", "ssh-add"),
                            ("ssh-add ~/.ssh/k", "ssh-add"),
                            ("pkexec ls", "pkexec"), ("visudo", "visudo"), ("ssh-copy-id buildhost", "ssh-copy-id"),
                            ("ssh-keygen -t ed25519 -f k", "ssh-keygen"), ("timeout 5 sudo -n true", "sudo"),
                            ("env A=1 doas ls", "doas"), ("setcap cap_net_raw+ep f", "setcap"),
                            ("systemctl --user set-property app.slice MemoryMax=8G", "systemctl set-property"),
                            ("systemctl edit x.service", "systemctl edit"),
                            ("systemctl --user revert x.service", "systemctl revert")]:
            with self.subTest(text=text):
                tokens = [h.token for h in self.blocking(text)]
                self.assertIn(token, tokens)

    def test_read_only_forms_pass(self):
        for text in ["iptables -L", "iptables -nvL INPUT", "ip6tables -S", "nft list ruleset", "nft -a list table x",
                     "ufw status verbose", "ufw app list", "firewall-cmd --state", "firewall-cmd --zone=x --list-all",
                     "ssh-keygen -lf k.pub", "ssh-keygen -F host", "ssh-keygen -y -f k", "ssh-add -l", "ssh-add -L"]:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [], text)

    def test_new_private_dirs_and_same_mode_installs_pass(self):
        (self.shallow / "bin").mkdir()
        (self.shallow / "bin" / "tool").write_text("x")
        os.chmod(self.shallow / "bin" / "tool", 0o755)  # the test's own temp file
        (self.work / "tool").write_text("y")
        b = self.shallow / "bin"
        for text in ["mkdir -m 700 ~/newdir", "mkdir -pm 700 ~/a/b", "mkdir -p -m 0750 ~/x", "mkdir --mode=755 ~/y",
                     f"install -m 755 tool {b}/tool", f"install -m 0755 tool {b}/", f"install -m 644 tool {b}/new",
                     f"install -Dm600 tool {b}/new2", f"install -m 755 -t {b} tool"]:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [], text)
        for text in ["mkdir -m 777 ~/shared", "mkdir -m 2775 ~/g", "mkdir -m g+w ~/z", "mkdir -m $M ~/z",
                     f"install -m 700 tool {b}/tool", f"install -m 775 tool {b}/new", f"install -o user tool {b}/new",
                     f"install -m 755 -g user tool {b}/new", f"install -m 644 a b {b}/missing-dir",
                     f"install -m 644 tool {b}/*", f"install -d -m 700 {b}"]:
            with self.subTest(text=text):
                self.assertTrue(self.blocking(text), text)

    def test_mode_commands_outside_the_own_area(self):
        for text in ["chown user ~/workspace", "chgrp user /srv/x", "setfacl -m u:x:rw ~/workspace/a",
                     "chattr +i ~/x", "chmod -R 755 /home", "install -o root a /etc/x",
                     "mkdir -m 777 ~/newdir", "mkdir -pm 1777 ~/newdir", "rsync -a --chmod=g-w a/ ~/workspace/",
                     "chmod +x $F", "chmod +x \"$(pwd)/f\"", "chacl u::rwx ~/x", "chmod -w ~/workspace/x"]:
            with self.subTest(text=text):
                self.assertTrue(self.blocking(text), text)

    def test_mode_commands_inside_the_own_area_pass(self):
        for text in ["chmod +x scripts/run.sh", "chmod 600 scripts/run.sh", "chmod u+x,g-w ./scripts/run.sh",
                     f"chmod +x {self.work}/scripts/run.sh", "chmod -R g-w scripts", "chmod +x scripts/*.sh",
                     "mkdir -m 700 scripts/new", "install -m 755 scripts/run.sh scripts/run2.sh"]:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [], text)
        # scratch is strictly below <root>/<lane>/
        root = self.scratch_root
        self.assertEqual(self.blocking(f"chmod +x {root}/lane/run.sh"), [])
        self.assertEqual(self.blocking(f"chmod +x {root}/lane/new/x.sh"), [])
        self.assertTrue(self.blocking(f"chmod g-w {root}/lane"))  # a lane dir itself
        self.assertTrue(self.blocking(f"chmod g-w {root}"))
        self.assertTrue(self.blocking(f"chmod g-w {root}/../x/y"))
        (root / "loose.sh").write_text("x")
        self.assertEqual(self.blocking(f"chmod +x {root}/loose.sh"), [])  # a file right in the root
        # a project's home scratch and a worktree, strictly below their <dir>
        proj = self.home / "workspace" / "Org" / "app"
        for d in (proj / "tmp" / "run1", self.home / "workspace" / ".worktrees" / "lane-x" / "src"):
            d.mkdir(parents=True)
        for text in [f"chmod 600 {proj}/tmp/run1/key.env", f"chmod +x ~/workspace/.worktrees/lane-x/src/a.sh",
                     f"chmod -R g-w ~/workspace/.worktrees/lane-x/src"]:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text, cwd=self.home), [], text)
        for text in [f"chmod g-w {proj}/tmp", f"chmod g-w {proj}/tmp/run1", "chmod g-w ~/tmp/x/y",
                     "chmod -R g-w ~/workspace/.worktrees", "chmod -R g-w ~/workspace/.worktrees/lane-x",
                     f"chmod +x {proj}/run.sh"]:
            with self.subTest(text=text):
                self.assertTrue(self.blocking(text, cwd=self.home), text)

    @unittest.skipUnless(sys.platform.startswith("linux"), "the Linux temp roots")
    def test_the_real_scratch_roots(self):
        with host_profile.HostProfile.use(host_profile.HostProfile({}, os_name="linux")):
            ctx = access.Context(str(self.work), "/home/nobody-jev")
            self.assertEqual(access.scan_access("chmod +x /var/tmp/some-lane-jev/run.sh", ctx), [])
            self.assertEqual(access.scan_access("chmod +x /tmp/some-lane-jev/run.sh", ctx), [])
            for text in ("chmod g-w /var/tmp", "chmod 1777 /tmp"):
                with self.subTest(text=text):
                    self.assertTrue(access.scan_access(text, ctx))
            if os.path.dirname(self.tmp.name) == "/var/tmp":  # a lane dir itself (it exists)
                self.assertTrue(access.scan_access(f"chmod g-w {self.tmp.name}", ctx))

    def test_a_top_level_cd_resolves_relative_targets(self):
        lane = self.scratch_root / "lane"
        home = self.home
        passes = [f"cd {lane} && chmod 755 run.sh", f"cd {lane}\nchmod 600 *.sh", f"cd {lane}; chmod +x ./run.sh",
                  f"builtin cd {lane} && chmod +x run.sh", f"pushd {lane} && chmod +x run.sh"]
        for text in passes:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text, cwd=home), [], text)
        blocks = [f"chmod 755 run.sh",                                   # cwd is HOME
                  f"cd {lane}/missing; chmod -R g-w workspace",           # cd to nothing known
                  f"(cd {lane} && chmod +x run.sh)",                      # a subshell's cd
                  f"cd {lane} && (cd ~/workspace && chmod -R g-w example)",
                  f"cd {lane} && (cd ~/workspace) && chmod -R g-w run.sh",
                  f"cd {lane} && popd && chmod +x run.sh",
                  f"cd $D && chmod +x run.sh", f"cd {lane} && cd - && chmod +x run.sh",
                  f"bash -c 'cd {lane} && chmod +x run.sh'",
                  f"cd {lane} && chmod -R g-w ../..", f"cd {home}/workspace && chmod -R g-w Org"]
        for text in blocks:
            with self.subTest(text=text):
                self.assertTrue(self.blocking(text, cwd=home), text)
        # the cd moves resolution for that text only, never the context
        ctx = self.ctx(cwd=home)
        access.scan_access(f"cd {lane}", ctx)
        self.assertEqual(ctx.cwd, str(home))

    def test_a_shallow_cwd_is_no_own_area(self):
        self.assertTrue(self.blocking("chmod +x Org/repo/scripts/run.sh", cwd=self.shallow))
        self.assertTrue(self.blocking("chmod +x .", cwd=self.work))  # the cwd itself, not strictly below

    def test_a_symlink_out_of_the_own_area_blocks(self):
        (self.work / "out").symlink_to(self.shallow)
        self.assertTrue(self.blocking("chmod g-w out"))
        self.assertTrue(self.blocking("chmod -L -R g-w scripts"))

    def test_nested_remote_xargs_find(self):
        cases = [("bash -c 'chmod +x scripts/run.sh'", "inside a nested script"),
                 ("ssh buildhost 'chmod 600 x'", "remote host"),
                 ("ls | xargs chmod +x", "xargs or find"),
                 ("find ~/workspace -type d -exec chmod g-w {} +", "xargs or find")]
        for text, why in cases:
            with self.subTest(text=text):
                hits = self.blocking(text)
                self.assertTrue(any(why in h.why for h in hits), hits)

    def test_inline_code(self):
        for text in ["python3 -c 'import os; os.chmod(\"x\", 0o777)'", "python3 -c 'import shutil; shutil.chown(p)'",
                     "perl -e 'chmod 0777, \"x\"'", "node -e 'require(\"fs\").chmodSync(\"x\", 0o777)'",
                     "node -e 'fs.chownSync(p, 0, 0)'", "ruby -e 'File.chmod(0777, \"x\")'",
                     "python3 -c 'import subprocess; subprocess.run([\"sudo\", \"ls\"])'",
                     "python3 -c 'open(\"/home/x/.ssh/authorized_keys\", \"a\")'"]:
            with self.subTest(text=text):
                self.assertIn("code", [h.kind for h in self.blocking(text)])

    def test_what_passes(self):
        for text in ["grep -n chmod f", "echo 'sudo chmod g-w x'", "git log --grep=chmod", "man chmod",
                     "systemctl --user status x", "systemctl --user restart x.service", "ls -la ~/.ssh",
                     "cat ~/.ssh/config", "ssh buildhost ls", "ssh-keygen -l -f k.pub", "rm -rf target/",
                     "mkdir -p /var/tmp/lane/x", "python3 -c 'print(1)'", "echo hi > /var/tmp/x/out.txt",
                     "cargo test -p synaps", "git -c rerere.enabled=false merge x", "umask",
                     "umask 022; ls", "stat -c %a f", "ls -l ~/.synaps-cli/sandbox/sessions",
                     "cat ~/.synaps-cli/sandbox/sessions/old.conf", "journalctl --user -u x",
                     "systemd-run --user --scope -p MemoryMax=8G cargo build",
                     "sed -n 1,18p ~/.ssh/config", "perl -ne 'print' ~/.ssh/config", "grep x ~/.ssh/config",
                     "sed -n 5p ~/.synaps-cli/memory/jev/audit.jsonl"]:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [], text)


class SystemdRun(HomeCase):
    """systemd-run (the access rule): without --scope the user
    manager runs the job as a service, outside the session's sandbox; the
    memory-cap scope form (`systemd-run --user --scope` with memory caps only) keeps
    today's answer. The check only ADDS hits: nothing here lets through a
    call that asked before."""

    WRAPS = ("{}", "env CARGO_INCREMENTAL=0 {}", "nohup {} &", "timeout 600 {}", "sh -c '{}'", 'bash -c "{}"',
             "cd /var/tmp && {}")

    def run_hits(self, text):
        return [h for h in self.blocking(text) if h.token == "systemd-run"]

    def assert_asks(self, text, why):
        for wrap in self.WRAPS:
            if (wrap.startswith("sh -c") and "'" in text) or (wrap.startswith("bash -c") and ('"' in text or "$" in text)):
                continue  # the quoting would change what the text says
            with self.subTest(text=wrap.format(text)):
                hits = self.run_hits(wrap.format(text))
                self.assertEqual([(h.kind, h.token) for h in hits], [("command", "systemd-run")], hits)
                self.assertIn(why, hits[0].why)
                self.assertEqual(hits[0].descent, wrap.startswith(("sh -c", "bash -c")))

    def test_without_scope_it_asks(self):
        for text in ("systemd-run --user cargo build", "systemd-run --user -p MemoryMax=8G cargo build",
                     "systemd-run cargo build", "/usr/bin/systemd-run --user -q -- cargo build",
                     "systemd-run --user --on-active=60 cargo build", "systemd-run --user --wait --pipe make",
                     "systemd-run --user -t bash", "systemd-run --user --unit=x -p CPUQuota=5% make",
                     "systemd-run --user --same-dir --collect -- make", "systemd-run --user -- --scope"):
            self.assert_asks(text, "outside the session's sandbox (no --scope)")

    def test_a_scope_outside_the_memory_cap_form_asks(self):
        cases = [
            ("systemd-run --scope -p MemoryMax=8G cargo build", "under the system manager"),
            ("systemd-run --system --scope cargo build", "under the system manager"),
            ("systemd-run --user --system --scope cargo build", "under the system manager"),
            ("systemd-run --user --scope --slice=app.slice cargo build", "another slice"),
            ("systemd-run --user --scope --slice app.slice cargo build", "another slice"),
            ("systemd-run --user --scope --slice-inherit cargo build", "another slice"),
            ("systemd-run --user --scope --uid=0 make", "another slice"),
            ("systemd-run --user --scope --gid 0 make", "another slice"),
            ("systemd-run --user --scope -M box make", "another slice"),
            ("systemd-run --user --scope --machine=box make", "another slice"),
            ("systemd-run --user --scope -H buildhost make", "another slice"),
            ("systemd-run --user --scope -Hbuildhost make", "another slice"),
            ("systemd-run --user --scope --host=user@buildhost make", "another slice"),
            ("systemd-run --user --scope -p CPUQuota=50% make", "other than a memory cap"),
            ("systemd-run --user --scope --property=TasksMax=10 make", "other than a memory cap"),
            ("systemd-run --user --scope --property Delegate=yes make", "other than a memory cap"),
            ("systemd-run --user --scope -pIOWeight=10 make", "other than a memory cap"),
            ("systemd-run --user --scope -p MemoryMax=1G -p MemoryLimit=2G make", "other than a memory cap"),
            ("systemd-run --user --scope -p memorymax=1G make", "other than a memory cap"),
            ("systemd-run --user --scope -p MemoryMax make", "other than a memory cap"),
            ("systemd-run --user --scope -qp CPUWeight=1 make", "other than a memory cap"),
            ("systemd-run --user --scope --prop=CPUWeight=1 make", "other than a memory cap"),
            ("systemd-run --user --scope --unit=build make", "names its unit"),
            ("systemd-run --user --scope -u build make", "names its unit"),
            ("systemd-run --user --scope -ubuild make", "names its unit"),
            ("systemd-run --user --scope --description=build make", "names its unit"),
            ("systemd-run --user --scope --desc build make", "names its unit"),
            ("systemd-run --user --scope --nice=5 make", "outside the memory-cap scope form"),
            ("systemd-run --user --scope --working-directory=/ make", "outside the memory-cap scope form"),
            ("systemd-run --user --scope -R make", "outside the memory-cap scope form"),
            ("systemd-run --user --scope -v make", "outside the memory-cap scope form"),
            ("systemd-run --user --scope --no-ask-password make", "outside the memory-cap scope form"),
            ("systemd-run --user --scope --sl=x.slice make", "outside the memory-cap scope form"),
            ("systemd-run --user --scope --frobnicate make", "outside the memory-cap scope form"),
            ("systemd-run --user --scope -qX make", "outside the memory-cap scope form"),
            ("systemd-run --user --scope $OPTS make", "options the scan cannot see"),
            ('systemd-run --user --scope -p "$PROP" make', "options the scan cannot see"),
            ("systemd-run --user --scope --property=$(cat p) make", "options the scan cannot see"),
        ]
        for text, why in cases:
            self.assert_asks(text, why)

    def test_one_hit_per_call_in_a_fixed_order(self):
        hits = self.run_hits("systemd-run --slice=x -p CPUQuota=1% --unit=y make")
        self.assertEqual(len(hits), 1)
        self.assertIn("(no --scope)", hits[0].why)
        hits = self.run_hits("systemd-run --scope --uid=0 -p CPUQuota=1% --unit=y make")
        self.assertEqual(len(hits), 1)
        self.assertIn("under the system manager", hits[0].why)
        for h in self.run_hits("systemd-run --user cargo build # " + CANARY) + self.run_hits(
                f"systemd-run --user --scope -p {CANARY}=1 make"):
            self.assertNotIn(CANARY, h.why + h.token)

    def test_the_memory_cap_form_and_mentions_keep_todays_answer(self):
        for text in ["systemd-run --user --scope -p MemoryMax=8G cargo build",
                     "systemd-run --user --scope -q --same-dir --collect -p MemoryMax=8G -p MemoryHigh=6G "
                     "-p MemorySwapMax=0 -- cargo build",
                     "systemd-run --scope --user -qdG --property=MemoryMax=8G -pMemoryHigh=6G cargo test",
                     "systemd-run --user --scope --property MemorySwapMax=0 --quiet cargo test",
                     'systemd-run --us --sco -p "MemoryMax=$LIMIT" cargo build',
                     "systemd-run --user --scope -- cargo build", "systemd-run --user --scope cargo build",
                     "env CARGO_INCREMENTAL=0 systemd-run --user --scope -p MemoryMax=8G -- cargo build",
                     "timeout 600 systemd-run --user --scope -p MemoryMax=8G cargo build",
                     "bash -c 'systemd-run --user --scope -p MemoryMax=8G cargo build'",
                     "systemd-run --user --scope -p MemoryMax=8G ./$TOOL --flag",
                     "systemd-run --help", "systemd-run --version",
                     "echo 'systemd-run --user cargo build'", "grep -n systemd-run notes.md", "man systemd-run",
                     "git commit -m 'use systemd-run --user --slice=x'",
                     "cat > /var/tmp/x/notes.txt <<'EOF'\nsystemd-run --user cargo build\nEOF",
                     "python3 -c 'print(\"systemd-run --user make\")'",
                     "systemctl --user status run-u1.scope"]:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [], text)

    def test_the_inner_command_is_scanned(self):
        cases = [("systemd-run --user --scope -p MemoryMax=1G -- chmod 777 ~/workspace", [("command", "chmod")]),
                 ("systemd-run --user --scope -q sudo ls", [("command", "sudo")]),
                 ("systemd-run --user --scope -p MemoryHigh=1G tee -a ~/.ssh/authorized_keys", [("write", "~/.ssh")]),
                 ("systemd-run --user --scope -u x -- usermod -aG docker user",
                  [("command", "systemd-run"), ("command", "usermod")]),
                 ("systemd-run --user cp k ~/.ssh/authorized_keys", [("command", "systemd-run"), ("write", "~/.ssh")]),
                 ("env A=1 systemd-run --user --scope -p MemoryMax=1G env B=2 timeout 9 systemctl --user "
                  "set-property app.slice CPUQuota=5%", [("command", "systemctl set-property")]),
                 ("systemd-run --user --scope -p MemoryMax=1G systemd-run --user make",
                  [("command", "systemd-run")])]
        for text, want in cases:
            with self.subTest(text=text):
                self.assertEqual(sorted((h.kind, h.token) for h in self.blocking(text)), sorted(want))
        # the outer form's hits come first, at the outer command's line
        hits = self.blocking("ls\nsystemd-run --user -- chmod 777 ~/workspace")
        self.assertEqual([(h.token, h.line) for h in hits], [("systemd-run", 2), ("chmod", 2)])

    def test_setenv_is_part_of_the_memory_cap_form(self):
        # an environment variable is no access item
        # in the access rule (and `VAR=x cmd` passes), so -E/--setenv joins the form
        for text in ["systemd-run --user --scope -E A=1 make",
                     "systemd-run --user --scope --setenv=A=1 -p MemoryMax=8G make",
                     "systemd-run --user --scope -qE A=1 --setenv B=2 -p MemoryMax=8G -- cargo test",
                     "systemd-run --user --scope -EA=1 make", "systemd-run --user --scope --setenv=PATH make",
                     "systemd-run --user --scope --sete=A=1 make"]:
            for wrap in ("{}", "timeout 600 {}", "sh -c '{}'"):
                with self.subTest(text=wrap.format(text)):
                    self.assertEqual(self.blocking(wrap.format(text)), [])
        # anything else outside the form still asks for that
        self.assert_asks("systemd-run --user --scope -E A=1 --unit=x make", "names its unit")
        self.assert_asks("systemd-run --user -E A=1 make", "(no --scope)")

    def test_an_option_value_that_can_split_is_unseen(self):
        # an expansion in a -p or -E value that can split
        # into more words (unquoted, or a form that splits even in double
        # quotes) can add options: unseen. A double-quoted $NAME or ${NAME}
        # cannot, and keeps today's answer.
        for text in ["systemd-run --user --scope -p MemoryMax=$M make",
                     "systemd-run --user --scope -pMemoryMax=$M make",
                     "systemd-run --user --scope -qp MemoryMax=$M make",
                     "systemd-run --user --scope --property=MemoryHigh=${H}G make",
                     "systemd-run --user --scope --property MemorySwapMax=$S make",
                     "systemd-run --user --scope -E V=$X make", "systemd-run --user --scope -qE V=$X make",
                     "systemd-run --user --scope --setenv=$NAME make",
                     'systemd-run --user --scope -p MemoryMax="$M"$N make',
                     'systemd-run --user --scope -p "MemoryMax=$(cat m)" make',
                     'systemd-run --user --scope -E "A=$@" make',
                     'systemd-run --user --scope -p "MemoryMax=${M:-8G}" make',
                     'systemd-run --user --scope -E "A=${a[@]}" make']:
            self.assert_asks(text, "options the scan cannot see")
        for text in ["systemd-run --user --scope -E A=`id -u` make",
                     "timeout 9 systemd-run --user --scope -p MemoryMax=`cat m` make"]:
            with self.subTest(text=text):
                hits = self.run_hits(text)
                self.assertEqual(len(hits), 1, hits)
                self.assertIn("options the scan cannot see", hits[0].why)
        for text in ['systemd-run --user --scope -p "MemoryMax=$M" make',
                     'systemd-run --user --scope -p MemoryMax="$M" make',
                     'systemd-run --user --scope -p "MemoryHigh=${H}G" -E "V=$X" make',
                     'systemd-run --user --scope --setenv="$NAME" make',
                     'systemd-run --user --scope -E "CARGO_TARGET_DIR=$PWD/target" -- cargo build',
                     "systemd-run --user --scope -p 'MemoryMax=$M' make",
                     "systemd-run --user --scope -E A=\\$x make",
                     "systemd-run --user --scope -E $'A=1' make"]:
            for wrap in ("{}", "timeout 600 {}", "sh -c '{}'"):
                if "'" in text and wrap.startswith("sh"):
                    continue
                with self.subTest(text=wrap.format(text)):
                    self.assertEqual(self.blocking(wrap.format(text)), [])

    def test_a_script_its_command_runs_is_read_as_under_a_wrapper(self):
        # the memory-cap form wraps a nested script like a
        # rule-1 wrapper does, with the same descents (a shell's -c string,
        # ssh's remote command, eval, su/runuser/script -c, env -S, flock -c,
        # watch); the hits equal those under `timeout`
        form = "systemd-run --user --scope -p MemoryMax=8G -- {}"
        for script in ["bash -c 'chmod -R g-w ~/workspace'", "sh -c 'chmod -R g-w ~/workspace'",
                       "timeout 5 bash -c 'chmod -R g-w ~/workspace'", "nohup sh -c 'sudo ls'",
                       "env -S 'chmod -R g-w ~/workspace'", "eval chmod -R g-w ~/workspace",
                       "ssh buildhost chmod -R g-w ~/workspace", "script -q -c 'chmod -R g-w ~/workspace' /dev/null",
                       "flock /tmp/l -c 'chmod -R g-w ~/workspace'", "watch -n 5 chmod -R g-w ~/workspace",
                       "find . -name x -exec bash -c 'chmod 777 ~/workspace' \\;",
                       "bash -c \"cd /tmp && bash -c 'usermod -aG docker user'\"",
                       "env -C /tmp bash -c 'echo hi; chmod g-w ~/workspace'"]:
            with self.subTest(script=script):
                wrapped = sorted(self.blocking("timeout 600 " + script))
                self.assertTrue(wrapped, "a rule-1 wrapper's descent finds it")
                self.assertEqual(sorted(self.blocking(form.format(script))), wrapped)
                self.assertEqual(sorted(self.blocking("timeout 9 " + form.format(script))), wrapped)
                self.assertEqual(sorted(self.blocking("systemd-run --user --scope -q " + script)), wrapped)
        hits = self.blocking("systemd-run --user --scope -p MemoryMax=8G -- bash -c 'chmod -R g-w ~/workspace'")
        self.assertEqual([(h.kind, h.token, h.descent) for h in hits], [("command", "chmod", True)])
        self.assertIn("inside a nested script", hits[0].why)
        hits = self.blocking("systemd-run --user --scope -- timeout 5 bash -c 'chmod -R g-w ~/workspace'")
        self.assertEqual([(h.token, h.descent) for h in hits], [("chmod", True)])
        # outside the form: its own hit first, then the nested one
        hits = self.blocking("systemd-run --user -- bash -c 'chmod -R g-w ~/workspace'")
        self.assertEqual([(h.token, h.descent) for h in hits], [("systemd-run", False), ("chmod", True)])
        # a script with no access change
        for text in ["systemd-run --user --scope -p MemoryMax=8G -- bash -c 'cargo build && echo ok'",
                     "systemd-run --user --scope -- timeout 5 sh -c 'make -j4'",
                     "systemd-run --user --scope -p MemoryMax=8G bash -c 'echo chmod'",
                     "systemd-run --user --scope -E A=1 -- sh -c 'cd /tmp && ls'"]:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [])

    def test_rule1_never_unwraps_systemd_run(self):
        # the access scan reads what systemd-run runs; the rule-1 scan does
        # not: its results stay as they were (systemd-run is no rule-1 wrapper)
        self.assertNotIn("systemd-run", rule1.WRAPPERS)
        inner = "bash -c 'sed -i s/a/b/ f'"
        self.assertEqual([h.family for h in rule1.scan_rule1("timeout 5 " + inner)], ["E1"])
        self.assertEqual(rule1.scan_rule1("systemd-run --user --scope -p MemoryMax=8G -- " + inner), [])
        self.assertEqual(rule1.scan_rule1("systemd-run --user -- " + inner), [])


class Writes(HomeCase):
    def test_protected_writes(self):
        for text, token in [("echo k >> ~/.ssh/authorized_keys", "~/.ssh"),
                            ('echo k >> "$HOME/.ssh/authorized_keys"', "~/.ssh"),
                            ("echo k | tee -a ~/.ssh/authorized_keys", "~/.ssh"),
                            ("cp ~/.ssh/id_ed25519 /var/tmp/x/", "~/.ssh"),
                            ("ssh-keyscan h >> ~/.ssh/known_hosts", "~/.ssh"),
                            ("rm ~/.ssh/authorized_keys", "~/.ssh"),
                            ("sed -i '$d' ~/.ssh/authorized_keys", "~/.ssh"), ("perl -pi -e s/a/b/ ~/.ssh/config", "~/.ssh"),
                            ("echo x | tee /etc/sudoers.d/x", "sudoers"),
                            ("cp p.rules /etc/polkit-1/rules.d/", "polkit"),
                            ("echo x >> /etc/group", "users and groups"),
                            ("cp r /etc/ufw/user.rules", "firewall config"),
                            ("echo auto > ~/.synaps-cli/memory/jev/sandbox-mode", "the jev guard's state and switch"),
                            ("rm ~/.synaps-cli/memory/jev/sandbox-mode", "the jev guard's state and switch"),
                            ("echo guard_access=off >> ~/.synaps-cli/plugins/jev/config", "the jev guard's config")]:
            with self.subTest(text=text):
                self.assertIn(token, [h.token for h in self.blocking(text)])

    def test_umask_lines_in_shell_and_service_config(self):
        self.assertTrue(self.blocking("echo 'umask 002' >> ~/.bashrc"))
        self.assertTrue(self.blocking("cat >> ~/.bashrc <<EOF\numask 002\nEOF"))
        self.assertTrue(self.blocking("echo 'daemon.umask = \"002\"' >> ~/.synaps-cli/config"))
        self.assertEqual(self.blocking("echo 'alias ll=ls' >> ~/.bashrc"), [])
        self.assertEqual(self.blocking("echo 'model = x' >> ~/.synaps-cli/config"), [])

    def test_units_block_only_on_a_limit_or_access_key(self):
        t = self.tmp.name
        self.assertTrue(self.blocking(f"printf '[Service]\\nMemoryMax=8G\\n' > {self.units}/x.service"))
        self.assertTrue(self.blocking(f"cp {t}/limit.slice {self.units}/"))
        self.assertTrue(self.blocking(f"cp {t}/missing.slice {self.units}/"))  # unreadable source: blocked
        self.assertEqual(self.blocking(f"cp {t}/plain.slice {self.units}/"), [])
        self.assertEqual(self.blocking(f"printf '[Timer]\\nOnCalendar=daily\\n' > {self.units}/rr-x.timer"), [])
        self.assertEqual(self.blocking(f"rm {self.units}/rr-x.timer"), [])

    def test_path_access_for_write_tools(self):
        ctx = self.ctx()
        self.assertEqual(access.path_access("~/.ssh/authorized_keys", "k", ctx).token, "~/.ssh")
        self.assertIsNotNone(access.path_access(f"{self.units}/x.service", "[Service]\nUMask=0002\n", ctx))
        self.assertIsNone(access.path_access(f"{self.units}/x.timer", "[Timer]\nOnCalendar=daily\n", ctx))
        self.assertIsNotNone(access.path_access("~/.bashrc", "umask 002\n", ctx))
        self.assertIsNone(access.path_access("~/.bashrc", "alias x=y\n", ctx))
        self.assertIsNone(access.path_access("scripts/new.sh", "chmod g-w x", ctx))


class Launchctl(HomeCase):
    """launchctl is gated on every OS (it does not exist on Linux: no change there)."""

    def test_gated_subcommands_block(self):
        for text, token in [("launchctl load ~/Library/LaunchAgents/x.plist", "launchctl load"),
                            ("launchctl bootout gui/501/com.x", "launchctl bootout"),
                            ("launchctl kickstart -k system/com.x", "launchctl kickstart"),
                            ("launchctl setenv PATH /x", "launchctl setenv"),
                            ("launchctl limit maxfiles 1 2", "launchctl limit"),
                            ("/bin/launchctl BOOTSTRAP gui/501 x.plist", "launchctl bootstrap"),
                            ("sudo launchctl enable system/com.x", "launchctl enable"),
                            ("launchctl", "launchctl"), ("launchctl $SUB x", "launchctl"),
                            ("launchctl < cmds.txt", "launchctl")]:
            with self.subTest(text=text):
                self.assertIn(token, [h.token for h in self.blocking(text)])

    def test_reads_pass(self):
        for text in ["launchctl list", "launchctl print gui/501", "launchctl getenv PATH", "launchctl version"]:
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [])


class MacOSTables(HomeCase):
    """The macOS protected tables, on any OS through an injected profile; a
    realpath that maps /etc into /private, as macOS does."""

    def mac_ctx(self, os_name="macos"):
        def real(p):
            r = os.path.realpath(p)
            return "/private" + r if r == "/etc" or r.startswith("/etc/") else r
        profile = host_profile.HostProfile({}, os_name=os_name, home=str(self.home),
                                           platform=host_profile.Platform(os_name, temp_roots=(str(self.scratch_root),)))
        return access.Context(str(self.work), str(self.home), realpath=real, profile=profile)

    CASES = [("cp x.plist ~/Library/LaunchAgents/", "launchd job"),
             ("echo x > ~/Library/LaunchAgents/com.x.plist", "launchd job"),
             ("cp x.plist /Library/LaunchDaemons/", "launchd job"),
             ("echo 'pass all' >> /etc/pf.conf", "firewall config"),
             ("echo x | tee /etc/sudoers.d/x", "sudoers"), ("echo x | tee /private/etc/sudoers.d/x", "sudoers"),
             ("echo x >> /private/etc/pam.d/sudo", "pam and limits"),
             ("echo 'umask 002' >> /etc/zshrc", "shell or service config")]

    def test_macos_protected_writes(self):
        ctx = self.mac_ctx()
        for text, cls in self.CASES:
            with self.subTest(text=text):
                self.assertTrue([h for h in access.scan_access(text, ctx) if h.kind != "auto"], text)
                self.assertEqual(access.classify("/private" + "/etc/sudoers", ctx)[0], "sudoers")
        self.assertEqual(access.classify(str(self.home / "Library" / "LaunchAgents" / "a.plist"), ctx)[0],
                         "launchd job")

    def test_linux_keeps_the_old_tables(self):
        ctx = self.mac_ctx("linux")
        for path in [self.home / "Library" / "LaunchAgents" / "a.plist", "/Library/LaunchDaemons/a.plist",
                     "/etc/pf.conf", "/etc/zshrc"]:
            with self.subTest(path=path):
                self.assertIsNone(access.classify(str(path), ctx))
        self.assertEqual(access.classify("/etc/sudoers", ctx)[0], "sudoers")


class OwnProjectIgnoresTheProfile(HomeCase):
    """Facts are not authority: workspace.root (valid, invalid or unset)
    never changes the own-project rule; a cwd at depth 3 or more below HOME
    is a project of the session's own, exactly the old rule."""

    def use(self, snapshot):
        profile = host_profile.HostProfile(snapshot, home=str(self.home),
                                           platform=host_profile.Platform(temp_roots=(str(self.scratch_root),)))
        use = host_profile.HostProfile.use(profile)
        use.__enter__()
        self.addCleanup(use.__exit__, None, None, None)

    SNAPSHOTS = ({}, {"workspace": {"root": "WS"}}, {"workspace": {"root": "WS", "worktrees_dir": "WS/.worktrees"}},
                 {"workspace": {"root": "HOME"}}, {"workspace": {"root": "/"}}, {"workspace": {"root": "/srv/elsewhere"}})

    def snapshots(self):
        for snap in self.SNAPSHOTS:
            ws = snap.get("workspace", {})
            yield {"workspace": {k: v.replace("WS", str(self.shallow)).replace("HOME", str(self.home))
                                 for k, v in ws.items()}} if ws else {}

    def test_the_old_heuristic_with_any_profile(self):
        other = self.home / "other" / "Org" / "repo"
        (other / "scripts").mkdir(parents=True)
        (other / "scripts" / "run.sh").write_text("x")
        wt = self.shallow / ".worktrees"
        (wt / "x" / "scripts").mkdir(parents=True)
        (wt / "f.sh").write_text("x")
        for snapshot in self.snapshots():
            with self.subTest(snapshot=snapshot):
                self.use(snapshot)
                self.assertEqual(self.blocking("chmod +x scripts/run.sh", cwd=self.work), [])
                self.assertEqual(self.blocking("chmod +x scripts/run.sh", cwd=other), [])   # depth 3, outside any root
                # depth 2, even directly below a valid workspace.root: no project
                self.assertTrue(self.blocking("chmod +x repo/scripts/run.sh", cwd=self.shallow / "Org"))
                self.assertTrue(self.blocking("chmod +x Org/repo/scripts/run.sh", cwd=self.shallow))
                # the worktrees dir itself: no project; below .worktrees/<name>/ the worktree rule applies
                self.assertTrue(self.blocking("chmod +x f.sh", cwd=wt))
                self.assertEqual(self.blocking("chmod +x x/scripts", cwd=wt), [])

class SandboxSwitch(HomeCase):
    def test_manual_passes_only_a_new_session_file(self):
        ctx = self.ctx()
        self.assertIsNone(access.path_access(f"{self.sessions}/new.conf", "x", ctx, "create"))
        for raw, op in [(f"{self.sessions}/old.conf", "create"), (f"{self.sessions}/old.conf", "change"),
                        (f"{self.sessions}/new.conf", "change"), (f"{self.sessions}/new.conf.new", "create"),
                        (f"{self.sessions}/sub/new.conf", "create"), (f"{self.sessions}/../OFF", "create"),
                        ("~/.synaps-cli/sandbox/OFF", "create"), ("~/.synaps-cli/sandbox/x.conf", "create")]:
            with self.subTest(raw=raw, op=op):
                hit = access.path_access(raw, "x", ctx, op)
                self.assertIsNotNone(hit)
                self.assertEqual(hit.kind, "sandbox")

    def test_manual_shell(self):
        stage = self.scratch / "sid.conf"
        stage.write_text("x")
        self.assertEqual(self.blocking(f"mv -n {stage} {self.sessions}/sid.conf"), [])
        self.assertEqual(self.blocking(f"cp {stage} {self.sessions}/"), [])
        self.assertEqual(self.blocking(f"install -D {stage} {self.sessions}/sid.conf"), [])
        for text in [f"mv -n {stage} {self.sessions}/old.conf", f"cp {stage} {self.sessions}/old.conf",
                     f"rm {self.sessions}/old.conf", f"mv {self.sessions}/old.conf {self.scratch}/",
                     f"echo x > {self.sessions}/new.conf", f"echo x | tee {self.sessions}/new.conf",
                     "touch ~/.synaps-cli/sandbox/OFF", "rm ~/.synaps-cli/sandbox/OFF",
                     f"sed -i s/a/b/ {self.sessions}/old.conf"]:
            with self.subTest(text=text):
                kinds = [h.kind for h in self.blocking(text)]
                self.assertIn("sandbox", kinds)

    def test_auto_passes_below_sessions_and_audits_existing(self):
        ctx = self.ctx(mode="auto")
        self.assertEqual(access.path_access(f"{self.sessions}/old.conf", "x", ctx, "change").kind, "auto")
        self.assertIsNone(access.path_access(f"{self.sessions}/brand-new.conf", "x", ctx, "create"))
        self.assertEqual(access.path_access("~/.synaps-cli/sandbox/OFF", "x", ctx, "create").kind, "sandbox")
        hits = self.scan(f"rm {self.sessions}/old.conf", mode="auto")
        self.assertEqual([h.kind for h in hits], ["auto"])
        self.assertTrue(self.blocking("touch ~/.synaps-cli/sandbox/OFF", mode="auto"))

    def test_the_switch_file(self):
        switch = Path(access.switch_path(str(self.home)))
        self.assertEqual(access.read_sandbox_mode(str(self.home)), "manual")  # missing
        for body, mode in [("auto\n", "auto"), ("  auto  ", "auto"), ("AUTO", "manual"), ("auto x", "manual"),
                           ("manual", "manual"), ("", "manual"), ("auto" + " " * 70, "manual")]:
            switch.write_text(body)
            with self.subTest(body=body):
                self.assertEqual(access.read_sandbox_mode(str(self.home)), mode)


class ReviewBypasses(HomeCase):
    """The six bypasses of the post-install review of 4f104879 (a-f)."""

    def setUp(self):
        super().setUp()
        self.limit = self.units / "limit.service"
        self.limit.write_text("[Unit]\nDescription=x\n[Service]\nMemoryMax=1G\n")
        (self.units / "rr-x.timer").write_text("[Timer]\nOnCalendar=daily\n")
        (self.home / ".ssh" / "d").mkdir()
        (self.work / "lk").symlink_to(self.home / ".ssh" / "d")

    def test_a_umask_in_a_shell_call(self):
        for text in ("umask 000; touch f", "umask 002", "umask g+w", "umask u=rwx,g=rwx,o=rx", "umask $M"):
            with self.subTest(text=text):
                self.assertEqual([h.token for h in self.blocking(text)], ["umask"])
        for text in ("umask", "umask -S", "umask 022", "umask 077", "umask 0027"):
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [])

    def test_b_links_and_dotdot(self):
        for text in (f"echo k >> {self.work}/lk/../authorized_keys", "echo k >> lk/../authorized_keys",
                     "echo k >> ~/workspace/../.ssh/authorized_keys", f"cp k {self.work}/lk/"):
            with self.subTest(text=text):
                self.assertIn("~/.ssh", [h.token for h in self.blocking(text)])
        self.assertIsNotNone(access.path_access("lk/../authorized_keys", "k", self.ctx()))

    def test_c_glob_and_brace_spellings(self):
        for text in ("echo k >> ~/.ss?/authorized_keys", "echo k >> ~/.s*h/authorized_keys",
                     "echo k >> ~/{tmp,.ssh}/authorized_keys", "touch ~/.synaps-cli/sand*/OFF",
                     "echo x > ~/.synaps-cli/memory/j[e]v/sandbox-mode", "rm -rf ~/.synaps-cli/sandbo?"):
            with self.subTest(text=text):
                self.assertTrue(self.blocking(text))
        self.assertEqual(self.blocking("rm -f build/*.o scripts/{a,b}.sh"), [])

    def test_d_removing_or_moving_a_dir_that_holds_one(self):
        for text in ("rm -rf ~/.synaps-cli", "rm -rf ~/.synaps-cli/sandbox/..", "rm -rf ~/.config/systemd",
                     "mv ~/.synaps-cli ~/old", "rsync -a --delete /var/tmp/e/ ~/.config/", "rm -rf ~"):
            with self.subTest(text=text):
                self.assertTrue(self.blocking(text))
        self.assertEqual(self.blocking("rm -rf build scripts/old"), [])
        jev = "~/.synaps-cli/plugins/jev/"
        install = f"rsync -a --delete --exclude=/config --exclude=/.synaps-local-revision /var/tmp/st/ {jev}"
        self.assertEqual(self.blocking(install), [])
        self.assertEqual(self.blocking(f"rsync -an --delete /var/tmp/st/ {jev}"), [])
        self.assertTrue(self.blocking(f"rsync -a --delete /var/tmp/st/ {jev}"))
        self.assertTrue(self.blocking(install.replace("--delete", "--delete --delete-excluded")))

    def test_e_value_only_and_dropping_unit_edits(self):
        for text in (f"sed -i s/1G/8G/ {self.limit}", f": > {self.limit}", f"rm {self.limit}",
                     f"mv {self.limit} {self.scratch}/", f"cp {self.tmp.name}/plain.slice {self.limit}",
                     f"printf '[Service]\\n' > {self.limit}"):
            with self.subTest(text=text):
                self.assertTrue(self.blocking(text))
        for text in (f"echo '# note' >> {self.limit}", f"sed -i s/daily/hourly/ {self.units}/rr-x.timer",
                     f"rm {self.units}/rr-x.timer", f"sed -n p {self.limit}"):
            with self.subTest(text=text):
                self.assertEqual(self.blocking(text), [])
        ctx, path = self.ctx(), str(self.limit)
        self.assertIsNotNone(access.path_access(path, "8G", ctx, old="1G", tool="edit"))
        self.assertIsNotNone(access.path_access(path, "", ctx, old="MemoryMax=1G\n", tool="edit"))
        self.assertIsNone(access.path_access(path, "Description=y", ctx, old="Description=x", tool="edit"))
        self.assertIsNotNone(access.path_access(path, "[Service]\n", ctx, tool="write"))
        edits = [{"path": path, "op": "replace", "anchor": "1G", "text": "8G"}]
        self.assertIsNotNone(access.path_access(path, "8G", ctx, tool="multi_edit", edits=edits))
        edits = [{"path": path, "op": "replace", "anchor": "Description=x", "text": "Description=y"},
                 {"path": path, "op": "append", "text": "# end\n"}]
        self.assertIsNone(access.path_access(path, "Description=y", ctx, tool="multi_edit", edits=edits))
        edits = [{"path": path, "op": "replace", "anchor": "^Memory", "anchor_mode": "line_regex", "text": "X"}]
        self.assertIsNotNone(access.path_access(path, "X", ctx, tool="multi_edit", edits=edits))
        (self.home / ".bashrc").write_text("umask 022\n")
        self.assertIsNotNone(access.path_access("~/.bashrc", "2", ctx, old="22", tool="edit"))
        self.assertTrue(self.blocking("sed -i s/022/002/ ~/.bashrc"))
        self.assertEqual(self.blocking("echo 'alias x=y' >> ~/.bashrc"), [])

    def test_f_inline_code_naming_a_protected_path(self):
        for text in ('python3 -c "open(\'/home/u/.ssh/authorized_keys\',\'a\').write(\'k\')"',
                     "node -e \"require('fs').appendFileSync(process.env.HOME+'/.ssh/authorized_keys','k')\"",
                     "python3 -c \"import pathlib; pathlib.Path('~/.synaps-cli/sandbox/OFF').expanduser().touch()\"",
                     "perl -e 'open F, \">>/etc/sudoers.d/x\"'"):
            with self.subTest(text=text):
                self.assertEqual([h.kind for h in self.blocking(text)], ["code"])
        self.assertEqual(self.blocking('python3 -c "print(1)"'), [])


class Wiring(HomeCase):
    def setUp(self):
        super().setUp()
        self.audit_path = Path(self.tmp.name) / "audit.jsonl"
        self.audit = audit_mod.Audit(str(self.audit_path))
        self.logs = []

    def check(self, tool, tool_input, **cfg):
        params = {"kind": "before_tool_call", "tool_name": tool, "tool_runtime_name": tool,
                  "tool_input": tool_input, "session_id": "20261020-000000-aaaa", "cwd": str(self.work)}
        return guard.access_check(params, guard.GuardConfig(cfg), self.audit, self.logs.append)

    def rows(self):
        if not self.audit_path.exists():
            return []
        return [json.loads(x) for x in self.audit_path.read_text().splitlines() if x.strip()]

    def test_block_text_and_audit_row(self):
        result = self.check("bash", {"command": f"chmod g-w ~/workspace # {CANARY}"})
        self.assertEqual(result["action"], "block")
        self.assertTrue(result["reason"].startswith(HEAD), result["reason"])
        self.assertIn("Don't run it or work around it. End your turn and ask for the owner's yes (a worker asks "
                      "its foreman). This task waits.", result["reason"])
        self.assertIn("line 1: `chmod` changes access outside", result["reason"])
        self.assertIn("The rule's only exception is a file you created yourself", result["reason"])
        self.assertNotIn(SANDBOX_NOTE, result["reason"])
        rows = self.rows()
        self.assertEqual([(r["rule"], r["action"]) for r in rows], [("access", "block")])
        self.assertNotIn(CANARY, json.dumps(rows))
        self.assertNotIn(CANARY, " ".join(self.logs))
        self.assertEqual(self.audit.counters.get("guard.access.block"), 1)

    def test_the_own_area_note_only_when_it_could_apply(self):
        for text in ("sudo chmod +x f", "chmod +x f; echo k >> ~/.ssh/authorized_keys", "ls | xargs chmod +x"):
            with self.subTest(text=text):
                reason = self.check("bash", {"command": text})["reason"]
                self.assertNotIn("only exception", reason)
        self.assertIn("only exception", self.check("bash", {"command": "chmod +x $F"})["reason"])

    def test_value_only_unit_edits_through_the_tools(self):
        unit = self.units / "limit.service"
        unit.write_text("[Service]\nMemoryMax=1G\nDescription=x\n")
        self.assertEqual(self.check("edit", {"path": str(unit), "old_string": "1G", "new_string": "8G"})["action"],
                         "block")
        self.assertEqual(self.check("multi_edit", {"edits": [
            {"path": str(unit), "op": "replace", "anchor": "1G", "text": "8G"}]})["action"], "block")
        self.assertIsNone(self.check("edit", {"path": str(unit), "old_string": "Description=x",
                                              "new_string": "Description=y"}))
        self.assertIsNone(self.check("multi_edit", {"edits": [
            {"path": str(unit), "op": "replace", "anchor": "Description=x", "text": "Description=y"}]}))

    def test_sandbox_text_and_auto_row(self):
        result = self.check("write", {"path": "~/.synaps-cli/sandbox/OFF", "content": "x"})
        self.assertIn(SANDBOX_NOTE, result["reason"])
        self.assertIsNone(self.check("write", {"path": f"{self.sessions}/fresh.conf", "content": "x"}))
        Path(access.switch_path(str(self.home))).write_text("auto\n")
        self.assertIsNone(self.check("edit", {"path": f"{self.sessions}/old.conf", "old_string": "a",
                                              "new_string": "b"}))
        self.assertEqual([r["rule"] for r in self.rows()], ["access", "access_auto"])

    def test_tools_modes_and_scope(self):
        self.assertIsNone(self.check("read", {"path": "~/.ssh/authorized_keys"}))
        self.assertEqual(self.check("multi_edit", {"edits": [{"path": "~/.ssh/config", "op": "append",
                                                               "text": "Host x"}]})["action"], "block")
        self.assertEqual(self.check("shell_send", {"input": "sudo -i\r"})["action"], "block")
        self.assertIsNone(self.check("bash", {"command": "chmod g-w ~/workspace"}, guard_access="off"))
        self.assertIsNone(self.check("bash", {"command": "chmod g-w ~/workspace"}, guard_access="warn"))
        self.assertEqual(self.rows()[-1]["action"], "warn")
        self.assertEqual(self.check("bash", {"command": "chmod g-w ~/workspace"}, guard_access="bogus")["action"],
                         "block")
        self.assertIsNone(self.check("bash", {"command": "ls"}))

    def test_systemd_run_block_text_and_a_stopped_scan(self):
        result = self.check("bash", {"command": "systemd-run --user cargo build"})
        self.assertEqual(result["action"], "block")
        self.assertIn("line 1: `systemd-run` runs the job as a systemd service, outside the "
                      "session's sandbox (no --scope)", result["reason"])
        self.assertNotIn("only exception", result["reason"])
        self.assertIsNone(self.check("bash", {"command": "systemd-run --user --scope -p MemoryMax=8G make"}))
        big = "echo " + "x" * (guard.SHELL_SCAN_MAX_BYTES + 10)
        result = self.check("bash", {"command": big + "\nsystemd-run --user --scope -p MemoryMax=8G make"})
        self.assertEqual(result["action"], "block", "a stopped scan that names systemd-run fails closed")
        self.assertIn("could not be checked to the end", result["reason"])

    def test_a_stopped_scan_blocks_only_when_it_names_access(self):
        big = "echo " + "x" * (guard.SHELL_SCAN_MAX_BYTES + 10)
        self.assertIsNone(self.check("bash", {"command": big}))
        result = self.check("bash", {"command": big + "\nchmod g-w ~/workspace"})
        self.assertEqual(result["action"], "block")
        self.assertIn("could not be checked to the end", result["reason"])
        with mock.patch.object(access, "scan_access", side_effect=RuntimeError("boom " + CANARY)):
            self.assertEqual(self.check("bash", {"command": "sudo ls"})["action"], "block")
            self.assertIsNone(self.check("bash", {"command": "ls"}))
        self.assertNotIn(CANARY, json.dumps(self.rows()) + " ".join(self.logs))

    def extension(self, **cfg):
        import jev_ext
        ext = jev_ext.Extension()
        ext.initialize({"config": {"project_root": str(self.work), "audit_file": str(self.audit_path), **cfg}})
        return ext

    def hook(self, ext, command, session="20261020-000000-aaaa"):
        return ext.hook({"kind": "before_tool_call", "tool_name": "bash", "tool_runtime_name": "bash",
                         "tool_input": {"command": command}, "session_id": session, "cwd": str(self.work)}, None)

    def test_extension_runs_it_first_whatever_the_key_or_guard_switch(self):
        for patcher in (mock.patch("jev_ext.keys.discover", return_value=(None, "none")),
                        mock.patch.object(guard, "_ask", side_effect=AssertionError("a model call"))):
            patcher.start()
            self.addCleanup(patcher.stop)
        for cfg in ({}, {"guard": False}, {"guard_rule1": "off"}, {"guard_tools": "read"}):
            with self.subTest(cfg=cfg):
                ext = self.extension(**cfg)
                out = self.hook(ext, "chmod g-w ~/workspace")
                self.assertEqual(out["action"], "block", out)
                self.assertTrue(out["reason"].startswith(HEAD), out["reason"])
        # both rules would refuse: the access rule answers, alone
        out = self.hook(self.extension(guard_rule1_scope="all"), "cat > f <<'EOF'\nx\nEOF\nchmod g-w ~/workspace")
        self.assertTrue(out["reason"].startswith(HEAD), out["reason"])
        self.assertEqual(self.hook(self.extension(guard_access="off", guard_rule1="off", guard=False),
                                   "chmod g-w ~/workspace"), {"action": "continue"})

    def test_the_manifest_declares_its_keys(self):
        manifest = json.loads((Path(ROOT) / ".synaps-plugin" / "plugin.json").read_text())["extension"]
        keys = {c["key"]: c for c in manifest["config"]}
        self.assertEqual((keys["guard_access"]["default"], keys["guard_access_scope"]["default"]), ("block", "all"))
        hooked = {h.get("tool") for h in manifest["hooks"] if h["hook"] == "before_tool_call"}
        self.assertTrue(guard.ACCESS_TOOLS <= hooked)


if __name__ == "__main__":
    unittest.main()
