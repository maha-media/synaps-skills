# Discord Adapter — Task Breakdown

## Task 1: Auth + Capabilities + Config (XS) ✅
**Files:** `discord/auth.js`, `discord/auth.test.js`, `discord/discord-capabilities.js`, `discord/discord-capabilities.test.js`, `bridge/config.js`

**Acceptance criteria:**
- [x] `readDiscordAuth(env)` returns `{botToken}`, throws on missing/malformed
- [x] `redactTokens(s)` strips Discord token patterns from strings
- [x] `DISCORD_CAPABILITIES` frozen object with correct flags
- [x] `bridge/config.js` has `sources.discord` defaults + normalization
- [x] Tests pass for auth validation, redaction, and capabilities

---

## Task 2: Formatter (S) ✅
**Files:** `discord/discord-formatter.js`, `discord/discord-formatter.test.js`

**Acceptance criteria:**
- [x] `formatMarkdown(md)` escapes `@everyone`/`@here`, otherwise near-identity
- [x] `formatError(err)` returns `"⚠️ <message>"` string
- [x] `formatSubagent(state)` returns Discord Embed object array
- [x] Tests for markdown edge cases, error formatting, subagent states

---

## Task 3: BotGate (XS) ✅
**Files:** `discord/discord-bot-gate.js`, `discord/discord-bot-gate.test.js`

**Acceptance criteria:**
- [x] `DiscordBotGate extends BotGate`
- [x] `evaluate()` delegates to base (no aiAppMode override)
- [x] Tests verify turn counting and admission control

---

## Task 4: Renderers — Subagent + Tool Progress (S) ✅
**Files:** `discord/discord-subagent-renderer.js`, `discord/discord-subagent-renderer.test.js`, `discord/discord-tool-progress-renderer.js`, `discord/discord-tool-progress-renderer.test.js`

**Acceptance criteria:**
- [x] SubagentRenderer produces Discord Embed with status icon, agent name, task/result preview
- [x] ToolProgressRenderer produces Discord Embed with tool name, input preview, result/error
- [x] Embeds respect 6000 char / 25 field limits
- [x] Tests for all lifecycle states (pending, running, done, failed)

---

## Task 5: StreamHandle (M) ✅
**Files:** `discord/discord-stream-handle.js`, `discord/discord-stream-handle.test.js`

**Acceptance criteria:**
- [x] `start()` sends placeholder message, stores ref, starts typing indicator loop
- [x] `append(markdown_text)` accumulates buffer, edits message with 1000ms debounce
- [x] `append(task_update/plan_update)` silently drops (logged)
- [x] `stop()` flushes buffer, final edit, stops typing, idempotent
- [x] Typing indicator repeats every 8s during active stream
- [x] Tests with fake message object (send/edit/sendTyping stubs)

---

## Task 6: File Store (S) ✅
**Files:** `discord/file-store.js`, `discord/file-store.test.js`

**Acceptance criteria:**
- [x] `downloadDiscordFile({attachment, conversation, thread})` downloads CDN URL (no auth)
- [x] Reuses `sanitizeFilename` pattern from Slack's file-store
- [x] Respects 20MB size limit, 0o600 permissions
- [x] Returns `{path, name, mime}`
- [x] Tests with fetch stub

---

## Checkpoint: After Tasks 1-6 ✅
- [x] All unit tests pass (`npx vitest run bridge/sources/discord/`)
- [x] No changes to any core or Slack files (except config.js)
- [x] Every Discord module is independently testable

---

## Task 7: DiscordAdapter — Main Integration (L) ✅
**Files:** `discord/index.js`, `discord/index.test.js`

**Acceptance criteria:**
- [x] `DiscordAdapter extends AdapterInstance` with `source = 'discord'`
- [x] `start()` creates discord.js Client with correct intents, registers handlers, logs in
- [x] `stop()` calls `client.destroy()`
- [x] Handles `messageCreate` — filters bot messages, routes mentions + DMs + thread replies
- [x] `_handleUserMessage` pipeline mirrors Slack's 15 steps
- [x] Integrates sessionRouter, memoryGateway, identityRouter, botGate, formatter, streamHandle
- [x] `discordClientFactory` injection for tests
- [x] Startup warning if MessageContent intent missing
- [x] Tests with fake discord.js client

---

## Task 8: Core Wiring (XS) ✅
**Files:** `bridge/index.js`

**Acceptance criteria:**
- [x] `bridge/index.js` imports Discord adapter, has factory, wires start/stop gated on `config.sources.discord.enabled`
- [x] `discordAdapterFactory` injection for tests
- [x] Existing Slack tests still pass
- [x] Bridge starts cleanly with Discord disabled (default)

---

## Task 9: E2E Test (M) ❌ TODO
**Files:** `tests/bridge-e2e/discord-*.test.mjs`

**Acceptance criteria:**
- [ ] E2E test with fake discord.js client + fake synaps rpc
- [ ] Tests: mention → response streams, DM → response, thread reply, file attachment
- [ ] All existing e2e tests still pass

**Dependencies:** Task 8

---

## Final Checkpoint
- [x] Full `npm test` passes (all Slack + Discord tests) — 497 tests
- [x] Bridge starts with Discord enabled — live tested as Jawz#6454
- [ ] E2E test coverage
- [ ] Documentation updated
