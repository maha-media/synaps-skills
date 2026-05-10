/**
 * bridge/core/workspace-manager.test.js
 *
 * Unit tests for WorkspaceManager.
 *
 * All Docker I/O is mocked — no real Docker daemon is required.
 * WorkspaceRepo is also fully mocked.
 *
 * Spec reference: PLATFORM.SPEC.md § 3.1, § 3.4, § 5
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassThrough }                           from 'node:stream';
import { WorkspaceManager }                      from './workspace-manager.js';

// ─── shared mock factories ────────────────────────────────────────────────────

/**
 * Build a fresh fake container for each test so mock call counts are isolated.
 * @param {object} overrides  - Partial property overrides.
 */
function makeFakeContainer(overrides = {}) {
  const baseInspect = {
    Id:              'abc123def456abc123def456abc123def456abc123def456abc123def456abc123',
    State:           { Running: true },
    NetworkSettings: { IPAddress: '172.17.0.42' },
  };

  return {
    start:   vi.fn().mockResolvedValue(undefined),
    stop:    vi.fn().mockResolvedValue(undefined),
    remove:  vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockResolvedValue(baseInspect),
    exec:    vi.fn().mockResolvedValue({
      start:   vi.fn().mockResolvedValue(new PassThrough()),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    }),
    ...overrides,
  };
}

/**
 * A docker.modem stub that does nothing (no-op demux), so exec tests don't hang.
 * In production the stream is already ended before demuxStream is called;
 * our PassThrough mock immediately ends.
 */
const fakeModem = {
  demuxStream: (stream, out, err) => {
    // pipe data straight to stdout and close both sides when stream ends
    stream.on('data',  (chunk) => out.write(chunk));
    stream.on('end',   () => { out.end(); err.end(); });
    stream.on('error', (e) => { out.destroy(e); err.destroy(e); });
  },
};

/**
 * Build a fake Docker object that uses the given container.
 * @param {object} fakeContainer
 */
function makeFakeDocker(fakeContainer) {
  return {
    createContainer: vi.fn().mockResolvedValue(fakeContainer),
    getContainer:    vi.fn().mockReturnValue(fakeContainer),
    modem:           fakeModem,
  };
}

/**
 * Build a fresh fake repo for each test.
 * @param {object} overrides
 */
