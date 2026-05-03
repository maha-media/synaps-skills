# Extension Showcase Plugin

A proof-of-concept plugin that shows what Synaps extensions can do out of the gate.

It intentionally combines multiple extension surfaces in one small, auditable Python process:

- registers an extension tool
- intercepts selected tool calls with hook policy
- observes lifecycle/message-complete events
- registers a local extension model provider
- uses extension config passed through `initialize`

## Installed capabilities

### Tool

```text
extension-showcase:showcase_note
```

Input schema:

```json
{
  "note": "What to record",
  "tag": "optional tag"
}
```

The tool appends JSONL records to:

```text
$SYNAPS_BASE_DIR/memory/extension-showcase.jsonl
```

### Hooks

- `before_tool_call` for `bash` commands containing `rm -rf`
- `after_tool_call` for lightweight tool telemetry
- `on_message_complete`
- `on_session_start`
- `on_session_end`

### Provider model

```text
extension-showcase:showcase:demo-small
```

The model is fully local and deterministic. It echoes a concise explanation of what it received and advertises itself as an extension-provided provider.

## Configuration

The extension declares two non-secret config keys:

- `response_prefix`, default `showcase`
- `notes_file`, default `memory/extension-showcase.jsonl`

These are resolved by Synaps and passed to the extension in the `initialize` request.

## Safety

This example does not perform network I/O. It writes only to the configured notes file under `$SYNAPS_BASE_DIR` by default.
