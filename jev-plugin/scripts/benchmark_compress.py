#!/usr/bin/env python3
"""Public synthetic lossless compression benchmark; stdlib, offline by default."""
import argparse
import copy
import json
import math
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev import compress
from jev.audit import Audit
from jev.client import DecisionClient, JevError, PRICE_PER_MTOK_INPUT

MODEL = 'jev-1.13.0'
MAX_CALLS = 4
CAVEAT = ('Fixed synthetic fixtures, expected=None: no perfect-decision or accuracy claim. '
          'Deterministic RLE may be sufficient; Jev adds a readability veto, not unique savings. '
          'Bytes measure tool-output payload within the host/downstream boundary, not end-to-end '
          'traffic, tokens or dollars saved. Jev input-token cost is a separate estimate. '
          'No synthetic commands or workers execute. No cache or repeats.')


def fixtures():
    """Public API: fresh envelopes and full synthetic text, never commands to execute."""
    specs = [
        ('progress', 'routine progress tick\n' * 2000),
        ('status', 'routine status ready\n' * 1000),
        ('blocks', 'phase amber ready\n' * 250 + 'phase blue ready\n' * 250
         + 'unique middle observation amber\n' + 'phase amber ready\n' * 250
         + 'phase blue ready\n' * 250 + 'final café 中 🌱'),
        ('crlf-unicode', 'étape 中 🌱 ready\r\n' * 400
         + 'unique middle observation jade\r\n' + 'étape 中 🌱 ready\r\n' * 400),
    ]
    return [dict(name=name, expected=None, params=dict(
        kind='after_tool_call', tool_runtime_name='bash', tool_name='bash',
        tool_input={'fixture': name}, tool_output=raw)) for name, raw in specs]


class ForcedCompact:
    """Forced readability decision, no API; all safety/profit checks remain production."""
    def decide(self, state, questions, *, op):
        return {'answers': {'format': {'type': 'choice', 'choice': 'compact',
                'confidence': 1.0, 'probabilities': {'compact': 1.0, 'keep': 0.0, 'unknown': 0.0}}}}


class Sentinel:
    def __init__(self):
        self.calls = 0

    def decide(self, *args, **kwargs):
        self.calls += 1
        raise AssertionError('free variant attempted a decision')


def observe(case, client, measured=False):
    params = copy.deepcopy(case['params'])
    audit = Audit(None)
    start = time.perf_counter()
    reply = compress.handle(params, '', client, compress.CompressConfig({}), audit, lambda _: None)
    elapsed = (time.perf_counter() - start) * 1000
    raw = params['tool_output']
    folded = reply['action'] == 'replace'
    output = reply['output'] if folded else raw
    restored = compress.decode_output(output) if folded else output
    preserved = restored.encode('utf-8') == raw.encode('utf-8')
    if not preserved or params != case['params']:
        raise AssertionError('lossless contract violated')
    raw_bytes, size = len(raw.encode('utf-8')), len(output.encode('utf-8'))
    return dict(case=case['name'], expected=case['expected'], folded=folded,
                roundtrip=preserved, raw_bytes=raw_bytes, transmitted_output_bytes=size,
                delta_bytes=size - raw_bytes, hook_latency_ms=elapsed if measured else None,
                calls=audit.counters.get('compress.call', 0),
                questions=audit.counters.get('compress.questions', 0),
                errors=audit.counters.get('compress.error', 0))


