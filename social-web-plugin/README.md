# social-web

Polite, read-only, logged-out look at public social media pages: YouTube, TikTok,
Instagram, X, Spotify, SoundCloud, Bandcamp and Suno.

- `scripts/socialweb`: the CLI (`profile`, `posts`, `post`, `check`, `platforms`; `--json`).
  Python 3 stdlib only; uses `yt-dlp` for YouTube details if installed.
- `scripts/shared-browser-preflight`: local existence checks before the optional
  shared-browser mode (headed Chrome via web-tools >= 1.3.2 with the dedicated profile
  `--data-dir ~/.cache/browser-tools-shared`, or a lane's own dir with `--lane`; the
  user signs in to their own accounts; never override HOME). `--wayland` in the start
  command is Linux-only; the preflight adds it only when native Wayland is ready.
- `scripts/_lib/host.py`: the one host-fact helper, `host_get(key[, default])`
  (`pria-fleet host get KEY`; per-OS defaults when pria-fleet, the `host` command or
  the key is missing; never writes the profile).
- `skills/social-web/SKILL.md`: recipes, per-platform table, rules (incl. guard
  refusals), shared-browser known behaviour (own-tab reads, signed-in selectors,
  Google sign-in limits), learnings.
- `tests/`: offline unit tests with small fixtures: `bash tests/run.sh`.

Exit codes: 0 ok, 1 error, 2 usage, 3 needs login (incl. bot checks), 4 not found,
5 rate limited. Cache: `~/.cache/socialweb` (TTL 1 h). At least 2 s between requests
to the same host. No cookies, logins, proxies or captcha solving.

## Lane dir (`--lane`) and the old `/var/tmp/social` path

`shared-browser-preflight --lane` uses `<scratch.dir>/social-web/chrome-shared`.
`scratch.dir` comes from the host profile (`pria-fleet host get scratch.dir`); when it
is unset, or pria-fleet is missing or too old to know `host`, the default is
`~/.cache/pria/scratch` on Linux and `~/Library/Caches/Pria/scratch` on macOS.

Upgrading from 0.1.2: lanes used `/var/tmp/social/chrome-shared`. If that dir exists
and `scratch.dir` is unset, `--lane` keeps using it, so the shared sign-ins saved
there are still found. Once `scratch.dir` is set, `--lane` moves to the new dir
(sign in again there; the old dir is left alone, so remove it yourself when done).
