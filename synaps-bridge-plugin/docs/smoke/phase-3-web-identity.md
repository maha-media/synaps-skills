# Phase 3 — Web Dashboard + Identity: Manual Smoke Playbook

> **Scope:** End-to-end local verification of the Synaps Bridge Phase 3
> identity reconciliation, web chat streaming, and link-code flow.
>
> **Spec reference:** `synaps-skills/docs/plans/PLATFORM.SPEC.md` §7 + §3.3 + §14.1

---

## Table of Contents

1. [Phase 3 scope summary](#1-phase-3-scope-summary)
2. [Prerequisites](#2-prerequisites)
3. [bridge.toml configuration](#3-bridgetoml-configuration)
4. [pria-ui-v22 preparation](#4-pria-ui-v22-preparation)
5. [Smoke 1 — Start bridge daemon with identity enabled](#5-smoke-1--start-bridge-daemon-with-identity-enabled)
6. [Smoke 2 — Web chat streams text](#6-smoke-2--web-chat-streams-text)
7. [Smoke 3 — Inspect Mongo after first web chat](#7-smoke-3--inspect-mongo-after-first-web-chat)
8. [Smoke 4 — Slack resolves to a NEW SynapsUser (pre-link)](#8-smoke-4--slack-resolves-to-a-new-synapuser-pre-link)
9. [Smoke 5 — Generate a link code from the web UI](#9-smoke-5--generate-a-link-code-from-the-web-ui)
10. [Smoke 6 — Redeem the link code in Slack](#10-smoke-6--redeem-the-link-code-in-slack)
11. [Smoke 7 — Inspect Mongo after linking](#11-smoke-7--inspect-mongo-after-linking)
12. [Smoke 8 — Cross-channel memory recall](#12-smoke-8--cross-channel-memory-recall)
13. [Rollback: disable identity](#13-rollback-disable-identity)
14. [Known limitations](#14-known-limitations)

---

## 1. Phase 3 scope summary

Phase 3 closes two spec gaps:

| Gap | What shipped |
|-----|-------------|
| **#3 — Identity** | `IdentityRouter` + `NoOpIdentityRouter`; `synaps_users`, `synaps_channel_identities`, `synaps_link_codes` MongoDB collections; link-code UDS ops on the ControlSocket |
| **#4 — Web dashboard** | `GET /api/synaps/chat/stream` SSE endpoint in pria-ui-v22; `/synaps/chat` React page powered by server-sent AI SDK frames; `/synaps/link` page to generate + display 6-char link code |

After Phase 3:

- One `SynapsUser` per pria user, spanning Slack + web.
- Web chat at `/synaps/chat` streams from SCP via SSE using the AI SDK numbered-frame protocol.
- 6-char link-code flow: `/synaps link ABC123` in Slack reconciles channel identities.
- Memory namespace `u_<synapsUserId>` is shared across channels once linked.

---

## 2. Prerequisites

### 2.1 Completed phases

Phase 1 (workspace container) and Phase 2 (memory gateway) must be landed and
their smoke tests verified before running Phase 3 smoke tests.

```bash
# Verify the branch stacks correctly.
cd /home/jr/Projects/Maha-Media/.worktrees/synaps-skills-scp-phase-3/synaps-bridge-plugin
git log --oneline -5
# Expected: Phase 3 commits on top of Phase 2 commit on top of Phase 1.
```

### 2.2 Node ≥ 20

```bash
node --version   # v20.x.x or newer
```

### 2.3 MongoDB running locally

Phase 3 requires a reachable MongoDB instance.  The simplest approach for
local smoke testing:

```bash
# If using the system MongoDB service:
sudo systemctl start mongod
mongosh --eval "db.runCommand({ ping: 1 })"
# Expected: { ok: 1 }

# Alternatively, spin up a container:
docker run -d --name mongo-local -p 27017:27017 mongo:7
```

### 2.4 axel binary on PATH (for Phase 2 memory)

```bash
axel --version
# Expected: axel 0.x.y
```

If not found, install from the `axel-memory-manager` repo and add it to `$PATH`.

### 2.5 synaps-bridge-plugin dependencies

```bash
cd /home/jr/Projects/Maha-Media/.worktrees/synaps-skills-scp-phase-3/synaps-bridge-plugin
npm install
npm test -- --run
# Expected: 1306 tests passed
```

### 2.6 pria-ui-v22 checked out at `feat/synaps-web-dashboard`

```bash
cd /home/jr/Projects/Praxis/pria-ui-v22
git fetch origin
git checkout feat/synaps-web-dashboard
# Install dependencies (may take a minute):
npm install
```

---

## 3. bridge.toml configuration

Create or edit `~/.synaps-cli/bridge/bridge.toml`.  The Phase 3 additions are
the `[identity]` block and ensuring `[mongodb]` is set:

```toml
# ── Phase 1: platform (SCP mode) ─────────────────────────────────────────────
[platform]
mode = "bridge"          # set to "scp" if using workspace containers

# ── Phase 2: memory gateway ───────────────────────────────────────────────────
[memory]
enabled          = true
transport        = "cli"
cli_path         = "axel"
brain_dir        = "~/.local/share/synaps/memory"
recall_k         = 8
recall_min_score = 0.0
recall_max_chars = 2000

# ── Phase 3: identity ─────────────────────────────────────────────────────────
[identity]
enabled             = true        # ← Phase 3 opt-in
link_code_ttl_secs  = 300         # 5 min; reduce for faster testing

# ── MongoDB (required when identity.enabled = true) ───────────────────────────
[mongodb]
uri = "mongodb://localhost:27017/priadb"
```

> **Note:** `identity.enabled = false` (the default) restores Phase 2
> behaviour exactly — Slack still works, no DB writes, no link codes.

---

## 4. pria-ui-v22 preparation

```bash
cd /home/jr/Projects/Praxis/pria-ui-v22
git checkout feat/synaps-web-dashboard

# Install any new deps added by Phase 3 (e.g. ai / @ai-sdk/react if added).
npm install

# Confirm the Synaps Express routes exist.
ls routes/synaps/
# Expected: chat.js  link.js  (and possibly index.js)

# Confirm the React UI pages exist.
ls src/synaps/
# Expected: SynapsChat.jsx  SynapsLink.jsx  (and supporting components)

# Start the dev server.
npm run startmac      # macOS
# or
npm run start         # Linux
```

Expected console output:
```
[pria-ui-v22] Server listening on http://localhost:3000
[synaps] identity socket path: ~/.synaps-cli/bridge/control.sock
```

---

## 5. Smoke 1 — Start bridge daemon with identity enabled

Export Slack tokens and start the bridge:

```bash
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_APP_TOKEN="xapp-..."

cd /home/jr/Projects/Maha-Media/.worktrees/synaps-skills-scp-phase-3/synaps-bridge-plugin
node bin/synaps-bridge.js
```

**Expected log lines** (order may vary):

```
[bridge/index] identity.enabled=true — building IdentityRouter
[db/connect] Connecting to MongoDB: mongodb://localhost:27017/priadb
[db/connect] MongoDB connected.
[BridgeDaemon] memory gateway started (enabled=true)
[BridgeDaemon] started
[Slack] connected to workspace <workspace name>
```

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| `identity.enabled=true` in logs | IdentityRouter wired | ☐ |
| `MongoDB connected` in logs | DB reachable | ☐ |
| No `ERROR` lines at startup | Clean start | ☐ |
| Slack connected | Bot online | ☐ |

If `MongoDB connected` does not appear, check `[mongodb] uri` in bridge.toml
and verify `mongod` is running.

---

## 6. Smoke 2 — Web chat streams text

1. Open a browser and navigate to `http://localhost:3000`.
2. Log in to pria (JWT cookie auth).
3. Visit `http://localhost:3000/synaps/chat`.
4. Type "hi" and press Enter (or click Send).

**Expected behaviour:**
- Text streams back character-by-character (SSE, AI SDK frames).
- The response appears in the chat UI without a full page refresh.
- No browser console errors.

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| `/synaps/chat` page loads | React component renders | ☐ |
| Text input + send works | Message sent via UDS | ☐ |
| Streaming response appears | SSE frames rendered | ☐ |
| No `401` / `403` errors | Auth cookie forwarded | ☐ |

---

## 7. Smoke 3 — Inspect Mongo after first web chat

After the first web chat turn, MongoDB should contain:

```bash
mongosh priadb
```

```js
// synaps_users: exactly 1 doc for your pria user.
db.synaps_users.find().pretty()
// Expected:
// {
//   _id: ObjectId("..."),
//   pria_user_id: ObjectId("..."),     // your pria user's _id
//   memory_namespace: "u_<_id>",
//   default_channel: "web",
//   created_at: ISODate("..."),
//   ...
// }

// synaps_channel_identities: 1 'web' doc.
db.synaps_channel_identities.find().pretty()
// Expected:
// {
//   _id: ObjectId("..."),
//   synaps_user_id: ObjectId("..."),   // same _id as above
//   channel: "web",
//   external_id: "<pria_user_id>",
//   external_team_id: "",
//   link_method: "oauth",
//   ...
// }
```

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| `synaps_users` has 1 doc | Your pria user | ☐ |
| `synaps_channel_identities` has 1 web doc | Channel linked | ☐ |
| `memory_namespace = "u_<_id>"` | Correct format | ☐ |

---

## 8. Smoke 4 — Slack resolves to a NEW SynapsUser (pre-link)

In Slack, send a message to the Synaps bot (DM or `@synaps` mention):

```
@synaps hello
```

**Expected behaviour:**
- The bot responds (Phase 2 behaviour still works).
- Behind the scenes, a NEW SynapsUser is created for your Slack identity
  (no link to your pria web user yet).

Verify in Mongo:

```js
db.synaps_users.find().pretty()
// Expected: NOW 2 docs — one for web, one for Slack (synthetic, pria_user_id: null).

db.synaps_channel_identities.find().pretty()
// Expected: 2 docs — 'web' and 'slack', each pointing to different synaps_users.
```

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| Slack bot responds | Phase 2 still working | ☐ |
| 2 SynapsUsers in DB | Web user + Slack synthetic user | ☐ |
| 2 channel_identities | 'web' and 'slack' | ☐ |

---

## 9. Smoke 5 — Generate a link code from the web UI

1. In the browser, visit `http://localhost:3000/synaps/link`.
2. Click **Generate link code**.
3. Copy the displayed 6-character code (e.g. `ABC123`).

**Expected behaviour:**
- A 6-char uppercase alphanumeric code appears on the page.
- The code has a ~5-minute expiry countdown.

Verify in Mongo:

```js
db.synaps_link_codes.find().pretty()
// Expected: 1 doc with the 6-char code, redeemed_at: null, expires_at in the future.
```

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| `/synaps/link` page loads | React component renders | ☐ |
| Code generated | 6 uppercase chars | ☐ |
| Doc in `synaps_link_codes` | redeemed_at: null | ☐ |
| Expiry ~5 min in future | Default TTL working | ☐ |

---

## 10. Smoke 6 — Redeem the link code in Slack

In Slack, type the `/synaps link` slash command with the code you copied:

```
/synaps link ABC123
```

**Expected bot reply:**
```
✅ Linked Slack to your web account.
```

(If the code expired, the bot replies with an error.  Generate a new one and
try again within 5 minutes.)

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| Bot replies ✅ | Code valid + redeemed | ☐ |
| `synaps_link_codes` redeemed_at is set | Code consumed | ☐ |

---

## 11. Smoke 7 — Inspect Mongo after linking

After redemption, the Slack identity should be bound to your web `SynapsUser`:

```js
db.synaps_users.find().pretty()
// Expected: still 2 docs (orphaned Slack synthetic user + your web user).
// The orphaned synthetic user is acceptable in Phase 3 v0; a Phase 5
// cleanup job will reap these.

db.synaps_channel_identities.find().pretty()
// Expected: 3 docs:
//   1. 'web' → your web SynapsUser  (link_method: "oauth")
//   2. 'slack' → your web SynapsUser (link_method: "magic_code")   ← NEW
//   3. 'slack' → the old synthetic SynapsUser                      ← orphaned
//
// The new Slack identity (magic_code) should point to the SAME _id as the
// web identity.

// Verify the Slack identity now points to the web SynapsUser:
const webUser = db.synaps_users.findOne({ default_channel: 'web', pria_user_id: { $ne: null } });
const slackCI = db.synaps_channel_identities.findOne({ channel: 'slack', link_method: 'magic_code' });
print(webUser._id.equals(slackCI.synaps_user_id));  // Expected: true
```

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| New `slack` CI with `magic_code` | Link method set | ☐ |
| `slack` CI synaps_user_id = web user _id | Identity reconciled | ☐ |
| `synaps_link_codes` redeemed_at set | Code consumed | ☐ |

---

## 12. Smoke 8 — Cross-channel memory recall

This verifies the key Phase 3 acceptance criterion: shared memory across
Slack + web after linking.

### Step 1: Tell Synaps your favourite colour in Slack

In Slack:
```
@synaps remember: my favourite colour is blue
```

Wait for the bot to acknowledge.

### Step 2: Recall via web chat

In the browser at `/synaps/chat`:
```
What's my favourite colour?
```

**Expected:** The response should reference **blue**.

If the bot does not recall "blue", check:
1. Are both Slack and web using the same `memory_namespace`?  They should
   both be `u_<webUser._id>` after linking.

```bash
# In bridge logs, look for:
grep "memory" ~/.synaps-cli/bridge/daemon.log | tail -20
# Expected: both interactions use the SAME namespace u_<webUser._id>
```

2. Check the brain file exists:
```bash
ls ~/.local/share/synaps/memory/u_*.r8
# Expected: 1 file named u_<webUser._id>.r8
```

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| Slack memory stored | Brain file appears | ☐ |
| Web recall returns "blue" | Cross-channel memory working | ☐ |
| Same brain file used | Namespace unified | ☐ |

---

## 13. Rollback: disable identity

To revert to Phase 2 behaviour (Slack works, no identity DB, no link codes):

1. **Edit bridge.toml:**

   ```toml
   [identity]
   enabled = false
   ```

2. **Restart the bridge:**

   ```bash
   # Ctrl-C the running daemon, then:
   node bin/synaps-bridge.js
   ```

3. **Expected log:**

   ```
   [bridge/index] identity.enabled=false — using NoOpIdentityRouter
   ```

4. **Verify Slack still works:** Send `@synaps hello` in Slack — the bot
   responds exactly as it did in Phase 2.

5. **No new MongoDB documents** are created (the `NoOpIdentityRouter` never
   touches the DB).

**Checkpoint:**

| Check | Expected | Pass? |
|-------|----------|-------|
| `NoOpIdentityRouter` in logs | Identity disabled | ☐ |
| Slack bot responds | Phase 2 behaviour preserved | ☐ |
| No new Mongo docs | NoOp is truly a no-op | ☐ |

---

## 14. Known limitations

### 14.1 Phase 2 → Phase 3 memory namespace migration

> **Not a bug — documented design decision.**

Phase 2 stored memory under `u_<slackUserId>` (the raw Slack user ID string).
Phase 3 uses `u_<synapsUserId>` (the MongoDB ObjectId hex string of the
`SynapsUser` document).

**Impact on upgrade:** Any Slack user who had memory stored under Phase 2 will
see a fresh (empty) memory namespace after the Phase 3 upgrade, because the
namespace key changed.  Existing `.r8` brain files named `u_<slackUserId>.r8`
are not migrated — they remain on disk but are no longer referenced.

**Mitigation:** After linking, new Slack messages rebuild memory under the
unified `u_<synapsUserId>` namespace.  Pre-upgrade memories can be recovered
manually by renaming the old brain file:

```bash
# Find the old brain file:
ls ~/.local/share/synaps/memory/u_U*.r8       # Slack user IDs start with U

# Find the new namespace for that user (after they send a message):
mongosh priadb --eval "db.synaps_users.findOne({ default_channel: 'slack' })"

# Rename:
mv ~/.local/share/synaps/memory/u_USLACKID.r8 \
   ~/.local/share/synaps/memory/u_<synapsUserId>.r8
```

This is acceptable for Phase 3 v0.  A Phase 5 migration script will automate
this for production deployments.

### 14.2 Orphaned synthetic Slack users

When a Slack user sends messages before linking, a synthetic `SynapsUser` is
created with `pria_user_id: null`.  After they redeem a link code, a new
`channel_identity` row points to their real web `SynapsUser`, but the old
synthetic `SynapsUser` document and its old `channel_identity` row (with
`link_method: "inferred"`) remain in the DB.

**Impact:** Minimal — the orphaned docs are never queried after linking.  Disk
usage is negligible.

**Remediation:** A Phase 5 cleanup job will reap orphaned synthetic users
(those with `pria_user_id: null` and no `channel_identity` rows referencing
them).

### 14.3 Web chat: no rich subagent task trees

Web chat currently renders the basic AI SDK frame types (text, data parts,
annotations, done).  Subagent task trees with full Slack-style styling
(`task_update` cards, collapsible timelines) are not yet styled in the React
UI.  The data arrives in the stream — it just renders as a raw JSON block in
this Phase 3 v0.

Full task-tree styling in the web UI is planned for Phase 5.

### 14.4 Link code is single-use and 5-minute TTL

If the code expires before the Slack user types `/synaps link CODE`, they must
return to `/synaps/link` and generate a new code.  The TTL is configurable via
`[identity] link_code_ttl_secs` in bridge.toml (default: 300 s).  For
development, set a longer TTL (e.g. `3600`).

### 14.5 No CSRF protection on the link-code endpoint

The `/api/synaps/link/issue` Express endpoint is protected by the existing
pria JWT cookie middleware (same-origin).  It does not have additional CSRF
tokens.  This is acceptable for an internal development deployment.  A Phase 5
security hardening pass will add CSRF tokens.
