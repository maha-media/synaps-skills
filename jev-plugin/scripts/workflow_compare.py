#!/usr/bin/env python3
"""Offline-first public toy workflow replay. No provider integration or sandbox."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
import time

MODES = ("off", "selected", "deterministic")
FEATURES = ("guard", "router", "triage", "reports", "evidence", "verification", "discovery", "diagnosis", "context", "compress")
CONFIGS = {mode: {**{k: False for k in FEATURES}, "compress_mode": "jev"} for mode in MODES}
CONFIGS["selected"].update(router=True, triage=True)
CONFIGS["deterministic"].update(compress=True, compress_mode="deterministic")
TASKS = [
    {"task_id": "parser", "instruction": "Strip surrounding whitespace from each string; preserve all internal whitespace. Write {outputs: [...]} to solution.json.",
     "vectors": ["  alpha  beta \n", "\t gamma\tdelta \t", "   ", "x\ny"]},
    {"task_id": "account-cache", "instruction": "For each public toy [account, resource] pair output the same two-element list as a cache binding key. Never omit account. Write {outputs: [...]} to solution.json. These are not credentials.",
     "vectors": [["toy-a", "inbox"], ["toy-b", "inbox"], ["toy-a", "calendar"], ["toy-a", "inbox"]]},
    {"task_id": "keyboard-focus", "instruction": "Each vector is [initial index, events]. There are three focus positions 0..2. Tab advances cyclically; ShiftTab retreats cyclically; Escape sets 0; other events do nothing. Output final indices in {outputs: [...]} in solution.json.",
     "vectors": [[0, ["Tab", "Tab", "Tab"]], [0, ["ShiftTab"]], [2, ["Escape", "Tab"]], [1, ["noop", "ShiftTab"]]]},
]
# Fixed independent grader labels, never included in task requests.
EXPECTED = {"parser": ["alpha  beta", "gamma\tdelta", "", "x\ny"],
            "account-cache": [["toy-a", "inbox"], ["toy-b", "inbox"], ["toy-a", "calendar"], ["toy-a", "inbox"]],
            "keyboard-focus": [0, 2, 1, 0]}
FIELDS = ("input_tokens", "output_tokens", "cost_usd", "requests", "retries")
LIMIT = 8192


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def sha(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def starter(task):
    return {"request.json": canonical(task).decode(), "solution.json": '{"outputs":[]}\n'}


def template(task, mode, model):
    return {"schema": 1, "task_id": task["task_id"], "mode": mode, "model": model,
            "task_sha": sha(task), "input_sha": sha(starter(task)),
            "main_model": dict.fromkeys(FIELDS), "jev": dict.fromkeys((*FIELDS, "wire_attempts")),
            "verification": {"claimed_passed": None}}


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def reject_constant(_):
    raise ValueError("nonfinite JSON")


def read_json(root, relative):
    """Open fixed bundle paths without following symlinks (including parents)."""
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in relative.split("/")[:-1]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = new
        file_fd = os.open(relative.split("/")[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file_fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT or info.st_nlink != 1:
                raise ValueError("not a bounded regular file")
            data = stream.read(LIMIT + 1)
            if len(data) > LIMIT:
                raise ValueError("oversize")
        return json.loads(data, object_pairs_hook=pairs, parse_constant=reject_constant)
    finally:
        os.close(fd)


def validate(result, expected):
    if type(result) is not dict or result.keys() != expected.keys():
        raise ValueError("result shape")
    for key in ("schema", "task_id", "mode", "model", "task_sha", "input_sha"):
        if type(result[key]) is not type(expected[key]) or result[key] != expected[key]:
            raise ValueError("identity mismatch")
    for group in ("main_model", "jev"):
        values = result[group]
        if type(values) is not dict or values.keys() != expected[group].keys():
            raise ValueError("usage shape")
        for key, value in values.items():
            if value is None:
                continue
            allowed = (int, float) if key == "cost_usd" else (int,)
            if type(value) not in allowed or not 0 <= value <= 1_000_000_000 or not math.isfinite(value):
                raise ValueError("usage range")
    v = result["verification"]
    if type(v) is not dict or v.keys() != {"claimed_passed"} or (v["claimed_passed"] is not None and type(v["claimed_passed"]) is not bool):
        raise ValueError("verification shape")
    return result


def grade(root, task):
    try:
        solution = read_json(root, "workspace/solution.json")
        # Canonical equality distinguishes booleans from integers; exact schema.
        return "passed" if canonical(solution) == canonical({"outputs": EXPECTED[task["task_id"]]}) else "failed"
    except (ValueError, OSError, RecursionError, UnicodeError):
        return "failed"


def total(values):
    return None if any(v is None for v in values) else sum(values)


def run_one(args, task, mode, repeat):
    expected = template(task, mode, args.model)
    record = {"task_id": task["task_id"], "mode": mode, "repeat": repeat,
              "input_sha": expected["input_sha"], "task_sha": expected["task_sha"],
              "status": "planned", "grader": "unknown", "wall_seconds": None,
              "usage": expected, "total_cost_usd": None}
    if not args.execute:
        return record
    with tempfile.TemporaryDirectory(prefix="workflow-compare-") as directory:
        root = Path(directory)
        workspace = root / "workspace"
        workspace.mkdir()
        for name, contents in starter(task).items():
            (workspace / name).write_text(contents, encoding="utf-8")
        home = root / "home"
        home.mkdir()
        base = root / "synaps"
        base.mkdir()
        request = {"schema": 1, "task": task, "mode_config": CONFIGS[mode], "result_template": expected}
        (root / "task.json").write_bytes(canonical(request))
        env = {k: os.environ[k] for k in ("PATH", "LANG", *args.pass_env) if k in os.environ}
        env.update(HOME=str(home), SYNAPS_BASE_DIR=str(base))
        argv = [args.runner, *args.runner_arg, "--task", str(root / "task.json"),
                "--workspace", str(workspace), "--result", str(root / "result.json"), "--mode", mode]
        start = time.monotonic()
        status = "launch_failed"
        try:
            with subprocess.Popen(argv, shell=False, cwd=root, env=env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True) as proc:
                try:
                    status = "completed" if proc.wait(timeout=args.timeout) == 0 else "nonzero"
                except subprocess.TimeoutExpired:
                    status = "timeout"
                finally:
                    # Terminate the process group even if the leader left descendants.
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait()
        except OSError:
            pass
        record["wall_seconds"] = time.monotonic() - start
        record["status"] = status
        record["grader"] = grade(root, task)
        if status == "completed":
            try:
                record["usage"] = validate(read_json(root, "result.json"), expected)
                record["total_cost_usd"] = total([record["usage"][g]["cost_usd"] for g in ("main_model", "jev")])
            except (ValueError, OSError, RecursionError, UnicodeError, OverflowError):
                record["status"] = "invalid_result"
    return record


def summarize(runs):
    summaries = {}
    for mode in MODES:
        rows = [r for r in runs if r["mode"] == mode]
        summaries[mode] = {"runs": len(rows), "completed": sum(r["status"] == "completed" for r in rows),
                           "quality": {label: sum(r["grader"] == label for r in rows) for label in ("passed", "failed", "unknown")},
                           "wall_seconds": total([r["wall_seconds"] for r in rows]),
                           "total_cost_usd": total([r["total_cost_usd"] for r in rows]),
                           "usage_totals": {g: {k: total([r["usage"][g][k] for r in rows]) for k in rows[0]["usage"][g]} for g in ("main_model", "jev")}}
    identities_match = all(
        len({(r["task_sha"], r["input_sha"], r["usage"]["model"]) for r in runs if r["task_id"] == task["task_id"]}) == 1
        and {r["mode"] for r in runs if r["task_id"] == task["task_id"]} == set(MODES)
        for task in TASKS)
    comparable = identities_match and all(r["status"] == "completed" and r["grader"] == "passed" and r["usage"]["model"] is not None
                     and all(v is not None for g in ("main_model", "jev") for v in r["usage"][g].values()) for r in runs)
    return summaries, {"comparable": comparable,
                       "reason": "same harness adapter identity, fixed model/task/input; adapter-asserted usage only" if comparable else "incomparable: require every run completed, locally correct, fixed non-null model and all usage known",
                       "cost_delta_vs_off_usd": {mode: summaries[mode]["total_cost_usd"] - summaries["off"]["total_cost_usd"] if comparable else None for mode in MODES[1:]}}


def bounded_int(low, high):
    def parse(value):
        number = int(value)
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f"must be {low}..{high}")
        return number
    return parse


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--runner")
    parser.add_argument("--runner-arg", action="append", default=[])
    parser.add_argument("--pass-env", action="append", default=[])
    parser.add_argument("--model")
    parser.add_argument("--repeats", type=bounded_int(1, 3), default=1)
    parser.add_argument("--timeout", type=bounded_int(1, 120), default=30)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)
    if args.execute:
        if not args.runner or not os.path.isabs(args.runner) or not os.path.isfile(args.runner) or not os.access(args.runner, os.X_OK):
            parser.error("execution requires an absolute executable --runner")
    elif args.runner or args.runner_arg or args.pass_env or args.repeats != 1:
        parser.error("runner, environment forwarding and repeats require --execute")
    if args.model is not None and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}", args.model):
        parser.error("model must be a bounded public identifier")
    if len(args.pass_env) > 16 or any(not re.fullmatch(r"[A-Z][A-Z0-9_]{0,63}", name) or name in {"HOME", "SYNAPS_BASE_DIR"} for name in args.pass_env):
        parser.error("pass-env requires at most 16 bounded names; isolated directories cannot be overridden")
    return args


def build_report(args):
    runs = [run_one(args, task, mode, repeat) for repeat in range(1, args.repeats + 1) for task in TASKS for mode in MODES]
    summary, comparison = summarize(runs)
    return {"schema": 1, "kind": "public-toy-workflow-replay", "executed": args.execute,
            "provenance": "adapter-supplied usage, not trusted or invoiced; local fixed data grader; not a production or LLM benchmark",
            "adapter_identity": sha([args.runner, args.runner_arg]) if args.execute else None,
            "model": args.model, "mode_configs": CONFIGS, "fixtures": [{"task": t, "starter_files": starter(t)} for t in TASKS],
            "protocol": {"result_limit_bytes": LIMIT, "solution": {"outputs": []}, "workers": 1,
                         "result_template": template(TASKS[0], "off", args.model)},
            "runs": runs, "summary": summary, "comparison": comparison}


def main(argv=None):
    args = arguments(argv)
    report = build_report(args)
    encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if args.output:
        # Explicit output only; never overwrite files or follow symlinks.
        with args.output.open("x", encoding="utf-8") as stream:
            stream.write(encoded)
    else:
        print(encoded, end="")
    return 0 if not args.execute or all(r["status"] == "completed" and r["grader"] == "passed" for r in report["runs"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
