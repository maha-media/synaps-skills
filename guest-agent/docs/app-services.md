# App services (VM-Sites) — guest supervisor contract

Guest half of the VM-Sites RC (Pria `PLAN.md` "Guest transport (WP-B)" /
"Guest Rust (WP-F)"). The guest agent supervises managed **dev** and
**release** processes for a project workspace and seals build output. Pria
owns *authorization* (which session/project may start what); the guest owns
the local safety envelope.

## Routes (`/guest/v1`, all HMAC-signed — GETs sign an empty body)

| Method | Path | Request | Response |
|---|---|---|---|
| `POST` | `/services/start` | `{serviceId, kind:'dev'\|'release', sessionId, workdir, command:[..], env:{}, readiness:{path, timeoutMs}, limits:{maxLogBytes?, maxRuntimeSec?}, requestId?}` | `ServiceSnapshot` (`{serviceId, kind, generation, state, port, pid, exitCode, signal?, since, startedAt, detail?}`) |
| `POST` | `/services/{id}/stop` | `{generation, requestId?}` | `ServiceSnapshot` — `409 service_generation_stale` on a stale generation; idempotent once terminal |
| `GET` | `/services/{id}/status` | — | `ServiceSnapshot` |
| `GET` | `/services/{id}/logs?cursor&limit` | `cursor` = opaque seq (omit → oldest retained), `limit` ≤ 500 (default 200) | `{entries:[{seq, ts, stream, line}], next, dropped}` |
| `POST` | `/artifacts/seal` | `{workdir, outputDir, maxFiles?, maxBytes?, requestId?}` | `{files:[{path, size, sha256}], totalBytes}` |

States: `starting → ready | failed`, `ready → exited | failed`,
`{starting, ready} → stopping → stopped`. `exited` = exit code 0 without a
stop; `failed` = non-zero exit, signal death, readiness timeout, runtime
limit. `exitCode` for signal deaths is shell-style `128 + signal` (`signal`
carries the raw number).

`/services/start` answers within `app_services.start_wait_ms` (default
1.5 s): a quick server is reported `ready` inline, otherwise `starting` and
the verdict arrives through `GET status` and the `app-service` callback.
Starting an id that is `starting`/`ready` returns the live record unchanged
(idempotent); starting a terminal id spawns a new **generation**; starting a
`stopping` id is `409 service_busy` (retryable).

Error codes added: `service_not_found` (404), `service_generation_stale`
(409), `service_busy` (409, retryable), `service_limit_exceeded` (429),
`service_start_failed` (500), `artifact_bounds_exceeded` (413). Validation
failures are `invalid_request` (400); a root agent without a running session
for `sessionId` answers `session_not_found` (404).

## Safety envelope (guest-enforced)

* `serviceId` `[A-Za-z0-9_-]{8,64}`; `sessionId` `[A-Za-z0-9_.-]{1,128}`.
* `workdir`: absolute, no `..`, an existing directory, canonical form under
  `app_services.workspace_root` (default `paths.efs_root`) — symlink escapes
  are refused. `outputDir` (seal) must resolve inside `workdir` the same way.
* `command[0]`: bare name from `app_services.command_allowlist` (default
  `npm pnpm yarn node npx python3 vite serve`), resolved by the guest from
  `<workdir>/node_modules/.bin` then `PATH`; never a shell. Args are verbatim
  except the literal tokens `${PORT}` / `${HOST}`.
* `env`: only `PATH HOME NODE_ENV PORT HOST REVISION_BASE CI VITE_*` pass;
  everything else is dropped. `PORT`/`HOST=127.0.0.1` are always the
  supervisor's. `PATH`/`HOME` fall back to the agent's, then to a fixed
  baseline / the workdir.
* Child: `setsid` (own session + process group), stdin null, stdout/stderr
  captured, and — when the agent is root — `setgroups → setgid → setuid` to
  the owning session's identity (`SessionStore::identity`). Root without a
  session identity never spawns.
* Ports: `app_services.port_range_start..=port_range_end`, persisted in
  `{run_root}/app-services/state.json` (`{services:{id:{port, generation,
  pid, active}}}`), bind-probed on 127.0.0.1 before handing out; released
  when the process exits; generation is monotonic per id across agent
  restarts; a live orphan of the same id is superseded (group-killed) on the
  next start.
