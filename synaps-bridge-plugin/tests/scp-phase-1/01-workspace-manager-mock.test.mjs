/**
 * @file tests/scp-phase-1/01-workspace-manager-mock.test.mjs
 *
 * End-to-end stitch test: WorkspaceManager + WorkspaceRepo + in-memory MongoDB.
 *
 * Exercises the full call chain from manager.ensure() → repo.create() /
 * repo.setState() → persisted document, with a fully mocked Dockerode so no
 * real Docker daemon is required.
 *
 * Covers:
 *   - ensure() cold boot: creates repo doc + calls docker.createContainer
 *   - ensure() idempotent warm path: alive container → returns existing doc
 *   - ensure() restart reattach: daemon stopped & restarted, WorkspaceManager
 *     reconstructed — still finds the live container and short-circuits
 *   - ensure() dead container → creates a new container (re-provision)
 *   - ensure() failure → marks state=failed, rethrows
 *   - stop() updates state to "stopped" in Mongo
 *   - reap() updates state to "reaped" in Mongo
 *
 * Constraints:
 *   - ESM only (.mjs)
 *   - No top-level await
 *   - vitest describe/it/expect/vi/beforeAll/afterAll/beforeEach
 *   - Uses mongodb-memory-server (no external MongoDB)
 *   - No real Docker daemon
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PassThrough } from 'node:stream';

import { getSynapsWorkspaceModel } from '../../bridge/core/db/models/synaps-workspace.js';
import { WorkspaceRepo } from '../../bridge/core/db/repositories/workspace-repo.js';
import { WorkspaceManager } from '../../bridge/core/workspace-manager.js';

// ─── In-memory MongoDB setup ─────────────────────────────────────────────────

let mongod;
let m;     // local mongoose instance (avoids global singleton pollution)
let Model;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  m = new mongoose.Mongoose();
  m.set('strictQuery', true);
  await m.connect(mongod.getUri(), {
    serverSelectionTimeoutMS: 5000,
    autoIndex: true,
  });
  Model = getSynapsWorkspaceModel(m);
}, 120_000);

afterAll(async () => {
  await m.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  // Wipe all workspace docs between tests for isolation
  await Model.deleteMany({});
});

// ─── Mock factories ───────────────────────────────────────────────────────────

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Build a fake Docker container object.
 * By default the container is "running" (inspect returns State.Running=true).
 */
function makeFakeContainer({
  running = true,
  containerId = 'fake-container-id-abc123',
  ip = '172.17.0.42',
  startError = null,
} = {}) {
  const inspectResult = {
    Id:              containerId,
    State:           { Running: running },
    NetworkSettings: { IPAddress: ip },
  };

  const execInstance = {
    start:   vi.fn().mockResolvedValue(new PassThrough()),
    inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
  };

  return {
    start:   startError
      ? vi.fn().mockRejectedValue(startError)
      : vi.fn().mockResolvedValue(undefined),
    stop:    vi.fn().mockResolvedValue(undefined),
    remove:  vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(inspectResult),
    exec:    vi.fn().mockResolvedValue(execInstance),
    _id:     containerId,
  };
}

/**
 * Build a fake Docker object whose createContainer/getContainer return the
 * given container mock.
 */
function makeFakeDocker(container) {
  return {
    createContainer: vi.fn().mockResolvedValue(container),
    getContainer:    vi.fn().mockReturnValue(container),
    modem: {
      demuxStream: (stream, out, err) => {
        stream.on('data',  (chunk) => out.write(chunk));
        stream.on('end',   () => { out.end(); err.end(); });
        stream.on('error', (e) => { out.destroy(e); err.destroy(e); });
      },
    },
  };
}

/**
 * Build a WorkspaceManager wired to the real repo (real in-memory DB)
 * but a mocked Docker.
 */