function makeFakeRepo(overrides = {}) {
  return {
    byUserId:  vi.fn().mockResolvedValue(null),
    byId:      vi.fn().mockResolvedValue(null),
    create:    vi.fn().mockResolvedValue({ _id: 'ws-id-1', state: 'provisioning' }),
    setState:  vi.fn().mockResolvedValue({ _id: 'ws-id-1', state: 'running', container_id: 'abc123', vnc_url: 'http://172.17.0.42:6901' }),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a WorkspaceManager under test with fully mocked dependencies.
 */
function buildManager(repoOverrides = {}, containerOverrides = {}, dockerOverrides = {}) {
  const fakeContainer = makeFakeContainer(containerOverrides);
  const fakeDocker    = { ...makeFakeDocker(fakeContainer), ...dockerOverrides };
  const fakeRepo      = makeFakeRepo(repoOverrides);

  const manager = new WorkspaceManager({
    docker:        fakeDocker,
    repo:          fakeRepo,
    logger:        silentLogger,
    image:         'synaps/workspace:0.1.0',
    volumeRoot:    '/efs/agents',
    defaultLimits: { cpu: 1.0, mem_mb: 2048, pids: 256 },
    bootTimeoutMs: 30_000,
  });

  return { manager, fakeRepo, fakeDocker, fakeContainer };
}

// ─── ensure() ────────────────────────────────────────────────────────────────

describe('WorkspaceManager.ensure()', () => {
  // Test 1: No existing workspace → full boot path
  it('creates repo doc, calls createContainer with correct args, starts and inspects, returns running doc', async () => {
    const { manager, fakeRepo, fakeDocker, fakeContainer } = buildManager();

    const result = await manager.ensure('user-42');

    // repo.byUserId called first
    expect(fakeRepo.byUserId).toHaveBeenCalledWith('user-42');

    // repo.create called (no prior doc)
    expect(fakeRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ synaps_user_id: 'user-42' }),
    );

    // createContainer called
    expect(fakeDocker.createContainer).toHaveBeenCalledTimes(1);
    const createArg = fakeDocker.createContainer.mock.calls[0][0];
    expect(createArg.Image).toBe('synaps/workspace:0.1.0');
    expect(createArg.name).toMatch(/^synaps-ws-/);

    // container.start called
    expect(fakeContainer.start).toHaveBeenCalledTimes(1);

    // container.inspect called
    expect(fakeContainer.inspect).toHaveBeenCalledTimes(1);

    // repo.setState called with running + metadata
    expect(fakeRepo.setState).toHaveBeenCalledWith(
      'ws-id-1',
      'running',
      expect.objectContaining({
        container_id: expect.any(String),
        vnc_url:      expect.stringContaining('6901'),
      }),
    );

    // Returns the updated doc
    expect(result.state).toBe('running');
  });

  // Test 2: Existing 'running' doc + container alive → reuse
  it('returns existing doc without creating new container when running+alive', async () => {
    const existingDoc = {
      _id:          'ws-existing',
      state:        'running',
      container_id: 'ctr-alive',
    };

    const { manager, fakeRepo, fakeDocker } = buildManager({
      byUserId: vi.fn().mockResolvedValue(existingDoc),
      byId:     vi.fn().mockResolvedValue(existingDoc),
    });

    const result = await manager.ensure('user-99');

    // Must NOT call createContainer
    expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    expect(result).toBe(existingDoc);
  });

  // Test 3: Existing 'running' doc + container dead → creates new container
  it('creates new container when running doc exists but container is dead', async () => {
    const existingDoc = {
      _id:          'ws-dead',
      state:        'running',
      container_id: 'ctr-dead',
    };

    const deadContainer = makeFakeContainer({
      inspect: vi.fn().mockResolvedValue({
        Id:              'ctr-dead',
        State:           { Running: false },
        NetworkSettings: { IPAddress: '172.17.0.50' },
      }),
    });

    const fakeDocker = makeFakeDocker(deadContainer);

    const fakeRepo = makeFakeRepo({
      byUserId: vi.fn().mockResolvedValue(existingDoc),
      // First byId is for isAlive check, second for exec, etc.
      byId:     vi.fn().mockResolvedValue(existingDoc),
    });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    await manager.ensure('user-dead');

    expect(fakeDocker.createContainer).toHaveBeenCalledTimes(1);
  });

  // Test 4: Existing 'provisioning' doc → treated same as running for isAlive check
  it('checks isAlive for provisioning state and reuses if alive', async () => {
    const existingDoc = {
      _id:          'ws-prov',
      state:        'provisioning',
      container_id: 'ctr-prov',
    };

    const { manager, fakeRepo, fakeDocker } = buildManager({
      byUserId: vi.fn().mockResolvedValue(existingDoc),
      byId:     vi.fn().mockResolvedValue(existingDoc),
    });

    const result = await manager.ensure('user-prov');

    // Container is alive (default mock), so we reuse
    expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    expect(result).toBe(existingDoc);
  });

  // Test 5: Existing 'stopped' doc → creates new container
  it('creates new container when existing doc is in stopped state', async () => {
    const stoppedDoc = {
      _id:          'ws-stopped',
      state:        'stopped',
      container_id: 'ctr-old',
    };

    const { manager, fakeRepo, fakeDocker } = buildManager({
      byUserId: vi.fn().mockResolvedValue(stoppedDoc),
    });

    await manager.ensure('user-stopped');

    expect(fakeDocker.createContainer).toHaveBeenCalledTimes(1);
  });

  // Test 5b: Existing 'failed' state → creates new container
  it('creates new container when existing doc is in failed state', async () => {
    const failedDoc = { _id: 'ws-fail', state: 'failed' };
    const { manager, fakeDocker } = buildManager({
      byUserId: vi.fn().mockResolvedValue(failedDoc),
    });
    await manager.ensure('user-fail');
    expect(fakeDocker.createContainer).toHaveBeenCalledTimes(1);
  });

  // Test 5c: Existing 'reaped' — byUserId returns null (repo excludes reaped)
  it('creates new container when byUserId returns null (e.g. all docs reaped)', async () => {
    const { manager, fakeDocker } = buildManager({
      byUserId: vi.fn().mockResolvedValue(null),
    });
    await manager.ensure('user-reaped');
    expect(fakeDocker.createContainer).toHaveBeenCalledTimes(1);
  });

  // Test 6: createContainer throws → repo.setState('failed') + rethrow
  it('marks state=failed and rethrows when createContainer throws', async () => {
    const createError = new Error('image pull failure');

    const { manager, fakeRepo, fakeDocker } = buildManager({}, {}, {
      createContainer: vi.fn().mockRejectedValue(createError),
      getContainer:    vi.fn().mockReturnValue(makeFakeContainer()),
    });

    await expect(manager.ensure('user-boom')).rejects.toThrow('image pull failure');

    expect(fakeRepo.setState).toHaveBeenCalledWith(
      'ws-id-1',
      'failed',
      expect.objectContaining({ error_msg: 'image pull failure' }),
    );
  });

  // Test 7: container.start() throws → repo.setState('failed') + container.remove called
  it('calls container.remove and sets failed state when start() throws', async () => {
    const startError = new Error('start failure');
    const fakeContainer = makeFakeContainer({
      start: vi.fn().mockRejectedValue(startError),
    });
    const fakeDocker = makeFakeDocker(fakeContainer);
    const fakeRepo   = makeFakeRepo();

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    await expect(manager.ensure('user-startfail')).rejects.toThrow('start failure');

    expect(fakeContainer.remove).toHaveBeenCalled();
    expect(fakeRepo.setState).toHaveBeenCalledWith(
      'ws-id-1',
      'failed',
      expect.objectContaining({ error_msg: 'start failure' }),
    );
  });

  // Test 8: Image / volume path / limits applied correctly
  it('passes correct image, volume bind, memory, NanoCpus and PidsLimit to createContainer', async () => {
    const { manager, fakeDocker } = buildManager();

    await manager.ensure('user-limits');

    const arg = fakeDocker.createContainer.mock.calls[0][0];
    expect(arg.Image).toBe('synaps/workspace:0.1.0');
    expect(arg.HostConfig.Binds).toEqual([
      '/efs/agents/user-limits:/home/agent',
    ]);
    expect(arg.HostConfig.Memory).toBe(2048 * 1024 * 1024);
    expect(arg.HostConfig.NanoCpus).toBe(1_000_000_000);
    expect(arg.HostConfig.PidsLimit).toBe(256);
    expect(arg.HostConfig.AutoRemove).toBe(false);
    expect(arg.ExposedPorts).toEqual({ '6901/tcp': {} });
  });
});

