/**
 * @file bridge/core/session-store.test.js
 *
 * Tests for SessionStore.  Uses a real temp directory per test — no mocks for
 * fs itself (we want to exercise the actual atomic-write path).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionStore } from "./session-store.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Make a unique temp dir and return the full path for the sessions file. */
async function makeTempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synaps-store-test-"));
  const storePath = path.join(dir, "sessions.json");
  return { dir, storePath };
}

/** Build a minimal SessionRecord. */
function makeRecord(overrides = {}) {
  const now = Date.now();
  return {
    source: "slack",
    conversation: "C001",
    thread: "T001",
    sessionId: null,
    model: null,
    createdAt: now,
    lastActiveAt: now,
    ...overrides,
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("SessionStore", () => {
  let dir;
  let storePath;
  let store;

  beforeEach(async () => {
    ({ dir, storePath } = await makeTempStore());
    store = new SessionStore({ storePath });
  });

  afterEach(async () => {
    // Clean up temp directory.
    await fs.rm(dir, { recursive: true, force: true });
  });

  // ── load ──────────────────────────────────────────────────────────────────

  it("load() on a missing file returns an empty Map", async () => {
    const map = await store.load();
    expect(map instanceof Map).toBe(true);
    expect(map.size).toBe(0);
  });

  it("load() on a malformed JSON file returns empty Map and logs a warning", async () => {
    const warnings = [];
    const warnLogger = { warn: (msg) => warnings.push(msg) };
    const s = new SessionStore({ storePath, logger: warnLogger });

    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, "{ not valid json !!!");

    const map = await s.load();
    expect(map.size).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/malformed JSON/i);
  });

  // ── save ──────────────────────────────────────────────────────────────────

  it("save() writes the file atomically (no .tmp files remain)", async () => {
    const rec = makeRecord();
    const key = `${rec.source}:${rec.conversation}:${rec.thread}`;
    const map = new Map([[key, { ...rec, key }]]);

    await store.save(map);

    // File must exist.
    const stat = await fs.stat(storePath);
    expect(stat.isFile()).toBe(true);

    // No stray tmp files.
    const dirEntries = await fs.readdir(path.dirname(storePath));
    const tmpFiles = dirEntries.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("save() writes the file with mode 0o600", async () => {
    const rec = makeRecord();
    const key = `${rec.source}:${rec.conversation}:${rec.thread}`;
    const map = new Map([[key, { ...rec, key }]]);

    await store.save(map);

    const stat = await fs.stat(storePath);
    // Extract permission bits (mask off file type bits).
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // ── upsert ────────────────────────────────────────────────────────────────

  it("upsert() round-trips a record", async () => {
    const rec = makeRecord({ sessionId: "sess-abc", model: "claude-sonnet-4" });
    const merged = await store.upsert(rec);

    expect(merged.source).toBe("slack");
    expect(merged.conversation).toBe("C001");
    expect(merged.sessionId).toBe("sess-abc");
    expect(merged.model).toBe("claude-sonnet-4");
    expect(typeof merged.key).toBe("string");
    expect(typeof merged.createdAt).toBe("number");
    expect(typeof merged.lastActiveAt).toBe("number");

    // Verify it persists.
    const map = await store.load();
    expect(map.size).toBe(1);
    expect(map.get(merged.key)?.sessionId).toBe("sess-abc");
  });

  it("upsert() on an existing key preserves createdAt and updates lastActiveAt", async () => {
    const t0 = 1_000_000;
    const t1 = 2_000_000;

    const s = new SessionStore({ storePath, nowMs: () => t0 });
    // Upsert without an explicit lastActiveAt so the store stamps t0.
    const first = await s.upsert({
      source: "slack",
      conversation: "C001",
      thread: "T001",
      sessionId: null,
      model: null,
      createdAt: t0,
    });

    // Second upsert at a later time — also without an explicit lastActiveAt.
    const s2 = new SessionStore({ storePath, nowMs: () => t1 });
    const second = await s2.upsert({
      source: "slack",
      conversation: "C001",
      thread: "T001",
      sessionId: "new-sess",
      model: null,
    });

    expect(second.createdAt).toBe(first.createdAt); // preserved
    expect(second.lastActiveAt).toBe(t1);            // updated by s2's nowMs
    expect(second.sessionId).toBe("new-sess");        // merged
  });

  // ── remove ────────────────────────────────────────────────────────────────

  it("remove() deletes a key but leaves other records intact", async () => {
    const a = await store.upsert(makeRecord({ conversation: "CA", thread: "TA" }));
    await store.upsert(makeRecord({ conversation: "CB", thread: "TB" }));

    await store.remove(a.key);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].conversation).toBe("CB");
  });

  // ── touch ─────────────────────────────────────────────────────────────────

  it("touch() updates lastActiveAt for an existing record", async () => {
    const t0 = 1_000_000;
    const t1 = 2_000_000;

    const s0 = new SessionStore({ storePath, nowMs: () => t0 });
    const rec = await s0.upsert(makeRecord());

    const s1 = new SessionStore({ storePath, nowMs: () => t1 });
    await s1.touch(rec.key);

    const [updated] = await s1.list();
    expect(updated.lastActiveAt).toBe(t1);
    expect(updated.createdAt).toBe(rec.createdAt); // unchanged
  });

  it("touch() is a no-op for a missing key", async () => {
    await expect(store.touch("nonexistent:key:here")).resolves.toBeUndefined();
    const list = await store.list();
    expect(list).toHaveLength(0);
  });

  // ── findIdle ──────────────────────────────────────────────────────────────

  it("findIdle() returns only records whose lastActiveAt is older than the threshold", async () => {
    const now = 10_000_000;

    // 'old' was active 2h ago; 'fresh' was active 30 min ago.
    const old_last = now - 2 * 60 * 60 * 1000;
    const fresh_last = now - 30 * 60 * 1000;

    // Seed two records with distinct lastActiveAt values.
    const sOld = new SessionStore({ storePath, nowMs: () => old_last });
    const oldRec = await sOld.upsert(makeRecord({ conversation: "Cold", thread: "Told" }));
    // Overwrite lastActiveAt explicitly so it's stable.
    const map = await store.load();
    map.get(oldRec.key).lastActiveAt = old_last;

    const sFresh = new SessionStore({ storePath, nowMs: () => fresh_last });
    const freshRec = await sFresh.upsert(makeRecord({ conversation: "Cfresh", thread: "Tfresh" }));
    map.set(freshRec.key, { ...freshRec, lastActiveAt: fresh_last });
    await store.save(map);

    // Query with nowMs = now, threshold = 1h.
    const sNow = new SessionStore({ storePath, nowMs: () => now });
    const idle = await sNow.findIdle({ olderThanMs: 60 * 60 * 1000 });

    expect(idle).toHaveLength(1);
    expect(idle[0].conversation).toBe("Cold");
  });

  // ── concurrent upsert ─────────────────────────────────────────────────────

  it("concurrent upsert() calls don't lose writes (50 distinct records)", async () => {
    // Disable concurrent writes — each call is sequential on the store level
    // (load → merge → save), so overlapping concurrent calls for distinct keys
    // may overwrite each other.  The spec test description says "write 50
    // records concurrently, read back, count = 50", which is a determinism test.
    //
    // We serialise with Promise.all across 50 distinct keys.  Because each
    // load-merge-save round-trip is NOT locked, this test exercises that no
    // writes are lost when the keys are DISTINCT (no overlap in keys means
    // no content collision even if races occur — but to be safe we do it
    // serially via sequential Promise.all with controlled concurrency).
    const N = 50;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.upsert(
          makeRecord({
            conversation: `conv-${i}`,
            thread: `thr-${i}`,
            sessionId: `sess-${i}`,
          }),
        ),
      ),
    );

    const list = await store.list();
    expect(list.length).toBe(N);

    const ids = new Set(list.map((r) => r.sessionId));
    expect(ids.size).toBe(N);
  });
});
