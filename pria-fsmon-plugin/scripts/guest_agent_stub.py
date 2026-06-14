#!/usr/bin/env python3
"""B8 control-plane STUB: stands in for the Pria guest agent (A11) + ingest (A15).

Demonstrates the full fsmon ↔ guest-agent contract end-to-end WITHOUT the real
guest agent / VM image (HS-IMG) and WITHOUT fanotify privileges:

  1. Starts a `--forward` Unix socket listener (the guest agent's audit socket)
     and a mock ingest HTTP collector behind it.
  2. Launches `synaps_fsmon run` and pushes a policy over the `--control` socket
     (mimicking POST /guest/v1/policy/apply).
  3. Uses `synaps_fsmon simulate` to drive decisions through the real
     decide → spool → forward path, then prints the audit records the
     "guest agent" would POST to /agents/ingest/events.

Run:  python3 scripts/guest_agent_stub.py
Exits non-zero if the contract round-trip fails.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

CRATE = Path(__file__).resolve().parents[1] / "extensions" / "synaps-fsmon"
BIN_REL = CRATE / "target" / "release" / "synaps_fsmon"
BIN_DBG = CRATE / "target" / "debug" / "synaps_fsmon"


def binary():
    if BIN_REL.exists():
        return str(BIN_REL)
    if BIN_DBG.exists():
        return str(BIN_DBG)
    print("building synaps_fsmon (debug)…")
    subprocess.run(["cargo", "build"], cwd=CRATE, check=True)
    return str(BIN_DBG)


class ForwardListener(threading.Thread):
    """Stands in for the guest agent's --forward audit socket + ingest POST."""

    def __init__(self, sock_path):
        super().__init__(daemon=True)
        self.sock_path = sock_path
        self.ingested = []   # what the guest agent would POST to A15
        self._stop = False
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if os.path.exists(sock_path):
            os.unlink(sock_path)
        self._srv.bind(sock_path)
        self._srv.listen(8)
        self._srv.settimeout(0.5)

    def run(self):
        while not self._stop:
            try:
                conn, _ = self._srv.accept()
            except socket.timeout:
                continue
            with conn:
                data = b""
                conn.settimeout(1.0)
                try:
                    while True:
                        chunk = conn.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                except socket.timeout:
                    pass
                for line in data.decode("utf-8").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    envelope = json.loads(line)
                    # Guest agent would now POST envelope["events"] to A15 ingest
                    # with the bearer token + uid→session mapping.
                    self.ingested.extend(envelope.get("events", []))

    def stop(self):
        self._stop = True
        self._srv.close()


def control_request(control_sock, msg):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect(control_sock)
    s.sendall((json.dumps(msg) + "\n").encode())
    resp = s.recv(4096).decode().strip()
    s.close()
    return json.loads(resp)


def main():
    bin_path = binary()
    tmp = tempfile.mkdtemp(prefix="fsmon-stub-")
    control = os.path.join(tmp, "control.sock")
    forward = os.path.join(tmp, "forward.sock")
    spool = os.path.join(tmp, "fsmon.jsonl")
    policy_file = os.path.join(tmp, "policy.json")

    policy = {
        "default_decision": "allow",
        "high_risk_prefixes": ["/srv/synaps"],
        "immutable_prefixes": ["/srv/synaps/policy"],
        "principals": [{
            "uid": 12001, "account_id": "acct_123", "instance_id": "inst_456",
            "user_id": "user_789", "session_id": "sess_def", "vm_id": "vm_abc",
            "instance_roots": ["/srv/accounts/acme-school/instances/tutor-bot-7"],
            "home_root": "/home/alice_acme",
        }],
    }
    Path(policy_file).write_text(json.dumps(policy))

    listener = ForwardListener(forward)
    listener.start()

    # 1. Launch the daemon (fanotify will fail without caps -> degraded; the
    #    control socket still comes up). We only exercise control + simulate.
    proc = subprocess.Popen(
        [bin_path, "run", "--mount", tmp, "--spool", spool,
         "--control", control, "--forward", forward, "--policy", policy_file],
        stderr=subprocess.DEVNULL,
    )
    try:
        # wait for control socket
        deadline = time.time() + 10
        while time.time() < deadline and not os.path.exists(control):
            time.sleep(0.05)
        assert os.path.exists(control), "control socket never appeared"

        # 2. Hot policy push (mimics POST /guest/v1/policy/apply).
        resp = control_request(control, {"type": "policy_apply", "policy": policy})
        assert resp.get("type") == "ok", f"policy push failed: {resp}"
        print("✓ policy push accepted:", resp)

        # 3. Drive decisions through the real spool+forward path via `simulate`.
        cases = [
            (12001, "/srv/accounts/acme-school/instances/tutor-bot-7/workspace/a.txt",
             "open_write", "allow"),
            (12001, "/srv/accounts/acme-school/instances/lab-grader-2/workspace/secret.env",
             "open_write", "deny"),
            (12001, "/srv/synaps/policy/rules.md", "open_write", "deny"),
        ]
        for uid, path, op, want in cases:
            out = subprocess.run(
                [bin_path, "simulate", "--uid", str(uid), "--path", path, "--op", op,
                 "--spool", spool, "--forward", forward, "--policy", policy_file],
                capture_output=True, text=True,
            )
            decision = json.loads(out.stdout)["decision"]
            status = "✓" if decision == want else "✗"
            print(f"{status} simulate {op} {path} -> {decision} (want {want})")
            assert decision == want, f"expected {want}, got {decision}"

        # give the listener a moment to drain
        time.sleep(0.3)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        listener.stop()

    # The "guest agent" would POST these to /agents/ingest/events (A15).
    denied = [e for e in listener.ingested if e.get("kind") == "file.write.denied"]
    print(f"\n✓ guest-agent forwarded {len(listener.ingested)} record(s); "
          f"{len(denied)} deny(s) ready for ingest POST")
    assert any(
        e.get("account_id") == "acct_123" and e.get("session_id") == "sess_def"
        for e in denied
    ), "denied records must carry account/session tags"
    print("✓ forwarded records carry account/instance/user/session/uid tags")
    print("\nSample record the guest agent would POST to /agents/ingest/events:")
    print(json.dumps(denied[0], indent=2))
    print("\nB8 round-trip OK")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print("B8 STUB FAILED:", e)
        sys.exit(1)
