---
name: youtube
description: YouTube toolkit — fetch transcripts, download videos/audio, extract metadata, list formats, and get subtitles. Uses youtube-transcript-plus for transcripts and yt-dlp for everything else.
---

# YouTube

YouTube toolkit with two backends:
- **transcript.js** — fast transcript fetching (no download needed)
- **yt-dlp** — download, metadata, formats, subtitles, audio extraction

## Setup

### Transcript

```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts/youtube
npm install
```

### yt-dlp

Install via pip or package manager:

```bash
pip install -U yt-dlp        # or: brew install yt-dlp / sudo apt install yt-dlp
```

Verify: `yt-dlp --version`

## Transcripts

**Try transcript.js first** (fast, no download). If it fails, **fall back to download + whisper**.

### Step 1: Try fast transcript

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/youtube/transcript.js <video-id-or-url>
```

Accepts video ID or full URL. Returns timestamped transcript:

```
[0:00] All right. So, I got this UniFi Theta
[0:15] I took the camera out, painted it
[1:23] And here's the final result
```

- Works with auto-generated and manual captions
- No download needed — fetches directly from YouTube API

### Step 2: If transcript unavailable — download + transcribe

Some videos have captions disabled, are age-restricted, or are live streams. When `transcript.js` fails:

```bash
# Download audio only (fast, small file)
yt-dlp -x --audio-format mp3 -o "/tmp/%(id)s.%(ext)s" "URL"

# Transcribe with Whisper (uses transcribe skill)
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py /tmp/<video-id>.mp3 --stdout
```

Or with full output files (txt + srt + json):

```bash
yt-dlp -x --audio-format mp3 -o "/tmp/%(id)s.%(ext)s" "URL"
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py /tmp/<video-id>.mp3
```

**When to use which:**

| Situation | Method |
|-----------|--------|
| Video has captions (most videos) | `transcript.js` — instant, no download |
| Captions disabled / unavailable | Download audio → `transcribe` skill |
| Need SRT subtitles or JSON timestamps | Download audio → `transcribe` skill with `--format srt,json` |
| Age-restricted / private video | `yt-dlp --cookies-from-browser chrome -x` → `transcribe` skill |
| Non-English video, want English text | Download audio → `transcribe` skill with `--language <code>` |

## Video Info / Metadata

```bash
yt-dlp --dump-json --no-download "URL"
```

Returns full JSON: title, description, duration, view count, upload date, channel, tags, chapters, thumbnails, formats, etc.

**Compact summary:**

```bash
yt-dlp --print "%(title)s | %(channel)s | %(duration_string)s | %(view_count)s views | %(upload_date)s" "URL"
```

## List Available Formats

```bash
yt-dlp -F "URL"
```

Shows all available video+audio formats with resolution, codec, filesize.

## Download Video

```bash
# Best quality (default)
yt-dlp -o "%(title)s.%(ext)s" "URL"

# Specific resolution
yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" -o "%(title)s.%(ext)s" "URL"

# MP4 only
yt-dlp --merge-output-format mp4 -o "%(title)s.%(ext)s" "URL"
```

## Download Audio Only

```bash
# Best audio → extract to mp3
yt-dlp -x --audio-format mp3 -o "%(title)s.%(ext)s" "URL"

# Best audio → extract to m4a (no re-encode)
yt-dlp -x --audio-format m4a -o "%(title)s.%(ext)s" "URL"

# Best audio → keep original format
yt-dlp -x -o "%(title)s.%(ext)s" "URL"
```

## Download Subtitles

```bash
# Download auto-generated subtitles
yt-dlp --write-auto-sub --sub-lang en --skip-download -o "%(title)s" "URL"

# Download manual subtitles (if available)
yt-dlp --write-sub --sub-lang en --skip-download -o "%(title)s" "URL"

# Convert subtitles to SRT
yt-dlp --write-auto-sub --sub-lang en --convert-subs srt --skip-download -o "%(title)s" "URL"

# List available subtitle languages
yt-dlp --list-subs "URL"
```

## Download Playlist

```bash
# Download entire playlist
yt-dlp -o "%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s" "PLAYLIST_URL"

# Download specific range
yt-dlp --playlist-start 1 --playlist-end 5 -o "%(title)s.%(ext)s" "PLAYLIST_URL"

# Audio-only playlist
yt-dlp -x --audio-format mp3 -o "%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s" "PLAYLIST_URL"
```

## Download Thumbnail

```bash
yt-dlp --write-thumbnail --skip-download -o "%(title)s" "URL"
```

## Chapters

```bash
# List chapters
yt-dlp --dump-json --no-download "URL" | jq '.chapters[]? | "\(.start_time) - \(.end_time): \(.title)"'

# Split video by chapters
yt-dlp --split-chapters -o "chapter:%(section_title)s.%(ext)s" "URL"
```

## Common Flags

| Flag | Description |
|------|-------------|
| `-o TEMPLATE` | Output filename template |
| `-f FORMAT` | Format selection |
| `-F` | List formats |
| `--no-download` | Don't download (use with `--dump-json`, `--write-thumbnail`, etc.) |
| `--skip-download` | Same as `--no-download` |
| `-x` | Extract audio |
| `--audio-format FMT` | Audio format: mp3, m4a, wav, opus, flac |
| `--merge-output-format` | Container: mp4, mkv, webm |
| `--write-auto-sub` | Download auto-generated subtitles |
| `--write-sub` | Download manual subtitles |
| `--sub-lang LANG` | Subtitle language (e.g., `en`, `es`, `en,es`) |
| `--write-thumbnail` | Save thumbnail |
| `--embed-thumbnail` | Embed thumbnail in file |
| `--embed-subs` | Embed subtitles in video |
| `--restrict-filenames` | Safe filenames (no spaces/special chars) |
| `--cookies-from-browser BROWSER` | Use browser cookies for age-restricted/private videos |
| `-q` | Quiet mode |
| `--print TEMPLATE` | Print metadata fields without downloading |

## Output Templates

Common fields for `-o` and `--print`:

| Field | Example |
|-------|---------|
| `%(title)s` | Video title |
| `%(id)s` | Video ID |
| `%(ext)s` | File extension |
| `%(channel)s` | Channel name |
| `%(upload_date)s` | Upload date (YYYYMMDD) |
| `%(duration_string)s` | Duration (H:MM:SS) |
| `%(view_count)d` | View count |
| `%(playlist_title)s` | Playlist name |
| `%(playlist_index)03d` | Playlist position (zero-padded) |

## When to Use What

| Task | Tool |
|------|------|
| Get transcript (captions available) | `transcript.js` — fast, no download |
| Get transcript (captions unavailable) | `yt-dlp -x` → `transcribe` skill |
| Get video metadata | `yt-dlp --dump-json --no-download` |
| Download video | `yt-dlp` |
| Download audio for offline transcription | `yt-dlp -x --audio-format mp3` |
| Get subtitles as SRT/VTT file | `yt-dlp --write-auto-sub --skip-download` |
| Generate SRT from audio (no captions) | `yt-dlp -x` → `transcribe` skill with `--format srt` |
| Check available quality | `yt-dlp -F` |
