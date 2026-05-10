/**
 * @file bridge/core/metrics/metrics-registry.js
 *
 * MetricsRegistry — tiny, dependency-free Prometheus metrics aggregator.
 *
 * Supports three metric types: counter, histogram, gauge.
 * Serialises current state to the Prometheus text exposition format via
 * `render()`.
 *
 * ─── Design constraints ──────────────────────────────────────────────────────
 * • No I/O.  Pure in-memory aggregation.
 * • No external dependencies.
 * • ESM only — no `require`, no top-level `await`.
 * • Label-set validation on every mutation; unknown keys throw.
 * • Missing label keys are filled with `""` (Prometheus convention).
 * • Numeric label values are coerced to strings.
 * • Duplicate labelNames at registration time throw.
 * • Re-registering the same name with a different type or help throws.
 * • Re-registering with identical type + help returns the existing instance
 *   (idempotent).
 *
 * ─── Internal storage per series ─────────────────────────────────────────────
 * Each series entry in the Map stores its normalised label object under the
 * internal `_labels` key so `render()` can reconstruct label pairs without
 * needing a separate side-table.
 *
 *   Counter series : { _labels, value }
 *   Gauge series   : { _labels, value }
 *   Histogram series: { _labels, buckets: Map<number|'+Inf', count>, count, sum }
 *
 * ─── Prometheus text format highlights ───────────────────────────────────────
 * • `# HELP <name> <docstring>` then `# TYPE <name> <type>` per metric.
 * • Sample lines: `<name>[{labels}] <value>`.
 * • Label values escape: `\` → `\\`, `"` → `\"`, newline → `\n`.
 * • Metrics emitted alphabetically by name.
 * • Label key-value pairs within a sample ordered alphabetically by key.
 * • Exactly one trailing `\n`.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default histogram bucket upper bounds (seconds).
 * Matches the conventional defaults used by prom-client / Prometheus client libs.
 *
 * @type {readonly number[]}
 */
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Unit-separator character used as the label-hash field delimiter. */
const SEP = '\x1f';

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Escape a label value per the Prometheus text format specification.
 *
 * @param {string} v
 * @returns {string}
 */
