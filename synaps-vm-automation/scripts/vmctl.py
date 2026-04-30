#!/usr/bin/env python3
"""Host-side virsh helper for Synaps VM automation."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

PLUGIN_VERSION = "0.1.0"
MIN_AGENT_VERSION = "0.1.0"


@dataclass(slots=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str


class VirshError(RuntimeError):
    pass


def run_command(command: list[str]) -> CommandResult:
    completed = subprocess.run(command, text=True, capture_output=True, check=False)
    return CommandResult(completed.returncode, completed.stdout, completed.stderr)


def require_success(result: CommandResult, command: list[str]) -> str:
    if result.returncode != 0:
        raise VirshError(f"command failed ({result.returncode}): {' '.join(command)}: {result.stderr.strip()}")
    return result.stdout


def virsh(args: list[str]) -> str:
    command = ["virsh", *args]
    return require_success(run_command(command), command)


def list_vms(_: argparse.Namespace) -> dict[str, Any]:
    output = virsh(["list", "--all", "--name"])
    vms = [line.strip() for line in output.splitlines() if line.strip()]
    return {"vms": [{"name": name, "state": _domstate(name, missing_ok=True)} for name in vms]}


def status(args: argparse.Namespace) -> dict[str, Any]:
    vm = args.vm
    ips = _ip_candidates(vm)
    agent = _agent_health(ips, args.agent_port, args.token)
    return {
        "vm": vm,
        "plugin_version": PLUGIN_VERSION,
        "min_agent_version": MIN_AGENT_VERSION,
        "domain_state": _domstate(vm),
        "ip_candidates": ips,
        "qemu_guest_agent": _qemu_guest_ping(vm),
        "display": _domdisplay(vm),
        "guest_agent": agent,
        "compatible": _compatible(agent.get("version")),
    }


def lifecycle(args: argparse.Namespace) -> dict[str, Any]:
    command = {"start": ["start", args.vm], "shutdown": ["shutdown", args.vm, "--mode=agent"], "reboot": ["reboot", args.vm, "--mode=agent"]}[args.command]
    output = virsh(command)
    return {"vm": args.vm, "operation": args.command, "output": output.strip()}


def snapshot_create(args: argparse.Namespace) -> dict[str, Any]:
    command = ["snapshot-create-as", args.vm, args.name]
    if args.description:
        command.extend(["--description", args.description])
    output = virsh(command)
    return {"vm": args.vm, "snapshot": args.name, "output": output.strip()}


def snapshot_list(args: argparse.Namespace) -> dict[str, Any]:
    output = virsh(["snapshot-list", args.vm, "--name"])
    return {"vm": args.vm, "snapshots": [line.strip() for line in output.splitlines() if line.strip()]}


def snapshot_revert(args: argparse.Namespace) -> dict[str, Any]:
    if not args.yes:
        raise VirshError("snapshot-revert can discard VM state; rerun with --yes after confirmation")
    output = virsh(["snapshot-revert", args.vm, args.name])
    return {"vm": args.vm, "snapshot": args.name, "reverted": True, "output": output.strip()}


def agent_call(args: argparse.Namespace) -> dict[str, Any]:
    ips = _ip_candidates(args.vm)
    if not ips:
        raise VirshError("no guest IP candidates found")
    method = args.method.upper()
    body = json.loads(args.body) if args.body else None
    last_error = None
    for ip in ips:
        try:
            return {"vm": args.vm, "ip": ip, "response": _http_json(ip, args.endpoint, args.agent_port, args.token, method, body)}
        except Exception as exc:  # noqa: BLE001 - report all candidate failures
            last_error = str(exc)
    raise VirshError(f"agent call failed for all IPs: {last_error}")


def _domstate(vm: str, *, missing_ok: bool = False) -> str | None:
    try:
        return virsh(["domstate", vm]).strip()
    except Exception:
        if missing_ok:
            return None
        raise


def _ip_candidates(vm: str) -> list[str]:
    try:
        output = virsh(["domifaddr", vm, "--source", "agent"])
    except Exception:
        return []
    ips: list[str] = []
    for token in output.replace("/", " ").split():
        parts = token.split(".")
        if len(parts) == 4 and all(part.isdigit() and 0 <= int(part) <= 255 for part in parts):
            ips.append(token)
    return ips


def _qemu_guest_ping(vm: str) -> dict[str, Any]:
    result = run_command(["virsh", "qemu-agent-command", vm, '{"execute":"guest-ping"}'])
    return {"ok": result.returncode == 0, "stderr": result.stderr.strip() if result.returncode else ""}


def _domdisplay(vm: str) -> str | None:
    result = run_command(["virsh", "domdisplay", vm])
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def _agent_health(ips: list[str], port: int, token: str | None) -> dict[str, Any]:
    for ip in ips:
        try:
            health = _http_json(ip, "/health", port, token, "GET", None)
            return {"reachable": True, "ip": ip, **health}
        except Exception:
            continue
    return {"reachable": False}


def _http_json(ip: str, endpoint: str, port: int, token: str | None, method: str, body: Any) -> Any:
    url = f"http://{ip}:{port}{endpoint if endpoint.startswith('/') else '/' + endpoint}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read().decode("utf-8"))


def _compatible(agent_version: str | None) -> bool | None:
    if not agent_version:
        return None
    return tuple(map(int, agent_version.split(".")[:3])) >= tuple(map(int, MIN_AGENT_VERSION.split(".")))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Synaps virsh VM automation helper")
    parser.add_argument("--json", action="store_true", default=True)
    parser.add_argument("--agent-port", type=int, default=8765)
    parser.add_argument("--token", default=os.environ.get("SYNAPS_VM_AGENT_TOKEN"))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list").set_defaults(func=list_vms)
    for name in ["status", "start", "shutdown", "reboot"]:
        p = sub.add_parser(name)
        p.add_argument("vm")
        p.set_defaults(func=status if name == "status" else lifecycle)
    p = sub.add_parser("snapshot-create")
    p.add_argument("vm"); p.add_argument("name"); p.add_argument("--description")
    p.set_defaults(func=snapshot_create)
    p = sub.add_parser("snapshot-list")
    p.add_argument("vm"); p.set_defaults(func=snapshot_list)
    p = sub.add_parser("snapshot-revert")
    p.add_argument("vm"); p.add_argument("name"); p.add_argument("--yes", action="store_true")
    p.set_defaults(func=snapshot_revert)
    p = sub.add_parser("agent-call")
    p.add_argument("vm"); p.add_argument("endpoint"); p.add_argument("--method", default="GET"); p.add_argument("--body")
    p.set_defaults(func=agent_call)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        print(json.dumps(args.func(args), indent=2, sort_keys=True))
        return 0
    except Exception as exc:  # noqa: BLE001 - CLI returns structured errors
        print(json.dumps({"error": {"code": exc.__class__.__name__, "message": str(exc)}}, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
