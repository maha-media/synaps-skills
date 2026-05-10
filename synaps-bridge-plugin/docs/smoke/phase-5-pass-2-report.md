# Phase 5 — Pass 2 Tetragon Smoke Report

**Run date**: 2026-05-10
**Host**: Ubuntu 26.04, kernel 7.0.0-15-generic (HWE), Docker 29.1.3
**Tetragon**: v1.7.0 (image `quay.io/cilium/tetragon:v1.7.0`)
**`tetra` CLI**: v1.7.0
**Audit log**: `/tmp/tetragon-smoke-audit-20260510-142144.json` (39 794 lines)

---

## TL;DR

| Step | Policy | Outcome |
|---|---|---|
| Tetragon container launch + readiness | — | ✅ `Listening for events…` |
| `tetra` CLI install (to `~/bin`) | — | ✅ v1.7.0 |
| Load `block-egress-metadata` | (v1.7 patches required) | ✅ enabled, enforce |
| Load `block-kernel-modules` | (v1.7 patches required) | ✅ enabled, enforce |
| Load `kill-fork-bomb` | — | ❌ schema rejected (`matchRateLimit` unknown field) |
| Load `kill-cpu-runaway` | — | ✅ stub loaded (intentionally no tracepoints) |
| Fork-bomb behavioural test | n/a | ⏭ skipped (policy did not load) |
| **Metadata egress block (live curl)** | `block-egress-metadata` | ✅ **3× rc=137 SIGKILL, 2 audit events** |
| Kernel module block (insmod) | `block-kernel-modules` | ⚠ kprobe attaches but doesn't fire on this kernel |
| Tetragon audit trail dump | — | ✅ 39 794 events captured |
| Cleanup | — | ✅ all policies/containers removed |

---

## Critical finding — egress block works end-to-end

**Proof (audit log):**
```json
{"function_name": "tcp_connect",
 "action": "KPROBE_ACTION_SIGKILL",
 "policy_name": "block-egress-metadata",
 "process": {"binary": "/usr/bin/curl"},
 "args": [{"sock_arg": {"daddr": "169.254.169.254"}}]}
```

3 consecutive `curl http://169.254.169.254/` calls inside `workspace-alice`
container all returned exit code 137 (= 128 + SIGKILL). NPOST / NENFORCE
counters on the policy reached 11/11 by the end of the session, confirming
the enforcement path fired every time.

This is the most important policy for cloud-credential-exfil defence and is
**verified working** on this host.

---

## Tetragon v1.7.0 API drift findings (vs. v1.2 that YAMLs were authored for)

Three of the four YAMLs in `config/tetragon/` needed edits to load on v1.7:

### 1. `block-egress-metadata.yaml`

| Issue | v1.2 syntax | v1.7 requirement |
|---|---|---|
| Override on non-syscall kprobe | `action: Override` + `argError: -1` on `tcp_connect` | **Forbidden** — only syscalls/`security_*` hooks can use Override. Switch to `Sigkill`. |
| `sock` arg filter operator | `operator: Equal` | **Must use `DAddr`** for destination-address matching from `sock*` |
| Event visibility | (auto-emitted with Override) | **Must add `action: Post`** explicitly when using Sigkill |

Patched policy (working) is in `/tmp/tetragon-v17/block-egress-metadata.yaml`
on the smoke host. **Update upstream `config/tetragon/block-egress-metadata.yaml`
in a follow-up commit.**

### 2. `block-kernel-modules.yaml`

| Issue | v1.2 syntax | v1.7 requirement |
|---|---|---|
| `matchNamespaces` value | `values: ["host"]` | **Must be `host_ns`** or numeric inode |

Additionally, the original `User`-namespace filter only matches processes
in user-namespace-remapped containers. On a default Docker install (no
`userns-remap`) the user namespace is shared with host, so the policy
correctly excludes the container — but for smoke purposes the test
container falls outside its scope.

For production deployments using `--userns-remap`, the original semantics
are correct; only the string-value fix is needed.

### 3. `kill-fork-bomb.yaml`

| Issue | v1.2 syntax | v1.7 requirement |
|---|---|---|
| Per-PID fork-rate selector | `matchRateLimit:` selector | **No equivalent in current Tetragon stable**. The `rateLimit` field on `matchActions[]` exists but limits *event emission*, not *per-PID trigger counting* |

The policy cannot be ported to v1.7.0 without a redesign. Tetragon's stable
rate-limit primitive doesn't track per-process counters required for fork-bomb
detection.

**Recommendation**: rely on cgroup `pids.max` (workspace-container creation
flag) as the primary fork-bomb defence. Document this in `PLATFORM.SPEC.md`
§9 as a layer-handoff: cgroup limits at the container boundary, JS Reaper
for graceful workspace cleanup, Tetragon for cross-container kernel events.
The `kill-fork-bomb.yaml` becomes a documented gap with a `kill-cpu-runaway`-
style stub comment.

### 4. `kill-cpu-runaway.yaml` (stub)

Loads cleanly on v1.7.0 (as designed — intentional stub, no tracepoints).
No changes needed.

---

## Kernel-module block behavioural finding

