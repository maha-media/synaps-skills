#!/usr/bin/env python3
"""Opt-in bounded Synaps RPC v1 adapter for workflow_compare. Not a sandbox.

No arguments: help only. Execution requires --execute, --synaps-bin and the
harness's --task/--workspace/--result/--mode bundle. Credentials come only from
explicit harness --pass-env forwarding. No billed-cost comparison is available.
"""
import argparse
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import sys
import time

# -I intentionally excludes cwd; only this trusted script directory is imported.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from workflow_compare import (TASKS, CONFIGS, FEATURES, canonical, starter, template,
                              read_json, pairs, reject_constant)

ROOT = Path(__file__).resolve().parents[1]
KEYS = ("TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY")
TOOLS = {"jev_" + name for name in ("decide", "select", "status", "verify", "evidence", "diagnose")}
SYSTEM = "Complete the public toy data task in the current workspace. Read request.json and write solution.json. Avoid unnecessary tools and delegation. Do not alter configuration or accounting files."
FRAME = 1024 * 1024
TOTAL = 16 * FRAME


class Failure(Exception):
    pass


def require(value):
    if not value:
        raise Failure()


def safe_path(value):
    p = Path(value)
    require(p.is_absolute() and str(p) == value and ".." not in p.parts)
    # Reject symlinks in every existing component, not merely the final file.
    for node in (*reversed(p.parents), p):
        require(not node.is_symlink())
    return p


def exclusive(path, data, limit=8192):
    require(len(data) <= limit)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(data)


def validate_bundle(a):
    task_path, ws, result = map(safe_path, (a.task, a.workspace, a.result))
    root = task_path.parent
    require(task_path == root / "task.json" and ws == root / "workspace" and result == root / "result.json")
    require(not result.exists())
    home, base = map(safe_path, (os.environ.get("HOME", ""), os.environ.get("SYNAPS_BASE_DIR", "")))
    require(home == root / "home" and base == root / "synaps")
    require(home.is_dir() and base.is_dir() and not list(home.iterdir()) and not list(base.iterdir()))
    require(set(p.name for p in root.iterdir()) == {"task.json", "workspace", "home", "synaps"})
    require(set(p.name for p in ws.iterdir()) == {"request.json", "solution.json"})
    request = read_json(root, "task.json")
    require(type(request) is dict and request.keys() == {"schema", "task", "mode_config", "result_template"})
    task = next((t for t in TASKS if canonical(t) == canonical(request["task"])), None)
    require(task is not None and a.mode in CONFIGS)
    model = request["result_template"].get("model")
    require(type(model) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}", model))
    expected = template(task, a.mode, model)
    require(canonical(request) == canonical({"schema": 1, "task": task,
            "mode_config": CONFIGS[a.mode], "result_template": expected}))
    for name, contents in starter(task).items():
        read_json(root, "workspace/" + name)  # bounded regular, single-link, nofollow
        require((ws / name).read_bytes() == contents.encode())
    require(a.mode != "selected" or bool(os.environ.get("TYPESAFE_API_KEY", "").strip()))
    binary = safe_path(a.synaps_bin)
    require(binary.is_file() and os.access(binary, os.X_OK))
    return root, ws, base, expected, task


def prepare(base, mode):
    plugin = base / "plugins" / "jev"
    (plugin / ".synaps-plugin").mkdir(parents=True)
    # Only trusted manifest + Python extension sources, never caches/config/symlinks.
    manifest = ROOT / ".synaps-plugin" / "plugin.json"
    require(not manifest.is_symlink())
    doc = json.loads(manifest.read_bytes())
    doc["extension"]["args"] = ["-u", "extensions/workflow_jev_snapshot.py"]
    exclusive(plugin / ".synaps-plugin" / "plugin.json", canonical(doc), limit=65536)
    for source in sorted((ROOT / "extensions").rglob("*.py")):
        relative = source.relative_to(ROOT / "extensions")
        if "__pycache__" in relative.parts or any(p.is_symlink() for p in (source, *source.parents)):
            continue
        target = plugin / "extensions" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        # Source modules can exceed the result-file bound.
        with target.open("xb") as out:
            out.write(source.read_bytes())
    wrapper = ROOT / "scripts" / "workflow_jev_snapshot.py"
    require(not wrapper.is_symlink())
    exclusive(plugin / "extensions" / wrapper.name, wrapper.read_bytes())
    config = {**CONFIGS[mode], "audit_file": "", "budget_enabled": False}
    lines = [f"extension.jev.{k} = {str(v).lower() if type(v) is bool else v}" for k, v in config.items()]
    exclusive(base / "config", ("\n".join([*lines, "events.auto_turn = false"]) + "\n").encode())