def free_variants():
    base = fixtures()[0]
    raw = base['params']['tool_output']
    variants = []
    for name, output in [
        ('small', 'ready\n'),
        ('no-repetition', ''.join(f'item {i:04d} ready\n' for i in range(1000))),
        ('failure-beginning', 'failure synthetic\n' + raw),
        ('failure-middle', raw[:len(raw)//2] + 'failure synthetic\n' + raw[len(raw)//2:]),
        ('failure-tail', raw + 'failure synthetic\n'),
        ('json', json.dumps({'items': ['ready'] * 2000})),
        ('truncated', raw + '[truncated]\n'),
        ('already-envelope', compress.encode_output(raw)),
        ('missing-client', raw), ('wrong-tool', raw), ('truncation-metadata', raw),
    ]:
        case = copy.deepcopy(base)
        case.update(name=name)
        case['params']['tool_input'] = {'fixture': name}
        case['params']['tool_output'] = output
        if name == 'wrong-tool':
            case['params']['tool_runtime_name'] = 'read'
        if name == 'truncation-metadata':
            case['params']['truncated'] = True
        variants.append(case)
    return variants


class SingleAttemptClient(DecisionClient):
    """Reuse production decide/deadline/transport; sanitize errors before retry handling."""
    def __init__(self, key):
        super().__init__(key, model=MODEL, timeout_s=3)
        self.measurements = []

    def _post(self, body, *, timeout_s):
        request = json.loads(body)
        if (len(self.measurements) >= MAX_CALLS or request.get('model') != MODEL
                or request.get('questions') != compress.questions()):
            raise JevError('benchmark budget or request contract')
        row = dict(input_tokens=None, output_tokens=None, total_tokens=None,
                   estimated_jev_cost_usd=None, model=None, network_latency_ms=None)
        self.measurements.append(row)
        start = time.perf_counter()
        try:
            response = super()._post(body, timeout_s=timeout_s)
            usage = response.get('usage') if isinstance(response, dict) else None
            if isinstance(usage, dict):
                for key in ('input_tokens', 'output_tokens', 'total_tokens'):
                    value = usage.get(key)
                    if type(value) is int and 0 <= value <= 2**53 - 1:
                        row[key] = value
            if row['input_tokens'] is not None:
                row['estimated_jev_cost_usd'] = row['input_tokens'] * PRICE_PER_MTOK_INPUT / 1_000_000
            if isinstance(response, dict) and response.get('model') == MODEL:
                row['model'] = MODEL
            return response  # Metadata stays untouched for production validation.
        except Exception:
            raise JevError('benchmark transport failed; no retry') from None
        finally:
            row['network_latency_ms'] = (time.perf_counter() - start) * 1000


def percentile(values, fraction):
    """Linear interpolation on sorted samples at (n-1)*fraction (including n=1)."""
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * fraction
    lo, hi = math.floor(index), math.ceil(index)
    return values[lo] + (values[hi] - values[lo]) * (index - lo)


def latencies(values):
    return dict(median_ms=percentile(values, .5), p95_ms=percentile(values, .95))


def summarize(rows):
    return dict(cases=rows, fold_count=sum(r['folded'] for r in rows),
                keep_count=sum(not r['folded'] for r in rows),
                raw_bytes=sum(r['raw_bytes'] for r in rows),
                transmitted_output_bytes=sum(r['transmitted_output_bytes'] for r in rows),
                delta_bytes=sum(r['delta_bytes'] for r in rows))


def report(client=None):
    cases = fixtures()
    raw = [observe(c, None) for c in cases]
    deterministic = [observe(c, ForcedCompact()) for c in cases]
    for row in deterministic:
        if not (6144 <= row['raw_bytes'] <= 65536 and row['folded']
                and row['delta_bytes'] <= -1024
                and row['transmitted_output_bytes'] * 10 <= row['raw_bytes'] * 7
                and row['calls'] == row['questions'] == 1):
            raise AssertionError('fixture no longer eligible')
    sentinel = Sentinel()
    variants = [observe(c, None if c['name'] == 'missing-client' else sentinel)
                for c in free_variants()]
    if sentinel.calls or any(r['calls'] or r['folded'] for r in variants):
        raise AssertionError('free variants violated zero-call contract')
    result = dict(mode='offline' if client is None else 'live', model=MODEL, caveat=CAVEAT,
                  raw_baseline=summarize(raw), deterministic_baseline=summarize(deterministic),
                  deterministic_description='Forced readability compact decision; production safety/profit checks; no API',
                  free_variants=variants, jev=None)
    if client is not None:
        if client.measurements:
            raise ValueError('benchmark requires fresh client')
        rows = [observe(c, client, measured=True) for c in cases]
        samples = client.measurements
        tokens = [s['input_tokens'] for s in samples]
        known = len(tokens) == MAX_CALLS and all(t is not None for t in tokens)
        result['jev'] = dict(**summarize(rows), wire_calls=len(samples),
                            questions=sum(r['questions'] for r in rows), measurements=samples,
                            input_tokens=sum(tokens) if known else None,
                            estimated_jev_cost_usd=sum(tokens) * PRICE_PER_MTOK_INPUT / 1_000_000 if known else None,
                            hook_latency=latencies([r['hook_latency_ms'] for r in rows]),
                            network_latency=latencies([s['network_latency_ms'] for s in samples]))
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Opt in: pinned model, four wire attempts, no retries')
    args = parser.parse_args(argv)
    client = None
    if args.live:
        from jev import keys
        key, _ = keys.discover()
        if not key:
            print(json.dumps({'status': 'not_run', 'reason': 'no_configured_key'}))
            return 2
        client = SingleAttemptClient(key)
    print(json.dumps(report(client), ensure_ascii=False, allow_nan=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
