# youtube — Transcripts, downloads, metadata

Two backends:
- **`transcript.js`** — instant transcript fetch via youtube-transcript-plus (no download)
- **`yt-dlp`** — everything else: download, metadata, formats, subtitles, audio extraction

Always try `transcript.js` first. On `no_transcript`, escalate to `yt-dlp -x` →
`transcribe` skill.

## Setup

### transcript.js
```bash
cd "${CLAUDE_PLUGIN_ROOT}/scripts/youtube"
npm install
```

### yt-dlp
```bash
pip install -U yt-dlp        # or: brew install yt-dlp / sudo apt install yt-dlp
yt-dlp --version
```

## Transcripts (preferred path)

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/youtube/transcript.js EBw7gsDPAYQ
${CLAUDE_PLUGIN_ROOT}/scripts/youtube/transcript.js https://www.youtube.com/watch?v=EBw7gsDPAYQ
```

Output:
```
[0:00] All right. So, I got this UniFi camera
[0:15] I took it out of the box
[1:23] And here's the final result
```

Works with auto-generated and manual captions. Exits **2** with `err_class=no_transcript`
when captions are unavailable — script automatically prints the audio-download
escalation command.

## Escalation: download audio + transcribe

When `transcript.js` returns `no_transcript`:

```bash
yt-dlp -x --audio-format mp3 -o "/tmp/%(id)s.%(ext)s" "URL"
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py /tmp/<id>.mp3 --stdout
```

For full output (txt + srt + json):
```bash
python3 ${CLAUDE_PLUGIN_ROOT}/scripts/transcribe/transcribe.py /tmp/<id>.mp3
```

| Situation                         | Method                                                |
|-----------------------------------|-------------------------------------------------------|
| Captions available                | `transcript.js` — instant                             |
| Captions disabled / unavailable   | `yt-dlp -x` → `transcribe.py`                         |
| Need SRT/JSON timestamps          | `yt-dlp -x` → `transcribe.py --format srt,json`       |
| Age-restricted / private          | `yt-dlp --cookies-from-browser chrome -x` → transcribe |
| Non-English video, want English   | `yt-dlp -x` → `transcribe.py --language <code>`       |

## Metadata

```bash
yt-dlp --dump-json --no-download "URL"                                   # full JSON
yt-dlp --print "%(title)s | %(channel)s | %(duration_string)s | %(view_count)s views" "URL"
yt-dlp -F "URL"                                                          # list formats
```

## Download

```bash
# Best quality (default)
yt-dlp -o "%(title)s.%(ext)s" "URL"

# Specific resolution
yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" -o "%(title)s.%(ext)s" "URL"

# MP4 only
yt-dlp --merge-output-format mp4 -o "%(title)s.%(ext)s" "URL"

# Audio only → mp3
yt-dlp -x --audio-format mp3 -o "%(title)s.%(ext)s" "URL"

# Subtitles only
yt-dlp --write-auto-sub --sub-lang en --convert-subs srt --skip-download -o "%(title)s" "URL"

# Playlist
yt-dlp -o "%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s" "PLAYLIST_URL"
```

## Self-healing notes

- **PRE**: `transcript.js` recalls `op-youtube-transcript` notes.
- **POST**:
  - `no_transcript` (exit 2) — expected on caption-disabled videos. Don't
    commit a `kind-fix`; it's the normal flow → escalate to whisper.
  - `age_gate` — escalate with `yt-dlp --cookies-from-browser chrome`.
  - `rate_limit` — wait or rotate IP; consider committing the rate-limit window
    if it's a recurring host pattern.

## Common flags

| Flag                            | Purpose                              |
|---------------------------------|--------------------------------------|
| `-o TEMPLATE`                   | Output filename template             |
| `-f FORMAT`                     | Format selection                     |
| `-F`                            | List formats                         |
| `--no-download` / `--skip-download` | Just metadata / subs / thumbs    |
| `-x`                            | Extract audio                        |
| `--audio-format FMT`            | mp3, m4a, wav, opus, flac            |
| `--merge-output-format`         | mp4, mkv, webm                       |
| `--write-auto-sub`              | Auto-generated subs                  |
| `--write-sub`                   | Manual subs                          |
| `--sub-lang LANG`               | Subtitle language                    |
| `--write-thumbnail`             | Save thumbnail                       |
| `--cookies-from-browser BROWSER`| Use browser cookies (age-restricted) |
| `--print TEMPLATE`              | Metadata fields without download     |
