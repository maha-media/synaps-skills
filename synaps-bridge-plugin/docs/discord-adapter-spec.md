# Discord Adapter Specification — synaps-bridge-plugin

## 1. Objective

Add Discord as a second chat platform source for synaps-bridge. Users in Discord servers and DMs can talk to Synaps agents with full session isolation, memory, streaming responses, and tool/subagent rendering — mirroring the Slack adapter's functionality within Discord's platform constraints.

**Success criteria:**
- Discord bot responds to @mentions in guild channels
- Discord bot responds to DMs
- Discord bot responds in threads it's participating in
- Each conversation gets an isolated `synaps rpc` session
- Responses stream via edit-in-place with debounced throttling
- Tool calls and subagent events render as Discord Embeds
- File attachments are downloaded and forwarded to the agent
- Bot-loop prevention (ignores own messages and other bots)
- Per-user memory via MemoryGateway (when enabled)
- Identity routing via IdentityRouter (when enabled)
- All existing Slack tests continue to pass
- Discord adapter has its own unit test suite

## 2. Commands

```bash
# Install deps
cd ~/Projects/synaps-skills/synaps-bridge-plugin && npm install

# Run tests
npm test

# Run Discord-specific tests
npx vitest run bridge/sources/discord/

# Start bridge with Discord enabled
DISCORD_BOT_TOKEN=... node bin/synaps-bridge.js
```

## 3. Project Structure

```
bridge/sources/discord/
├── index.js                          # DiscordAdapter extends AdapterInstance
├── index.test.js                     # Adapter integration tests
├── auth.js                           # readDiscordAuth + redactTokens
├── auth.test.js
├── discord-capabilities.js           # DISCORD_CAPABILITIES frozen object
├── discord-capabilities.test.js
├── discord-bot-gate.js               # DiscordBotGate extends BotGate
├── discord-bot-gate.test.js
├── discord-formatter.js              # DiscordFormatter extends Formatter
├── discord-formatter.test.js
├── discord-stream-handle.js          # DiscordStreamHandle extends StreamHandle
├── discord-stream-handle.test.js
├── discord-subagent-renderer.js      # Embeds for subagent state
├── discord-subagent-renderer.test.js
├── discord-tool-progress-renderer.js # Embeds for tool calls
├── discord-tool-progress-renderer.test.js
└── file-store.js                     # downloadDiscordFile
    file-store.test.js
```

Core integration (minimal edits):
- `bridge/config.js` — add `sources.discord` defaults + normalization
- `bridge/index.js` — add Discord factory, wiring in start/stop

## 4. Code Style

Follow existing patterns exactly. ESM only, no top-level await, no I/O in constructors, DI everywhere, test via factory injection.

```js
// Example: how the adapter registers (mirroring Slack pattern)
import { DiscordAdapter } from './sources/discord/index.js';
import { readDiscordAuth } from './sources/discord/auth.js';

function defaultDiscordAdapterFactory({ auth, sessionRouter, memoryGateway, identityRouter, logger }) {
  return new DiscordAdapter({ sessionRouter, auth, memoryGateway, identityRouter, logger });
}
```

## 5. Testing Strategy

- **Unit tests** for every module (formatter, bot-gate, auth, stream-handle, renderers, file-store)
- **Integration test** for the adapter (fake discord.js client, fake synaps rpc)
- **No real Discord API calls** — inject `discordClientFactory` for tests
- **Vitest** framework (existing project standard)
- Follow the `fake-bolt-client.mjs` pattern from Slack e2e tests

## 6. Boundaries

**Always do:**
- Run `npm test` before commits
- Follow existing abstraction contracts exactly
- Inject all dependencies (no global imports of discord.js in tests)
- Never log tokens
- Use `redactTokens()` on all error messages

**Ask first:**
- Adding new npm dependencies beyond `discord.js`
- Changing any abstraction interface
- Modifying core files beyond config.js and index.js

**Never do:**
- Import from `bridge/sources/slack/` in Discord code
- Import from `bridge/sources/discord/` in core code
- Hardcode tokens or channel IDs
- Skip tests

## 7. Key Design Decisions

### Capabilities
```js
DISCORD_CAPABILITIES = {
  streaming: false,       // No native streaming API — use edit-in-place
  richStreamChunks: false, // No task_update/plan_update chunks
  buttons: true,          // ActionRow + Button components
  files: true,            // CDN attachment downloads
  reactions: true,        // Unicode emoji reactions
  threading: true,        // ThreadChannel support
  auxBlocks: true,        // Embeds as aux messages
  aiAppMode: false,       // No assistant surface
}
```

### Thread Identity Mapping
```
Guild thread:  conversation = thread.parentId, thread = thread.id
Guild channel: conversation = channel.id,      thread = ''
DM:            conversation = channel.id,      thread = ''
```

### Streaming Strategy
Edit-in-place with 1000ms debounce (vs Slack's native streaming).
- `start()` → `channel.send("⏳")` → store message ref
- `append(markdown_text)` → accumulate buffer, `message.edit()` throttled
- `append(task_update/plan_update)` → drop (no rich chunks)
- `stop()` → final `message.edit()` with complete text
- Typing indicator maintained via `channel.sendTyping()` every 8s

### Markdown Conversion
Near-identity — Discord speaks standard markdown. Only transforms:
- Escape `@everyone`, `@here` → `\@everyone`, `\@here`
- Use `allowedMentions: { parse: [] }` on all sends

### Auth
Single token: `DISCORD_BOT_TOKEN` env var. No app token needed.

### Bot-Loop Prevention
Drop messages where `message.author.bot === true`.

### File Downloads  
Discord CDN URLs are publicly signed — no auth header needed.
Download synchronously (URLs expire ~24h).
