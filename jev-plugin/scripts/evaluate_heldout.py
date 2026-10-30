#!/usr/bin/env python3
"""Frozen weak-label evaluation. Offline structural checks are not classifier measurements."""
import argparse
import copy
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'extensions'))
from jev import evidence, verify, reports, diagnose
from jev.audit import Audit
from jev.client import DecisionClient, JevError, usage_tokens, PRICE_PER_MTOK_INPUT

ROOT = Path(__file__).resolve().parent / 'evaluation'
MODEL = 'jev-1.13.0'
THRESHOLDS = {'evidence': .8, 'verification': .8, 'reports': .8,
              'diagnosis_hypothesis': .85, 'diagnosis_check': .8}
WARNINGS = [
    'Public synthetic weak labels; heldout relative to prior fixtures, not provider-unseen proof.',
    'No truth, source authority, safety, exhaustive coverage, or savings certification.',
    'Confidence is not probability of correctness; small-sample agreement is not calibration.',
    'Repeated heldout review retires this version for future tuning; freeze a new version after changes.',
    'Router unsupported: route selection needs a separate frozen protocol.',
]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def require(condition):
    if not condition:
        raise ValueError("frozen protocol invariant failed")


def load_dataset(path=ROOT / 'jev-evaluation-v1.json'):
    for feature, function in (("evidence", evidence._choice), ("verification", verify._choice),
                              ("reports", reports.choice)):
        require(inspect.signature(function).parameters['threshold'].default == THRESHOLDS[feature])
    require(diagnose.HYPOTHESIS_THRESHOLD == THRESHOLDS['diagnosis_hypothesis'])
    require(diagnose.CHECK_THRESHOLD == THRESHOLDS['diagnosis_check'])
    raw = Path(path).read_bytes()
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    if hashlib.sha256(raw).hexdigest() != manifest['sha256']:
        raise ValueError('frozen dataset digest mismatch')
    data = json.loads(raw)
    require(set(data) == {'version', 'provenance', 'cases'})
    require(data['version'] == manifest['version'] == 1)
    cases = data['cases']
    require(len(cases) == 24 and len({c['id'] for c in cases}) == 24)
    require(len({c['input_sha256'] for c in cases}) == 24)
    for split in ('dev', 'heldout'):
        for feature in ('evidence', 'verification', 'reports', 'diagnosis'):
            require(sum(c['split'] == split and c['feature'] == feature for c in cases) == 3)
    for c in cases:
        require(set(c) == {'id', 'split', 'feature', 'payload', 'input_sha256', 'expected'})
        require(digest(c['payload']) == c['input_sha256'])
        f, p = c['feature'], c['payload']
        if f == 'reports':
            reports.validate(p)
            require(set(c['expected']) == set(reports.CRITERIA))
        else:
            {'evidence': evidence, 'verification': verify, 'diagnosis': diagnose}[f]._validate(p)
            require(set(c['expected']) == {i for _, i, _, _ in mappings(c)})
    for c in cases:
        for _, ident, criteria, norm in mappings(c):
            require(c['expected'][ident] in {norm.get(k, k) for k in criteria})
    return cases


def mappings(case):
    """Production question IDs -> native descriptor IDs, class sets, normalizations."""
    f, p = case['feature'], case['payload']
    if f == 'reports':
        return [(q, q, criteria, {}) for q, criteria in reports.CRITERIA.items()]
    if f == 'diagnosis':
        return [(f'h{i}', x['id'], diagnose.HYPOTHESES, {'plausible': 'investigate', 'unknown': 'review'})
                for i, x in enumerate(p['hypotheses'])] + [
                (f'c{i}', x['id'], diagnose.CHECKS, {'unknown': 'review'})
                for i, x in enumerate(x for x in p['checks'] if not x['required'])]
    group, criteria = ('candidates', evidence.CHOICES) if f == 'evidence' else ('checks', verify.CHOICES)
    return [(f'q{i}', x['id'], criteria, {'unknown': 'review'})
            for i, x in enumerate(x for x in p[group] if not x['required'])]


