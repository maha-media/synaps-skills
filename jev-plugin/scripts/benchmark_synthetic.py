#!/usr/bin/env python3
"""Opt-in LIVE synthetic measurement. Never reads project data or prints keys."""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev import keys, triage
from jev.audit import Audit
from jev.client import DecisionClient

CASES = [
    ('Command failed (exit 127):\nbash: widget: command not found', 'dependency'),
    ('Command failed (exit 1):\nSyntaxError: invalid syntax at demo.py:3', 'syntax'),
    ('Command failed (exit 1):\nAssertionError: expected 2, got 3', 'assertion'),
    ('Command failed (exit 1):\nPermission denied opening /public/example', 'permission'),
    ('Command timed out after 30s', 'timeout'),
    ('BUILD FAILED\nRequired SDK version 8 is missing; installed version is 7', 'environment'),
    ('Command failed (exit 2):\nunexplained', None),
    ('All 12 tests passed', None),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Consent to <=8 fixed public synthetic cases using the configured key')
    args = parser.parse_args()
    if not args.live:
        parser.exit(2, 'Not run: explicit --live required. No key discovery performed.\n')
    key, _ = keys.discover()
    if not key:
        parser.exit(2, 'Not run: no configured key.\n')
    client = DecisionClient(key)
    runner, audit = triage.Triage(), Audit(None)
    correct = abstain = 0
    t0 = time.monotonic()
    for output, expected in CASES:
        params = {'tool_name': 'bash', 'tool_output': output}
        result = runner.handle(params, client, True, audit) if triage.recognized(params) else triage.CONTINUE
        if result == triage.CONTINUE:
            abstain += 1
            correct += expected is None
        else:
            correct += expected is not None and ('category=' + expected + ';') in result['output'][len(output):]
    print(json.dumps({'cases': len(CASES), 'correct_including_expected_abstentions': correct,
                      'abstain': abstain, 'total_latency_ms': round((time.monotonic()-t0)*1000),
                      'stats': client.stats.snapshot(),
                      'caveat': 'Synthetic labels only; estimated Jev cost, not actual savings or real-world accuracy.'}, indent=2))


if __name__ == '__main__':
    main()
