# local-voice

Opt-in local voice dictation provider for Synaps CLI.

This plugin owns the heavyweight microphone / Whisper runtime. The Synaps binary only includes generic plugin hook plumbing and the compatibility voice sidecar protocol while the native plugin-hook refactor lands; install and enable this plugin to start a local STT sidecar.

## Native hooks

The plugin declares the default voice toggle keybind in `.synaps-plugin/plugin.json`:

```json
{
  "key": "F8",
  "action": "slash_command",
  "command": "voice toggle",
  "description": "Toggle local voice dictation"
}
```

Synaps should treat this like any other plugin keybind. If the plugin is disabled or absent, F8 should not provide voice behavior. Users can override or disable the keybind through Synaps' normal keybind configuration.

## Setup

Build and install the sidecar locally:

```bash
./scripts/setup.sh
```

The script builds `cargo build --release --features local-stt`, copies the binary to `bin/synaps-voice-plugin`, and prints the exact Synaps config snippet with an absolute sidecar path.

Optional acceleration features can be passed through Cargo features, for example:

```bash
./scripts/setup.sh --features local-stt,metal
```

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
- macOS: Rust toolchain and Xcode command line tools. Metal acceleration is optional with the `metal` feature.
- Windows: Rust MSVC toolchain and native build tools supported by `whisper-rs`/`cpal`.

No built sidecar binary is committed to this repository; setup always builds from source.
