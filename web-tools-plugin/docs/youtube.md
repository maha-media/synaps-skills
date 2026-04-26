# youtube — Transcripts, downloads, metadata

Single binary backend: **`yt-dlp`**. The `transcript.js` script wraps it for
caption-only fetches; for everything else (download, metadata, formats, audio
extraction) call `yt-dlp` directly.

> **Why no JS library?** Third-party transcript libs
> (`youtube-transcript`, `youtube-transcript-plus`) have been broken since
> late-2025 — every video returns `TRANSCRIPT_UNAVAILABLE`. yt-dlp is the
> only reliable path. See
> `~/.synaps-cli/memory/web/notes/youtube-transcripts-via-yt-dlp-*.md`.

## Setup

```bash
# yt-dlp itself
pip install -U yt-dlp        # or: brew install yt-dlp / sudo apt install yt-dlp
yt-dlp --version

# Linux only: lets yt-dlp decrypt Chrome's GNOME-keyring-encrypted cookies
sudo apt install python3-secretstorage

# Node ≥ 18 is required by transcript.js (no other runtime deps).
```

## Transcripts (preferred path)

```bash
${CLAUDE_PLUGIN_ROOT}/scripts/youtube/transcript.js xh2v5oC5Lx4
${CLAUDE_PLUGIN_ROOT}/scripts/youtube/transcript.js https://www.youtube.com/watch?v=xh2v5oC5Lx4
```

Output:
```
[0:00] (audience applauding)
[0:06] - All right.
[0:07] I'm so excited to be here with you, Ray.
…
```

### Flags

| Flag                            | Default      | Purpose                                       |
|---------------------------------|--------------|-----------------------------------------------|
| `--no-cookies`                  | off          | Skip the browser cookie jar (only public, fully unrestricted videos) |
| `--cookies-from-browser=NAME`   | `chrome`     | Override browser source (`firefox`, `brave`, `edge`…) |
| `--lang=CODE`                   | `en`         | Subtitle language                              |

### Exit codes & err_class

| Exit | err_class        | Meaning                                       | Recovery                                         |
|------|------------------|-----------------------------------------------|--------------------------------------------------|
| 0    | —                | Success                                       | —                                                |
| 1    | —                | Usage error / bad video ID                    | Fix args                                         |
| 2    | `no_transcript`  | No captions for this video                    | Fall back to whisper (see below)                 |
| 2    | `bot_detected`   | YouTube blocked anonymous request             | Drop `--no-cookies`, ensure browser logged in    |
| 2    | `age_gate`       | Age-restricted, needs login                   | `--cookies-from-browser=chrome` w/ login         |
| 2    | `cookie_decrypt` | Chrome cookies couldn't be read (Linux)       | `sudo apt install python3-secretstorage`         |
| 2    | `nsig_failed`    | n-sig challenge solver failed                 | `pip install -U yt-dlp`                          |
| 2    | `http_403/404`   | Private / unavailable                         | Verify URL / access                              |
| 2    | `rate_limit`     | YouTube 429                                   | Wait or rotate IP                                |
| 3    | `no_yt_dlp`      | yt-dlp not on PATH                            | Install (see Setup)                              |

## Escalation: download audio + transcribe

When transcripts are unavailable (`no_transcript`):

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
| Age-restricted / private          | `transcript.js URL --cookies-from-browser=chrome` (logged in) |
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

# Subtitles only (manual + auto, English)
yt-dlp --write-auto-sub --sub-lang en --convert-subs srt --skip-download -o "%(title)s" "URL"

# Playlist
yt-dlp -o "%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s" "PLAYLIST_URL"
```

## Self-healing notes

- **PRE**: `transcript.js` recalls `op-youtube-transcript` notes from `~/.synaps-cli/memory/web/`.
- **POST**:
  - `no_transcript` (exit 2) — expected on caption-disabled videos. Don't
    commit a `kind-fix`; it's the normal flow → escalate to whisper.
  - `bot_detected` — first time per host: try `--cookies-from-browser=chrome`.
    Recurring → check Chrome is logged in; consider `firefox`.
  - `age_gate` — same recovery as `bot_detected`. Cookies must come from
    a logged-in profile.
  - `cookie_decrypt` (Linux) → install `python3-secretstorage`.
  - `nsig_failed` → `pip install -U yt-dlp`. If recurring, file an upstream issue.
  - `rate_limit` → wait or rotate IP; if it's a recurring host pattern
    consider committing the rate-limit window as a `kind-fix`.

## Common yt-dlp flags

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
