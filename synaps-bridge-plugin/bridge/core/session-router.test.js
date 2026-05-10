/**
 * @file bridge/core/session-router.test.js
 *
 * Tests for SessionRouter.
 *
 * All tests use FakeRpc and rpcFactory injection — no real synaps binary is
 * ever spawned.  Fake-timer tests use vi.useFakeTimers().
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionRouter } from "./session-router.js";
import { SessionStore } from "./session-store.js";
import { sessionKey } from "./helpers.js";

// ─── FakeRpc ─────────────────────────────────────────────────────────────────

class FakeRpc extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this._started = false;
  }

  async start() {
    this._started = true;
    const sid = this.opts.sessionId ?? "sess-" + Math.random().toString(36).slice(2);
    this._sessionId = sid;
    return {
      sessionId: sid,
      model: this.opts.model ?? "default",
      protocolVersion: 1,
    };
  }

  async prompt(msg) {
    return { ok: true, response: "echo: " + msg };
  }

  async shutdown() {
    this.emit("exit", { code: 0, signal: null });
    return { code: 0, signal: null };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function makeTempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synaps-router-test-"));
  const storePath = path.join(dir, "sessions.json");
  return { dir, storePath };
}

function makeRouter(overrides = {}) {
  const instances = [];
  const factory = vi.fn((opts) => {
    const rpc = new FakeRpc(opts);
    instances.push(rpc);
    return rpc;
  });

  const router = new SessionRouter({
    rpcFactory: factory,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    ...overrides,
  });

  return { router, factory, instances };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("SessionRouter", () => {
  let dir;
  let storePath;

  beforeEach(async () => {
    ({ dir, storePath } = await makeTempStore());
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ── getOrCreateSession — basic creation ───────────────────────────────────

  it("first call spawns and awaits ready (factory called once)", async () => {
    const { router, factory } = makeRouter();
    await router.start();

    const rpc = await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(rpc).toBeInstanceOf(FakeRpc);
    expect(rpc._started).toBe(true);

    await router.stop();
  });

  it("second call with same key returns same instance (factory NOT called again)", async () => {
    const { router, factory } = makeRouter();
    await router.start();

    const r1 = await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });
    const r2 = await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    expect(r1).toBe(r2);
    expect(factory).toHaveBeenCalledTimes(1);

    await router.stop();
  });

  // ── race safety ───────────────────────────────────────────────────────────

  it("100 concurrent calls for the same key resolve to the same instance (factory called exactly once)", async () => {
    const { router, factory, instances } = makeRouter();
    await router.start();

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        router.getOrCreateSession({ source: "slack", conversation: "C1", thread: "T1" }),
      ),
    );

    expect(factory).toHaveBeenCalledTimes(1);
    // All 100 references point to the same FakeRpc instance.
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(instances[0]);

    await router.stop();
  });

  it("100 concurrent calls for different keys spawn 100 instances", async () => {
    const { router, factory } = makeRouter();
    await router.start();

    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        router.getOrCreateSession({
          source: "slack",
          conversation: `C${i}`,
          thread: `T${i}`,
        }),
      ),
    );

    expect(factory).toHaveBeenCalledTimes(100);
    expect(new Set(results).size).toBe(100);

    await router.stop();
  });

  // ── store persistence across restart ─────────────────────────────────────

  it("session record persists across stop() / start()", async () => {
    const store = new SessionStore({ storePath });
    const { router, factory } = makeRouter({ store });
    await router.start();

    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    await router.stop();

    // Verify the record is in the store.
    const list = await store.list();
    expect(list.length).toBe(1);
    expect(list[0].source).toBe("slack");
    expect(typeof list[0].sessionId).toBe("string");
  });

  it("getOrCreateSession for an existing key spawns rpc with sessionId from store", async () => {
    // Pre-seed the store with a known sessionId.
    const store = new SessionStore({ storePath });
    await store.upsert({
      source: "slack",
      conversation: "C1",
      thread: "T1",
      sessionId: "known-session-id",
      model: "claude-opus",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });

    const { router, factory } = makeRouter({ store });
    await router.start();

    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    // The factory should have been called with sessionId = "known-session-id".
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "known-session-id" }),
    );

    await router.stop();
  });

  // ── exit / restart ────────────────────────────────────────────────────────

  it("on unexpected exit (code 1), router attempts one restart (factory called twice) and emits session_restarted on success", async () => {
    const store = new SessionStore({ storePath });
    const { router, factory, instances } = makeRouter({ store });
    await router.start();

    const restartedEvents = [];
    router.on("session_restarted", (e) => restartedEvents.push(e));

    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    // Simulate unexpected crash.
    const key = sessionKey({ source: "slack", conversation: "C1", thread: "T1" });
    instances[0].emit("exit", { code: 1, signal: null });

    // Give the async restart handler time to run.
    await new Promise((r) => setTimeout(r, 10));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(restartedEvents).toHaveLength(1);
    expect(restartedEvents[0].key).toBe(key);

    await router.stop();
  });

  it("on exit + restart failure, emits session_failed and removes from live", async () => {
    const store = new SessionStore({ storePath });
    let callCount = 0;

    const factory = vi.fn(() => {
      callCount++;
      const rpc = new FakeRpc();
      if (callCount > 1) {
        // Second factory → rpc that fails to start.
        rpc.start = async () => { throw new Error("restart failed intentionally"); };
      }
      return rpc;
    });

    const { instances } = (() => {
      const instances = [];
      const origFactory = factory;
      return { instances };
    })();

    const router = new SessionRouter({
      store,
      rpcFactory: factory,
      logger: { warn: () => {}, info: () => {}, error: () => {} },
    });
    await router.start();

    const failedEvents = [];
    router.on("session_failed", (e) => failedEvents.push(e));

    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    // Reach into the internal live map to get the first rpc.
    const key = sessionKey({ source: "slack", conversation: "C1", thread: "T1" });
    const firstRpc = router._live.get(key);

    firstRpc.emit("exit", { code: 1, signal: null });

    await new Promise((r) => setTimeout(r, 20));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].key).toBe(key);
    expect(router._live.has(key)).toBe(false);

    await router.stop();
  });

  // ── closeSession ──────────────────────────────────────────────────────────

  it("closeSession shuts down rpc and removes from live map but keeps store record", async () => {
    const store = new SessionStore({ storePath });
    const { router } = makeRouter({ store });
    await router.start();

    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    const key = sessionKey({ source: "slack", conversation: "C1", thread: "T1" });
    expect(router._live.has(key)).toBe(true);

    await router.closeSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    expect(router._live.has(key)).toBe(false);

    // Store record must still exist.
    const list = await store.list();
    expect(list.length).toBe(1);
    expect(list[0].key).toBe(key);

    await router.stop();
  });

  // ── reapIdle ─────────────────────────────────────────────────────────────

  it("reapIdle closes rpcs idle past idleTtlMs and emits session_reaped", async () => {
    vi.useFakeTimers();

    const base = 10_000_000;
    let nowValue = base;
    const nowMs = () => nowValue;

    const store = new SessionStore({ storePath, nowMs });
    const { router } = makeRouter({ store, nowMs, idleTtlMs: 60_000 });
    await router.start();

    const reaped = [];
    router.on("session_reaped", (e) => reaped.push(e));

    // Seed a session.
    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    const key = sessionKey({ source: "slack", conversation: "C1", thread: "T1" });

    // Advance time past TTL.
    nowValue = base + 120_000; // 2 minutes later, TTL is 60s.

    await router.reapIdle();

    expect(router._live.has(key)).toBe(false);
    expect(reaped).toHaveLength(1);
    expect(reaped[0].key).toBe(key);

    vi.useRealTimers();
    await router.stop();
  });

  it("reapIdle does NOT close sessions whose lastActiveAt is within TTL", async () => {
    const base = 10_000_000;
    let nowValue = base;
    const nowMs = () => nowValue;

    const store = new SessionStore({ storePath, nowMs });
    const { router } = makeRouter({ store, nowMs, idleTtlMs: 60_000 });
    await router.start();

    const reaped = [];
    router.on("session_reaped", (e) => reaped.push(e));

    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    // Advance time less than TTL.
    nowValue = base + 30_000;

    await router.reapIdle();

    const key = sessionKey({ source: "slack", conversation: "C1", thread: "T1" });
    expect(router._live.has(key)).toBe(true);
    expect(reaped).toHaveLength(0);

    await router.stop();
  });

  // ── liveSessions ─────────────────────────────────────────────────────────

  it("liveSessions() returns all live {key, rpc} pairs", async () => {
    const { router } = makeRouter();
    await router.start();

    await Promise.all([
      router.getOrCreateSession({ source: "slack", conversation: "C1", thread: "T1" }),
      router.getOrCreateSession({ source: "slack", conversation: "C2", thread: "T2" }),
    ]);

    const live = router.liveSessions();
    expect(live.length).toBe(2);
    for (const { key, rpc } of live) {
      expect(typeof key).toBe("string");
      expect(rpc).toBeInstanceOf(FakeRpc);
    }

    await router.stop();
  });

  // ── session_started event ─────────────────────────────────────────────────

  it("emits session_started with key, sessionId, model on creation", async () => {
    const { router } = makeRouter();
    await router.start();

    const started = [];
    router.on("session_started", (e) => started.push(e));

    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
      model: "claude-opus",
    });

    expect(started).toHaveLength(1);
    expect(started[0].key).toBe("slack:C1:T1");
    expect(typeof started[0].sessionId).toBe("string");
    // FakeRpc.start() returns opts.model when set, so session_started should carry "claude-opus".
    expect(started[0].model).toBe("claude-opus");

    await router.stop();
  });

  // ── recordActivity ────────────────────────────────────────────────────────

  it("recordActivity updates lastActiveAt in store", async () => {
    const base = 5_000_000;
    let nowValue = base;
    const nowMs = () => nowValue;

    const store = new SessionStore({ storePath, nowMs });
    const { router } = makeRouter({ store, nowMs });
    await router.start();

    await router.getOrCreateSession({
      source: "slack",
      conversation: "C1",
      thread: "T1",
    });

    const key = sessionKey({ source: "slack", conversation: "C1", thread: "T1" });

    nowValue = base + 99_999;
    await router.recordActivity(key);

    const list = await store.list();
    expect(list[0].lastActiveAt).toBe(base + 99_999);

    await router.stop();
  });
});