class Frames:
    def __init__(self, proc, deadline):
        self.proc, self.deadline = proc, deadline
        self.buffer = b""
        self.total = self.count = 0

    def next(self):
        while True:
            require(time.monotonic() < self.deadline)
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                self.count += 1
                require(len(line) <= FRAME and self.count <= 100000)
                value = json.loads(line, object_pairs_hook=pairs, parse_constant=reject_constant)
                require(type(value) is dict and value.get("type") != "error")
                return value
            require(len(self.buffer) <= FRAME)
            ready, _, _ = select.select([self.proc.stdout], [], [], max(0, self.deadline - time.monotonic()))
            require(ready)
            data = os.read(self.proc.stdout.fileno(), 65536)
            require(data)
            self.total += len(data)
            require(self.total <= TOTAL)
            self.buffer += data


def send(proc, value, deadline):
    data = canonical(value) + b"\n"
    fd = proc.stdin.fileno()
    os.set_blocking(fd, False)
    while data:
        require(time.monotonic() < deadline)
        _, ready, _ = select.select([], [fd], [], max(0, deadline - time.monotonic()))
        require(ready)
        try:
            data = data[os.write(fd, data):]
        except BlockingIOError:
            continue


def descendants(pid):
    """Linux ordinary descendants; child stays in the outer harness process group.

    No setsid/daemonization: outer SIGKILL still reaches the entire job even if
    this adapter cannot run cleanup. This is not containment of hostile tools.
    """
    found = []
    try:
        children = Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
    except OSError:
        return found
    for child in children:
        found.extend(descendants(int(child)))
        found.append(int(child))
    return found


def cleanup(proc, known):
    for pid in set(descendants(os.getpid()) + known + [proc.pid]):
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    proc.wait()


def count(value, nullable=False):
    require((nullable and value is None) or (type(value) is int and 0 <= value <= 1_000_000_000))
    return value


def jev_usage(base, mode):
    data = read_json(base, "workflow-stats.json")
    require(type(data) is dict and data.keys() == {"stats", "features", "compress_mode"})
    require(canonical(data["features"]) == canonical({**{k: CONFIGS[mode][k] for k in FEATURES}, "tools": True}))
    require(data["compress_mode"] == CONFIGS[mode]["compress_mode"])
    s = data["stats"]
    require(type(s) is dict and s.keys() == {
        "calls", "errors", "input_tokens", "cost_usd", "known_input_tokens", "known_cost_usd",
        "unknown_usage_calls", "unknown_usage_attempts", "wire_attempts", "retries", "mean_ms",
        "model", "by_op", "op_stats", "cost_basis"})
    require(type(s["model"]) is str and len(s["model"]) <= 256)
    require(s["cost_basis"] == "estimated Jev input-token cost only; no savings estimate")
    require(type(s["by_op"]) is dict and type(s["op_stats"]) is dict)
    operations = {"guard", "router", "triage", "reports", "evidence", "verification", "discovery",
                  "diagnose", "compress", "decide", "select", "test", "probe"}
    require(s["by_op"].keys() <= operations and s["op_stats"].keys() == s["by_op"].keys())
    for op, calls in s["by_op"].items():
        count(calls)
        detail = s["op_stats"][op]
        require(type(detail) is dict and detail.keys() == {
            "calls", "errors", "known_input_tokens", "total_ms", "unknown_usage_calls",
            "wire_attempts", "unknown_usage_attempts", "retries", "mean_ms", "known_cost_usd",
            "input_tokens", "cost_usd"})
        for key, value in detail.items():
            if key.endswith("cost_usd"):
                require(value is None or (type(value) in (int, float) and math.isfinite(value)
                                         and 0 <= value <= 1_000_000_000))
            else:
                count(value, key == "input_tokens")
        require(detail["calls"] == calls)
    require(sum(s["by_op"].values()) == s["calls"])
    for k in ("calls", "errors", "wire_attempts", "retries", "unknown_usage_calls", "unknown_usage_attempts", "known_input_tokens", "mean_ms"):
        count(s[k])
    tokens = count(s["input_tokens"], True)
    cost = s["cost_usd"]
    require(cost is None or (type(cost) in (int, float) and math.isfinite(cost) and 0 <= cost <= 1_000_000_000))
    require(s["retries"] <= s["wire_attempts"] and s["errors"] <= s["calls"])
    require(s["unknown_usage_calls"] <= s["calls"] and s["unknown_usage_attempts"] <= s["wire_attempts"])
    known_cost = s["known_cost_usd"]
    require(type(known_cost) in (int, float) and math.isfinite(known_cost)
            and known_cost == s["known_input_tokens"] * 0.042 / 1_000_000)
    unknown = s["unknown_usage_calls"] or s["unknown_usage_attempts"]
    require((tokens is None and cost is None) if unknown else (tokens == s["known_input_tokens"] and cost is not None))
    if cost is not None:
        require(cost == round(known_cost, 6))
    zero = s["wire_attempts"] == 0
    if zero:
        require(all(s[k] == 0 for k in ("calls", "errors", "retries", "unknown_usage_calls", "unknown_usage_attempts", "known_input_tokens", "input_tokens", "cost_usd")))
    return {"input_tokens": tokens, "output_tokens": 0 if zero else None,
            "cost_usd": cost, "requests": s["calls"], "retries": s["retries"], "wire_attempts": s["wire_attempts"]}


