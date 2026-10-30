# local-voice

Opt-in local voice dictation provider for Synaps CLI.

This plugin owns the heavyweight microphone / Whisper runtime. The Synaps binary only includes generic plugin hook plumbing and the compatibility voice sidecar protocol while the native plugin-hook refactor lands; install and enable this plugin to start a local STT sidecar.

## Native hooks

The plugin declares the default voice toggle keybind in `.synaps-plugin/plugin.json`:

```json
{
  "key": "C-Space",
  "action": "slash_command",
  "command": "voice toggle",
  "description": "Toggle local voice dictation on/off"
}
```

Synaps treats this like any other plugin keybind. If the plugin is disabled or absent, the key does not provide voice behavior. Plugin manifests declare one fixed key (no per-OS keys), so to change it, override it in your Synaps config (`${SYNAPS_BASE_DIR:-~/.synaps-cli}/config`):

```text
keybind.C-Space = disabled
keybind.F8 = /voice toggle
```

You can also type `/voice toggle` at any time.

**macOS:** Ctrl-Space is macOS's default "Select the previous input source" shortcut. While that shortcut is on, macOS takes the key before your terminal sees it. Either turn it off (System Settings > Keyboard > Keyboard Shortcuts > Input Sources) or rebind voice as above. On Mac keyboards, F-keys may need the Fn key unless "Use F1, F2, etc. keys as standard function keys" is on.

## Setup

Build and install the sidecar locally:

```bash
./scripts/setup.sh
```

The script builds `cargo build --release --features local-stt`, copies the binary to `bin/synaps-voice-plugin`, and prints the exact Synaps config snippet with an absolute sidecar path.

Optional acceleration features can be passed through Cargo features, for example:

```bash
./scripts/setup.sh --features local-stt,cuda
```

On Apple Silicon macOS the default is `local-stt,metal` (Metal GPU). Pass `--features local-stt` for a CPU-only build. Everywhere else the default is `local-stt`.

## Model

Real microphone transcription requires a Whisper GGML model. The default config path is:

```text
~/.synaps-cli/models/whisper/ggml-base.en.bin
```

To print model download guidance while setting up:

```bash
./scripts/setup.sh --model base.en
```

## Configure Synaps

Use the config snippet printed by setup. It will look like:

```text
voice.enabled = true
voice.provider = sidecar
voice.sidecar.command = /absolute/path/to/local-voice-plugin/bin/synaps-voice-plugin
voice.stt_model_path = ~/.synaps-cli/models/whisper/ggml-base.en.bin
```

Enable the `local-voice` plugin from `/plugins` or `/settings` when plugin enablement is available. Disabled plugins should not provide voice sidecars.

## Platform prerequisites

- Linux: Rust toolchain plus native build/audio packages such as `build-essential`, `pkg-config`, `clang`, `cmake`, and `libasound2-dev`.
- macOS: Rust toolchain and Xcode command line tools. Metal is built in by default on Apple Silicon (see Setup).
- Windows: Rust MSVC toolchain and native build tools supported by `whisper-rs`/`cpal`.

No built sidecar binary is committed to this repository; setup always builds from source.

### macOS microphone permission

macOS asks for microphone access (TCC) the first time the sidecar opens the mic. The permission belongs to the terminal app that runs Synaps (Terminal, iTerm2, Ghostty, and so on), not to the sidecar binary. If you denied it, or no prompt appeared and dictation stays silent, turn the terminal on under System Settings > Privacy & Security > Microphone and restart the terminal. To be asked again, run `tccutil reset Microphone <terminal bundle id>`, for example `com.apple.Terminal`.
