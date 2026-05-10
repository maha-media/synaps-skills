/**
 * @file bridge/core/synaps-rpc-docker.test.js
 *
 * Unit tests for DockerExecSynapsRpc.
 *
 * All Docker / WorkspaceManager I/O is mocked via fake objects and a
 * PassThrough duplex stream that simulates the hijacked exec stream.
 *
 * Required cases covered (≥ 12):
 *  1.  start() calls workspaceManager.ensure with synapsUserId
 *  2.  start() calls docker exec with correct argv (incl. sessionId / model / profile flags)
 *  3.  start() emits `ready` once exec is attached
 *  4.  line-JSON parsing emits `event`-equivalent (message_update) for each chunk
 *  5.  request (prompt) writes a line-JSON to the stream
 *  6.  request (prompt) returns a Promise that resolves on matching response
 *  7.  shutdown() writes `{"type":"shutdown"}` and resolves on exit
 *  8.  events buffered across chunk boundaries are delimited correctly
 *  9.  malformed JSON line emits an `error` but doesn't crash
 * 10.  workspace.ensure failure → start() rejects, no exec attempted
 * 11.  exec.start failure → start() rejects, error emitted
 * 12.  Constructor without workspaceManager throws
 * 13.  Constructor without synapsUserId throws
 * 14.  sessionId / model / profile flags are included in the exec Cmd
 * 15.  stream end emits exit event
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { DockerExecSynapsRpc } from './synaps-rpc-docker.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * Build a fake duplex stream that can emit data (simulating docker exec output)
 * and record what is written to it (simulating stdin writes).
 */
function makeFakeExecStream() {
  const pt = new PassThrough({ allowHalfOpen: true });
  pt.writtenData = [];
  const origWrite = pt.write.bind(pt);
  pt.write = (chunk, ...rest) => {
    pt.writtenData.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return origWrite(chunk, ...rest);
  };
  return pt;
}

/**
 * Build a fake exec instance (returned by container.exec()).
 * Calling execInstance.start() returns the provided stream.
 */
function makeFakeExecInstance(stream) {
  return {
    start: vi.fn().mockResolvedValue(stream),
    inspect: vi.fn().mockResolvedValue({ ExitCode: 0, Running: false }),
  };
}

/**
 * Build a fake dockerode container with configurable exec behaviour.
 */
function makeFakeContainer(execInstance) {
  return {
    exec: vi.fn().mockResolvedValue(execInstance),
  };
}

/**
 * Build a fake dockerode Docker instance.
 * demuxStream re-routes all data from src directly to stdout (mirrors non-TTY passthrough).
 */
function makeFakeDocker(container) {
  return {
    getContainer: vi.fn().mockReturnValue(container),
    modem: {
      /**
       * Fake demux: we simulate a non-multiplexed raw stream by piping src
       * directly to stdoutStream. In real dockerode, this uses the 8-byte header;
       * here we skip that for simplicity.
       */
      demuxStream: vi.fn((src, stdoutStream, _stderrStream) => {
        src.on('data', (chunk) => stdoutStream.write(chunk));
        src.on('end',  ()      => stdoutStream.end());
      }),
    },
  };
}

/**
 * Build a fake WorkspaceManager.
 * By default ensure() resolves with a workspace doc containing container_id.
 */
function makeFakeWorkspaceManager(docker, {
  containerId   = 'fake-container-id',
  ensureError   = null,
} = {}) {
  const wm = {
    docker,   // public accessor used by DockerExecSynapsRpc
    _docker:  docker,
    ensure: vi.fn(async () => {
      if (ensureError) throw ensureError;
      return { _id: 'fake-ws-id', container_id: containerId, state: 'running' };
    }),
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  };
  return wm;
}

/**
 * Full wiring helper: creates stream → execInstance → container → docker → workspaceManager.
 * Returns everything so individual tests can inspect / push data.
 */
function buildFixture({
  synapsUserId  = 'user-abc',
  sessionId     = null,
  model         = null,
  profile       = null,
  binPath       = 'synaps',
  args          = [],
  ensureError   = null,
  execStartFail = false,
} = {}) {
  const stream       = makeFakeExecStream();
  const execInstance = makeFakeExecInstance(stream);
  if (execStartFail) {
    execInstance.start = vi.fn().mockRejectedValue(new Error('exec start failed'));
  }
  const container  = makeFakeContainer(execInstance);
  const docker     = makeFakeDocker(container);
  const wm         = makeFakeWorkspaceManager(docker, { ensureError });
  const logger     = makeLogger();

  const rpc = new DockerExecSynapsRpc({
    workspaceManager: wm,
    synapsUserId,
    binPath,
    sessionId,
    model,
    profile,
    args,
    logger,
  });

  return { rpc, wm, docker, container, execInstance, stream, logger };
}

/**
 * Push a `ready` frame into the fake exec stream so start() can resolve.
 */
