/**
 * @file bridge/core/metrics/metrics-registry.test.js
 *
 * Vitest unit tests for MetricsRegistry (Phase 9 — Track 6 Wave A).
 *
 * 14 tests covering:
 *   1.  counter basic
 *   2.  counter with labels
 *   3.  counter inc(amount) + negative-amount throw
 *   4.  counter idempotent registration / type-clash throw
 *   5.  histogram bucket cumulativity
 *   6.  histogram +Inf bucket always emitted
 *   7.  gauge set / inc / dec
 *   8.  label key validation — unknown key throws
 *   9.  label coercion — numeric value → string in output
 *   10. label escaping — `"` and `\` in label values
 *   11. render alphabetical metric order
 *   12. render alphabetical label key order within a sample
 *   13. HELP + TYPE lines — each metric emits exactly one of each
 *   14. DEFAULT_BUCKETS sanity
 */

import { describe, it, expect } from 'vitest';
import { MetricsRegistry, DEFAULT_BUCKETS } from './metrics-registry.js';

// ── Helper ────────────────────────────────────────────────────────────────────

/** Extract every non-comment, non-empty line from a render() output. */
function sampleLines(output) {
  return output.split('\n').filter(l => l !== '' && !l.startsWith('#'));
}

/** Extract every `# HELP` line from a render() output. */
function helpLines(output) {
  return output.split('\n').filter(l => l.startsWith('# HELP'));
}