function buildManager(fakeContainer) {
  const docker = makeFakeDocker(fakeContainer);
  const repo   = new WorkspaceRepo({ model: Model, logger: silentLogger });
  const manager = new WorkspaceManager({
    docker,
    repo,
    logger:        silentLogger,
    image:         'synaps/workspace:dev',
    volumeRoot:    '/tmp/scp-smoke/agents',
    defaultLimits: { cpu: 1.0, mem_mb: 2048, pids: 256 },
    bootTimeoutMs: 10_000,
  });
  return { manager, docker, repo };
}

// ─── 1. Cold boot: no existing workspace ──────────────────────────────────────

describe('WorkspaceManager.ensure() — cold boot (integration)', () => {
  it('creates a workspace doc and returns state=running', async () => {
    const container = makeFakeContainer();
    const { manager } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    const result = await manager.ensure(userId);

    expect(result.state).toBe('running');
    expect(result.container_id).toBe('fake-container-id-abc123');
    expect(result.vnc_url).toContain('6901');
  });

  it('persists the running workspace doc to MongoDB', async () => {
    const container = makeFakeContainer();
    const { manager } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    const result = await manager.ensure(userId);

    // Verify it actually landed in the DB
    const fromDb = await Model.findById(result._id).lean();
    expect(fromDb).not.toBeNull();
    expect(fromDb.state).toBe('running');
    expect(fromDb.container_id).toBe('fake-container-id-abc123');
  });

  it('calls docker.createContainer once with correct image and name prefix', async () => {
    const container = makeFakeContainer();
    const { manager, docker } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    await manager.ensure(userId);

    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    const arg = docker.createContainer.mock.calls[0][0];
    expect(arg.Image).toBe('synaps/workspace:dev');
    expect(arg.name).toMatch(/^synaps-ws-/);
  });

  it('calls container.start() exactly once during cold boot', async () => {
    const container = makeFakeContainer();
    const { manager } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    await manager.ensure(userId);

    expect(container.start).toHaveBeenCalledTimes(1);
  });
});

// ─── 2. Idempotent warm path: existing running doc + alive container ──────────

describe('WorkspaceManager.ensure() — idempotent warm path (integration)', () => {
  it('returns existing doc without creating a new container when container is alive', async () => {
    const container = makeFakeContainer();
    const { manager, docker } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();

    // First call — boots the container
    const first = await manager.ensure(userId);
    expect(first.state).toBe('running');

    // Reset call counts
    docker.createContainer.mockClear();

    // Second call — should reuse
    const second = await manager.ensure(userId);

    expect(docker.createContainer).not.toHaveBeenCalled();
    // Returns the same workspace
    expect(String(second._id)).toBe(String(first._id));
  });

  it('second ensure() call returns a doc in state=running', async () => {
    const container = makeFakeContainer();
    const { manager } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    await manager.ensure(userId);

    const result = await manager.ensure(userId);
    expect(result.state).toBe('running');
  });
});

// ─── 3. Restart reattach: reconstruct manager, existing live doc ──────────────

describe('WorkspaceManager.ensure() — restart reattach (integration)', () => {
  it('reattaches to an existing running container after daemon restart', async () => {
    // Simulate first daemon lifecycle
    const container = makeFakeContainer();
    const { manager: mgr1, docker: docker1 } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    const firstDoc = await mgr1.ensure(userId);

    // "Restart" the daemon: build a NEW manager instance (same DB, same mock
    // container) — simulates the process being killed and restarted.
    const docker2 = makeFakeDocker(container);
    const repo2   = new WorkspaceRepo({ model: Model, logger: silentLogger });
    const mgr2    = new WorkspaceManager({
      docker:        docker2,
      repo:          repo2,
      logger:        silentLogger,
      image:         'synaps/workspace:dev',
      volumeRoot:    '/tmp/scp-smoke/agents',
    });

    const reattached = await mgr2.ensure(userId);

    // No new container created — reattached to existing
    expect(docker2.createContainer).not.toHaveBeenCalled();
    expect(String(reattached._id)).toBe(String(firstDoc._id));
    expect(reattached.state).toBe('running');
  });

  it('creates new container after restart if old container is dead', async () => {
    // Boot with a "running" container
    const liveContainer = makeFakeContainer({ running: true });
    const { manager: mgr1 } = buildManager(liveContainer);

    const userId = new m.Types.ObjectId().toHexString();
    await mgr1.ensure(userId);

    // Simulate daemon restart with a DEAD container (running = false)
    const deadContainer = makeFakeContainer({ running: false, containerId: 'dead-container' });
    const docker2 = makeFakeDocker(deadContainer);
    const repo2   = new WorkspaceRepo({ model: Model, logger: silentLogger });
    const mgr2    = new WorkspaceManager({
      docker:        docker2,
      repo:          repo2,
      logger:        silentLogger,
      image:         'synaps/workspace:dev',
      volumeRoot:    '/tmp/scp-smoke/agents',
    });

    const newDoc = await mgr2.ensure(userId);

    // A new container was created
    expect(docker2.createContainer).toHaveBeenCalledTimes(1);
    expect(newDoc.state).toBe('running');
  });
});

