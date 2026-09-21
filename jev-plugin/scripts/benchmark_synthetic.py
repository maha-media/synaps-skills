#!/usr/bin/env python3
"""Opt-in LIVE synthetic measurement. Never reads project data or prints keys."""
import argparse
import json
import math
import re
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
    print(json.dumps(measure(client), indent=2))


def measure(client):
    """Only fixed synthetic inputs; emit labels and timing, never raw errors."""
    runner, audit = triage.Triage(), Audit(None)
    rows = []
    t0 = time.monotonic()
    for i, (output, expected) in enumerate(CASES[:8]):
        started = time.monotonic()
        result = runner.handle({'tool_name': 'bash', 'tool_output': output}, client, True, audit)
        advice = result.get('output', '')[len(output):]
        match = re.search(r'category=([a-z]+);', advice)
        predicted = match.group(1) if match else None
        rows.append({'case': i + 1, 'expected': expected, 'predicted': predicted,
                     'abstain': predicted is None,
                     'latency_ms': round((time.monotonic() - started) * 1000, 3)})
    timings = sorted(row['latency_ms'] for row in rows)
    def percentile(p):
        # Nearest-rank percentile; n <= 8, so p95 is the slowest case.
        return timings[max(0, math.ceil(p * len(timings)) - 1)] if timings else 0
    return {'cases': len(rows), 'results': rows,
            'correct_including_expected_abstentions': sum(r['expected'] == r['predicted'] for r in rows),
            'abstain': sum(r['abstain'] for r in rows),
            'total_latency_ms': round((time.monotonic() - t0) * 1000),
            'p50_latency_ms': percentile(.50), 'p95_latency_ms': percentile(.95),
            'stats': client.stats.snapshot(),
            'caveat': 'Synthetic labels only; estimated Jev cost, not actual savings or real-world accuracy.'}


if __name__ == '__main__':
    main()