function sendReady(stream, { sessionId = 'sess-1', model = 'claude-opus', protocolVersion = 1 } = {}) {
  stream.push(JSON.stringify({
    type:             'ready',
    session_id:       sessionId,
    model,
    protocol_version: protocolVersion,
  }) + '\n');
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('DockerExecSynapsRpc', () => {

  // ── test 12 / 13: constructor guards ───────────────────────────────────────

  it('12. Constructor without workspaceManager throws', () => {
    expect(() => new DockerExecSynapsRpc({ synapsUserId: 'u1' }))
      .toThrow('workspaceManager is required');
  });

  it('13. Constructor without synapsUserId throws', () => {
    expect(() => new DockerExecSynapsRpc({ workspaceManager: {} }))
      .toThrow('synapsUserId is required');
  });

  // ── test 1: ensure() called with correct userId ────────────────────────────

  it('1. start() calls workspaceManager.ensure with synapsUserId', async () => {
    const { rpc, wm, stream } = buildFixture({ synapsUserId: 'user-xyz' });
    const startP = rpc.start();
    sendReady(stream);
    await startP;
    expect(wm.ensure).toHaveBeenCalledWith('user-xyz');
  });

  // ── test 2: docker exec called with correct argv (basic) ──────────────────

  it('2. start() calls docker exec with correct Cmd (no flags)', async () => {
    const { rpc, container, stream } = buildFixture({ binPath: 'synaps' });
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    expect(container.exec).toHaveBeenCalledWith(expect.objectContaining({
      Cmd:          ['synaps', 'rpc'],
      AttachStdin:  true,
      AttachStdout: true,
      AttachStderr: true,
      Tty:          false,
    }));
  });

  // ── test 14: flags included when provided ─────────────────────────────────

  it('14. start() includes --continue / --model / --profile flags in Cmd', async () => {
    const { rpc, container, stream } = buildFixture({
      sessionId: 'ses-99',
      model:     'claude-sonnet',
      profile:   'myprofile',
    });
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const { Cmd } = container.exec.mock.calls[0][0];
    expect(Cmd).toContain('--continue');
    expect(Cmd).toContain('ses-99');
    expect(Cmd).toContain('--model');
    expect(Cmd).toContain('claude-sonnet');
    expect(Cmd).toContain('--profile');
    expect(Cmd).toContain('myprofile');
  });

  // ── test 3: emits 'ready' once exec attached ──────────────────────────────

  it('3. start() resolves with ready payload', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream, { sessionId: 'sess-42', model: 'gpt-99', protocolVersion: 1 });
    const result = await startP;
    expect(result).toMatchObject({ sessionId: 'sess-42', model: 'gpt-99', protocolVersion: 1 });
  });

  // ── test 4: line-JSON parsing emits message_update ────────────────────────

  it('4. message_update frames are emitted after start()', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const events = [];
    rpc.on('message_update', (e) => events.push(e));

    stream.push(JSON.stringify({ type: 'message_update', event: { text: 'hello' } }) + '\n');
    // Give event loop a tick
    await new Promise((r) => setTimeout(r, 0));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: 'hello' });
  });

  // ── test 5: prompt() writes line-JSON to stream ───────────────────────────

  it('5. prompt() writes a line-JSON frame to the exec stream', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    // Don't await prompt (we need to inspect before the response arrives)
    const promptP = rpc.prompt('hello docker');

    // Drain: the last write contains our frame
    await new Promise((r) => setTimeout(r, 0));

    // Find the prompt frame in what was written
    const writtenFrame = stream.writtenData.find((d) => {
      try {
        const j = JSON.parse(d.trim());
        return j.type === 'prompt' && j.message === 'hello docker';
      } catch { return false; }
    });
    expect(writtenFrame).toBeDefined();

    // Resolve the pending promise by sending back a response
    const sentFrame = JSON.parse(writtenFrame.trim());
    stream.push(JSON.stringify({ type: 'response', id: sentFrame.id, command: 'prompt', ok: true }) + '\n');
    await promptP;
  });

  // ── test 6: prompt() resolves on matching response ────────────────────────

  it('6. prompt() resolves with response payload from matching id', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const promptP = rpc.prompt('tell me a joke');
    await new Promise((r) => setTimeout(r, 0));

    // Extract id from the written frame
    const written = stream.writtenData.find((d) => {
      try { return JSON.parse(d.trim()).type === 'prompt'; } catch { return false; }
    });
    const { id } = JSON.parse(written.trim());

    stream.push(JSON.stringify({ type: 'response', id, command: 'prompt', ok: true, text: 'funny' }) + '\n');

    const result = await promptP;
    expect(result).toMatchObject({ ok: true, text: 'funny' });
  });

  // ── test 7: shutdown() writes shutdown frame and resolves on exit ─────────

  it('7. shutdown() writes {"type":"shutdown"} and resolves on exit', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const shutP = rpc.shutdown();
    await new Promise((r) => setTimeout(r, 0));

    const shutFrame = stream.writtenData.find((d) => {
      try { return JSON.parse(d.trim()).type === 'shutdown'; } catch { return false; }
    });
    expect(shutFrame).toBeDefined();

    // End the stream to simulate exec exit
    stream.push(null);
    const result = await shutP;
    expect(result).toMatchObject({ code: null, signal: null });
  });

  // ── test 8: events buffered across chunk boundaries ───────────────────────

  it('8. events split across multiple chunks are parsed correctly', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();

    // Send ready in two pieces
    const readyLine = JSON.stringify({
      type:             'ready',
      session_id:       'sess-chunked',
      model:            'fast',
      protocol_version: 1,
    });
    stream.push(readyLine.slice(0, 10));
    stream.push(readyLine.slice(10) + '\n');

    const result = await startP;
    expect(result.sessionId).toBe('sess-chunked');

    // Now send two events, the first split
    const events = [];
    rpc.on('agent_end', (e) => events.push(e));

    const evt1 = JSON.stringify({ type: 'agent_end', usage: { tokens: 100 } });
    const evt2 = JSON.stringify({ type: 'agent_end', usage: { tokens: 200 } });

    stream.push(evt1.slice(0, 5));
    stream.push(evt1.slice(5) + '\n' + evt2 + '\n');

    await new Promise((r) => setTimeout(r, 5));

    expect(events).toHaveLength(2);
    expect(events[0].usage.tokens).toBe(100);
    expect(events[1].usage.tokens).toBe(200);
  });

  // ── test 9: malformed JSON emits error but doesn't crash ──────────────────

  it('9. malformed JSON line emits an "error" but does not throw / crash', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const errors = [];
    rpc.on('error', (e) => errors.push(e));

    // Push a malformed line
    stream.push('THIS IS NOT JSON\n');
    await new Promise((r) => setTimeout(r, 5));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Malformed JSON/i);
  });

  // ── test 10: ensure() failure → start() rejects, no exec ─────────────────

  it('10. workspace.ensure failure → start() rejects, no exec attempted', async () => {
    const ensureError = new Error('workspace boot failed');
    const { rpc, container } = buildFixture({ ensureError });

    await expect(rpc.start()).rejects.toThrow('workspace boot failed');
    expect(container.exec).not.toHaveBeenCalled();
  });

  // ── test 11: exec.start() failure → start() rejects ──────────────────────

  it('11. exec.start() failure → start() rejects, error event emitted', async () => {
    const { rpc } = buildFixture({ execStartFail: true });

    const errors = [];
    rpc.on('error', (e) => errors.push(e));

    await expect(rpc.start()).rejects.toThrow('exec start failed');
    expect(errors).toHaveLength(1);
  });

  // ── test 15: stream end emits exit ────────────────────────────────────────

  it('15. stream end emits "exit" event', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const exits = [];
    rpc.on('exit', (e) => exits.push(e));

    stream.push(null); // EOF
    await new Promise((r) => setTimeout(r, 5));

    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ code: null, signal: null });
  });

  // ── double-start guard ────────────────────────────────────────────────────

  it('throws if start() is called twice', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    await expect(rpc.start()).rejects.toThrow('already started');
  });

  // ── subagent events are forwarded ─────────────────────────────────────────

  it('subagent_start / subagent_update / subagent_done events are emitted', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const starts  = [];
    const updates = [];
    const dones   = [];
    rpc.on('subagent_start',  (e) => starts.push(e));
    rpc.on('subagent_update', (e) => updates.push(e));
    rpc.on('subagent_done',   (e) => dones.push(e));

    stream.push(JSON.stringify({ type: 'subagent_start',  subagent_id: 's1', agent_name: 'a', task_preview: 't' }) + '\n');
    stream.push(JSON.stringify({ type: 'subagent_update', subagent_id: 's1', agent_name: 'a', status: 'working' }) + '\n');
    stream.push(JSON.stringify({ type: 'subagent_done',   subagent_id: 's1', agent_name: 'a', result_preview: 'done', duration_secs: 1.2 }) + '\n');

    await new Promise((r) => setTimeout(r, 5));

    expect(starts).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(dones).toHaveLength(1);
  });

  // ── error frame correlation ───────────────────────────────────────────────

  it('error frame with matching id rejects the pending promise', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const promptP = rpc.prompt('fail me');
    await new Promise((r) => setTimeout(r, 0));

    const written = stream.writtenData.find((d) => {
      try { return JSON.parse(d.trim()).type === 'prompt'; } catch { return false; }
    });
    const { id } = JSON.parse(written.trim());

    stream.push(JSON.stringify({ type: 'error', id, message: 'something went wrong' }) + '\n');

    await expect(promptP).rejects.toThrow('something went wrong');
  });

  // ── unmatched error frame emits global error ──────────────────────────────

  it('error frame with no matching id emits global "error" event', async () => {
    const { rpc, stream } = buildFixture();
    const startP = rpc.start();
    sendReady(stream);
    await startP;

    const errors = [];
    rpc.on('error', (e) => errors.push(e));

    stream.push(JSON.stringify({ type: 'error', message: 'unexpected crash' }) + '\n');
    await new Promise((r) => setTimeout(r, 5));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('unexpected crash');
  });
});
