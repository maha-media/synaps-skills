# Phase 2 — Memory Gateway: Manual Smoke Playbook

> **Scope:** End-to-end local verification of the Synaps Bridge Phase 2
> per-user memory feature backed by `axel-memory-manager`.
>
> **Spec reference:** `synaps-skills/docs/plans/PLATFORM.SPEC.md` § 6

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Smoke 1 — Config validation](#2-smoke-1--config-validation)
3. [Smoke 2 — Manual axel sanity](#3-smoke-2--manual-axel-sanity)
4. [Smoke 3 — Bridge with memory enabled](#4-smoke-3--bridge-with-memory-enabled)
5. [Smoke 4 — Recall on second thread](#5-smoke-4--recall-on-second-thread)
6. [Smoke 5 — Namespace isolation](#6-smoke-5--namespace-isolation)
7. [Smoke 6 — Disabled mode](#7-smoke-6--disabled-mode)
8. [Rollback](#8-rollback)

---

## 1. Prerequisites

### 1.1 axel CLI on PATH

Memory gateway v0 shells out to the `axel` CLI binary per call.  Confirm it is
available:

```bash
axel --version
```

Expected: a version string such as `axel 0.x.y`.

If the command is not found, install it according to the `axel-memory-manager`
project README and ensure the install directory is on your `$PATH`:

```bash
# Example (adjust to actual install path):
export PATH="$HOME/.cargo/bin:$PATH"
axel --version
```

### 1.2 Node ≥ 20

```bash
node --version
# v20.x.x or newer
```

### 1.3 Synaps bridge built

```bash
cd synaps-bridge-plugin
node --version        # sanity
ls bridge/index.js    # bridge entrypoint must exist
```

### 1.4 bridge.toml with `[memory] enabled = true`

The memory gateway is **disabled by default** (opt-in for v0).  Create or edit
`~/.synaps-cli/bridge/bridge.toml`:

```bash
mkdir -p ~/.synaps-cli/bridge
cat >> ~/.synaps-cli/bridge/bridge.toml << 'EOF'

[memory]
enabled          = true
transport        = "cli"
cli_path         = "axel"
brain_dir        = "~/.local/share/synaps/memory"
recall_k         = 8
recall_min_score = 0.0
recall_max_chars = 2000
EOF
```

> **Note:** If the file already has a `[memory]` section, edit it in place
> rather than appending to avoid duplicate-section TOML errors.

---

## 2. Smoke 1 — Config validation

Verify the bridge reads and normalises the `[memory]` section correctly.

```bash
node -e "
import('./bridge/config.js').then(async ({ loadBridgeConfig }) => {
  const cfg = await loadBridgeConfig();
  console.log(JSON.stringify(cfg.memory, null, 2));
});
"
```

Expected output:

```json
{
  "enabled": true,
  "transport": "cli",
  "cli_path": "axel",
  "brain_dir": "~/.local/share/synaps/memory",
  "recall_k": 8,
  "recall_min_score": 0,
  "recall_max_chars": 2000,
  "axel_socket": "/run/synaps/axel.sock",
  "consolidation_cron": "0 3 * * *"
}
```

Key checks:

- `"enabled": true` — memory gateway will be active.
- `"transport": "cli"` — axel CLI binary will be shelled out to per call.
- `"brain_dir"` matches the path you set.

If `"enabled": false` appears, the `[memory]` section was not saved to the
right file.  Confirm the config path:

```bash
node -e "
import('./bridge/config.js').then(({ DEFAULT_CONFIG_PATH }) =>
  console.log('config path:', DEFAULT_CONFIG_PATH)
);
"
```

---

## 3. Smoke 2 — Manual axel sanity

Confirm the `axel` binary works independently before wiring it through the
bridge.  These commands use a throw-away brain file:

```bash
# Pick a temp brain path (axel uses the AXEL_BRAIN env var)
export AXEL_BRAIN="/tmp/smoke-test.r8"

# Step 1 — initialise a new brain
axel init --name smoke-test
# Expected: brain file created at /tmp/smoke-test.r8

# Step 2 — store a memory
axel remember "the sky is blue on a clear day"
# Expected: OK or a JSON id line

# Step 3 — search for it
axel search "sky colour" --limit 5 --json
# Expected: JSON array with the stored memory near the top

# Clean up
rm -f /tmp/smoke-test.r8
```

If `axel init` fails with `command not found`, the binary is not on PATH.
If `axel search` returns an empty array, the search index may need a moment to
build — retry after ~5 seconds.

---

## 4. Smoke 3 — Bridge with memory enabled

Export Slack tokens and start the bridge daemon:

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."

node bin/synaps-bridge.js
```

Expected log lines (order may vary, exact wording depends on your logger):

```
[config] memory.enabled=true transport=cli brain_dir=~/.local/share/synaps/memory
[BridgeDaemon] memory gateway started (enabled=true)
[Slack] connected to workspace <workspace name>
```

> If you see `memory gateway started (enabled=false)` or no memory log at all,
> revisit Step 1.4 and confirm `enabled = true` is saved.

Confirm the brain directory is created on startup (lazy-init fires on first
message, so the directory may appear only after the first Slack message):

```bash
ls -la ~/.local/share/synaps/memory/
# (may be empty until the first user sends a message)
```

---

## 5. Smoke 4 — Recall on second thread

This smoke test verifies **acceptance criterion 1**: two threads from the same
Slack user share persistent recall.

### Step-by-step

1. **Thread A — store a fact:**
   In Slack, open a DM with your Synaps bot or start a new thread in a
   channel.  Send:

   ```
   My favourite food is definitely sushi.
   ```

   After the bot responds, check the brain directory:

   ```bash
   ls ~/.local/share/synaps/memory/
   # Expected: a file like u_<your-slack-user-id>.r8
   ```

2. **Thread B — trigger recall:**
   Start a **new** DM thread (fresh `thread_ts`) with the same bot.  Ask:

   ```
   What food do I like?
   ```

   Expected bot response: mentions "sushi" (pulled from the per-user brain via
   `[memory_recall]…[/memory_recall]` injection before the prompt is sent to
   Synaps).

3. **Daemon log inspection:**
   ```bash
   # If running in background:
   tail -f ~/.synaps-cli/bridge/daemon.log | grep memory
   ```

   Look for lines like:
   ```
   [memory] recall alice_<id>: 1 result(s) injected
   [memory] store alice_<id>: ok
   ```

### Checkpoint

| Step | Expected result | Pass? |
|------|----------------|-------|
| Thread A response stored | `u_<id>.r8` file appears | ☐ |
| Thread B recall | bot mentions "sushi" | ☐ |
| Log line for recall | `recall … result(s) injected` | ☐ |

---

## 6. Smoke 5 — Namespace isolation

This smoke test verifies **acceptance criterion 2**: two different Slack users
do NOT share recall.

### Step-by-step

1. **User A stores a private fact** (Smoke 4 already did this):
   The brain file `u_<userA-id>.r8` holds "sushi".

2. **User B asks the same question:**
   Log in to Slack as a **different** user (or use a different Slack workspace
   seat), DM the bot:

   ```
   What food do I like?
   ```

   Expected: the bot does NOT mention "sushi" — it has no memory for User B.
   The response should fall back to a generic "I don't know your food
   preferences" or similar.

3. **Confirm separate brain files:**
   ```bash
   ls ~/.local/share/synaps/memory/
   # Should show TWO files: u_<userA-id>.r8 and u_<userB-id>.r8
   # Each user has their own isolated brain.
   ```

4. **Daemon log:**
   The search for User B's path returns `[]` → no recall injection.

### Checkpoint

| Step | Expected result | Pass? |
|------|----------------|-------|
| User B recall | does NOT contain User A's "sushi" fact | ☐ |
| Two separate `.r8` files | one per user in `brain_dir` | ☐ |
| User B brain empty | no facts stored yet | ☐ |

---

## 7. Smoke 6 — Disabled mode

Verify that flipping `memory.enabled = false` produces a `NoopMemoryGateway`
and the bridge still works for ordinary chat.

1. **Edit bridge.toml:**
   ```toml
   [memory]
   enabled = false
   ```

2. **Restart the bridge daemon:**
   ```bash
   # Ctrl-C the running daemon, then:
   node bin/synaps-bridge.js
   ```

3. **Expected log line:**
   ```
   [BridgeDaemon] memory gateway started (enabled=false)
   ```
   or
   ```
   [BridgeDaemon] NoopMemoryGateway active — memory disabled
   ```

4. **Send a Slack message** — the bot should respond normally to ordinary chat
   requests.  No memory is stored or injected.

5. **No new `.r8` files** should appear in `brain_dir` (the NoopMemoryGateway
   never calls `axel`):
   ```bash
   ls ~/.local/share/synaps/memory/
   # File list should be unchanged from before the restart.
   ```

### Checkpoint

| Step | Expected result | Pass? |
|------|----------------|-------|
| Log shows noop/disabled | memory gateway is NoopMemoryGateway | ☐ |
| Bot still responds | ordinary chat still works | ☐ |
| No new brain files | brain_dir unchanged | ☐ |

---

## 8. Rollback

### Disable memory gateway

Set `enabled = false` in `bridge.toml` and restart the bridge.  No data is
deleted — the brain files remain on disk for future re-enable.

### Remove brain files

Brain files are stored at:

```
~/.local/share/synaps/memory/u_<synapsUserId>.r8
```

To wipe all brain data:

```bash
rm -rf ~/.local/share/synaps/memory/
```

> **Warning:** This permanently deletes all per-user memory.  There is no
> recovery path unless you have backups of the `.r8` files.

### Re-enable memory later

Set `enabled = true` in `bridge.toml` and restart the bridge.  If the
`brain_dir` was not deleted, prior memories are still available.  If the
directory was deleted, the gateway will lazily re-create it on the next
message.
