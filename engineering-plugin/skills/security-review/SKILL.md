---
name: security-review
description: Use before merging code that handles user input, secrets, auth, plugins, sidecars, shell commands, filesystem paths, network calls, or other external I/O. Covers engineering-ecosystem controls — oracle write-segregation, verdict-only egress, commit-reveal ordering, and plans-server token/CSP/path confinement.
---

# Security Review

*Where this fits: the **review** stage of plan → implement → verify → review — the security-focused deep-dive that complements the general code review before merge.*

Perform a focused review of trust boundaries, privileged operations, and failure modes. Keep it practical: identify what an attacker or untrusted input can influence, what privilege the code has, and whether checks happen before the dangerous operation.

## Threat Surface First

Start every security review with four bullets:

```md
### Threat Surface
- Inputs: [user args, JSON/RPC frames, plugin manifest, HTTP response, file path, env vars]
- Privileged operations: [shell exec, file write, network call, token use, sidecar spawn]
- Trust boundaries: [plugin -> host, user -> CLI, network -> parser, config -> runtime]
- Secrets/resources: [API keys, auth tokens, local files, processes, CPU/memory/disk]
```

If there is no meaningful trust boundary, say so and keep the review short.

## Checklist

### Input and parsing

- Validate all user/plugin/network input before use.
- Prefer typed parsing (`TryFrom`, `FromStr`, enums, newtypes) over passing raw strings or `serde_json::Value` deep into core logic.
- Reject unknown or malformed fields when accepting them would create ambiguous behavior.
- Bound input sizes before allocation, recursion, or buffering.

### Command execution and sidecars

- No shell string concatenation with untrusted data.
- Prefer `Command::new(program).args(args)` over `sh -c`.
- Validate executable paths and arguments before spawn.
- Apply plugin permissions before command/tool execution.
- Ensure child process cleanup on success, error, timeout, and cancellation.

### Filesystem and paths

- Prevent path traversal (`..`, absolute path surprises, symlink escape when relevant).
- Canonicalize/sandbox paths before destructive operations.
- Check TOCTOU risks where a path is checked and later used.
- Use safe temp-file handling and cleanup on error paths.
- Avoid writing secrets to world-readable files.

### Secrets and logs

- No hardcoded secrets, API keys, credentials, tokens, or private URLs.
- Do not log tokens, auth headers, cookies, or full environment dumps.
- Error messages should not expose secrets or unnecessary internal paths.
- Config files containing secrets should have restrictive permissions where applicable.

### Auth, authorization, and permissions

- Authentication proves identity; authorization still checks the action.
- Permission checks must happen before side effects.
- Deny by default when a permission/config value is missing or invalid.
- Plugin capability declarations must not be trusted as proof of authorization.

### Network and dependency use

- Use HTTPS for external APIs unless an explicit local/insecure mode is documented.
- Handle timeouts and retries with bounds.
- Treat dependency updates and install scripts as supply-chain risk.
- Avoid downloading and executing code without verification or explicit user intent.

### Resource exhaustion / DoS

- Bound loops, retries, queue sizes, request bodies, file reads, and subprocess output.
- Avoid unbounded concurrency.
- Add timeouts for network calls and child processes.
- Consider disk/memory growth from caches, logs, transcripts, build artifacts, and worktrees.

### Crypto

- Do not invent crypto.
- Use constant-time comparison for secrets/tokens when equality leaks matter.
- Use well-maintained libraries and safe defaults.

### Engineering-ecosystem controls (oracle + plans-server)

These are the adversarial-evaluation and live-viewer patterns proven in this
plugin. Treat each as a fail-closed invariant:

- **Write-segregation.** The builder cannot author its own oracle. Oracle tests
  and verdicts under `.oracle/**` are write-segregated from the builder's
  workspace — the entity under test has no write path to the tests that judge
  it. (See the henhouse rule in **code-review**.)
- **Verdict-only egress sandbox.** The oracle runner executes untrusted code in
  a sandbox whose only output channel is the structured `oracle/1` verdict — no
  arbitrary file, network, or stdout egress that could exfiltrate or smuggle a
  pass.
- **Commit-reveal ordering.** Enforce `commit < freeze < reveal`: the builder
  commits its solution, the oracle freezes its independently-authored tests,
  and only then are tests revealed/run. Reordering (revealing before freeze)
  lets the builder overfit — reject any path that allows it.
- **Plans-server controls.** Loopback-only bind (127.0.0.1), per-session token
  on all data routes, strict CSP (`script-src 'self'`, no `unsafe-inline`), and
  path confinement via `safeRealpath`/`isInside` for every served file.

> **Worked example — token-gate / asset-401 bug.** The plans-server token gate
> originally ran before the `/_assets/*` branch, so the browser's no-token
> asset fetches returned 401 and the viewer hung on "Loading…". The fix served
> static assets *before* the token gate while keeping `/api/*` and `/plan/*`
> gated, and kept `safeRealpath`/`isInside` so traversal still 403s. Lesson:
> **auth must not block non-sensitive static assets, but must gate all data
> routes** — and relaxing the gate must not relax path confinement.

## Synaps-Specific Hot Spots

Pay extra attention to:

- `.synaps-plugin/plugin.json` permissions and capabilities
- sidecar spawn args and environment variables
- extension RPC frames and tool-call input
- MCP/tool execution paths
- setup scripts and install hooks
- shell helpers in plugin `lib/` and `scripts/`
- workspace/container automation
- memory stores and logs that may capture secrets
- local voice/audio paths and model downloads

## Output Format

```md
## Security Review: [change]

### Threat Surface
- Inputs:
- Privileged operations:
- Trust boundaries:
- Secrets/resources:

### Verdict: [PASS | REQUEST CHANGES | NEEDS DISCUSSION]

### Findings

🔴 **Critical — [file:line] [title]**
[Exploit/risk, impact, required fix]

🟡 **Important — [file:line] [title]**
[Risk, why it matters, suggested fix]

🟢 **Suggestion — [file:line] [title]**
[Optional hardening]

### Positive Controls
- [Checks or patterns that were correctly implemented]
```

## Severity Guide

- 🔴 **Critical** — exploitable command/path injection, auth bypass, secret exposure, destructive action without authorization, remote code execution, data loss.
- 🟡 **Important** — missing bounds, weak validation, incomplete cleanup, overly broad permissions, risky defaults, unclear trust boundary.
- 🟢 **Suggestion** — defense-in-depth, clearer types, better logs, tighter docs, optional hardening.

## Verification

Before passing the review:

- [ ] Threat surface is identified or explicitly declared trivial
- [ ] Every privileged operation has a prior validation/permission check
- [ ] Untrusted paths/commands/protocol frames are not used raw
- [ ] Secrets are not exposed in code, logs, errors, tests, or fixtures
- [ ] Resource usage is bounded or intentionally documented
- [ ] Critical and Important findings are resolved or explicitly accepted by policy

## Related skills

- **code-review** — the general review this skill's Security axis expands on.
- **type-driven-design** — parse-at-the-boundary types that close many input-validation findings.
- **verification-before-completion** — the evidence discipline behind a fail-closed verdict.
