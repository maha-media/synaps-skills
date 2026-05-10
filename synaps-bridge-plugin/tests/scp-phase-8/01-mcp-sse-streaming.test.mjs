/**
 * @file tests/scp-phase-8/01-mcp-sse-streaming.test.mjs
 *
 * Acceptance test — Track 3: MCP-over-SSE Streaming
 *
 * Tests:
 *  1. POST /mcp/v1 with Accept: text/event-stream + sseEnabled=true →
 *     response Content-Type: text/event-stream, SSE framing (data: …\n\n).
 *  2. SSE stream contains at least one notification frame then a result frame.
 *  3. Transport closes (response ends) after result frame.
 *  4. sseEnabled=false + Accept: text/event-stream → normal JSON response (no SSE).
 *  5. McpSseTransport unit: notify() writes correct SSE frame; result() closes stream.
 *
 * NOTE — chunk-by-chunk streaming from synaps_chat is a TODO tracked in the
 * Phase 8 brief.  Phase 8 exercises the SSE framing path end-to-end with a
 * single-notification + single-result pattern via the sseDispatcher.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import { McpSseTransport } from '../../bridge/core/mcp/mcp-sse-transport.js';
import { McpServer } from '../../bridge/core/mcp/mcp-server.js';
import { ScpHttpServer } from '../../bridge/core/scp-http-server.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeConfig() {
  return {
    platform: { mode: 'scp' },
    web:      { enabled: true, http_port: 0, bind: '127.0.0.1',
                trust_proxy_header: 'x-synaps-user-id', allowed_origin: '' },
  };
}

function makeVncProxy() {
  return { middleware: () => (_req, _res, next) => next(), upgrade: () => {} };
}

/** Shared mocked collaborators for McpServer. */
function makeMcpCollaborators() {
  const tokenResolver = {
    resolve: async (token) =>
      token === 'valid-token'
        ? { synaps_user_id: 'u1', institution_id: 'i1', token_id: 't1' }
        : null,
  };
  const toolRegistry = {
    listTools:  async () => [],
    callTool:   async () => ({ content: [{ type: 'text', text: 'streamed-response' }], isError: false }),
  };
  const approvalGate = {
    filterTools:   async (t) => t,
    isToolAllowed: async ()  => true,
  };
  return { tokenResolver, toolRegistry, approvalGate };
}

/**
 * Fire an HTTP GET/POST request and accumulate the raw body as a string.
 * Returns { statusCode, headers, rawBody }.
 */
function fetchRaw({ port, path = '/mcp/v1', method = 'POST', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const reqHeaders = buf
      ? { 'Content-Type': 'application/json', 'Content-Length': buf.length, ...headers }
      : headers;

    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: reqHeaders },
      (res) => {
        let rawBody = '';
        res.on('data', (c) => (rawBody += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, rawBody }));
      },
    );
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

const TOOLS_CALL_BODY = {
  jsonrpc: '2.0',
  id:      42,
  method:  'tools/call',
  params:  { name: 'synaps_chat', arguments: { prompt: 'hello' } },
};

// ─── Unit tests: McpSseTransport framing ──────────────────────────────────────

describe('McpSseTransport — unit: SSE frame format', () => {
  function makeFakeRes() {
    const writes = [];
    let ended = false;
    let headCode = null;
    let headHeaders = {};
    const closeCbs = [];

    return {
      writes,
      ended: () => ended,
      headCode: () => headCode,
      headHeaders: () => headHeaders,
      // fake res
      writeHead: (code, hdrs) => { headCode = code; headHeaders = hdrs; },
      write:     (chunk) => { writes.push(chunk); return true; },
      end:       () => { ended = true; },
      on:        (event, cb) => { if (event === 'close') closeCbs.push(cb); },
      _triggerClose: () => closeCbs.forEach((cb) => cb()),
    };
  }

  it('start() sends 200 + SSE headers + retry hint', () => {
    const res = makeFakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();

    expect(res.headCode()).toBe(200);
    expect(res.headHeaders()['Content-Type']).toBe('text/event-stream');
    expect(res.writes[0]).toContain('retry:');
    t.close();
  });

  it('notify() sends data: {jsonrpc,method,params}\\n\\n frame', () => {
    const res = makeFakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();
    t.notify('synaps/chunk', { text: 'hello' });

    const notifyFrame = res.writes.find((w) => w.startsWith('data: ') && w.includes('synaps/chunk'));
    expect(notifyFrame).toBeDefined();
    expect(notifyFrame).toMatch(/^data: .+\n\n$/);

    const parsed = JSON.parse(notifyFrame.replace(/^data: /, '').trimEnd());
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.method).toBe('synaps/chunk');
    expect(parsed.params).toEqual({ text: 'hello' });
    t.close();
  });

  it('result() sends final result frame then closes (res.end called)', () => {
    const res = makeFakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();
    t.result(7, { content: [{ type: 'text', text: 'done' }] });

    expect(res.ended()).toBe(true);
    expect(t.closed).toBe(true);

    const resultFrame = res.writes.find((w) => w.includes('"result"'));
    expect(resultFrame).toBeDefined();
    const parsed = JSON.parse(resultFrame.replace(/^data: /, '').trimEnd());
    expect(parsed.id).toBe(7);
    expect(parsed.result.content[0].text).toBe('done');
  });

  it('peer disconnect (res close event) tears down transport', () => {
    const res = makeFakeRes();
    const t = new McpSseTransport({ res, heartbeatMs: 60_000 });
    t.start();

    expect(t.closed).toBe(false);
    res._triggerClose();
    expect(t.closed).toBe(true);
  });
});

