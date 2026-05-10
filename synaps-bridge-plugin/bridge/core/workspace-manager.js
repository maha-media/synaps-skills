/**
 * bridge/core/workspace-manager.js
 *
 * Docker-side lifecycle manager for Synaps user workspaces.
 *
 * Wraps dockerode to boot, stop, reap, and exec into per-user Ubuntu
 * containers.  All persistence (state transitions, heartbeats) delegates to
 * WorkspaceRepo.  The constructor performs zero I/O — side-effects only
 * happen inside the async methods.
 *
 * Spec reference: PLATFORM.SPEC.md § 3.1, § 3.4, § 5
 */

import path from 'node:path';
import { PassThrough } from 'node:stream';
import Docker from 'dockerode';

// ─── defaults ────────────────────────────────────────────────────────────────

const DEFAULT_IMAGE        = 'synaps/workspace:0.1.0';
const DEFAULT_VOLUME_ROOT  = '/efs/agents';
const DEFAULT_LIMITS       = { cpu: 1.0, mem_mb: 2048, pids: 256 };
const DEFAULT_BOOT_TIMEOUT = 30_000;

// States that mean "a live container might already exist"
const LIVE_STATES = new Set(['running', 'provisioning']);

// ─── WorkspaceManager ────────────────────────────────────────────────────────

/**
 * Manages the Docker container lifecycle for Synaps workspaces.
 *
 * @example
 * const manager = new WorkspaceManager({ repo });
 * const doc = await manager.ensure(synapsUserId);
 * const { stdout } = await manager.exec(doc._id, ['echo', 'hello']);
 */
