# Extension system

A SynapsCLI **extension** is a long-running subprocess that speaks
**JSON-RPC 2.0** over stdio. One JSON object per line. Synaps spawns the
process when a chat session starts that uses the plugin and shuts it down
when the session ends.

> Sources: `src/extensions/{mod,manifest,runtime,hooks}.rs`.

## Wire shape

```jsonc
// Synaps → extension
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }
// extension → Synaps
{ "jsonrpc": "2.0", "id": 1, "result": { "name":"foo", "version":"0.1.0", "protocol_version":1, "capabilities":{...} } }
```

- `id`-bearing messages are **requests**; reply with `result` or `error`.
- Missing `id` = **notification**; do NOT reply.
- Anything written to **stderr** is forwarded to the Synaps log.
- Keep each frame ≤ 1 MB; use multiple frames for streaming output.

## Lifecycle

1. **spawn** — Synaps execs `extension.command extension.args…`, sets
   `${PLUGIN_DIR}` in the environment.
2. **`initialize`** — must respond with capabilities + protocol_version (`1`).
3. **hook calls** — Synaps invokes `method = <hook_kind>` for each registered hook.
4. **command/RPC calls** — interactive slash commands and settings editors.
5. **`shutdown`** — last RPC; respond `{ "ok": true }` then exit.

If your process exits unexpectedly, Synaps will log the exit code and
disable the extension for the rest of the session.

## Hook return shapes

| Hook | `result` shape |
|---|---|
| `before_tool_call`    | `{ "action": "continue" \| "block" \| "confirm" \| "modify", … }` |
| `after_tool_call`     | `{ "action": "continue", "annotate"?: "string" }` |
| `before_message`      | `{ "action": "continue" \| "block" \| "modify", "content"?: "…" }` |
| `on_message_complete` | `{ "action": "continue" }` |
| `on_session_start`    | `{ "action": "continue" \| "inject_message", "role"?: "system", "content"?: "…" }` |
| `on_session_end`      | `{ "action": "continue" }` |
| `on_compaction`       | `{ "action": "continue" \| "modify", … }` |

Always return `{ "action": "continue" }` for the no-op case — never throw.

## Custom RPC methods

Your manifest's `extension.commands[]` and `settings.categories[].fields[]`
of type `editor` route through methods you implement.

| Surface | Method(s) |
|---|---|
| Interactive slash command | `command.invoke` (`{ subcommand, args }` → `{ output, exit }`) |
| Custom settings editor    | `settings.editor.open` / `render` / `key` / `commit` |
| Tool registration         | `tools.list` / `tools.invoke` *(`tools.register` permission)* |

Anything not in the dispatch table → respond with JSON-RPC error `-32601`.

## Skeleton (Python)

```python
import json, sys
def send(o): sys.stdout.write(json.dumps(o)+"\n"); sys.stdout.flush()
H = {
  "initialize": lambda p: {"name":"foo","version":"0.1.0","protocol_version":1,
                            "capabilities":{"hooks":["on_session_start"]}},
  "shutdown":   lambda p: {"ok": True},
  "on_session_start": lambda p: {"action":"continue"},
}
for line in sys.stdin:
    req = json.loads(line)
    fn  = H.get(req["method"])
    if fn is None: continue
    if "id" in req:
        send({"jsonrpc":"2.0","id":req["id"],"result":fn(req.get("params") or {})})
```

`plugin-maker new extension --plugin PATH --lang python` scaffolds a richer
version of this with all 7 hook stubs.

## Showcase: the plugin-maker extension itself

Open [`extensions/plugin_maker_ext.py`](../extensions/plugin_maker_ext.py)
for a fully-working reference covering:

- 3 hooks (`on_session_start`, `before_tool_call`, `after_tool_call` with `bash` filter)
- Interactive `/plugin-maker` command via `command.invoke`
- Custom settings editor (`browse_plugins`) implementing all 4 editor RPCs
- Help-lightbox entries via manifest `help_entries`

It's a thin RPC adapter that shells out to `bin/plugin-maker`. Use it as a
template when designing your own extension.
