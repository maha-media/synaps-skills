/**
 * @file fake-bolt-client.mjs
 *
 * Mock Bolt App + WebClient for e2e tests.
 *
 * Mirrors the exact Bolt API surface used by bridge/sources/slack/index.js:
 *   - app.event(type, handler)              — for assistant_thread_started etc.
 *   - app.start() / app.stop()              — lifecycle no-ops.
 *   - app.client.chat.{postMessage,update,startStream,appendStream,stopStream}
 *   - app.client.assistant.threads.{setStatus,setSuggestedPrompts,setTitle}
 *   - app.client.files.info
 *
 * Every API call is recorded in app.calls: Array<{ api: string, args: object }>.
 *
 * Call vi.fn() versions are used so tests can use vitest matchers on them.
 */

import { vi } from 'vitest';

// ─── makeFakeClient ──────────────────────────────────────────────────────────

/**
 * Build a fake Slack WebClient.
 * All methods push to the shared `calls` array and return a canned OK response.
 *
 * @param {Array} calls  - Shared call-recording array.
 * @returns {object}
 */
function makeFakeClient(calls) {
  /**
   * Create a spy function for `api.method` that records to `calls` and
   * returns a default response.
   *
   * @param {string} api          - e.g. 'chat'
   * @param {string} method       - e.g. 'startStream'
   * @param {object} defaultResp  - The canned response to return.
   */
  function spy(api, method, defaultResp = { ok: true }) {
    return vi.fn(async (args) => {
      calls.push({ api: `${api}.${method}`, args });
      return defaultResp;
    });
  }

  return {
    chat: {
      postMessage: spy('chat', 'postMessage', { ok: true, ts: '11111.1111', channel: 'D0TEST' }),
      update:      spy('chat', 'update',      { ok: true, ts: '11111.1111', channel: 'D0TEST' }),
      startStream: spy('chat', 'startStream', { ok: true, stream_id: 'ST-fake-001', channel: 'D0TEST' }),
      appendStream: spy('chat', 'appendStream', { ok: true }),
      stopStream:  spy('chat', 'stopStream',  { ok: true }),
    },
    assistant: {
      threads: {
        setStatus:         spy('assistant.threads', 'setStatus',         { ok: true }),
        setSuggestedPrompts: spy('assistant.threads', 'setSuggestedPrompts', { ok: true }),
        setTitle:          spy('assistant.threads', 'setTitle',          { ok: true }),
      },
    },
    files: {
      info: spy('files', 'info', { ok: true, file: { id: 'F0TEST', name: 'test.txt', mimetype: 'text/plain', url_private: 'https://example.com/test.txt' } }),
    },
  };
}

// ─── FakeBoltApp ─────────────────────────────────────────────────────────────

/**
 * Minimal Bolt App mock.
 *
 * Handler registration mirrors bridge/sources/slack/index.js which calls:
 *   app.event('assistant_thread_started', fn)
 *   app.event('assistant_thread_context_changed', fn)
 *   app.event('app_mention', fn)
 *   app.event('message', fn)
 */
export class FakeBoltApp {
  constructor() {
    /** @type {Map<string, Function>} */
    this._handlers = new Map();

    /** @type {Array<{ api: string, args: object }>} */
    this.calls = [];

    /** Fake WebClient instance */
    this.client = makeFakeClient(this.calls);
  }

  // ── Bolt registration API ────────────────────────────────────────────────

  /**
   * Register an event handler. Mirrors app.event(type, fn).
   * @param {string} type
   * @param {Function} handler
   */
  event(type, handler) {
    this._handlers.set(type, handler);
  }

  /**
   * Bolt assistant() middleware.
   * bridge/sources/slack/index.js does NOT use app.assistant() — it uses
   * app.event('assistant_thread_started', ...) directly.
   * Included here for completeness; no-op if called.
   */
  assistant(_config) {
    // no-op — adapter uses app.event() not app.assistant()
  }

  /** @returns {Promise<void>} */
  async start() { /* no-op */ }

  /** @returns {Promise<void>} */
  async stop() { /* no-op */ }

  // ── test helper: inject an event ─────────────────────────────────────────

  /**
   * Inject a Bolt-shaped event into the registered handler.
   *
   * @param {string} type    - Event type e.g. 'assistant_thread_started', 'user_message', 'app_mention', 'message'.
   * @param {object} payload - The `event` object passed to the handler.
   * @param {object} [extra] - Optional extra args ({ say, ack, etc. }).
   * @returns {Promise<void>}
   */
  async injectEvent(type, payload, extra = {}) {
    const handler = this._handlers.get(type);
    if (!handler) {
      throw new Error(`FakeBoltApp: no handler registered for event type '${type}'`);
    }

    const ack = extra.ack ?? vi.fn(async () => {});
    const say = extra.say ?? vi.fn(async () => {});

    await handler({
      event: payload,
      client: this.client,
      ack,
      say,
      ...extra,
    });
  }

  // ── convenience helpers ───────────────────────────────────────────────────

  /**
   * Filter recorded calls by api name (string or regex).
   * @param {string|RegExp} pattern
   * @returns {Array<{ api: string, args: object }>}
   */
  findCalls(pattern) {
    if (typeof pattern === 'string') {
      return this.calls.filter((c) => c.api === pattern);
    }
    return this.calls.filter((c) => pattern.test(c.api));
  }

  /** Reset the call log. */
  clearCalls() {
    this.calls.length = 0;
  }
}

// ─── makeBoltAppFactory ───────────────────────────────────────────────────────

/**
 * Build a boltAppFactory that always returns the same FakeBoltApp instance.
 * The instance is exposed on the returned factory so tests can access it.
 *
 * Usage:
 *   const { factory, fakeApp } = makeBoltAppFactory();
 *   const adapter = new SlackAdapter({ boltAppFactory: factory, ... });
 *
 * @returns {{ factory: Function, fakeApp: FakeBoltApp }}
 */
export function makeBoltAppFactory() {
  const fakeApp = new FakeBoltApp();
  const factory = () => fakeApp;
  factory.fakeApp = fakeApp;
  return { factory, fakeApp };
}
