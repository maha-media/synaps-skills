# transcribe — Local OpenAI Whisper

Local speech-to-text. No file size limit, no API key, no network. Auto-detects
GPU/CPU and picks the best Whisper model for your hardware.

## Setup

Run these checks **in order** — fix each before continuing.

### 1. Python 3.10+
```bash
python3 --version
```

### 2. ffmpeg
```bash
ffmpeg -version            # Required for audio decoding
# Ubuntu/Debian/WSL:  sudo apt install ffmpeg
# macOS:              brew install ffmpeg
```

### 3. Whisper
```bash
python3 -c "import whisper; print(whisper.__version__)"
# If missing:
pip install openai-whisper        # also installs torch
# Or per-user:
pip install --user openai-whisper
```

### 4. GPU (optional)
```bash
python3 -c "import torch; print('CUDA:', torch.cuda.is_available())"
```

CPU-only works fine, just slower. For CUDA-accelerated PyTorch:
```bash
pip install torch --index-url https://download.pytorch.org/whl/cu121
```

## Usage

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py interview.mp4
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py podcast.mp3 --format txt
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py meeting.m4a --format srt,txt --output-dir ./out
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py audio.wav --stdout              # text only, no files

# Advanced
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py video.mp4 --language es
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py video.mp4 --model large-v3
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py video.mp4 --device cpu          # force CPU
```

## Options

| Option           | Default     | Notes                                     |
|------------------|-------------|-------------------------------------------|
| `--format`       | `txt,srt,json` | Comma-separated subset                |
| `--output-dir`   | input dir   | Where to write outputs                    |
| `--name`         | input stem  | Override output filename stem             |
| `--model`        | auto        | tiny, base, small, medium, large-v3, turbo |
| `--language`     | auto-detect | en, es, fr, de, …                         |
| `--device`       | auto-detect | cuda, cpu                                 |
| `--stdout`       | off         | Print plain text to stdout, no files      |

## Auto model selection

| Hardware           | Picks   | Quality |
|--------------------|---------|---------|
| GPU ≥ 8 GB VRAM    | `turbo` | Great   |
| GPU < 8 GB VRAM    | `small` | Good    |
| CPU only           | `base`  | Fair    |

Model table (override with `--model`):

| Model      | VRAM/RAM | Speed   | Quality | Best for                |
|------------|----------|---------|---------|-------------------------|
| `tiny`     | ~1 GB    | Fastest | Low     | Drafts, testing         |
| `base`     | ~1 GB    | Fast    | Fair    | CPU transcription       |
| `small`    | ~2 GB    | Medium  | Good    | Low-VRAM GPUs           |
| `medium`   | ~5 GB    | Slow    | Better  | Balanced quality        |
| `turbo`    | ~6 GB    | Fast    | Great   | Best speed/quality      |
| `large-v3` | ~10 GB   | Slower  | Best    | Maximum accuracy        |

## Self-healing notes

- **PRE**: recall `op-transcribe` + `format-<ext>` (e.g. `format-mp3`).
- **POST**:
  - `oom` — script auto-classifies CUDA OOM. **Escalation**: retry with
    `--model small` then `--model base` then `--device cpu`.
  - `unsupported_format` — list lives in the script (`SUPPORTED_EXT`); convert
    upstream with ffmpeg first.
  - `media_decode` — file is corrupt or codec missing. Try
    `ffmpeg -i src.mp4 -vn -acodec mp3 out.mp3` to re-encode the audio track,
    then re-run.
  - `missing_dep` — install command shown in the error.

## Output formats

| Format | Description                          |
|--------|--------------------------------------|
| `.txt` | Clean transcription text             |
| `.srt` | SRT subtitles with timestamps        |
| `.json`| Full segments + language + duration  |

## Supported input

`mp3`, `mp4`, `m4a`, `wav`, `ogg`, `flac`, `webm`, `mpeg`, `mpga`, `avi`, `mkv`, `mov`

## Stdout mode for piping

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py audio.mp3 --stdout > transcript.txt
yt-dlp -x --audio-format mp3 -o /tmp/x.mp3 "URL" && \
  python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py /tmp/x.mp3 --stdout
```