class StructuralClient:
    model = MODEL

    def decide(self, state, questions, *, op):
        # No fixture labels, task parsing, source access, or external IO.
        return {'answers': {q: {'type': 'choice', 'choice': list(v['criteria'])[i % len(v['criteria'])],
                                'confidence': .9} for i, (q, v) in enumerate(questions.items())}}


class BudgetClient(DecisionClient):
    def __init__(self, key, max_calls):
        if type(max_calls) is not int or not 1 <= max_calls <= 12:
            raise ValueError('invalid budget')
        super().__init__(key, model=MODEL, timeout_s=3)
        self.max_calls = max_calls
        self.wires = 0

    def decide(self, state, questions, *, op):
        if self.wires >= self.max_calls:
            raise JevError('wire budget exhausted')
        return super().decide(state, questions, op=op)

    def _post(self, body, *, timeout_s):
        if self.wires >= self.max_calls:
            raise JevError('wire budget exhausted')
        self.wires += 1
        try:
            return super()._post(body, timeout_s=min(3, timeout_s))
        except Exception:
            # Including _Retryable: never expose transport text or permit retries.
            raise JevError('evaluation transport failure') from None


class Capture:
    def __init__(self, client):
        self.client, self.model = client, client.model
        self.response = None
        self.error = False
        self.calls = 0

    def decide(self, state, questions, *, op):
        self.calls += 1
        try:
            self.response = self.client.decide(state, questions, op=op)
            return self.response
        except Exception:
            self.error = True
            raise JevError('evaluation call failed') from None


