---
name: transcribe
description: Speech-to-text transcription using local OpenAI Whisper. Produces .txt, .srt subtitles, and .json with timestamps. No file size limit. Supports mp3, mp4, m4a, wav, ogg, flac, webm, avi, mkv, mov. Auto-detects GPU/CPU.
---

# Transcribe

Local speech-to-text using OpenAI Whisper. Produces clean text, SRT subtitles, and timestamped JSON. No file size limits, no API keys needed.

## Setup

Before first use, check the environment and install what's missing. Run these checks **in order** — stop and fix each issue before continuing.

### 1. Python

```bash
python3 --version
```

Requires Python 3.10+. If missing:
- **Ubuntu/Debian**: `sudo apt install python3 python3-pip`
- **macOS**: `brew install python` or download from https://python.org
- **Windows (WSL)**: `sudo apt install python3 python3-pip`

### 2. ffmpeg

```bash
ffmpeg -version
```

Required for audio/video decoding. If missing:
- **Ubuntu/Debian**: `sudo apt install ffmpeg`
- **macOS**: `brew install ffmpeg`
- **Windows (WSL)**: `sudo apt install ffmpeg`

### 3. Whisper

```bash
python3 -c "import whisper; print(whisper.__version__)"
```

If not installed:
```bash
pip install openai-whisper
```

If pip fails with permission errors, try `pip install --user openai-whisper` or use a virtual environment.

### 4. GPU detection (optional)

```bash
python3 -c "import torch; print('CUDA:', torch.cuda.is_available()); print('Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU only')"
```

**GPU is optional.** The script auto-detects CUDA and falls back to CPU. CPU transcription is slower but works fine.

If CUDA is available but not detected:
- Ensure NVIDIA drivers are installed: `nvidia-smi`
- You may need the CUDA-enabled PyTorch: `pip install torch --index-url https://download.pytorch.org/whl/cu121`

## Usage

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py <audio-or-video-file> [options]
```

### Basic

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py interview.mp4                              # → interview.txt, interview.srt, interview.json
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py podcast.mp3 --format txt                   # → podcast.txt only
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py meeting.m4a --format srt,txt               # → meeting.srt, meeting.txt
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py audio.wav --stdout                         # Print text to stdout (no files)
```

### Advanced

```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py video.mp4 --output-dir ./transcripts       # Write files to specific directory
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py video.mp4 --name "my-transcript"           # Override output filename stem
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py video.mp4 --language es                    # Spanish transcription
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py video.mp4 --model large-v3                 # Use larger model
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py video.mp4 --device cpu                     # Force CPU even if GPU available
```

### Options

- `--format <formats>` - Comma-separated: `txt`, `srt`, `json` (default: all three)
- `--output-dir <dir>` - Output directory (default: same as input file)
- `--name <name>` - Override output filename stem
- `--model <model>` - Whisper model (default: auto — picks best for your hardware)
- `--language <lang>` - Language code (default: auto-detect)
- `--device <device>` - `cuda` or `cpu` (default: auto-detect)
- `--stdout` - Print plain text to stdout only, no files written

### Model Selection

The script auto-selects the best model for your hardware when `--model` is not specified:

| Hardware | Auto-selected | Speed | Quality |
|----------|---------------|-------|---------|
| GPU >= 8 GB VRAM | `turbo` | Fast | Great |
| GPU < 8 GB VRAM | `small` | Medium | Good |
| CPU only | `base` | Fast (for CPU) | Fair |

Override with `--model`:

| Model | VRAM / RAM | Speed | Quality | Best for |
|-------|-----------|-------|---------|----------|
| `tiny` | ~1 GB | Fastest | Low | Quick drafts, testing |
| `base` | ~1 GB | Fast | Fair | CPU transcription |
| `small` | ~2 GB | Medium | Good | Low-VRAM GPUs |
| `medium` | ~5 GB | Slow | Better | Balanced quality |
| `turbo` | ~6 GB | Fast | Great | Best speed/quality |
| `large-v3` | ~10 GB | Slower | Best | Maximum accuracy |

## Output Formats

### .txt — Clean text
Plain transcription text with punctuation and capitalization.

### .srt — SRT subtitles
```
1
00:00:00,000 --> 00:00:04,500
Welcome to the interview today.

2
00:00:04,500 --> 00:00:08,200
Thank you for having me.
```

### .json — Timestamped segments
```json
{
  "text": "Full transcription text...",
  "language": "en",
  "duration_seconds": 1234.5,
  "segments": [
    { "start": 0.0, "end": 4.5, "text": "Welcome to the interview today." },
    { "start": 4.5, "end": 8.2, "text": "Thank you for having me." }
  ],
  "model": "turbo",
  "device": "cuda",
  "source_file": "interview.mp4"
}
```

## Supported Input

mp3, mp4, m4a, wav, ogg, flac, webm, mpeg, mpga, avi, mkv, mov

No file size limit — runs locally.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `ModuleNotFoundError: No module named 'whisper'` | `pip install openai-whisper` |
| `FileNotFoundError: ffmpeg` | Install ffmpeg (see Setup step 2) |
| `torch.cuda.OutOfMemoryError` | Use a smaller model: `--model small` or `--model base` |
| Very slow transcription | You're on CPU — normal. Use `--model tiny` or `base` for speed |
| `RuntimeError: CUDA out of memory` | Close other GPU apps, or use `--device cpu` |
| Wrong language detected | Specify with `--language en` (or appropriate code) |

## When to Use

- Transcribing interviews, meetings, podcasts, lectures
- Generating subtitles for video content
- Extracting searchable text from audio/video
- Batch transcription of large media files
- Any speech-to-text task with timestamped output