// ─── 4. ensure() failure path ─────────────────────────────────────────────────

describe('WorkspaceManager.ensure() — failure path (integration)', () => {
  it('marks the workspace doc as failed and rethrows when createContainer throws', async () => {
    const createError = new Error('image not found: synaps/workspace:dev');

    const container = makeFakeContainer();
    const failDocker = {
      createContainer: vi.fn().mockRejectedValue(createError),
      getContainer:    vi.fn().mockReturnValue(container),
      modem: { demuxStream: () => {} },
    };

    const repo    = new WorkspaceRepo({ model: Model, logger: silentLogger });
    const manager = new WorkspaceManager({
      docker:     failDocker,
      repo,
      logger:     silentLogger,
      image:      'synaps/workspace:dev',
      volumeRoot: '/tmp/scp-smoke/agents',
    });

    const userId = new m.Types.ObjectId().toHexString();

    await expect(manager.ensure(userId)).rejects.toThrow('image not found');

    // The provisioning doc should have been marked failed
    const failedDoc = await Model.findOne({ state: 'failed' }).lean();
    expect(failedDoc).not.toBeNull();
    expect(failedDoc.state).toBe('failed');
  });
});

// ─── 5. stop() ────────────────────────────────────────────────────────────────

describe('WorkspaceManager.stop() — integration', () => {
  it('sets state=stopped in MongoDB after stop()', async () => {
    const container = makeFakeContainer();
    const { manager } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    const doc = await manager.ensure(userId);

    await manager.stop(doc._id);

    const fromDb = await Model.findById(doc._id).lean();
    expect(fromDb.state).toBe('stopped');
  });

  it('stop() is idempotent — calling twice does not throw', async () => {
    const container = makeFakeContainer();
    const { manager } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    const doc = await manager.ensure(userId);

    await manager.stop(doc._id);
    await expect(manager.stop(doc._id)).resolves.not.toThrow();

    const fromDb = await Model.findById(doc._id).lean();
    expect(fromDb.state).toBe('stopped');
  });
});

// ─── 6. reap() ────────────────────────────────────────────────────────────────

describe('WorkspaceManager.reap() — integration', () => {
  it('sets state=reaped in MongoDB after reap()', async () => {
    const container = makeFakeContainer();
    const { manager } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    const doc = await manager.ensure(userId);

    await manager.reap(doc._id);

    const fromDb = await Model.findById(doc._id).lean();
    expect(fromDb.state).toBe('reaped');
  });

  it('byUserId() returns null after workspace is reaped', async () => {
    const container = makeFakeContainer();
    const { manager } = buildManager(container);

    const userId = new m.Types.ObjectId().toHexString();
    const doc = await manager.ensure(userId);

    await manager.reap(doc._id);

    const repo = new WorkspaceRepo({ model: Model, logger: silentLogger });
    const found = await repo.byUserId(userId);
    expect(found).toBeNull();
  });
});
