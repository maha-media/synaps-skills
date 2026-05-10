/**
 * bridge/core/synaps-rpc.test.js
 *
 * Unit tests for SynapsRpc — uses a fake child process built from
 * node:stream PassThrough pairs so no real `synaps` binary is ever spawned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { SynapsRpc } from "./synaps-rpc.js";

// ─── fake child factory ───────────────────────────────────────────────────────

/**
 * Creates a fake child-process-like object.
 *
 * Architecture:
 *   - `child.stdin`  is a PassThrough that the SynapsRpc instance writes to.
 *     We can read from it with `parentStdin`.
 *   - `child.stdout` is a PassThrough that we (the test) write to via
 *     `childStdoutWrite(line)`.
 *   - `child.stderr` is a PassThrough we write to via `childStderrWrite(text)`.
 *   - `simulateExit(code, signal)` triggers the 'exit' event.
 *
 * @returns {{ child: object, parentStdin: PassThrough, childStdoutWrite: Function,
 *             childStderrWrite: Function, simulateExit: Function }}
 */
function fakeChild() {
  // stdin as seen by the parent (SynapsRpc writes here)
  const stdinPT = new PassThrough();

  // stdout as seen by the parent (SynapsRpc reads here; test writes via childStdoutWrite)
  const stdoutPT = new PassThrough();

  // stderr as seen by the parent
  const stderrPT = new PassThrough();

  const emitter = new EventEmitter();

  const child = Object.assign(emitter, {
    stdin: stdinPT,
    stdout: stdoutPT,
    stderr: stderrPT,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn((sig) => {
      child.killed = true;
      child.signalCode = sig ?? "SIGTERM";
      // Simulate immediate exit on kill
      process.nextTick(() => simulateExit(null, sig ?? "SIGTERM"));
    }),
  });

  function childStdoutWrite(text) {
    stdoutPT.push(text);
  }

  function childStderrWrite(text) {
    stderrPT.push(text);
  }

  function simulateExit(code = 0, signal = null) {
    child.exitCode = code;
    child.signalCode = signal;
    stdoutPT.push(null); // EOF
    stderrPT.push(null); // EOF
    child.emit("exit", code, signal);
  }

  return { child, parentStdin: stdinPT, childStdoutWrite, childStderrWrite, simulateExit };
}

/**
 * Read one complete JSONL line from a readable stream.
 * @param {PassThrough} stream
 * @returns {Promise<object>}
 */