def run(a):
    root, ws, base, result, task = validate_bundle(a)
    prepare(base, a.mode)
    env = {k: os.environ[k] for k in ("PATH", "LANG", *KEYS) if k in os.environ}
    env.update(HOME=str(root / "home"), SYNAPS_BASE_DIR=str(base),
               RAYON_NUM_THREADS="1", TOKIO_WORKER_THREADS="1", OMP_NUM_THREADS="1",
               OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1", PYTHONDONTWRITEBYTECODE="1")
    deadline = time.monotonic() + a.timeout
    proc = subprocess.Popen([a.synaps_bin, "rpc", "--model", result["model"], "--system", SYSTEM],
                            cwd=ws, env=env, shell=False, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    known = []
    def interrupted(_signum, _frame):
        raise Failure()
    old = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        frames = Frames(proc, deadline)
        ready = frames.next()
        require(ready.get("type") == "ready" and type(ready.get("protocol_version")) is int
                and ready["protocol_version"] == 1 and ready.get("model") == result["model"])
        send(proc, {"type": "tools_list", "id": "tools"}, deadline)
        tools = frames.next()
        require(tools.get("type") == "response" and tools.get("id") == "tools" and tools.get("command") == "tools_list" and tools.get("ok") is True)
        require(type(tools.get("tools")) is list)
        names = {t.get("name") for t in tools["tools"] if type(t) is dict}
        # Host extension registry namespaces process tools as jev_jev_*.
        require(TOOLS <= names or {"jev_" + n for n in TOOLS} <= names)
        jev_usage(base, a.mode)  # Verify the loaded instance before any model turn.
        send(proc, {"type": "prompt", "id": "task", "message": SYSTEM + "\nPublic task JSON:\n" + canonical(task).decode()}, deadline)
        usage = None
        while True:
            event = frames.next()
            kind = event.get("type")
            if kind == "agent_end":
                require(usage is None)
                usage = event.get("usage")
                require(type(usage) is dict)
                for k in ("input_tokens", "output_tokens"):
                    count(usage.get(k))
                require(usage.get("model") in (None, result["model"]))
            elif kind == "response":
                require(event.get("id") == "task" and event.get("command") == "prompt" and event.get("ok") is True
                        and event.get("cancelled", False) is False and usage is not None)
                break
            else:
                require(kind == "message_update")  # No extra turns/delegation/events.
            # Raw text/thinking is discarded, never logged or used as accounting.
        known = descendants(proc.pid)
        send(proc, {"type": "shutdown"}, deadline)
        proc.stdin.close()
        # Drain bounded frames until EOF and require clean shutdown within deadline.
        while True:
            require(time.monotonic() < deadline)
            ready, _, _ = select.select([proc.stdout], [], [], max(0, deadline - time.monotonic()))
            require(ready)
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            # No unsolicited terminal frames permitted after our only turn.
            raise Failure()
        require(not frames.buffer)
        require(proc.wait(timeout=max(0.001, deadline - time.monotonic())) == 0)
    finally:
        cleanup(proc, known)
        for sig, handler in old.items():
            signal.signal(sig, handler)
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.close()
        proc.stdout.close()
    result["jev"] = jev_usage(base, a.mode)
    for k in ("input_tokens", "output_tokens"):
        result["main_model"][k] = usage[k] if usage[k] > 0 else None
    exclusive(root / "result.json", canonical(result))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    for name in ("synaps-bin", "task", "workspace", "result", "mode"):
        parser.add_argument("--" + name)
    parser.add_argument("--timeout", type=int, default=85)
    args = parser.parse_args(argv)
    if not args.execute:
        parser.print_help()
        return 0
    try:
        require(all((args.synaps_bin, args.task, args.workspace, args.result, args.mode)))
        require(1 <= args.timeout <= 90)
        run(args)
    except (Failure, OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError, subprocess.SubprocessError):
        print("workflow_synaps: failed", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