* Readiness: `GET http://127.0.0.1:{port}{readiness.path}` every 250 ms
  until `2xx`/`3xx` or `timeoutMs` (capped at `max_readiness_timeout_ms`) →
  `failed` + group kill.
* Stop: `SIGTERM` to the group, `SIGKILL` after `stop_grace_ms`.
* Logs: per-line cap 8 KiB, ring capped by `limits.maxLogBytes`
  (≤ `log_ring_max_bytes`) and `log_ring_max_entries`; evictions are counted
  in `dropped`.
* Runtime: `limits.maxRuntimeSec` (≤ `max_runtime_sec`) → `failed` + kill.
* Seal: skips dot-prefixed entries and symlinks (also re-checked at open
  time), sorted by path bytes, bounded by `maxFiles`/`maxBytes` (≤
  `seal_max_files`/`seal_max_bytes`).

## Callbacks (signed like every other Pria callback)

| Path | Body | When |
|---|---|---|
| `POST /internal/agentic-vm/app-service` | `{serviceId, generation, state, exitCode?, observedAt, port?}` | `ready` (with `port`), `exited`/`failed`/`stopped` (with `exitCode`); 3 bounded retries (250 ms / 1 s / 3 s) |
| `POST /internal/agentic-vm/app-log` | `{serviceId, generation, entries:[{seq, ts, stream, line}]}` | batches of ≤ `log_batch_max_entries` or every `log_batch_interval_ms`; one attempt, dropped on failure (the pull route stays authoritative) |

The owning `sessionId` rides the signed `x-pria-session-id` header, not the
body. Callback failures never block or alter the process lifecycle.

## Config (`app_services:` block, every key optional)

| Key | Default | Meaning |
|---|---|---|
| `port_range_start` / `port_range_end` | `43000` / `43999` | loopback port range |
| `command_allowlist` | `[npm, pnpm, yarn, node, npx, python3, vite, serve]` | accepted `command[0]` |
| `workspace_root` | `paths.efs_root` | jail for `workdir` |
| `stop_grace_ms` | `5000` | SIGTERM → SIGKILL window |
| `start_wait_ms` | `1500` | inline readiness wait in `/services/start` |
| `max_readiness_timeout_ms` | `120000` | ceiling for `readiness.timeoutMs` |
| `max_runtime_sec` | `21600` | ceiling/default for `limits.maxRuntimeSec` |
| `max_services` | `16` | concurrent non-terminal services |
| `log_ring_max_bytes` / `log_ring_max_entries` | `1048576` / `5000` | per-service ring caps |
| `log_batch_max_entries` / `log_batch_interval_ms` | `200` / `1000` | `app-log` batching |
| `seal_max_files` / `seal_max_bytes` | `4096` / `67108864` | seal ceilings |

## Tests

`tests/services_tests.rs` (real `python3 -m http.server` / `sleep` /
scripted `python3 -c` children on 127.0.0.1, HMAC on and off) plus unit tests
in `src/services/{logs,ports,seal,validate}.rs`.

## Retained built-in release / authenticated data plane (integration 2)

`app_services.retained_root` defaults to
`/var/lib/pria-guest-agent/retained-artifacts`. Provision it on durable storage,
owned by the guest-agent OS principal; it must not lie inside workload/session
storage. The agent creates private 0700 directories and atomically promotes
0400 records with fsync. Workload users cannot access this store. Non-root fixture
tests establish mutation isolation, **not** isolation from a hostile same-UID or
root workload. Retained payloads are currently bounded JSON records containing
exact bytes; this is a bounded adapter, not a general artifact filesystem.

Seal requires `sessionId`, `revisionId`, `workdir`, `outputDir`; optional `packaging`
is `{profile:"react-spa-relative-v1",navigationPaths:["/","/about/team"]}`.
Relative workdir resolves against the owning session's workspace, including the
fleet `worktree/` beneath that workspace. Release requests never resolve command
executables: `command:["static-serve"]` is the built-in trusted adapter. Start's
`artifact:{revisionId,artifactDigest,files,base,packaging}` binds exactly to seal.
A profile mismatch refuses readiness. Same revision with changed bytes refuses
seal. Same release service ID never restarts on retry, including after stop.