// ─── HTTP harness — SSE end-to-end ───────────────────────────────────────────

describe('ScpHttpServer — SSE streaming (tools/call, sseEnabled=true)', () => {
  let srvSse, portSse;
  let srvNoSse, portNoSse;

  beforeAll(async () => {
    const colls = makeMcpCollaborators();

    // SSE-enabled server
    const mcpSse = new McpServer({ ...colls, sseEnabled: true, logger: silent });
    srvSse = new ScpHttpServer({
      config: makeConfig(), vncProxy: makeVncProxy(),
      mcpServer: mcpSse, sseEnabled: true, logger: silent,
    });
    const r1 = await srvSse.start();
    portSse = r1.port;

    // SSE-disabled server (same mcpServer but sseEnabled=false on http layer)
    const mcpNoSse = new McpServer({ ...colls, sseEnabled: false, logger: silent });
    srvNoSse = new ScpHttpServer({
      config: makeConfig(), vncProxy: makeVncProxy(),
      mcpServer: mcpNoSse, sseEnabled: false, logger: silent,
    });
    const r2 = await srvNoSse.start();
    portNoSse = r2.port;
  });

  afterAll(async () => {
    await srvSse.stop();
    await srvNoSse.stop();
  });

  it('Accept: text/event-stream + sseEnabled=true → Content-Type: text/event-stream', async () => {
    const { statusCode, headers } = await fetchRaw({
      port:    portSse,
      body:    TOOLS_CALL_BODY,
      headers: { 'mcp-token': 'valid-token', 'Accept': 'text/event-stream' },
    });
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('text/event-stream');
  });

  it('SSE body contains data: frames with JSON-RPC objects', async () => {
    const { rawBody } = await fetchRaw({
      port:    portSse,
      body:    TOOLS_CALL_BODY,
      headers: { 'mcp-token': 'valid-token', 'Accept': 'text/event-stream' },
    });

    // Each SSE frame is "data: <json>\n\n"
    const frames = rawBody.split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.replace(/^data: /, '')));

    expect(frames.length).toBeGreaterThanOrEqual(1);

    // Last frame must have a `result` field (the final result frame).
    const lastFrame = frames[frames.length - 1];
    expect(lastFrame.result).toBeDefined();
    expect(lastFrame.id).toBe(42);
  });

  it('SSE body contains a notification frame (synaps/result) before the result frame', async () => {
    const { rawBody } = await fetchRaw({
      port:    portSse,
      body:    TOOLS_CALL_BODY,
      headers: { 'mcp-token': 'valid-token', 'Accept': 'text/event-stream' },
    });

    const frames = rawBody.split('\n\n')
      .filter((f) => f.startsWith('data: '))
      .map((f) => JSON.parse(f.replace(/^data: /, '')));

    const notif = frames.find((f) => f.method === 'synaps/result');
    expect(notif).toBeDefined();
  });

  it('sseEnabled=false + Accept: text/event-stream → normal JSON (application/json)', async () => {
    const { statusCode, headers, rawBody } = await fetchRaw({
      port:    portNoSse,
      body:    TOOLS_CALL_BODY,
      headers: { 'mcp-token': 'valid-token', 'Accept': 'text/event-stream' },
    });
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('application/json');
    const parsed = JSON.parse(rawBody);
    expect(parsed.result).toBeDefined();
  });
});