// ─── stop() ──────────────────────────────────────────────────────────────────

describe('WorkspaceManager.stop()', () => {
  // Test 9: Normal path — stop, remove, setState('stopped')
  it('calls container.stop, container.remove, and sets state=stopped', async () => {
    const doc = { _id: 'ws-1', state: 'running', container_id: 'ctr-1' };

    const { manager, fakeRepo, fakeContainer } = buildManager({
      byId: vi.fn().mockResolvedValue(doc),
    });

    await manager.stop('ws-1');

    expect(fakeContainer.stop).toHaveBeenCalledTimes(1);
    expect(fakeContainer.remove).toHaveBeenCalledTimes(1);
    expect(fakeRepo.setState).toHaveBeenCalledWith('ws-1', 'stopped');
  });

  // Test 9b: Idempotent on already-stopped (no container_id)
  it('is idempotent — sets stopped state even when no container_id', async () => {
    const doc = { _id: 'ws-already', state: 'stopped' };

    const { manager, fakeRepo, fakeDocker } = buildManager({
      byId: vi.fn().mockResolvedValue(doc),
    });

    await manager.stop('ws-already');

    expect(fakeDocker.getContainer).not.toHaveBeenCalled();
    expect(fakeRepo.setState).toHaveBeenCalledWith('ws-already', 'stopped');
  });

  // Test 10: Container 404 → still updates repo to stopped, no throw
  it('does not throw when container is already gone (404) and still sets stopped', async () => {
    const doc = { _id: 'ws-gone', state: 'running', container_id: 'ctr-gone' };
    const err404 = Object.assign(new Error('404 no such container'), { statusCode: 404 });

    const fakeContainer = makeFakeContainer({
      stop: vi.fn().mockRejectedValue(err404),
    });
    const fakeDocker = makeFakeDocker(fakeContainer);
    const fakeRepo   = makeFakeRepo({ byId: vi.fn().mockResolvedValue(doc) });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    await expect(manager.stop('ws-gone')).resolves.not.toThrow();
    expect(fakeRepo.setState).toHaveBeenCalledWith('ws-gone', 'stopped');
  });
});

// ─── reap() ──────────────────────────────────────────────────────────────────

