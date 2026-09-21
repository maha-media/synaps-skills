#!/usr/bin/env python3
"""Bounded synthetic router comparison; offline unless explicitly --live."""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'extensions'))
from jev import router

PRICE_PER_MTOK_INPUT = .042
READ_ONLY = {'mode': 'read_only'}


def cases():
    docs = {'task': 'Read the public synthetic README: "Hello is a greeting." Summarise it without edits.', 'role': 'researcher'}
    write = {'task': 'Edit the synthetic greeting.py so greet() returns "Hello, world!" instead of "Hi".', 'role': 'implementer'}
    review = {'task': 'Review this public synthetic diff without edits: -return 1\n+return 2. Describe the behaviour change.', 'write_policy': READ_ONLY}
    read = {'task': 'Read this public synthetic text: "The sample app prints Hello." Summarise it; do not edit files.'}
    return [
        ('docs', docs, [{'write_policy': READ_ONLY}], False, False),
        ('write', write, [{}], True, False),
        ('review', review, [{'role': r} for r in ('reviewer', 'researcher')], False, False),
        ('read', read, [{'role': r, 'write_policy': READ_ONLY} for r in ('researcher', 'reviewer')], False, False),
        ('docs_repeat', docs, [{'write_policy': READ_ONLY}], False, True),
        ('review_repeat', review, [{'role': r} for r in ('reviewer', 'researcher')], False, True),
        ('explicit', {'task': 'Summarise the public synthetic greeting without edits.', 'role': 'researcher', 'write_policy': READ_ONLY}, [{}], False, False),
    ]


class Audit:
    def __init__(self):
        self.counts = Counter()

    def bump(self, name):
        self.counts[name] += 1

    def write(self, record):
        # Frozen baseline emits raw records; deliberately discard them.
        pass


class Budget:
    def __init__(self, limit=12):
        if not 0 <= limit <= 12:
            raise ValueError('budget must be at most 12')
        self.limit, self.used = limit, 0

    def take(self):
        if self.used >= self.limit:
            raise RuntimeError('wire budget exhausted')
        self.used += 1


class SingleAttemptClient:
    """Calls the transport once, never DecisionClient.decide (which retries)."""
    def __init__(self, transport, budget):
        self.transport, self.budget = transport, budget
        self.model = transport.model
        self.records = []

    def decide(self, state, questions, *, op):
        self.budget.take()
        record = {'calls': 1, 'questions': len(questions), 'input_tokens': None,
                  'cost_usd': None, 'latency_ms': None, 'transport_error': False}
        self.records.append(record)
        start = time.monotonic()
        try:
            body = json.dumps({'state': state, 'questions': questions, 'model': self.model}).encode()
            response = self.transport._bounded_post(body, self.transport.timeout_s)
            if not isinstance(response, dict):
                raise ValueError('invalid response')
            usage = response.get('usage')
            tokens = usage.get('input_tokens') if isinstance(usage, dict) else None
            if type(tokens) is int and 0 <= tokens <= 2**53 - 1:
                record['input_tokens'] = tokens
                record['cost_usd'] = tokens * PRICE_PER_MTOK_INPUT / 1_000_000
            return response
        except Exception:
            record['transport_error'] = True
            # Both policies fail open on ValueError; never expose exception payloads.
            raise ValueError('benchmark transport failure') from None
        finally:
            record['latency_ms'] = (time.monotonic() - start) * 1000


def baseline():
    fixture = json.loads((ROOT / 'scripts/router-benchmark/baseline.json').read_text())
    namespace = {'time': time, 'DecisionClient': object, 'JevError': ValueError}
    exec(compile(fixture['source'], 'frozen-f3a6d07', 'exec'), namespace)
    return namespace


def assess(original, result, expected, writing):
    output = result.get('input', original) if result.get('action') == 'modify' else original
    preserved = sum(k in output and output[k] == v for k, v in original.items())
    fills = {k: v for k, v in output.items() if k not in original}
    correct = fills in expected and preserved == len(original) and 'model' not in output
    critical = writing and output.get('write_policy') == READ_ONLY
    # A missing allowed fill is abstention, not a wrong positive prediction.
    partial = any(all(k in allowed and allowed[k] == v for k, v in fills.items()) for allowed in expected)
    status = 'correct' if correct else ('abstain' if partial and preserved == len(original) and not critical else 'incorrect')
    return {'fills': fills, 'status': status, 'critical': critical,
            'preserved': preserved, 'explicit_fields': len(original), 'no_model': 'model' not in output}