function readOneLine(stream) {
  return new Promise((resolve, reject) => {
    let buf = "";
    function onData(chunk) {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        stream.removeListener("data", onData);
        stream.removeListener("error", reject);
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    }
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

/**
 * Collect the next N lines from a readable stream as parsed JSON objects.
 * @param {PassThrough} stream
 * @param {number} n
 * @returns {Promise<object[]>}
 */
function readNLines(stream, n) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const lines = [];
    function onData(chunk) {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) {
          lines.push(JSON.parse(line));
          if (lines.length === n) {
            stream.removeListener("data", onData);
            stream.removeListener("error", reject);
            resolve(lines);
          }
        }
      }
    }
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

// ─── helper to create an RPC instance backed by a fake child ─────────────────

function makeRpc(extraOpts = {}) {
  const fake = fakeChild();
  const rpc = new SynapsRpc({
    binPath: "synaps",
    commandTimeoutMs: 200,
    spawnTimeoutMs: 100,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    _spawn: () => fake.child,
    ...extraOpts,
  });
  return { rpc, ...fake };
}

// ─── helper to send a JSONL frame from child stdout ───────────────────────────

function sendFrame(write, obj) {
  write(JSON.stringify(obj) + "\n");
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("SynapsRpc", () => {

  // ── start() ──────────────────────────────────────────────────────────────

  describe("start()", () => {
    it("waits for ready event and resolves with {sessionId, model, protocolVersion}", async () => {
      const { rpc, childStdoutWrite } = makeRpc();

      const startPromise = rpc.start();

      // Simulate child emitting ready
      sendFrame(childStdoutWrite, {
        type: "ready",
        session_id: "sess-abc",
        model: "claude-opus-4-5",
        protocol_version: 1,
      });

      const result = await startPromise;
      expect(result).toEqual({
        sessionId: "sess-abc",
        model: "claude-opus-4-5",
        protocolVersion: 1,
      });
    });

    it("rejects if protocol_version !== 1", async () => {
      const { rpc, childStdoutWrite } = makeRpc();

      const startPromise = rpc.start();

      const readyP = new Promise((resolve) => rpc.once("error", resolve));

      sendFrame(childStdoutWrite, {
        type: "ready",
        session_id: "sess-abc",
        model: "claude-opus-4-5",
        protocol_version: 2,
      });

      const err = await readyP;
      expect(err.message).toMatch(/unsupported protocol_version 2/);

      // start() should time out (or resolve to never get there) —
      // we just confirm the error was emitted
      await expect(startPromise).rejects.toThrow();
    });

    it("times out after spawnTimeoutMs if no ready arrives", async () => {
      const { rpc } = makeRpc({ spawnTimeoutMs: 50 });

      await expect(rpc.start()).rejects.toThrow(/timed out waiting for ready/);
    });
  });

  // ── prompt() ─────────────────────────────────────────────────────────────

  describe("prompt()", () => {
    async function startedRpc(extra = {}) {
      const ctx = makeRpc(extra);
      const sp = ctx.rpc.start();
      sendFrame(ctx.childStdoutWrite, {
        type: "ready",
        session_id: "S1",
        model: "m1",
        protocol_version: 1,
      });
      await sp;
      return ctx;
    }

    it("correlates response by id and resolves with body", async () => {
      const { rpc, parentStdin, childStdoutWrite } = await startedRpc();

      const promptP = rpc.prompt("hello world");

      // Read what the rpc wrote to stdin
      const cmd = await readOneLine(parentStdin);
      expect(cmd.type).toBe("prompt");
      expect(cmd.message).toBe("hello world");
      expect(typeof cmd.id).toBe("string");

      // Send back a matching response
      sendFrame(childStdoutWrite, {
        type: "response",
        id: cmd.id,
        command: "prompt",
        ok: true,
        text: "Hi there!",
      });

      const result = await promptP;
      expect(result.ok).toBe(true);
      expect(result.text).toBe("Hi there!");
    });

    it("rejects when matching error event arrives with same id", async () => {
      const { rpc, parentStdin, childStdoutWrite } = await startedRpc();

      const promptP = rpc.prompt("fail please");
      const cmd = await readOneLine(parentStdin);

      sendFrame(childStdoutWrite, {
        type: "error",
        id: cmd.id,
        message: "runtime exploded",
      });

      await expect(promptP).rejects.toThrow("runtime exploded");
    });

    it("rejects after commandTimeoutMs with no response", async () => {
      const { rpc } = await startedRpc({ commandTimeoutMs: 50 });

      await expect(rpc.prompt("timeout test")).rejects.toThrow(/rpc timeout/);
    });

    it("rejects when ok:false with response.error message", async () => {
      const { rpc, parentStdin, childStdoutWrite } = await startedRpc();

      const promptP = rpc.prompt("bad");
      const cmd = await readOneLine(parentStdin);

      sendFrame(childStdoutWrite, {
        type: "response",
        id: cmd.id,
        command: "prompt",
        ok: false,
        error: "stream error",
      });

      await expect(promptP).rejects.toThrow("stream error");
    });

    it("rejects when ok:false with generic 'prompt failed' if no error field", async () => {
      const { rpc, parentStdin, childStdoutWrite } = await startedRpc();

      const promptP = rpc.prompt("bad2");
      const cmd = await readOneLine(parentStdin);

      sendFrame(childStdoutWrite, {
        type: "response",
        id: cmd.id,
        command: "prompt",
        ok: false,
      });

      await expect(promptP).rejects.toThrow("prompt failed");
    });
  });

  // ── abort() ───────────────────────────────────────────────────────────────

  describe("abort()", () => {
    it("sends {type:'abort', id:...} and resolves on response", async () => {
      const { rpc, childStdoutWrite } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // We need to intercept abort before it resolves
      let capturedId;
      const origSend = rpc._send.bind(rpc);
      vi.spyOn(rpc, "_send").mockImplementation((frame) => {
        const p = origSend(frame);
        return p;
      });

      const abortP = rpc.abort();

      // Collect the frame from stdin
      const { rpc: _r, parentStdin, childStdoutWrite: cw, ...rest } = makeRpc();
      // We need to read from the actual parentStdin — re-read from rpc's child stdin directly
      const stdinChunks = [];
      rpc._child.stdin.on("data", (d) => stdinChunks.push(d));

      // Give event loop a tick to propagate the write
      await new Promise((r) => setTimeout(r, 10));

      const raw = Buffer.concat(stdinChunks).toString();
      const sentCmd = JSON.parse(raw.trim());
      expect(sentCmd.type).toBe("abort");
      expect(typeof sentCmd.id).toBe("string");

      capturedId = sentCmd.id;

      sendFrame(childStdoutWrite, {
        type: "response",
        id: capturedId,
        command: "abort",
        ok: true,
      });

      const result = await abortP;
      expect(result.ok).toBe(true);
    });
  });

  // ── shutdown() ────────────────────────────────────────────────────────────

  describe("shutdown()", () => {
    it("writes {type:'shutdown'}, waits for exit, resolves with {code, signal}", async () => {
      const { rpc, childStdoutWrite, simulateExit } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Collect stdin writes
      const stdinData = [];
      rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const shutdownP = rpc.shutdown(500);

      // Give a tick for the write
      await new Promise((r) => setTimeout(r, 10));

      // Verify shutdown was written
      const written = Buffer.concat(stdinData).toString();
      const frame = JSON.parse(written.trim());
      expect(frame.type).toBe("shutdown");
      expect(frame.id).toBeUndefined();

      // Simulate clean exit — _onChildExit wraps into { code, signal }
      simulateExit(0, null);

      const result = await shutdownP;
      expect(result).toEqual({ code: 0, signal: null });
    });

    it("SIGTERMs on grace timeout, SIGKILLs after second timeout", async () => {
      // Use short grace AND short SIGKILL delay so the test runs fast
      const { rpc, childStdoutWrite, child } = makeRpc({
        _sigkillDelayMs: 30,
      });
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Override kill to NOT auto-exit (we want to test the two-stage kill)
      child.kill = vi.fn((sig) => {
        child.killed = true;
        child.signalCode = sig ?? null;
        // Do NOT emit exit — simulate the child hanging
      });

      // Grace = 30ms, SIGKILL delay = 30ms → total ≈ 60ms before SIGKILL is sent
      const shutdownP = rpc.shutdown(30);

      // Wait enough for both timeouts to fire (grace 30 + SIGKILL 30 + headroom)
      await new Promise((r) => setTimeout(r, 150));

      // Should have called SIGTERM then SIGKILL
      const killCalls = child.kill.mock.calls.map((c) => c[0]);
      expect(killCalls).toContain("SIGTERM");
      expect(killCalls).toContain("SIGKILL");

      // Now simulate exit so the promise can resolve
      child.emit("exit", null, "SIGKILL");

      await shutdownP; // Should resolve without throwing
    });

    it("resolves immediately if child already exited before shutdown() is called", async () => {
      const { rpc, childStdoutWrite, simulateExit } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Let the child exit first
      simulateExit(0, null);
      await new Promise((r) => setTimeout(r, 10));

      // Now set exitCode on the fake child so the "already dead" branch fires
      rpc._child.exitCode = 0;

      // shutdown() should resolve synchronously via the already-dead fast-path
      const result = await rpc.shutdown(500);
      expect(result).toEqual({ code: 0, signal: null });
    });
  });

  // ── streaming events ──────────────────────────────────────────────────────

  describe("streaming events", () => {
    async function startedCtx() {
      const ctx = makeRpc();
      const sp = ctx.rpc.start();
      sendFrame(ctx.childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;
      return ctx;
    }

    it("message_update: forwards the inner event object (not the wrapper)", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();

      const received = await new Promise((resolve) => {
        rpc.once("message_update", resolve);
        sendFrame(childStdoutWrite, {
          type: "message_update",
          event: { type: "text_delta", delta: "Hello!" },
        });
      });

      expect(received).toEqual({ type: "text_delta", delta: "Hello!" });
    });

    it("subagent_start re-emits verbatim", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();

      const received = await new Promise((resolve) => {
        rpc.once("subagent_start", resolve);
        sendFrame(childStdoutWrite, {
          type: "subagent_start",
          subagent_id: 42,
          agent_name: "researcher",
          task_preview: "Look up stuff",
        });
      });

      expect(received).toEqual({
        subagent_id: 42,
        agent_name: "researcher",
        task_preview: "Look up stuff",
      });
    });

    it("subagent_update re-emits verbatim", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();

      const received = await new Promise((resolve) => {
        rpc.once("subagent_update", resolve);
        sendFrame(childStdoutWrite, {
          type: "subagent_update",
          subagent_id: 42,
          agent_name: "researcher",
          status: "running",
        });
      });

      expect(received).toEqual({
        subagent_id: 42,
        agent_name: "researcher",
        status: "running",
      });
    });

    it("subagent_done re-emits verbatim", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();

      const received = await new Promise((resolve) => {
        rpc.once("subagent_done", resolve);
        sendFrame(childStdoutWrite, {
          type: "subagent_done",
          subagent_id: 42,
          agent_name: "researcher",
          result_preview: "Found 3 CVEs",
          duration_secs: 8.2,
        });
      });

      expect(received).toEqual({
        subagent_id: 42,
        agent_name: "researcher",
        result_preview: "Found 3 CVEs",
        duration_secs: 8.2,
      });
    });

    it("agent_end re-emits with {usage}", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();

      const usage = {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        model: "claude-opus-4-5",
      };

      const received = await new Promise((resolve) => {
        rpc.once("agent_end", resolve);
        sendFrame(childStdoutWrite, { type: "agent_end", usage });
      });

      expect(received).toEqual({ usage });
    });
  });

  // ── line buffering ────────────────────────────────────────────────────────

  describe("line buffering", () => {
    it("partial JSON lines are buffered correctly (split frame across two chunks)", async () => {
      const { rpc, childStdoutWrite } = makeRpc();
      const sp = rpc.start();

      // Split the ready frame across two chunks
      const readyJson = JSON.stringify({
        type: "ready",
        session_id: "S-partial",
        model: "m1",
        protocol_version: 1,
      }) + "\n";

      const half = Math.floor(readyJson.length / 2);
      childStdoutWrite(readyJson.slice(0, half));

      // event_update frame also split
      const updateJson = JSON.stringify({
        type: "message_update",
        event: { type: "text_delta", delta: "split!" },
      }) + "\n";

      let updateCount = 0;
      rpc.on("message_update", () => updateCount++);

      // Complete the ready frame
      childStdoutWrite(readyJson.slice(half));
      await sp;

      // Now send a split update frame
      const updateHalf = Math.floor(updateJson.length / 2);
      childStdoutWrite(updateJson.slice(0, updateHalf));

      await new Promise((r) => setTimeout(r, 10));
      expect(updateCount).toBe(0); // not yet — still buffered

      childStdoutWrite(updateJson.slice(updateHalf));

      await new Promise((r) => setTimeout(r, 10));
      expect(updateCount).toBe(1); // exactly one, not two
    });

    it("malformed JSON is dropped with a logger.warn call", async () => {
      const { rpc, childStdoutWrite } = makeRpc();
      const sp = rpc.start();

      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Inject bad JSON (not a complete frame — use raw write)
      childStdoutWrite("this is { not json\n");

      await new Promise((r) => setTimeout(r, 10));

      expect(rpc.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("dropped malformed JSON")
      );
    });

    it("oversize line (>1 MiB) passes through as normal (client trusts upstream)", async () => {
      const { rpc, childStdoutWrite } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Build a message_update with a 1.5 MiB delta
      const bigDelta = "x".repeat(1.5 * 1024 * 1024);
      const received = await new Promise((resolve) => {
        rpc.once("message_update", resolve);
        sendFrame(childStdoutWrite, {
          type: "message_update",
          event: { type: "text_delta", delta: bigDelta },
        });
      });

      expect(received.delta).toBe(bigDelta);
    });

    it("partial line remaining in lineBuffer when stdout ends is flushed", async () => {
      const { rpc, childStdoutWrite, child } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Write a complete message_update frame WITHOUT a trailing newline so it
      // stays in _lineBuffer; then close stdout — the "end" handler should flush.
      const frame = JSON.stringify({
        type: "message_update",
        event: { type: "text_delta", delta: "no-newline" },
      }); // intentionally no "\n"

      const received = await new Promise((resolve) => {
        rpc.once("message_update", resolve);
        child.stdout.push(frame);   // push without \n
        child.stdout.push(null);    // EOF → triggers "end" event
      });

      expect(received).toEqual({ type: "text_delta", delta: "no-newline" });
    });

    it("stderr end event flushes partial last line that had no trailing newline", async () => {
      const { rpc, childStdoutWrite, child } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Push stderr text without a newline, then EOF
      child.stderr.push("partial stderr line without newline");
      child.stderr.push(null); // EOF

      await new Promise((r) => setTimeout(r, 20));

      expect(rpc.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("partial stderr line without newline")
      );
    });
  });

  // ── backpressure ──────────────────────────────────────────────────────────

  describe("backpressure", () => {
    it("stdin write returning false makes the next write wait for 'drain'", async () => {
      const { rpc, childStdoutWrite } = makeRpc({ commandTimeoutMs: 500 });
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Track write order
      const writeOrder = [];

      // Override stdin.write to simulate backpressure on first call
      let drainCb = null;
      const origWrite = rpc._child.stdin.write.bind(rpc._child.stdin);
      let writeCallCount = 0;

      vi.spyOn(rpc._child.stdin, "write").mockImplementation((data, ...rest) => {
        writeCallCount++;
        writeOrder.push(`write-${writeCallCount}`);
        if (writeCallCount === 1) {
          // Return false to signal backpressure
          // Store data so we can verify it was written
          origWrite(data);
          return false;
        }
        return origWrite(data, ...rest);
      });

      // Manually emit drain after a tick
      const drainSpy = vi.fn();

      // Spy on 'once' for drain
      const originalOnce = rpc._child.stdin.once.bind(rpc._child.stdin);
      vi.spyOn(rpc._child.stdin, "once").mockImplementation((event, cb) => {
        if (event === "drain") {
          drainCb = cb;
          drainSpy();
          return rpc._child.stdin;
        }
        return originalOnce(event, cb);
      });

      // Send two frames rapidly
      rpc._writeFrame(JSON.stringify({ type: "get_state", id: "id1" }) + "\n");
      rpc._writeFrame(JSON.stringify({ type: "get_state", id: "id2" }) + "\n");

      // At this point, write should have been called once (first frame), returned false,
      // and the second frame should be queued
      expect(drainSpy).toHaveBeenCalledTimes(1);
      expect(writeCallCount).toBe(1);

      // Now trigger drain — second frame should flush
      drainCb();

      await new Promise((r) => setTimeout(r, 10));

      // Both frames should have been written
      expect(writeCallCount).toBe(2);
    });
  });

  // ── child crash ───────────────────────────────────────────────────────────

  describe("child crash", () => {
    it("child crash mid-prompt → all pending promises reject with 'rpc child exited'", async () => {
      const { rpc, childStdoutWrite, simulateExit } = makeRpc({ commandTimeoutMs: 5000 });
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Issue two commands that won't be answered
      const p1 = rpc.prompt("cmd1").catch((e) => e);
      const p2 = rpc.getState().catch((e) => e);

      await new Promise((r) => setTimeout(r, 10));

      // Simulate crash
      simulateExit(1, null);

      const [e1, e2] = await Promise.all([p1, p2]);
      expect(e1.message).toMatch(/rpc child exited/);
      expect(e2.message).toMatch(/rpc child exited/);
    });
  });

  // ── stderr logging ────────────────────────────────────────────────────────

  describe("stderr", () => {
    it("stderr lines pass through to logger.warn", async () => {
      const { rpc, childStdoutWrite, childStderrWrite } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      childStderrWrite("ERROR: something went wrong\n");

      await new Promise((r) => setTimeout(r, 20));

      expect(rpc.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("ERROR: something went wrong")
      );
    });
  });

  // ── token redaction ───────────────────────────────────────────────────────

  describe("token redaction", () => {
    it("env with SLACK_BOT_TOKEN never appears in any logger call", async () => {
      const secret = "xoxb-secret-token-1234";
      const warnSpy = vi.fn();
      const infoSpy = vi.fn();
      const errorSpy = vi.fn();

      const { rpc, childStdoutWrite, childStderrWrite } = makeRpc({
        env: { SLACK_BOT_TOKEN: secret, PATH: "/usr/bin" },
        logger: { warn: warnSpy, info: infoSpy, error: errorSpy },
      });

      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      // Force a warn by sending bad JSON
      childStderrWrite("some stderr line\n");
      childStdoutWrite("not json\n");

      await new Promise((r) => setTimeout(r, 20));

      // Collect ALL logger calls
      const allCalls = [
        ...warnSpy.mock.calls,
        ...infoSpy.mock.calls,
        ...errorSpy.mock.calls,
      ].flat().map(String);

      for (const call of allCalls) {
        expect(call).not.toContain(secret);
      }
    });
  });

  // ── command arg flags ─────────────────────────────────────────────────────

  describe("CLI flag building", () => {
    it("passes --continue, --system, --model, --profile flags correctly", async () => {
      let capturedBin, capturedArgv;

      const fakeFn = (bin, argv, opts) => {
        capturedBin = bin;
        capturedArgv = argv;
        return fakeChild().child;
      };

      const rpc = new SynapsRpc({
        binPath: "synaps",
        sessionId: "sess-xyz",
        systemPrompt: "you are helpful",
        model: "claude-opus-4-5",
        profile: "work",
        args: ["--debug"],
        _spawn: fakeFn,
        spawnTimeoutMs: 50,
      });

      // start() will time out since we don't emit ready, but flags should be captured
      await rpc.start().catch(() => {});

      expect(capturedBin).toBe("synaps");
      expect(capturedArgv).toEqual([
        "rpc",
        "--continue", "sess-xyz",
        "--system", "you are helpful",
        "--model", "claude-opus-4-5",
        "--profile", "work",
        "--debug",
      ]);
    });
  });

  // ── other commands ────────────────────────────────────────────────────────

  describe("other commands", () => {
    async function startedCtx(extraOpts = {}) {
      const ctx = makeRpc(extraOpts);
      const sp = ctx.rpc.start();
      sendFrame(ctx.childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;
      return ctx;
    }

    it("followUp sends follow_up type and resolves on response", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();
      const stdinData = [];
      rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const p = rpc.followUp("and another thing");

      await new Promise((r) => setTimeout(r, 10));
      const raw = Buffer.concat(stdinData).toString().trim();
      const cmd = JSON.parse(raw);

      sendFrame(childStdoutWrite, { type: "response", id: cmd.id, command: "follow_up", ok: true });

      const result = await p;
      expect(result.ok).toBe(true);
      expect(cmd.type).toBe("follow_up");
      expect(cmd.message).toBe("and another thing");
    });

    it("compact sends compact type", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();
      const stdinData = [];
      rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const p = rpc.compact();
      await new Promise((r) => setTimeout(r, 10));
      const cmd = JSON.parse(Buffer.concat(stdinData).toString().trim());

      sendFrame(childStdoutWrite, { type: "response", id: cmd.id, command: "compact", ok: true });
      await p;
      expect(cmd.type).toBe("compact");
    });

    it("newSession sends new_session type", async () => {
      const ctx = makeRpc();
      const sp = ctx.rpc.start();
      sendFrame(ctx.childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      const stdinData = [];
      ctx.rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const p = ctx.rpc.newSession();
      await new Promise((r) => setTimeout(r, 10));
      const cmd = JSON.parse(Buffer.concat(stdinData).toString().trim());

      sendFrame(ctx.childStdoutWrite, {
        type: "response", id: cmd.id, command: "new_session", ok: true,
      });
      await p;
      expect(cmd.type).toBe("new_session");
    });

    it("getMessages sends get_messages type", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();
      const stdinData = [];
      rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const p = rpc.getMessages();
      await new Promise((r) => setTimeout(r, 10));
      const cmd = JSON.parse(Buffer.concat(stdinData).toString().trim());

      sendFrame(childStdoutWrite, { type: "response", id: cmd.id, command: "get_messages", messages: [] });
      const result = await p;
      expect(cmd.type).toBe("get_messages");
      expect(result.messages).toEqual([]);
    });

    it("setModel sends set_model with model field", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();
      const stdinData = [];
      rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const p = rpc.setModel("claude-haiku");
      await new Promise((r) => setTimeout(r, 10));
      const cmd = JSON.parse(Buffer.concat(stdinData).toString().trim());

      sendFrame(childStdoutWrite, { type: "response", id: cmd.id, command: "set_model", ok: true });
      await p;
      expect(cmd.type).toBe("set_model");
      expect(cmd.model).toBe("claude-haiku");
    });

    it("getAvailableModels sends get_available_models type", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();
      const stdinData = [];
      rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const p = rpc.getAvailableModels();
      await new Promise((r) => setTimeout(r, 10));
      const cmd = JSON.parse(Buffer.concat(stdinData).toString().trim());

      sendFrame(childStdoutWrite, { type: "response", id: cmd.id, command: "get_available_models", models: ["m1"] });
      const result = await p;
      expect(cmd.type).toBe("get_available_models");
      expect(result.models).toEqual(["m1"]);
    });

    it("getSessionStats sends get_session_stats type", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();
      const stdinData = [];
      rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const p = rpc.getSessionStats();
      await new Promise((r) => setTimeout(r, 10));
      const cmd = JSON.parse(Buffer.concat(stdinData).toString().trim());

      sendFrame(childStdoutWrite, { type: "response", id: cmd.id, command: "get_session_stats", messages: 5 });
      const result = await p;
      expect(cmd.type).toBe("get_session_stats");
      expect(result.messages).toBe(5);
    });

    it("getState sends get_state type", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();
      const stdinData = [];
      rpc._child.stdin.on("data", (d) => stdinData.push(d));

      const p = rpc.getState();
      await new Promise((r) => setTimeout(r, 10));
      const cmd = JSON.parse(Buffer.concat(stdinData).toString().trim());

      sendFrame(childStdoutWrite, {
        type: "response", id: cmd.id, command: "get_state",
        streaming: false, model: "m1", session_id: "S1",
      });
      const result = await p;
      expect(cmd.type).toBe("get_state");
      expect(result.streaming).toBe(false);
    });
  });

  // ── error without id ──────────────────────────────────────────────────────

  describe("unmatched error frames", () => {
    it("error frame with no matching id emits 'error' event on the emitter", async () => {
      const { rpc, childStdoutWrite } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      const errP = new Promise((resolve) => rpc.once("error", resolve));

      sendFrame(childStdoutWrite, {
        type: "error",
        message: "frame too large",
        id: null,
      });

      const err = await errP;
      expect(err.message).toBe("frame too large");
    });
  });

  // ── double start guard ────────────────────────────────────────────────────

  describe("double start guard", () => {
    it("throws if start() is called twice", async () => {
      const { rpc, childStdoutWrite } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      await expect(rpc.start()).rejects.toThrow("already started");
    });
  });

  // ── coverage: remaining branches ─────────────────────────────────────────

  describe("branch coverage", () => {
    async function startedCtx(extra = {}) {
      const ctx = makeRpc(extra);
      const sp = ctx.rpc.start();
      sendFrame(ctx.childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;
      return ctx;
    }

    it("unknown frame type is logged via logger.warn and not thrown", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();

      // Send a frame type the client doesn't know about
      sendFrame(childStdoutWrite, { type: "future_unknown_event", payload: 42 });

      await new Promise((r) => setTimeout(r, 20));

      expect(rpc.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("unknown frame type 'future_unknown_event'")
      );
    });

    it("spurious response with no matching pending id is silently ignored", async () => {
      const { rpc, childStdoutWrite } = await startedCtx();

      // Send a response for an id that was never registered
      sendFrame(childStdoutWrite, {
        type: "response",
        id: "nonexistent-uuid",
        command: "prompt",
        ok: true,
      });

      await new Promise((r) => setTimeout(r, 20));

      // No throw, no rejection — the pending map is unchanged (empty)
      expect(rpc._pending.size).toBe(0);
      // And logger.warn was NOT called for this (it's silently dropped)
      const warnCalls = rpc.logger.warn.mock.calls.map((c) => c[0]);
      const spuriousCalls = warnCalls.filter((m) => m && String(m).includes("nonexistent"));
      expect(spuriousCalls).toHaveLength(0);
    });
  });

  // ── exit event ────────────────────────────────────────────────────────────

  describe("exit event", () => {
    it("emits exit event with {code, signal} when child exits", async () => {
      const { rpc, childStdoutWrite, simulateExit } = makeRpc();
      const sp = rpc.start();
      sendFrame(childStdoutWrite, {
        type: "ready", session_id: "S1", model: "m1", protocol_version: 1,
      });
      await sp;

      const exitP = new Promise((resolve) => rpc.once("exit", resolve));
      simulateExit(0, null);

      const result = await exitP;
      expect(result).toEqual({ code: 0, signal: null });
    });
  });
});