def observe(case, client, enabled=True):
    p = copy.deepcopy(case['payload'])
    audit = Audit(None)
    capture = Capture(client) if client is not None else None
    f = case['feature']
    if f == 'reports':
        out = reports.Reports().handle(p, capture, enabled, audit)
        require(isinstance(out, dict) and out.get('action') in ('continue', 'replace'))
        original = json.loads(case['payload']['tool_output'])
        flags = []
        if out['action'] == 'replace':
            require(set(out) == {'action', 'output'})
            replacement = json.loads(out['output'])
            advisory = replacement.pop('jev_advisory')
            preserved = canonical(replacement) == canonical(original)
            require(preserved)
            require(isinstance(advisory, dict) and set(advisory) == {'flags', 'note'})
            flags = advisory['flags']
            require(isinstance(flags, list) and all(isinstance(x, str) for x in flags))
            safe = set(reports.FLAGS.values()) | {'worker_failed', 'worker_timed_out', 'worker_cancelled'}
            require(bool(flags) and len(flags) == len(set(flags)) and set(flags) <= safe)
            require(advisory == {'flags': flags, 'note': reports.NOTE})
        else:
            require(out == {'action': 'continue'})
            preserved = p['tool_output'] == case['payload']['tool_output']
            require(preserved)
        actual = {flag: flag in flags for flag in reports.FLAGS.values()}
    else:
        hook = {'evidence': evidence.call_evidence, 'verification': verify.call_verify,
                'diagnosis': diagnose.call_diagnose}[f]
        out = json.loads(hook(p, capture, audit, enabled=enabled)['content'])
        rows = out['decisions'] if f == 'verification' else out['references']
        actual = {r['id']: r['priority'] for r in rows}
        required = [x['id'] for x in p['candidates' if f == 'evidence' else 'checks'] if x['required']]
        preserved = out['required_check_ids' if f == 'diagnosis' else 'required_ids'] == required
        optional_ids = {i for _, i, _, _ in mappings(case)}
        require(set(actual) == optional_ids | (set(required) if f != 'verification' else set()))
        require(len(rows) == len(actual))
        if f == 'evidence':
            require([{k:r[k] for k in ('id','kind','source','required')} for r in rows] ==
                    [{k:r[k] for k in ('id','kind','source','required')} for r in p['candidates']])
            require(out['fetched'] is False and out['trust_certified'] is False)
        else:
            require(out['executed'] is False)
            if f == 'diagnosis':
                require(canonical([{k: r[k] for k in ('id', 'kind', 'required')} for r in rows]) ==
                        canonical([dict(id=x['id'], kind=kind, required=x.get('required', False))
                         for group, kind in (('hypotheses', 'hypothesis'), ('checks', 'check'))
                         for x in p[group]]))
            else:
                # Verification has no required field on decisions: only optional IDs belong here.
                require([r['id'] for r in rows] == [x['id'] for x in p['checks'] if not x['required']])
                require(all(set(r) == {'id', 'priority',
                            'fallback_reason' if r['priority'] == 'review' else 'status'} for r in rows))
        if f != 'verification':
            require(all(actual[i] == 'required' for i in required))
    require(canonical(p) == canonical(case['payload']) and preserved)
    response = capture.response if capture else None
    answers = response.get('answers') if isinstance(response, dict) else None
    envelope = isinstance(answers, dict) and not set(answers) - {q for q, _, _, _ in mappings(case)}
    if envelope:
        try:
            envelope = len(canonical({k:v for k,v in response.items() if k != 'answers'})) <= 4096
        except (ValueError, TypeError, UnicodeError):
            envelope = False
    raw = []
    for q, ident, criteria, norm in mappings(case):
        a = answers.get(q) if envelope else None
        choice = None
        if isinstance(a, dict) and a.get('type') == 'choice':
            if f == 'evidence':
                choice = evidence._choice(a, 0)
            elif f == 'verification':
                choice = verify._choice(a, 0)
            elif f == 'diagnosis':
                choice = diagnose._choice(a, criteria, 0)
            else:
                choice = reports.choice(a, criteria, 0)
        label = norm.get(choice, choice)
        raw.append(dict(id=ident, choice=label, confidence=a['confidence'] if choice else None,
                        agreement=label == case['expected'][ident] if choice else None))
    tokens = usage_tokens(response)
    return dict(actual=actual, raw=raw, structural_ok=preserved,
                error=bool(capture and capture.error) or bool(out.get('fallback_reason') in ('upstream_error', 'invalid_response')) or bool(audit.counters.get('reports.error')),
                calls=capture.calls if capture else 0, input_tokens=tokens,
                cost_usd=tokens * PRICE_PER_MTOK_INPUT / 1e6 if tokens is not None else None,
                actual_model=MODEL if isinstance(response, dict) and response.get('model') == MODEL else None)


def wilson(hits, total):
    if not total:
        return None
    z = 1.959963984540054
    p = hits / total
    center = (p + z*z/(2*total)) / (1+z*z/total)
    half = z * math.sqrt(p*(1-p)/total + z*z/(4*total*total)) / (1+z*z/total)
    return [max(0, center-half), min(1, center+half)]


def metrics(pairs):
    # Unknown labels are not certified negatives. Review predictions abstain.
    known = [(e, a) for e, a in pairs if e is not None]
    tp = sum(e is True and a is True for e, a in known)
    fp = sum(e is False and a is True for e, a in known)
    fn = sum(e is True and a is not True for e, a in known)
    return dict(tp=tp, fp=fp, fn=fn, precision=tp/(tp+fp) if tp+fp else None,
                recall=tp/(tp+fn) if tp+fn else None, precision_wilson95=wilson(tp,tp+fp),
                recall_wilson95=wilson(tp,tp+fn), unknown_labels=len(pairs)-len(known),
                abstentions=sum(a is None for _, a in pairs),
                coverage=sum(a is not None for _, a in pairs)/len(pairs) if pairs else None,
                fp_cost_weight=1, weighted_fp_cost=fp)