def metrics(records):
    return {key: (sum(r[key] for r in records) if all(r[key] is not None for r in records) else None)
            for key in ('calls', 'questions', 'input_tokens', 'cost_usd', 'latency_ms')}


def run(clients=None):
    live = clients is not None
    old = baseline()
    cfg = router.RouterConfig({})
    old_cfg = old['RouterConfig']({})
    optimized = router.Router()
    audits = {arm: Audit() for arm in ('baseline', 'optimized')}
    rows = []
    for name, inp, expected, writing, repeat in cases():
        row = {'case': name, 'input': deepcopy(inp), 'expected_fill_sets': expected,
               'writing': writing, 'repeat': repeat}
        for arm in ('baseline', 'optimized'):
            skip = 'role' in inp and 'write_policy' in inp
            q = {} if skip else (old['questions'](False) if arm == 'baseline' else router.questions(inp, cfg))
            planned = bool(q) and not (arm == 'optimized' and repeat)
            data = {'planned_calls': int(planned), 'planned_questions': len(q) if planned else 0,
                    'question_names': list(q) if planned else [], 'calls': None, 'questions': None,
                    'input_tokens': None, 'cost_usd': None, 'latency_ms': None,
                    'assessment': None, 'cache_hits': None}
            if live:
                client = clients[arm]
                before = len(client.records)
                hits = audits[arm].counts['router.cache']
                params = {'tool_name': 'subagent_start', 'session_id': 'synthetic-benchmark', 'tool_input': deepcopy(inp)}
                handler = old['handle'] if arm == 'baseline' else optimized.handle
                try:
                    result = handler(params, client, old_cfg if arm == 'baseline' else cfg, audits[arm], lambda _: None)
                except Exception:
                    # Legacy malformed responses can escape its narrow catch.
                    audits[arm].bump('benchmark.handler_error')
                    result = {'action': 'continue'}
                data.update(metrics(client.records[before:]))
                data['assessment'] = assess(inp, result, expected, writing)
                data['cache_hits'] = audits[arm].counts['router.cache'] - hits
            row[arm] = data
        rows.append(row)
    report = {'mode': 'measured' if live else 'offline-plan', 'baseline_commit': 'f3a6d07',
              'model': clients['baseline'].model if live else None,
              'cost_basis': 'Returned input_tokens × $0.042 / million; output free. Missing usage is null.',
              'rows': rows, 'audit': {a: dict(v.counts) for a, v in audits.items()} if live else None}
    report['totals'] = {}
    for arm in ('baseline', 'optimized'):
        data = [r[arm] for r in rows]
        report['totals'][arm] = {**metrics(data),
            'planned_calls': sum(d['planned_calls'] for d in data),
            'planned_questions': sum(d['planned_questions'] for d in data)}
    report['baseline_minus_optimized'] = {}
    for group, subset in [('unique', [r for r in rows if not r['repeat']]), ('repeat', [r for r in rows if r['repeat']])]:
        report['baseline_minus_optimized'][group] = {}
        for key in ('calls', 'questions', 'input_tokens', 'cost_usd', 'latency_ms'):
            values = [r[a][key] for r in subset for a in ('baseline', 'optimized')]
            report['baseline_minus_optimized'][group][key] = None if any(v is None for v in values) else sum(r['baseline'][key] - r['optimized'][key] for r in subset)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--model', default='jev-latest', help='same Jev version for both arms; prefer a pinned version')
    args = parser.parse_args(argv)
    clients = None
    if args.live:
        # No key discovery, config reads, or transport imports in the default path.
        from jev.client import DecisionClient
        from jev.keys import discover
        key, _ = discover()
        if not key:
            print(json.dumps({'error': 'No Jev key available; no requests sent.'}))
            return 1
        budget = Budget()
        clients = {arm: SingleAttemptClient(DecisionClient(key, model=args.model), budget)
                   for arm in ('baseline', 'optimized')}
    print(json.dumps(run(clients), indent=2, allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