Profile HTML requires the blocking trusted React bootstrap script
`/_pria/v1/pria-agentspace-react.js` before module tags, relative built assets,
and no explicit base element. This is a conservative packaging check, **not**
verification of arbitrary JS behavior: gateway/browser receipts remain necessary.
Only declared extensionless navigation paths requested with `Accept: text/html`
fallback to `index.html`. Missing assets never fallback. Legacy unprofiled
artifacts can declare `artifact.navigationPaths`; profiled artifacts cannot mix it.

Signed GET/HEAD `/guest/v1/services/{id}/proxy/{generation}/{path}` serves retained
bytes or the supervised dev loopback endpoint. Root with/without trailing slash
works. Queries use existing canonical HMAC rules. Response proof is hex HMAC over
`VM-SITES/1`, nonce, service ID, decimal generation, status and body SHA256, joined
by newlines without trailing newline. HEAD/WS101 use empty body. HTTP body limit
16 MiB; timeout 15 seconds. Redirects and Set-Cookie are refused; only content-type
is forwarded, never app authorization/cookies/proxy headers or control HMAC.
WS uses the same signed endpoint, only for ready dev services, with a 300-second
connection lease and 250ms service generation/state fencing. It uses cached
hyper HTTP upgrade plumbing and reqwest's upgraded stream, not a downloaded WS
library. `DEV_PORT`, `PORT`, and `HOST` are overwritten by the supervisor.

Signed POST `/guest/v1/services/{id}/adopt` accepts
`{generation,revisionId,artifactDigest}`. Candidates expire after 1800 seconds;
adopted releases survive session/dev teardown and guest process restart. Adopt
before publication CAS; retain adopted service on failed/unknown CAS outcome,
never blindly clean up a potentially published artifact. Explicit stop is fenced.

Dev starts with `generation:1,requestId` persist an exact start intent before
spawn. Exact retries return current identity; altered intent refuses. After agent
restart, an existing dev intent is explicitly unavailable, **not** re-executed.
Legacy generation-omitted start behavior remains for old callers; new Node uses
the durable intent contract. No CPU/memory/disk enforcement is claimed: limits
accept only `maxLogBytes` and `maxRuntimeSec`, with unknown fields refused.

`examples/vm_sites_fixture.rs` (requires `test-fakes`) starts an actual loopback
HTTP agent using fake OS/Synaps/callback adapters, a synthetic HMAC secret, and
an explicit fixture root. Never use it as a production agent.

## Trusted prepared source profile and installed pack

Source builds require **all** of `app_services.skill_pack_root`,
`source_build_dependencies`, and `source_build_cgroup_root`. Missing/invalid
resources refuse before Git export or commands; there is no unbounded fallback.
Provision these offline as the OS administrator; neither agent requests nor the
installer download packages, change delegation, or install privileged services.

Production runs as root with a distinct nonroot scoped workload identity. Pack
and bundle payloads must be root-owned and not group/world writable; the bundle
ancestor chain must not permit workload replacement. These owner invariants are
the immutable-input boundary, not merely a read-only bind. A nonroot disposable
fixture validates its own UID and permissions but **does not certify hostile
same-UID/multiuser isolation**. Admin changes during a build are unsupported;
manifest/payload rechecks before both phases and after build detect accidental
changes rather than granting a new dependency identity mid-build.

The pack root contains S's `pack.json` descriptor and actual payload. Guest
recomputes sorted `[relativePath,sha256]` digest, checks manifest name/version,
rejects links/specials/writable payload and unknown or mismatched payload files.
Bounds: 512 entries, depth16, 2MiB/file, 16MiB total. The descriptor hash is not
hardcoded. Frozen source must contain exact copied adapter **and** opaque runtime
bytes; H's `adapters/*` and the shipped preparer's root filenames are supported.
This verifies presence/identity, not that arbitrary model code cannot bypass an
adapter. Static output packaging validation and browser gates remain separate.

