# bell — terminal completion notification

Rings the terminal bell when the assistant's turn completes, i.e. when the
session goes from **streaming** back to **ready**. The bell is the plain ASCII
`BEL` byte (`0x07`) written to the session's controlling terminal, which every
mainstream terminal turns into an audible bell and/or an attention indicator
on the tab or window — Ghostty, iTerm2, Kitty, WezTerm, Alacritty, GNOME
Terminal, Windows Terminal, and tmux all react to it. No terminal-specific
escape sequences are used.

Stdlib Python 3.8+; no host rebuild required.

## Install

```sh
cp -r bell-plugin ~/.synaps-cli/plugins/bell
```

Then `/plugins reload` in a running TUI, or start a new `synaps` session.
Loading it once is enough; there is no command to run.

## What triggers the bell

The extension protocol has no content-free "turn finished" hook, so the plugin
derives the boundary from two observe-only hooks:

1. `on_message_complete` with `has_tool_use == false` is a **candidate** turn
   end. Assistant messages that call tools never ring — the turn is still going.
2. A candidate arms a short timer (`settle_ms`, default 400 ms). If a
   `before_message` hook arrives first, the runtime is sending another
   request (queued steering, an autonomous driver continuing), so the bell is
   cancelled. Otherwise it rings once.
3. Rings are spaced at least `min_interval_ms` apart (default 1 s).

**Not covered:** turns that end in a provider error or user cancellation (no
hook fires for those). Subagent workers use their own hook bus, so their
completions never ring — only your foreground turn does.

## Permission rationale

Both hooks require `privacy.llm_content`, because the host attaches message
text to them. The plugin only reads `kind` and `data.has_tool_use`. Message
bodies are never inspected, stored, logged, or transmitted, and the plugin
writes nothing to stdout/stderr other than framed JSON-RPC replies. You can
audit this in `main.py` — it is ~200 lines.

## Configuration

Set in `~/.synaps-cli/config` as `extension.bell.<key> = value`, or via
`SYNAPS_EXTENSION_BELL_<KEY>` in the environment of the `synaps` process.

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | `false` keeps the plugin loaded but silent |
| `settle_ms` | `400` | grace window in which a follow-up request cancels the bell (0–10000) |
| `min_interval_ms` | `1000` | minimum spacing between rings (0–60000) |
| `tty` | *(empty)* | output device path; empty means `/dev/tty`. Test/diagnostic use only |

Invalid values fall back to the defaults.

## Terminal notes

- **Ghostty:** `bell-features` controls what a BEL does. `attention` shows the
  bell badge on the tab/window and requests attention from the OS; `audio`
  plays `bell-audio-path`; `system` uses the platform bell; `title` prefixes
  the window title. Example in `~/.config/ghostty/config`:

  ```
  bell-features = attention,title,system
  ```

  On Linux there may be no system bell sound by default; add `audio` with
  `bell-audio-path = /usr/share/sounds/freedesktop/stereo/complete.oga`
  (or any file you like) if you want an audible ring.
- **tmux:** `set -g bell-action any` and `set -g visual-bell off` keep the
  bell flowing through to the outer terminal; `monitor-bell on` (default)
  flags the window in the status line.
- **SSH:** the BEL travels over the pty like any other byte, so the bell
  reaches your local terminal.
- **Headless** (`synaps chat` with no controlling terminal): silent no-op.

## Limits

- This is a heuristic on hook ordering, not a host state machine. A provider
  request that starts more than `settle_ms` after a final message will ring
  and then continue; lower `settle_ms` makes the bell snappier but slightly
  more prone to that.
- No focus detection: it rings whether or not the tab is in front.
- One bell per settled turn; there is no "still working" heartbeat.

## Tests

```sh
python3 -m unittest discover -s bell-plugin/tests -v
cargo test --test bell_plugin -- --test-threads=1     # real host manager + process
```
