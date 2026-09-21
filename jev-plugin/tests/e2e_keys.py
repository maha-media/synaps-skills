#!/usr/bin/env python3
"""End-to-end for key setup paths. Needs TYPESAFE_API_KEY (used only as the
value we feed to `/jev key`; the extension itself starts with NO key).

    python3 tests/e2e_keys.py              # uses TYPESAFE_API_KEY, else the plugin's saved key

Covers:
  1. inert start (no key anywhere) still advertises tools; jev_status explains the fix
  2. guard is inert (continue) while unconfigured
  3. /jev key <bad>       → rejected, nothing saved
  4. /jev key <good>      → live-validated, persisted through host config.set (we play the host), activated
  5. guard now live in the same process (no restart)
  6. fresh inert process + key dropped into the plugin config file → picked up lazily
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
sys.path.insert(0, os.path.join(ROOT, "extensions"))


def configured_key() -> str | None:
    """TYPESAFE_API_KEY, else whatever the plugin itself would use (keys.discover)."""
    v = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if v:
        return v
    from jev import keys  # noqa: E402
    return keys.discover()[0]


def frame(obj):
    b = json.dumps(obj).encode()
    return f"Content-Length: {len(b)}\r\n\r\n".encode() + b


def read_frame(stdout):
    header = stdout.readline().decode()
    if not header.startswith("Content-Length:"):
        raise RuntimeError(f"bad header: {header!r}")
    n = int(header.split(":", 1)[1].strip())
    stdout.readline()
    return json.loads(stdout.read(n))


class Host:
    """Minimal host: spawns the extension in a sandboxed SYNAPS_BASE_DIR with no key."""

    def __init__(self, base_dir: str, config: dict | None = None):
        env = {k: v for k, v in os.environ.items() if k not in ("TYPESAFE_API_KEY", "SYNAPS_EXTENSION_JEV_API_KEY")}
        env["SYNAPS_BASE_DIR"] = base_dir
        self.base = base_dir
        self.store = os.path.join(base_dir, "plugins", "jev", "config")
        self.p = subprocess.Popen([sys.executable, "-u", os.path.join(ROOT, "extensions", "jev_ext.py")],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT, env=env)
        self.n = 0
        self.notifications: list[dict] = []
        self.config_sets: list[tuple[str, str]] = []
        self.init = self.request("initialize", {"plugin_id": "jev", "plugin_root": ROOT, "config": config or {}})

    def _write(self, obj):
        self.p.stdin.write(frame(obj)); self.p.stdin.flush()

    def request(self, method, params):
        self.n += 1
        rid = f"h{self.n}"
        self._write({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        while True:
            f = read_frame(self.p.stdout)
            if f.get("id") == rid and "method" not in f:
                return f
            if "method" in f and f.get("id") is not None:
                # inbound request from the extension — play host
                if f["method"] == "config.set":
                    k, v = f["params"]["key"], f["params"]["value"]
                    self.config_sets.append((k, v))
                    os.makedirs(os.path.dirname(self.store), exist_ok=True)
                    with open(self.store, "a") as fh:
                        fh.write(f"{k} = {v}\n")
                    self._write({"jsonrpc": "2.0", "id": f["id"], "result": {"ok": True}})
                else:
                    self._write({"jsonrpc": "2.0", "id": f["id"], "error": {"code": -32601, "message": "nope"}})
            elif "method" in f:
                self.notifications.append(f)

    def hook(self, kind, **kw):
        params = {"kind": kind, "tool_name": None, "tool_runtime_name": None, "tool_input": None,
                  "tool_output": None, "message": None, "session_id": "e2e", "transcript": None, "data": None}
        params.update(kw)
        return self.request("hook.handle", params)["result"]

    def command(self, *args):
        self.notifications.clear()
        r = self.request("command.invoke", {"name": "jev", "args": list(args), "request_id": "req-1"})
        events = [n["params"]["event"] for n in self.notifications if n["method"] == "command.output"]
        return r, events

    def close(self):
        self.request("shutdown", {})
        self.p.wait(timeout=5)
        return self.p.stderr.read().decode()


def main():
    good = configured_key()
    if not good:
        print("no key: set TYPESAFE_API_KEY or run scripts/setup.sh --key …", file=sys.stderr); sys.exit(2)
    fails = 0

    def check(ok, msg):
        nonlocal fails
        fails += not ok
        print(f"  {'✓' if ok else '✗'} {msg}")

    base = tempfile.mkdtemp(prefix="jev-keys-")
    h = Host(base)

    print("── 1. inert start")
    names = [t["name"] for t in h.init["result"]["capabilities"]["tools"]]
    check(names == ["jev_decide", "jev_status", "jev_select", "jev_verify"], f"tools advertised while inert: {names}")
    st = json.loads(h.request("tool.call", {"name": "jev_status", "input": {}})["result"]["content"])
    check(st.get("active") is False and "/jev key" in " ".join(st.get("how_to_fix", [])), "jev_status explains how to configure")
    r = h.request("tool.call", {"name": "jev_decide", "input": {"state": "x", "questions": {"q": {"type": "noul", "instructions": "?"}}}})
    check("error" in r and "/jev key" in r["error"]["message"], "jev_decide errors with the fix")

    print("── 2. guard inert")
    r = h.hook("before_tool_call", tool_name="bash", tool_runtime_name="bash", tool_input={"command": "rm -rf /"})
    check(r["action"] == "continue", f"unconfigured guard does not block: {r['action']}")

    print("── 3. /jev key <bad>")
    _, ev = h.command("key", "apikey_notarealkey_000000000000000000")
    kinds = [e["kind"] for e in ev]
    check("error" in kinds and kinds[-1] == "done" and not h.config_sets, f"rejected, nothing saved: {kinds}")
    _, ev = h.command("key", "garbage")
    check(any(e["kind"] == "error" for e in ev) and not h.config_sets, "malformed value rejected")

    print("── 4. /jev key <good>")
    t0 = time.monotonic()
    _, ev = h.command("key", good)
    ms = int((time.monotonic() - t0) * 1000)
    texts = " ".join(e.get("content", "") for e in ev)
    check(h.config_sets == [("api_key", good)], "persisted via host config.set")
    check("Jev is active" in texts and ev[-1]["kind"] == "done", f"activated in-process ({ms} ms)")
    check(os.path.exists(h.store), f"store written by (fake) host: {h.store}")

    print("── 5. guard live, same process")
    r = h.hook("before_tool_call", tool_name="bash", tool_runtime_name="bash", tool_input={"command": "cat ~/.synaps-cli/auth.json"})
    check(r["action"] == "confirm", f"auth.json read → {r['action']}")
    st = json.loads(h.request("tool.call", {"name": "jev_status", "input": {}})["result"]["content"])
    check(st.get("active") is True and st["calls"] >= 1 and st["key_source"].startswith("file:"), f"jev_status active, calls={st.get('calls')}, key_source={st.get('key_source')}")
    _, ev = h.command("status")
    check(any(e["kind"] == "table" for e in ev), "/jev status renders a table")
    _, ev = h.command("test")
    check(any("risk" in e.get("content", "") for e in ev if e["kind"] == "text"), "/jev test ran a live decision")
    _, ev = h.command("")
    check(any("/jev key" in e.get("content", "") for e in ev), "/jev (no args) prints usage")
    err = h.close()
    check("active (" in err, "stderr logged activation")

    print("── 6. lazy pickup from file in a fresh inert process")
    base2 = tempfile.mkdtemp(prefix="jev-keys-")
    h2 = Host(base2)
    r = h2.hook("before_tool_call", tool_name="bash", tool_runtime_name="bash", tool_input={"command": "cat ~/.ssh/id_ed25519"})
    check(r["action"] == "continue", "inert before the key exists")
    os.makedirs(os.path.dirname(h2.store), exist_ok=True)
    with open(h2.store, "w") as fh:
        fh.write(f"# written by setup.sh\napi_key = {good}\n")
    # recheck interval is 5 s; the first recheck already happened at the hook above, so wait it out
    time.sleep(5.2)
    r = h2.hook("before_tool_call", tool_name="bash", tool_runtime_name="bash", tool_input={"command": "cat ~/.ssh/id_ed25519"})
    check(r["action"] == "confirm", f"picked up the key without restart → {r['action']}")
    h2.close()

    print()
    if fails:
        print(f"✗ {fails} failure(s)"); sys.exit(1)
    print("✓ key-setup e2e clean")


if __name__ == "__main__":
    main()
