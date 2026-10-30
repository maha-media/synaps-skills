# social-web

Polite, read-only, logged-out look at public social media pages: YouTube, TikTok,
Instagram, X, Spotify, SoundCloud, Bandcamp and Suno.

- `scripts/socialweb`: the CLI (`profile`, `posts`, `post`, `check`, `platforms`; `--json`).
  Python 3 stdlib only; uses `yt-dlp` for YouTube details if installed.
- `scripts/shared-browser-preflight`: local existence checks before the optional
  shared-browser mode (headed Chrome via web-tools >= 1.3.2 with the dedicated profile
  `--data-dir ~/.cache/browser-tools-shared`; the user signs in himself; never override HOME).
- `skills/social-web/SKILL.md`: recipes, per-platform table, rules (incl. guard
  refusals), shared-browser known behaviour (own-tab reads, signed-in selectors,
  Google sign-in limits), learnings.
- `tests/`: offline unit tests with small fixtures: `bash tests/run.sh`.

Exit codes: 0 ok, 1 error, 2 usage, 3 needs login (incl. bot checks), 4 not found,
5 rate limited. Cache: `~/.cache/socialweb` (TTL 1 h). At least 2 s between requests
to the same host. No cookies, logins, proxies or captcha solving.
