# Permissions & hooks

Every Synaps extension declares **permissions** (capabilities the user must
trust) and zero or more **hooks** (callback registrations). Permissions are
the gate; hooks are the wires. **Each hook requires a matching permission** —
this map is enforced by SynapsCLI at load time and by `plugin-maker validate`.

## The 12 permissions

> Source: `SynapsCLI/src/extensions/permissions.rs`.

| Permission | Description |
|---|---|
| `tools.intercept`     | Subscribe to `before_tool_call` / `after_tool_call`. |
| `tools.override`      | _[reserved]_ Override built-in tools. |
| `tools.register`      | _[reserved]_ Register new model-callable tools. |
| `privacy.llm_content` | Subscribe to `before_message` (sees raw LLM content). |
| `session.lifecycle`   | Subscribe to `on_session_start` / `_end` / `on_compaction`. |
| `providers.register`  | _[reserved]_ Register chat-completion providers. |
| `memory.read`         | _[reserved]_ Read VelociRAG memory. |
| `memory.write`        | _[reserved]_ Write VelociRAG memory. |
| `config.write`        | _[reserved]_ Mutate user config. |
| `config.subscribe`    | Receive config-change notifications. |
| `audio.input`         | _[reserved]_ Read microphone (used by `local-voice`). |
| `audio.output`        | _[reserved]_ Write speakers (used by `local-voice`). |

`[reserved]` permissions parse and load today but are not yet wired to
runtime APIs in the current Synaps build. Declare them ahead of time only if
your extension code already uses the matching RPC stubs.

## The 7 hooks

> Source: `SynapsCLI/src/extensions/hooks/events.rs::HookKind`.

| Hook | Requires | Tool-filter? | Returns |
|---|---|---|---|
| `before_tool_call`    | `tools.intercept`     | yes | `continue` / `block` / `confirm` / `modify` |
| `after_tool_call`     | `tools.intercept`     | yes | `continue` (with optional `annotate`) |
| `before_message`      | `privacy.llm_content` | no  | `continue` / `block` / `modify` |
| `on_message_complete` | `privacy.llm_content` | no  | `continue` |
| `on_session_start`    | `session.lifecycle`   | no  | `continue` / `inject_message` |
| `on_session_end`      | `session.lifecycle`   | no  | `continue` |
| `on_compaction`       | `session.lifecycle`   | no  | `continue` / `modify` |

`tool_filter` (only meaningful for tool-call hooks) is an **array** of tool
names. An empty/missing array means *all tools*.

## Hook → permission map

```text
before_tool_call   →  tools.intercept
after_tool_call    →  tools.intercept
before_message     →  privacy.llm_content
on_message_complete→  privacy.llm_content
on_session_start   →  session.lifecycle
on_session_end     →  session.lifecycle
on_compaction      →  session.lifecycle
```

`plugin-maker validate` enforces this with rule **X005**.

## Quick recipes

### "Suggest a fix when the user runs failing tests"
```jsonc
"permissions": ["tools.intercept"],
"hooks": [
  { "kind": "after_tool_call", "tool_filter": ["bash"] }
]
```

### "Inject a system message on every new chat"
```jsonc
"permissions": ["session.lifecycle"],
"hooks": [{ "kind": "on_session_start" }]
```

### "Redact secrets in messages before they reach the LLM"
```jsonc
"permissions": ["privacy.llm_content"],
"hooks": [{ "kind": "before_message" }]
```

## Trust prompt minimisation

Synaps shows the user a single trust prompt listing every permission you ask
for. **Ask for the smallest set.** Adding `audio.input` because you might need
it later means every install gets a microphone-access prompt forever.

`plugin-maker lint` warns (rule `X101`) when you declare a permission but no
hook or RPC method actually uses it.
