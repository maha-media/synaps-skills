# Sidecar protocol v2

A **sidecar** is a per-plugin helper process that streams structured output
back into the chat. Unlike extensions, sidecars use a **line-JSON v2** wire
protocol (not JSON-RPC) and are designed for media/audio/streaming workloads.

> Source: `SynapsCLI/src/sidecar/protocol.rs`.

## Lifecycle modes

Set `provides.sidecar.lifecycle`:

| Mode | When sidecar runs |
|---|---|
| `always`     | Spawned on session start, alive until session end. |
| `on_command` | Spawned when `lifecycle_command` slash command runs. |
| `on_demand`  | Spawned when first triggered, idle-killed after timeout. |

## Models

Set `provides.sidecar.model`:

- `stream` — sidecar may emit many `InsertText` frames in `append` mode then
  one `final`.
- `oneshot` — sidecar emits exactly one `InsertText` (`final` mode) and exits.

## Wire frames

### Synaps → sidecar (commands)

```jsonc
{"type":"init", "config": { /* arbitrary */ }}
{"type":"trigger", "name": "transcribe", "payload": { /* arbitrary */ }}
{"type":"shutdown"}
```

### Sidecar → Synaps (frames)

```jsonc
// First frame after spawn — protocol handshake
{"type":"hello","protocol_version":2,"extension":"my-sidecar","capabilities":["audio.input"]}

// Status updates show in the TUI status bar
{"type":"status","state":"running","label":"transcribing…"}

// Insert text into the active chat
{"type":"insert_text","text":"hello ","mode":"append"}
{"type":"insert_text","text":"world","mode":"final"}

// Errors surface as a chat warning
{"type":"error","message":"mic device disappeared"}
```

`mode` for `insert_text`:

| Mode | Effect |
|---|---|
| `append`  | Streams partial text — appends to current message |
| `final`   | Marks the message complete |
| `replace` | Replaces in-flight buffer (e.g. live transcript correction) |

## Skeleton (Python)

```python
import json, sys
def send(o): sys.stdout.write(json.dumps(o)+"\n"); sys.stdout.flush()
send({"type":"hello","protocol_version":2,"extension":"foo","capabilities":[]})
for line in sys.stdin:
    cmd = json.loads(line)
    t = cmd.get("type")
    if t == "init":
        send({"type":"status","state":"ready"})
    elif t == "trigger":
        send({"type":"insert_text","text":"hello world","mode":"final"})
    elif t == "shutdown":
        break
```

`plugin-maker new sidecar --plugin PATH --lang python` scaffolds this with
proper signal handling and structured logging.

## Validation

`plugin-maker validate` enforces:

| Rule | Check |
|---|---|
| `S001` | `command` is set + executable |
| `S002` | `lifecycle` ∈ `{always, on_command, on_demand}` |
| `S003` | `model` ∈ `{stream, oneshot}` |
| `S004` | `lifecycle_command` matches a `commands[]` entry when `lifecycle=on_command` |
| `S005` | sidecar binary exists at the configured path |