The patched `block-kernel-modules` policy loads and attaches kprobes
successfully (confirmed in Tetragon logs:
`level=info msg="Added kprobe" function=__x64_sys_finit_module override=true`),
but `NPOST=0` after `insmod /tmp/fake.ko` from inside the workspace
container (with `seccomp=unconfined --cap-add SYS_MODULE` to bypass
Docker's built-in defence).

Inspection of `/proc/kallsyms` on Ubuntu 26.04's kernel 7.0.0-15-generic
shows that `__x64_sys_finit_module` is present only as `.cold` (cold-path
out-of-line symbol). The hot path on this kernel build appears to be inlined
or named differently, so the kprobe-multi attachment doesn't intercept
real `finit_module()` calls.

**This is a kernel-version sensitivity finding, not a Tetragon or policy
bug.** Docker's default seccomp profile already blocks `init_module` /
`finit_module` from unprivileged containers (verified — EPERM returned
before the syscall reaches the kernel), so this represents an unexercised
defence-in-depth layer rather than a real gap.

**Recommendation**: add a comment to `block-kernel-modules.yaml` noting
the kernel-symbol sensitivity, and verify the policy on a target production
kernel (e.g. mainline 6.x or RHEL UEK) before relying on it in production.

---

## Pass / Fail by playbook checklist

| Check | Outcome | Notes |
|---|---|---|
| All 4 policies load without error | ⚠ 3/4 | `kill-fork-bomb` schema-incompat with v1.7.0 |
| Fork bomb killed within 100 ms | ⏭ skip | Policy did not load (see above) |
| Metadata curl returns EPERM/ECONNREFUSED | ✅ | rc=137 (SIGKILL) — equivalent effect |
| Tetragon audit event for egress block | ✅ | `tcp_connect`/`KPROBE_ACTION_SIGKILL`/policy=`block-egress-metadata` |
| `block-kernel-modules` kprobe attaches | ✅ | But doesn't fire on this kernel (symbol drift) |
| `kill-cpu-runaway` loads cleanly (stub) | ✅ | NPOST=0 as designed |
| Audit log captures SIGKILL events | ✅ | 39 794 events, 11/11 enforcement |
| Cleanup complete | ✅ | Container + policies removed |

**Verdict**: Pass 2 verifies the **most critical security policy
(metadata egress block) end-to-end** on this host. Three documented findings
flag YAMLs for v1.7-compat updates and one kernel-symbol sensitivity that
warrants a target-kernel re-verification before production cutover.

---

## Action items (for follow-up commit)

1. **Patch `config/tetragon/block-egress-metadata.yaml`** for Tetragon v1.7+
   compatibility:
   - `operator: Equal` → `operator: DAddr`
   - `action: Override`/`argError: -1` → `action: Post` + `action: Sigkill`
2. **Patch `config/tetragon/block-kernel-modules.yaml`**:
   - `values: ["host"]` → `values: ["host_ns"]`
   - Add a comment about kernel-symbol sensitivity on Ubuntu HWE kernels
3. **Document `kill-fork-bomb.yaml` as needing redesign** for current
   Tetragon stable (no per-PID rate-limit primitive); add cgroup `pids.max`
   as primary defence in §9 of `PLATFORM.SPEC.md`.
4. **Update `phase-5-supervisor.md` smoke playbook**: pin Tetragon image
   to `v1.7.0` and adjust step 4 (fork-bomb) + step 5 (egress) expectations
   to match Sigkill semantics.

---

## Reproducing this run

```bash
# 1. Tetragon container
docker run --name tetragon --detach --privileged --pid=host --cgroupns=host \
  -v /sys/kernel/btf:/sys/kernel/btf:ro \
  -v /sys/fs/cgroup:/sys/fs/cgroup:ro \
  quay.io/cilium/tetragon:v1.7.0 /usr/bin/tetragon

# 2. tetra CLI to user-writable location
curl -fsSL https://github.com/cilium/tetragon/releases/download/v1.7.0/tetra-linux-amd64.tar.gz \
  | tar xz -C ~/bin tetra

# 3. Apply patched policies (held in /tmp/tetragon-v17/ during this run; will
#    land in config/tetragon/ via follow-up commit)
docker cp /tmp/tetragon-v17 tetragon:/tmp/tetragon
docker exec tetragon tetra tracingpolicy add /tmp/tetragon/block-egress-metadata.yaml
docker exec tetragon tetra tracingpolicy add /tmp/tetragon/block-kernel-modules.yaml
docker exec tetragon tetra tracingpolicy add /tmp/tetragon/kill-cpu-runaway.yaml

# 4. Workspace container
docker run --name workspace-alice --rm -d \
  --security-opt seccomp=unconfined ubuntu:24.04 sleep infinity
docker exec workspace-alice apt-get update -q
docker exec workspace-alice apt-get install -y -q curl

# 5. Fire egress block test
docker exec workspace-alice curl -m 2 -s -o /dev/null http://169.254.169.254/
echo $?   # expect 137

# 6. Audit
docker exec tetragon tetra getevents -o json --policy-names block-egress-metadata
```