describe('WorkspaceManager.reap()', () => {
  // Test 11: Live container → stops + removes + state=reaped
  it('stops and removes a live container, then sets state=reaped', async () => {
    const doc = { _id: 'ws-reap', state: 'running', container_id: 'ctr-reap' };

    const { manager, fakeRepo, fakeContainer } = buildManager({
      byId: vi.fn().mockResolvedValue(doc),
    });

    await manager.reap('ws-reap');

    expect(fakeContainer.stop).toHaveBeenCalledTimes(1);
    expect(fakeContainer.remove).toHaveBeenCalledTimes(1);
    expect(fakeRepo.setState).toHaveBeenCalledWith('ws-reap', 'reaped');
  });

  // Test 12: Already stopped (404) → just sets state=reaped, no throw
  it('sets state=reaped even when container is already gone (404)', async () => {
    const doc = { _id: 'ws-reap2', state: 'stopped', container_id: 'ctr-old' };
    const err404 = Object.assign(new Error('no such container'), { statusCode: 404 });

    const fakeContainer = makeFakeContainer({
      stop: vi.fn().mockRejectedValue(err404),
    });
    const fakeDocker = makeFakeDocker(fakeContainer);
    const fakeRepo   = makeFakeRepo({ byId: vi.fn().mockResolvedValue(doc) });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    await expect(manager.reap('ws-reap2')).resolves.not.toThrow();
    expect(fakeRepo.setState).toHaveBeenCalledWith('ws-reap2', 'reaped');
  });
});

// ─── exec() ──────────────────────────────────────────────────────────────────

describe('WorkspaceManager.exec()', () => {
  /**
   * Build a stream that immediately ends with optional content.
   */
  function makeEndedStream(content = '') {
    const s = new PassThrough();
    if (content) s.write(content);
    setImmediate(() => s.end());
    return s;
  }

  // Test 13: Successful exec returns {stdout, stderr, exitCode}
  it('returns {stdout, stderr, exitCode} from a successful exec', async () => {
    const doc = { _id: 'ws-exec', state: 'running', container_id: 'ctr-exec' };

    // Produce a stream that the modem stub will write through
    const outputStream = makeEndedStream('hello world');
    const execInstance = {
      start:   vi.fn().mockResolvedValue(outputStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    };
    const fakeContainer = makeFakeContainer({
      exec: vi.fn().mockResolvedValue(execInstance),
    });
    const fakeDocker = makeFakeDocker(fakeContainer);
    const fakeRepo   = makeFakeRepo({ byId: vi.fn().mockResolvedValue(doc) });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    const result = await manager.exec('ws-exec', ['echo', 'hello world']);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.stderr).toBe('string');
  });

  // Test 14: Non-zero exit code is captured
  it('captures non-zero exit code', async () => {
    const doc = { _id: 'ws-fail', state: 'running', container_id: 'ctr-fail' };

    const outputStream = makeEndedStream('');
    const execInstance = {
      start:   vi.fn().mockResolvedValue(outputStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 42 }),
    };
    const fakeContainer = makeFakeContainer({
      exec: vi.fn().mockResolvedValue(execInstance),
    });
    const fakeDocker = makeFakeDocker(fakeContainer);
    const fakeRepo   = makeFakeRepo({ byId: vi.fn().mockResolvedValue(doc) });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    const result = await manager.exec('ws-fail', ['false']);
    expect(result.exitCode).toBe(42);
  });

  // Test 15: tty:true uses single-stream path (no demux)
  it('uses single-stream path (no modem.demuxStream) when tty=true', async () => {
    const doc = { _id: 'ws-tty', state: 'running', container_id: 'ctr-tty' };

    const ttyStream = makeEndedStream('tty output');
    const execInstance = {
      start:   vi.fn().mockResolvedValue(ttyStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    };
    const fakeContainer = makeFakeContainer({
      exec: vi.fn().mockResolvedValue(execInstance),
    });

    const demuxSpy = vi.fn();
    const fakeDocker = {
      ...makeFakeDocker(fakeContainer),
      modem: { demuxStream: demuxSpy },
    };

    const fakeRepo = makeFakeRepo({ byId: vi.fn().mockResolvedValue(doc) });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    const result = await manager.exec('ws-tty', ['bash'], { tty: true });

    // demuxStream must NOT have been called in TTY mode
    expect(demuxSpy).not.toHaveBeenCalled();

    // Output should land in stdout
    expect(result.stdout).toContain('tty output');
    expect(result.exitCode).toBe(0);
  });

  // Test 16: Env map is converted to array and passed to container.exec
  it('passes env key=value array to container.exec', async () => {
    const doc = { _id: 'ws-env', state: 'running', container_id: 'ctr-env' };

    const outputStream = makeEndedStream('');
    const execInstance = {
      start:   vi.fn().mockResolvedValue(outputStream),
      inspect: vi.fn().mockResolvedValue({ ExitCode: 0 }),
    };
    const fakeContainer = makeFakeContainer({
      exec: vi.fn().mockResolvedValue(execInstance),
    });
    const fakeDocker = makeFakeDocker(fakeContainer);
    const fakeRepo   = makeFakeRepo({ byId: vi.fn().mockResolvedValue(doc) });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    await manager.exec('ws-env', ['env'], { env: { FOO: 'bar', BAZ: 'qux' } });

    const execCall = fakeContainer.exec.mock.calls[0][0];
    expect(execCall.Env).toEqual(expect.arrayContaining(['FOO=bar', 'BAZ=qux']));
  });
});