function escapeLabelValue(v) {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * Render a normalised label object as a `{k="v",...}` string.
 * Keys are emitted in alphabetical order for stability.
 * Returns `""` when there are no keys.
 *
 * @param {Record<string, string>} labels
 * @returns {string}
 */
function renderLabelSet(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  const pairs = keys.map(k => `${k}="${escapeLabelValue(labels[k])}"`);
  return `{${pairs.join(',')}}`;
}

/**
 * Compute the stable hash key for a series given an ordered label-name list
 * and a normalised label-value object.
 *
 * @param {string[]} labelNames  Ordered label names from registration.
 * @param {Record<string, string>} normLabels  Normalised label values.
 * @returns {string}
 */
function computeHash(labelNames, normLabels) {
  return labelNames.map(n => normLabels[n] ?? '').join(SEP);
}

/**
 * Validate and normalise a caller-supplied labels argument.
 *
 * - Unknown keys (not in `labelNames`) throw an informative error.
 * - Numeric values are coerced to string.
 * - Missing keys default to `""`.
 *
 * @param {string}   metricName  Used only in error messages.
 * @param {string[]} labelNames  Registered label keys for this metric.
 * @param {Record<string, string|number>} labels  Raw caller-supplied labels.
 * @returns {Record<string, string>}
 */
function normaliseLabels(metricName, labelNames, labels) {
  const allowed = new Set(labelNames);
  const result  = {};

  for (const [k, v] of Object.entries(labels)) {
    if (!allowed.has(k)) {
      throw new Error(
        `MetricsRegistry: unknown label key "${k}" for metric "${metricName}". ` +
        `Registered labelNames: [${labelNames.join(', ')}]`
      );
    }
    result[k] = typeof v === 'number' ? String(v) : String(v);
  }

  // Fill any missing registered keys with the empty string.
  for (const n of labelNames) {
    if (!(n in result)) result[n] = '';
  }

  return result;
}

// ── MetricsRegistry ───────────────────────────────────────────────────────────

/**
 * Aggregates Prometheus-style counter, histogram and gauge metrics in memory.
 * Call `render()` to produce the full Prometheus text exposition payload.
 */
export class MetricsRegistry {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]  Injectable clock returning epoch-ms.
   *   Defaults to `Date.now`.  Reserved for future use (e.g. staleness marks).
   */
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;

    /**
     * Primary metrics store.
     * @type {Map<string, import('./metrics-registry.js').MetricEntry>}
     */
    this._metrics = new Map();
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Shared pre-flight for all metric types.  Handles idempotency, type-clash
   * detection, and duplicate-labelName guarding.
   *
   * @param {'counter'|'histogram'|'gauge'} type
   * @param {string}   name
   * @param {string}   help
   * @param {string[]} labelNames
   * @returns {{ entry: object, isNew: boolean }}
   */
  _register(type, name, help, labelNames) {
    // Guard duplicate labelNames.
    const seen = new Set();
    for (const n of labelNames) {
      if (seen.has(n)) {
        throw new Error(
          `MetricsRegistry: duplicate labelName "${n}" registering metric "${name}"`
        );
      }
      seen.add(n);
    }

    if (this._metrics.has(name)) {
      const existing = this._metrics.get(name);

      if (existing.type !== type) {
        throw new Error(
          `MetricsRegistry: metric "${name}" is already registered as type ` +
          `"${existing.type}"; cannot re-register as "${type}"`
        );
      }
      if (existing.help !== help) {
        throw new Error(
          `MetricsRegistry: metric "${name}" is already registered with a different help string`
        );
      }

      return { entry: existing, isNew: false };
    }

    const entry = {
      type,
      help,
      labelNames: [...labelNames],
      series: new Map(),  // hash → series object
    };
    this._metrics.set(name, entry);
    return { entry, isNew: true };
  }

  // ── Counter ───────────────────────────────────────────────────────────────

  /**
   * Register (or fetch) a counter metric.
   * Counter values start at 0 and only increase.
   *
   * @param {string} name   Metric name, e.g. `synaps_mcp_requests_total`.
   * @param {{ help: string, labelNames?: string[] }} opts
   * @returns {{ inc(labels?: Record<string,string|number>, amount?: number): void }}
   */
  counter(name, { help, labelNames = [] } = {}) {
    const { entry } = this._register('counter', name, help, labelNames);

    return {
      /**
       * Increment the counter.
       *
       * @param {Record<string, string|number>} [labels={}]
       * @param {number} [amount=1]  Must be ≥ 0.
       */
      inc: (labels = {}, amount = 1) => {
        if (typeof amount === 'number' && amount < 0) {
          throw new Error(
            `MetricsRegistry: counter "${name}" inc() amount must be ≥ 0, got ${amount}`
          );
        }
        const norm = normaliseLabels(name, labelNames, labels);
        const hash = computeHash(labelNames, norm);

        if (!entry.series.has(hash)) {
          entry.series.set(hash, { _labels: norm, value: 0 });
        }
        entry.series.get(hash).value += amount;
      },
    };
  }

  // ── Histogram ─────────────────────────────────────────────────────────────

  /**
   * Register (or fetch) a histogram metric.
   * Histograms use cumulative bucket semantics: each bucket counts observations
   * with value ≤ the bucket's upper bound (`le`).
   *
   * @param {string} name
   * @param {{ help: string, labelNames?: string[], buckets?: number[] }} opts
   * @returns {{ observe(labels?: Record<string,string|number>, value: number): void }}
   */
  histogram(name, { help, labelNames = [], buckets = DEFAULT_BUCKETS } = {}) {
    const { entry } = this._register('histogram', name, help, labelNames);

    // Store sorted bucket boundaries on the entry so render() can iterate them.
    if (!entry.buckets) {
      entry.buckets = [...buckets].sort((a, b) => a - b);
    }

    return {
      /**
       * Record one observation.
       *
       * @param {Record<string, string|number>} [labels={}]
       * @param {number} value  Must be ≥ 0.
       */
      observe: (labels = {}, value) => {
        if (typeof value === 'number' && value < 0) {
          throw new Error(
            `MetricsRegistry: histogram "${name}" observe() value must be ≥ 0, got ${value}`
          );
        }
        const norm = normaliseLabels(name, labelNames, labels);
        const hash = computeHash(labelNames, norm);

        if (!entry.series.has(hash)) {
          // Initialise all configured bucket counters to 0.
          const bucketMap = new Map();
          for (const b of entry.buckets) bucketMap.set(b, 0);
          bucketMap.set('+Inf', 0);
          entry.series.set(hash, { _labels: norm, buckets: bucketMap, count: 0, sum: 0 });
        }

        const s = entry.series.get(hash);

        // Cumulative semantics: increment every bucket whose `le` ≥ value.
        for (const b of entry.buckets) {
          if (b >= value) {
            s.buckets.set(b, s.buckets.get(b) + 1);
          }
        }
        // +Inf always increments (total observation count).
        s.buckets.set('+Inf', s.buckets.get('+Inf') + 1);

        s.count += 1;
        s.sum   += value;
      },
    };
  }

  // ── Gauge ─────────────────────────────────────────────────────────────────

  /**
   * Register (or fetch) a gauge metric.
   * Gauges can go up and down arbitrarily.
   *
   * @param {string} name
   * @param {{ help: string, labelNames?: string[] }} opts
   * @returns {{
   *   set(labels?: Record<string,string|number>, value: number): void,
   *   inc(labels?: Record<string,string|number>, amount?: number): void,
   *   dec(labels?: Record<string,string|number>, amount?: number): void,
   * }}
   */
  gauge(name, { help, labelNames = [] } = {}) {
    const { entry } = this._register('gauge', name, help, labelNames);

    /**
     * Get or initialise the series for a given normalised label set.
     * @param {Record<string, string|number>} labels
     * @returns {{ _labels: Record<string,string>, value: number }}
     */
    const getOrInit = (labels) => {
      const norm = normaliseLabels(name, labelNames, labels);
      const hash = computeHash(labelNames, norm);
      if (!entry.series.has(hash)) {
        entry.series.set(hash, { _labels: norm, value: 0 });
      }
      return entry.series.get(hash);
    };

    return {
      /** Overwrite the gauge value. */
      set: (labels = {}, value) => {
        getOrInit(labels).value = value;
      },
      /** Increment the gauge by `amount` (default 1). */
      inc: (labels = {}, amount = 1) => {
        getOrInit(labels).value += amount;
      },
      /** Decrement the gauge by `amount` (default 1). */
      dec: (labels = {}, amount = 1) => {
        getOrInit(labels).value -= amount;
      },
    };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * Render all registered metrics to the Prometheus text exposition format.
   *
   * Output characteristics:
   * - Metrics are ordered alphabetically by name.
   * - Series within each metric are emitted in insertion order.
   * - Label key-value pairs within each sample line are ordered alphabetically
   *   by key.
   * - Exactly one trailing newline (`\n`).
   *
   * @returns {string}
   */
  render() {
    const lines = [];

    // Alphabetical metric ordering for stable output.
    const sortedNames = [...this._metrics.keys()].sort();

    for (const name of sortedNames) {
      const entry = this._metrics.get(name);

      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} ${entry.type}`);

      for (const series of entry.series.values()) {
        const labelObj = series._labels;   // normalised label object

        if (entry.type === 'counter') {
          lines.push(`${name}${renderLabelSet(labelObj)} ${series.value}`);

        } else if (entry.type === 'gauge') {
          lines.push(`${name}${renderLabelSet(labelObj)} ${series.value}`);

        } else if (entry.type === 'histogram') {
          // Emit each configured bucket with `le` appended to the label set.
          for (const b of entry.buckets) {
            const bucketLabels = { ...labelObj, le: String(b) };
            lines.push(`${name}_bucket${renderLabelSet(bucketLabels)} ${series.buckets.get(b)}`);
          }
          // Always emit +Inf bucket.
          const infLabels = { ...labelObj, le: '+Inf' };
          lines.push(`${name}_bucket${renderLabelSet(infLabels)} ${series.buckets.get('+Inf')}`);
          // _sum and _count lines (no `le` label).
          lines.push(`${name}_sum${renderLabelSet(labelObj)} ${series.sum}`);
          lines.push(`${name}_count${renderLabelSet(labelObj)} ${series.count}`);
        }
      }
    }

    return lines.join('\n') + '\n';
  }
}