Authenticated discovery: bodyless signed GET
`/guest/v1/app-builder/attestation`, no query, returns
`{accountId,vmId,pack:{name,version,profile,digest}}` under4096 bytes. Verify
`X-Pria-Service-Proof` with the existing VM-SITES/1 vector: request nonce,
`app_builder_pack`, generation `1`, decimal HTTP status, SHA256 exact response
body. Invalid installed pack returns a similarly proved503. Unsigned legacy
health is **not** an attestation. Signed heartbeat also supplies `skillPack`.
Node must authenticate, compare its supported pin, and persist before admission.

Dependencies use configured `BUNDLE/node_modules` and sibling `BUNDLE/bundle.json`:
`{version:1,lockSha256,nodeSha256,npmSha256,profile:"react-spa-relative-v1",files}`.
`files` is lexically path-sorted records `{path,size,sha256,mode,link?}`; hashes bind
actual bytes, not package names or a lockfile alone. Relative `.bin` links have
mode511, UTF8 link-target byte length/hash, and `link`; targets must resolve to
regular files inside the bundle. Manifest <=8MiB; payload <=512MiB, <=30,000
entries, depth32, <=256MiB/file. Tool hashes bind canonical `/usr/bin/node` and
`/usr/bin/npm` entry files (not a whole-OS/toolchain measurement). Committed
`package-lock.json` SHA256 must match exactly before tests; changed lock requires
another trusted prepared bundle. A source-only change can reuse the bundle.

Only committed full Git HEAD is exported; no dirty-worktree fallback or package
installation. Required commands are exactly `npm test -- --run`, then
`npm run build -- --outDir /output`; outputDir request is `dist`. Source is private
read-only, deps read-only, output fresh. Build receipt includes observed commit,
source blobs/modes/hashes, phase outcomes, installed skillPack and
`dependencyBundleDigest`. Source receipts/logs remain control-plane/private; no
source path is added to public serving. Existing fixed thread pools are2 each
(Rayon,UV,Rolldown workers/blocking,Tokio). Private leaves enforce pids64,
memory1GiB, swap0, CPU1; Git export subprocesses also join bounded leaves. The
270s whole-build deadline and two-build admission semaphore remain. No parent
cgroup policy/membership changes occur.

Offline fixture helper:
`python3 scripts/prepare-fixture-bundle.py SHARED_NODE_MODULES LOCK NEW_DEST`.
It copies only the installed supported package closure, bounded as above, into
private files; no install/network/shared chmod. Conflicting nested versions fail
explicitly rather than silently selecting wrong packages. Reuse the bundle.
Fixture: `vm_sites_fixture ROOT PORT NEW_DEST/node_modules CGROUP_ROOT [PACK_ROOT]`.
Pack arg5 or `PRIA_FIXTURE_SKILL_PACK_ROOT` defaults to sibling plugin; fixture
copies and verifies a bounded private pack, never modifies shared plugin modes.

## Retained quota, candidate expiry, and process ownership

One supervisor owns each retained root via lifetime exclusive nonblocking OS
`flock` on private `store.lock`; another store/process fails closed until owner
exit. Internal mutex serializes seal/start/adopt/collection. Published references
are protected only after successful guest adoption, which must precede Node CAS.
All adopted bindings protect artifact+source indefinitely, including stopped,
historical rollback, and unknown CAS winners. No EFS/user source or Node record
is deleted by guest collection.

New sealed candidates have24h leases; unadopted service candidates30min. First
adoption/new start after seal expiry refuses. Collector (before seal and periodic
heartbeat) removes only expired NEVER-adopted artifact+source with no live
candidate binding. Legacy artifacts lacking lease are conservatively retained.
Durable revision tombstone precedes unlink; binding/intent tombstones are retained
so retry cannot recreate expired identity. Malformed/unknown references fail
closed. Adopted rollback does not renew hosting expiry. maxCostUnits is Node
credit attribution only, never a guest seconds meter.

Aggregate admission is4096 records and512MiB serialized bytes, including private
source/output, intents/bindings/tombstones and temporary replacement headroom.
Full storage refuses new admission; it never evicts adopted/history references
or deletes tombstones to make room. This is bounded guest candidate cleanup,
**not** global/EFS reference GC or installed persistent-volume/reboot proof.