// ─── heartbeat() ─────────────────────────────────────────────────────────────

describe('WorkspaceManager.heartbeat()', () => {
  // Test 17: Delegates to repo.heartbeat
  it('delegates to repo.heartbeat with the workspace id', async () => {
    const { manager, fakeRepo } = buildManager();

    await manager.heartbeat('ws-heart');

    expect(fakeRepo.heartbeat).toHaveBeenCalledWith('ws-heart');
  });
});

// ─── isAlive() ───────────────────────────────────────────────────────────────

describe('WorkspaceManager.isAlive()', () => {
  // Test 18: True when inspect returns State.Running=true
  it('returns true when container inspect shows State.Running=true', async () => {
    const doc = { _id: 'ws-alive', container_id: 'ctr-alive' };

    const { manager } = buildManager({
      byId: vi.fn().mockResolvedValue(doc),
    });

    const result = await manager.isAlive('ws-alive');
    expect(result).toBe(true);
  });

  // Test 19: False when inspect throws 404 (container missing)
  it('returns false when container is missing (404 from inspect)', async () => {
    const doc = { _id: 'ws-missing', container_id: 'ctr-missing' };
    const err404 = Object.assign(new Error('no such container'), { statusCode: 404 });

    const fakeContainer = makeFakeContainer({
      inspect: vi.fn().mockRejectedValue(err404),
    });
    const fakeDocker = makeFakeDocker(fakeContainer);
    const fakeRepo   = makeFakeRepo({ byId: vi.fn().mockResolvedValue(doc) });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    const result = await manager.isAlive('ws-missing');
    expect(result).toBe(false);
  });

  // Test 20: False when State.Running = false
  it('returns false when container inspect shows State.Running=false', async () => {
    const doc = { _id: 'ws-stopped', container_id: 'ctr-stopped' };

    const fakeContainer = makeFakeContainer({
      inspect: vi.fn().mockResolvedValue({
        Id:              'ctr-stopped',
        State:           { Running: false },
        NetworkSettings: { IPAddress: '172.17.0.9' },
      }),
    });
    const fakeDocker = makeFakeDocker(fakeContainer);
    const fakeRepo   = makeFakeRepo({ byId: vi.fn().mockResolvedValue(doc) });

    const manager = new WorkspaceManager({
      docker: fakeDocker, repo: fakeRepo, logger: silentLogger,
    });

    const result = await manager.isAlive('ws-stopped');
    expect(result).toBe(false);
  });

  // Bonus: False when no container_id in doc
  it('returns false when workspace doc has no container_id', async () => {
    const { manager } = buildManager({
      byId: vi.fn().mockResolvedValue({ _id: 'ws-noid', state: 'provisioning' }),
    });

    const result = await manager.isAlive('ws-noid');
    expect(result).toBe(false);
  });

  // Bonus: False when byId returns null
  it('returns false when workspace doc does not exist', async () => {
    const { manager } = buildManager({
      byId: vi.fn().mockResolvedValue(null),
    });

    const result = await manager.isAlive('ws-nonexistent');
    expect(result).toBe(false);
  });
});

// ─── constructor validation ───────────────────────────────────────────────────

describe('WorkspaceManager constructor', () => {
  it('throws when repo is not provided', () => {
    expect(() => new WorkspaceManager({})).toThrow('repo is required');
  });

  it('accepts custom image, volumeRoot, and defaultLimits', () => {
    const { manager } = buildManager();
    // Smoke test — if constructor didn't throw, we're good
    expect(manager).toBeDefined();
  });
});