def summarize(feature, entries):
    pairs, raw = [], []
    for case, obs in entries:
        raw.extend(obs['raw'])
        if feature == 'reports':
            expected_flags = {reports.FLAGS[x] for x in case['expected'].values() if x in reports.FLAGS}
            known = all(r['choice'] not in (None, 'unknown') and r['confidence'] >= .8 for r in obs['raw']) and not obs['error']
            for flag in reports.FLAGS.values():
                pairs.append((flag in expected_flags if 'unknown' not in case['expected'].values() else None,
                              obs['actual'][flag] if known or obs['actual'][flag] else None))
        else:
            for ident, expected in case['expected'].items():
                actual = obs['actual'].get(ident, 'review')
                positives = ('inspect_first', 'prioritize', 'investigate', 'inspect')
                pairs.append((None if expected == 'review' else expected in positives,
                              None if actual == 'review' or obs['error'] else actual in positives))
    bins = []
    for lo, hi in ((0,.5),(.5,.8),(.8,1)):
        rows = [r for r in raw if r['confidence'] is not None and lo <= r['confidence'] and (r['confidence'] < hi or hi == 1)]
        bins.append(dict(lower=lo, upper=hi, count=len(rows), agreement=sum(r['agreement'] for r in rows)/len(rows) if rows else None))
    valid = [r for r in raw if r['agreement'] is not None]
    tokens = [o['input_tokens'] for _, o in entries]
    return dict(accepted_priorities=metrics(pairs), confidence_bins_decision_agreement=bins,
                raw_class_agreement=sum(r['agreement'] for r in valid)/len(valid) if valid else None,
                raw_valid_count=len(valid), raw_unknown_count=sum(r['choice'] in (None,'review','unknown') for r in raw),
                brier=None, brier_reason='Not computed; confidence is not an answer-class probability.',
                errors=sum(o['error'] for _, o in entries), executed_cases=len(entries),
                input_tokens=sum(tokens) if tokens and all(t is not None for t in tokens) else None,
                cost_usd=sum(o['cost_usd'] for _, o in entries) if tokens and all(t is not None for t in tokens) else None)


def evaluate(cases, split='dev', client=None, max_calls=4):
    selected = [c for c in cases if c['split'] == split]
    live = client is not None
    entries, rows = [], []
    for c in selected[:max_calls] if live else selected:
        if live:
            obs = observe(c, client)
            entries.append((c, obs))
            row = dict(error=obs['error'], input_tokens=obs['input_tokens'], cost_usd=obs['cost_usd'], actual_model=obs['actual_model'])
        else:
            checks = [observe(c, StructuralClient(), False), observe(c, None), observe(c, StructuralClient())]
            row = dict(structural_ok=all(o['structural_ok'] for o in checks), measurement=None)
        rows.append(dict(id=c['id'], tasksha=c['input_sha256'], **row))
    return dict(version=1, split=split, mode='live' if live else 'offline-structural', model=MODEL if live else None,
                thresholds=THRESHOLDS, warnings=WARNINGS, complete=len(rows)==len(selected),
                measurement={f:summarize(f, [(c,o) for c,o in entries if c['feature']==f])
                             for f in ('evidence','verification','reports','diagnosis')} if live else None,
                cases=rows, unexecuted_ids=[c['id'] for c in selected[len(rows):]])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--split', choices=('dev','heldout'), default='dev')
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--max-calls', type=int, default=4)
    parser.add_argument('--model', choices=(MODEL,), default=MODEL)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    if not 1 <= args.max_calls <= 12:
        parser.error('max-calls must be 1..12')
    # Validation precedes any key discovery, client construction or output creation.
    try:
        cases = load_dataset()
    except Exception:
        parser.exit(2, 'Frozen fixture validation failed.\n')
    client = None
    if args.live:
        key = os.environ.get('TYPESAFE_API_KEY')
        if not key:
            parser.exit(2, 'Explicit live evaluation requires TYPESAFE_API_KEY.\n')
        client = BudgetClient(key, args.max_calls)
    result = evaluate(cases, args.split, client, args.max_calls)
    text = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)+'\n'
    if args.output:
        with args.output.open('x', encoding='utf-8') as stream:
            stream.write(text)
    else:
        print(text, end='')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