/** Extract every `# TYPE` line from a render() output. */
function typeLines(output) {
  return output.split('\n').filter(l => l.startsWith('# TYPE'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MetricsRegistry', () => {

  // ── 1. Counter basic ────────────────────────────────────────────────────────

  it('counter basic — inc 3 times no labels, render shows value 3', () => {
    const reg = new MetricsRegistry();
    const c   = reg.counter('test_total', { help: 'a test counter' });

    c.inc();
    c.inc();
    c.inc();

    const out = reg.render();
    const samples = sampleLines(out);

    expect(samples).toHaveLength(1);
    expect(samples[0]).toBe('test_total 3');
  });

  // ── 2. Counter with labels ──────────────────────────────────────────────────

  it('counter with labels — two distinct label sets render as two sample lines', () => {
    const reg = new MetricsRegistry();
    const c   = reg.counter('req_total', {
      help: 'requests',
      labelNames: ['method', 'status'],
    });

    c.inc({ method: 'GET',  status: '200' }, 5);
    c.inc({ method: 'POST', status: '400' }, 2);

    const samples = sampleLines(reg.render());
    expect(samples).toHaveLength(2);
    expect(samples).toContain('req_total{method="GET",status="200"} 5');
    expect(samples).toContain('req_total{method="POST",status="400"} 2');
  });

  // ── 3. Counter inc(amount) + negative throw ─────────────────────────────────

  it('counter inc(amount) — adds supplied amount; negative amount throws', () => {
    const reg = new MetricsRegistry();
    const c   = reg.counter('items_total', { help: 'items' });

    c.inc({}, 5);
    expect(sampleLines(reg.render())[0]).toBe('items_total 5');

    expect(() => c.inc({}, -1)).toThrow(/amount must be.*0/);
  });

  // ── 4. Counter idempotent registration ──────────────────────────────────────

  it('counter idempotent registration — same args returns same behaviour; different type throws', () => {
    const reg = new MetricsRegistry();

    const c1 = reg.counter('x_total', { help: 'h', labelNames: ['a'] });
    const c2 = reg.counter('x_total', { help: 'h', labelNames: ['a'] });

    // Both references share the same underlying series.
    c1.inc({ a: 'alpha' });
    c2.inc({ a: 'alpha' });

    const samples = sampleLines(reg.render());
    // Single series, value = 2.
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBe('x_total{a="alpha"} 2');

    // Attempting to register as a different type must throw.
    expect(() => reg.gauge('x_total', { help: 'h' })).toThrow(/already registered as/);
  });

  // ── 5. Histogram bucket cumulativity ────────────────────────────────────────

  it('histogram bucket cumulativity — observe [0.05, 0.5, 5], verify cumulative counts', () => {
    const reg  = new MetricsRegistry();
    const hist = reg.histogram('latency_seconds', {
      help:    'latency',
      buckets: [0.025, 0.05, 0.1, 0.5, 1, 5, 10],
    });

    hist.observe({}, 0.05);
    hist.observe({}, 0.5);
    hist.observe({}, 5);

    const out = reg.render();

    // Helper: parse a bucket line `<name>_bucket{le="<x>"} <n>` → n.
    const bucketVal = (le) => {
      const line = out.split('\n').find(l => l.includes(`le="${le}"`) && !l.startsWith('#'));
      expect(line, `no line for le="${le}"`).toBeTruthy();
      return Number(line.split(' ').pop());
    };

    // le=0.025 → 0 observations ≤ 0.025
    expect(bucketVal('0.025')).toBe(0);
    // le=0.05  → 1 observation  ≤ 0.05 (the 0.05 observation itself)
    expect(bucketVal('0.05')).toBe(1);
    // le=0.1   → 1 (only the 0.05 obs is ≤ 0.1)
    expect(bucketVal('0.1')).toBe(1);
    // le=0.5   → 2 (0.05 and 0.5 are both ≤ 0.5)
    expect(bucketVal('0.5')).toBe(2);
    // le=1     → 2 (0.05 and 0.5)
    expect(bucketVal('1')).toBe(2);
    // le=5     → 3 (all three)
    expect(bucketVal('5')).toBe(3);
    // le=10    → 3
    expect(bucketVal('10')).toBe(3);

    // _count and _sum.
    const countLine = out.split('\n').find(l => l.startsWith('latency_seconds_count'));
    const sumLine   = out.split('\n').find(l => l.startsWith('latency_seconds_sum'));
    expect(Number(countLine.split(' ').pop())).toBe(3);
    expect(Number(sumLine.split(' ').pop())).toBeCloseTo(5.55, 10);
  });

  // ── 6. Histogram +Inf bucket ────────────────────────────────────────────────

  it('histogram +Inf bucket — always emitted with value equal to _count', () => {
    const reg  = new MetricsRegistry();
    const hist = reg.histogram('dur_seconds', { help: 'duration', buckets: [1, 2] });

    hist.observe({}, 0.5);
    hist.observe({}, 1.5);

    const out = reg.render();

    const infLine = out.split('\n').find(l => l.includes('le="+Inf"'));
    expect(infLine).toBeTruthy();
    expect(Number(infLine.split(' ').pop())).toBe(2);

    const countLine = out.split('\n').find(l => l.startsWith('dur_seconds_count'));
    expect(Number(countLine.split(' ').pop())).toBe(2);
  });

  // ── 7. Gauge set / inc / dec ────────────────────────────────────────────────

  it('gauge set/inc/dec — set 5, inc 2 → 7, dec 3 → 4; render shows 4', () => {
    const reg = new MetricsRegistry();
    const g   = reg.gauge('active_conns', { help: 'active connections' });

    g.set({}, 5);
    g.inc({}, 2);
    g.dec({}, 3);

    const samples = sampleLines(reg.render());
    expect(samples).toHaveLength(1);
    expect(samples[0]).toBe('active_conns 4');
  });

  // ── 8. Label key validation ─────────────────────────────────────────────────

  it('label key validation — unknown label key throws a clear error naming the metric', () => {
    const reg = new MetricsRegistry();
    const c   = reg.counter('events_total', {
      help:       'events',
      labelNames: ['env'],
    });

    expect(() => c.inc({ env: 'prod', region: 'us-east-1' }))
      .toThrow(/unknown label key.*region.*events_total/);
  });

  // ── 9. Label coercion ───────────────────────────────────────────────────────

  it('label coercion — numeric label value 42 renders as "42" in output', () => {
    const reg = new MetricsRegistry();
    const c   = reg.counter('status_total', {
      help:       'by status',
      labelNames: ['code'],
    });

    c.inc({ code: 42 });   // numeric value

    const out = reg.render();
    expect(out).toContain('status_total{code="42"} 1');
  });

  // ── 10. Label escaping ──────────────────────────────────────────────────────

  it('label escaping — `"` and `\\` in a label value are escaped per spec', () => {
    const reg = new MetricsRegistry();
    const c   = reg.counter('escaped_total', {
      help:       'escaping test',
      labelNames: ['msg'],
    });

    // Value: she said "hello\world"
    c.inc({ msg: 'she said "hello\\world"' });

    const out = reg.render();
    // Expected escaped form: she said \"hello\\world\"
    expect(out).toContain('msg="she said \\"hello\\\\world\\""');
  });

  // ── 11. Render alphabetical metric order ────────────────────────────────────

  it('render alphabetical metric order — three metrics registered out of order render alphabetically', () => {
    const reg = new MetricsRegistry();

    reg.counter('z_total',  { help: 'z' }).inc();
    reg.counter('a_total',  { help: 'a' }).inc();
    reg.counter('m_total',  { help: 'm' }).inc();

    const helpOrder = helpLines(reg.render()).map(l => l.split(' ')[2]);
    expect(helpOrder).toEqual(['a_total', 'm_total', 'z_total']);
  });

  // ── 12. Render alphabetical label key order ─────────────────────────────────

  it('render alphabetical label key order — {b,a} label set renders as a=…,b=…', () => {
    const reg = new MetricsRegistry();
    const c   = reg.counter('order_total', {
      help:       'key order',
      labelNames: ['b', 'a'],
    });

    c.inc({ b: '1', a: '2' });

    const samples = sampleLines(reg.render());
    expect(samples).toHaveLength(1);
    // a comes before b alphabetically.
    expect(samples[0]).toBe('order_total{a="2",b="1"} 1');
  });

  // ── 13. Multiple HELP + TYPE lines ──────────────────────────────────────────

  it('each metric emits exactly one # HELP and one # TYPE line; series follow contiguously', () => {
    const reg = new MetricsRegistry();

    const c = reg.counter('hits_total', { help: 'hits', labelNames: ['env'] });
    c.inc({ env: 'prod' });
    c.inc({ env: 'dev'  });

    const out   = reg.render();
    const lines = out.split('\n').filter(l => l !== '');

    const helpCount = lines.filter(l => l.startsWith('# HELP hits_total')).length;
    const typeCount = lines.filter(l => l.startsWith('# TYPE hits_total')).length;

    expect(helpCount).toBe(1);
    expect(typeCount).toBe(1);

    // The two HELP / TYPE lines are adjacent and precede the two sample lines.
    const helpIdx = lines.findIndex(l => l.startsWith('# HELP hits_total'));
    expect(lines[helpIdx + 1]).toMatch(/^# TYPE hits_total/);
    expect(lines[helpIdx + 2]).toMatch(/^hits_total\{/);
    expect(lines[helpIdx + 3]).toMatch(/^hits_total\{/);
  });

  // ── 14. DEFAULT_BUCKETS sanity ───────────────────────────────────────────────

  it('DEFAULT_BUCKETS — exported, first value 0.005, last 10, length 11', () => {
    expect(DEFAULT_BUCKETS).toBeInstanceOf(Array);
    expect(DEFAULT_BUCKETS).toHaveLength(11);
    expect(DEFAULT_BUCKETS[0]).toBe(0.005);
    expect(DEFAULT_BUCKETS[DEFAULT_BUCKETS.length - 1]).toBe(10);
  });

});