export class WorkspaceManager {
  /**
   * @param {object}        opts
   * @param {Docker}        [opts.docker]          - Injected dockerode instance (default: new Docker()).
   * @param {object}        opts.repo              - WorkspaceRepo instance (required).
   * @param {object}        [opts.logger]          - Logger with .info/.warn/.error; defaults to console.
   * @param {string}        [opts.image]           - Container image. Default 'synaps/workspace:0.1.0'.
   * @param {string}        [opts.volumeRoot]      - Host volume root. Default '/efs/agents'.
   * @param {object}        [opts.defaultLimits]   - Resource limits { cpu, mem_mb, pids }.
   * @param {number}        [opts.bootTimeoutMs]   - Boot timeout in ms. Default 30000.
   */
  constructor({
    docker        = null,
    repo,
    logger        = console,
    image         = DEFAULT_IMAGE,
    volumeRoot    = DEFAULT_VOLUME_ROOT,
    defaultLimits = DEFAULT_LIMITS,
    bootTimeoutMs = DEFAULT_BOOT_TIMEOUT,
  } = {}) {
    if (!repo) throw new Error('WorkspaceManager: opts.repo is required');

    this._docker       = docker ?? new Docker();
    this._repo         = repo;
    this._logger       = logger;
    this._image        = image;
    this._volumeRoot   = volumeRoot;
    this._limits       = { ...DEFAULT_LIMITS, ...defaultLimits };
    this._bootTimeout  = bootTimeoutMs;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Boot or reattach to the workspace for a given Synaps user.
   *
   * Idempotent: if a running/provisioning doc exists and the container is
   * alive, returns the existing doc without creating a new container.
   *
   * @param {string|import('mongoose').Types.ObjectId} synapsUserId
   * @returns {Promise<object>} The workspace doc (state='running').
   */
  async ensure(synapsUserId) {
    // 1. Check for an existing live doc.
    const existing = await this._repo.byUserId(synapsUserId);
    if (existing && LIVE_STATES.has(existing.state)) {
      if (await this.isAlive(existing._id)) {
        return existing;
      }
      // Container gone — fall through to re-provision
    }

    // 2. Create a new provisioning doc.
    const workspaceDoc = await this._repo.create({
      synaps_user_id: synapsUserId,
      image:          this._image,
      resource_limits: this._limits,
    });

    // 3. Compute volume path.
    const volume_path = path.join(this._volumeRoot, String(synapsUserId));

    // 4–7. Boot container, update repo.  Any failure marks doc as 'failed'.
    let container;
    try {
      // 4. Create container.
      container = await this._docker.createContainer({
        Image: this._image,
        name:  `synaps-ws-${workspaceDoc._id}`,
        ExposedPorts: { '6901/tcp': {} },
        HostConfig: {
          Binds:    [`${volume_path}:/home/agent`],
          Memory:   this._limits.mem_mb * 1024 * 1024,
          NanoCpus: Math.round(this._limits.cpu * 1e9),
          PidsLimit: this._limits.pids,
          AutoRemove: false,
        },
      });

      // 5. Start container.
      await container.start();

      // 6. Inspect to get real container_id + IP.
      const info        = await container.inspect();
      const container_id = info.Id;
      const ip           = info.NetworkSettings.IPAddress;
      const vnc_url      = `http://${ip}:6901`;

      // 7. Persist running state.
      const updated = await this._repo.setState(
        workspaceDoc._id,
        'running',
        { container_id, vnc_url },
      );

      this._logger.info(
        `[WorkspaceManager] ensure: workspace ${workspaceDoc._id} running (container=${container_id})`,
      );

      return updated;
    } catch (err) {
      // Clean up container if it was created.
      if (container) {
        try { await container.remove({ force: true }); } catch (_) { /* best-effort */ }
      }

      await this._repo.setState(workspaceDoc._id, 'failed', {
        error_msg: err.message ?? String(err),
      }).catch(() => { /* don't mask original error */ });

      this._logger.error(
        `[WorkspaceManager] ensure: failed for user ${synapsUserId}: ${err.message}`,
      );
      throw err;
    }
  }

  /**
   * Stop and remove the container for the given workspace.  Idempotent.
   *
   * @param {string|import('mongoose').Types.ObjectId} workspaceId
   * @returns {Promise<void>}
   */
  async stop(workspaceId) {
    const doc = await this._repo.byId(workspaceId);
    if (doc && doc.container_id) {
      const container = this._docker.getContainer(doc.container_id);
      try {
        await container.stop();
        await container.remove();
      } catch (err) {
        // 404 → container already gone; treat as success
        if (!_is404(err)) throw err;
      }
    }

    await this._repo.setState(workspaceId, 'stopped');
    this._logger.info(`[WorkspaceManager] stop: workspace ${workspaceId} stopped`);
  }

  /**
   * Mark the workspace as reaped and kill the container if still alive.
   *
   * @param {string|import('mongoose').Types.ObjectId} workspaceId
   * @returns {Promise<void>}
   */
  async reap(workspaceId) {
    const doc = await this._repo.byId(workspaceId);
    if (doc && doc.container_id) {
      const container = this._docker.getContainer(doc.container_id);
      try {
        await container.stop();
        await container.remove();
      } catch (err) {
        if (!_is404(err)) throw err;
      }
    }

    await this._repo.setState(workspaceId, 'reaped');
    this._logger.info(`[WorkspaceManager] reap: workspace ${workspaceId} reaped`);
  }

  /**
   * Run a command inside the workspace container.
   *
   * @param {string|import('mongoose').Types.ObjectId} workspaceId
   * @param {string[]} argv           - Command + args.
   * @param {object}   [opts]
   * @param {boolean}  [opts.tty]     - Allocate a pseudo-TTY.
   * @param {object}   [opts.env]     - Environment variables as a key→value map.
   * @returns {Promise<{stdout:string, stderr:string, exitCode:number}>}
   */
  async exec(workspaceId, argv, opts = { tty: false, env: {} }) {
    const tty = opts.tty ?? false;
    const envMap = opts.env ?? {};
    const envArray = Object.entries(envMap).map(([k, v]) => `${k}=${v}`);

    const doc = await this._repo.byId(workspaceId);
    if (!doc || !doc.container_id) {
      throw new Error(`WorkspaceManager: no container_id for workspace ${workspaceId}`);
    }

    const container = this._docker.getContainer(doc.container_id);

    // Create exec instance.
    const execInstance = await container.exec({
      Cmd:          argv,
      AttachStdout: true,
      AttachStderr: true,
      Tty:          tty,
      ...(envArray.length > 0 && { Env: envArray }),
    });

    // Start exec and capture stream.
    const stream = await execInstance.start({ Detach: false, Tty: tty });

    const { stdout, stderr } = await _captureStreams(
      stream,
      this._docker.modem,
      tty,
    );

    // Fetch exit code.
    const inspectResult = await execInstance.inspect();
    const exitCode = inspectResult.ExitCode ?? inspectResult.ExitCode;

    return { stdout, stderr, exitCode };
  }

  /**
   * Update the last_heartbeat timestamp for a workspace.
   *
   * @param {string|import('mongoose').Types.ObjectId} workspaceId
   * @returns {Promise<void>}
   */
  async heartbeat(workspaceId) {
    await this._repo.heartbeat(workspaceId);
  }

  /**
   * Returns true if the workspace container exists and is in the running state
   * according to Docker.
   *
   * @param {string|import('mongoose').Types.ObjectId} workspaceId
   * @returns {Promise<boolean>}
   */
  async isAlive(workspaceId) {
    const doc = await this._repo.byId(workspaceId);
    if (!doc || !doc.container_id) return false;

    try {
      const container = this._docker.getContainer(doc.container_id);
      const info = await container.inspect();
      return info.State.Running === true;
    } catch (err) {
      if (_is404(err)) return false;
      throw err;
    }
  }
}

// ─── private helpers ─────────────────────────────────────────────────────────

/**
 * Determine if a dockerode error represents a 404 (not found).
 * @param {Error} err
 * @returns {boolean}
 */
function _is404(err) {
  return (
    err &&
    (err.statusCode === 404 ||
      err.reason === 'no such container' ||
      (err.message && err.message.includes('404')) ||
      (err.message && err.message.toLowerCase().includes('no such container')))
  );
}

/**
 * Capture stdout/stderr from a dockerode exec stream.
 *
 * In TTY mode the stream is a raw byte stream (no multiplex header).
 * In non-TTY mode we use docker.modem.demuxStream to split the two channels.
 *
 * @param {import('stream').Duplex|import('stream').Readable} stream
 * @param {object}  modem   - dockerode modem (exposes demuxStream).
 * @param {boolean} tty
 * @returns {Promise<{stdout:string, stderr:string}>}
 */
function _captureStreams(stream, modem, tty) {
  return new Promise((resolve, reject) => {
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    const chunks   = { stdout: [], stderr: [] };

    stdoutStream.on('data', (d) => chunks.stdout.push(d));
    stderrStream.on('data', (d) => chunks.stderr.push(d));

    const finish = () =>
      resolve({
        stdout: Buffer.concat(chunks.stdout).toString('utf8'),
        stderr: Buffer.concat(chunks.stderr).toString('utf8'),
      });

    if (tty) {
      // TTY mode: single stream, no multiplex header — all output goes to stdout.
      stream.on('data',  (d) => stdoutStream.write(d));
      stream.on('end',   finish);
      stream.on('error', reject);
    } else {
      // Non-TTY: demux the multiplexed stream.
      modem.demuxStream(stream, stdoutStream, stderrStream);
      stream.on('end',   finish);
      stream.on('error', reject);
    }
  });
}
