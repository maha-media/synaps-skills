---
name: social-web
description: Use to look at public social media profiles and posts (YouTube, TikTok, Instagram, X, Spotify, SoundCloud, Bandcamp, Suno), read-only and logged out. Gets profile facts, recent posts with public counts, single items via oEmbed/page metadata, and says honestly when something needs login. Also covers the shared-browser mode where the user signs in to their own accounts and the agent only reads.
---

# social-web: read-only, logged-out social media

One CLI, `socialweb` (Python 3 stdlib; uses yt-dlp for YouTube details if installed).
It reads official logged-out routes only: oEmbed, RSS, OpenGraph/JSON-LD and the
data a public page already ships. It never signs in, keeps no cookies, solves no
captchas and rotates no proxies.

```bash
SW=${CLAUDE_PLUGIN_ROOT}/scripts/socialweb
$SW platforms                                  # what works per platform (no network)
$SW check   <url>                              # what is reachable logged-out, what needs login
$SW profile <platform> <handle|url>            # name, bio, links, follower/sub counts, post count
$SW posts   <platform> <handle|url> [--limit N]   # recent items: date, title, url, public counts
$SW post    <url>                              # one item (oEmbed / page metadata)
```

Platforms: `youtube` (yt), `tiktok` (tt), `instagram` (ig), `x` (twitter), `spotify`,
`soundcloud` (sc), `bandcamp` (bc), `suno`. Add `--json` for machine output,
`--no-cache` to skip the cache, `--ttl SECONDS` to change it.

## Recipes

- **Unknown page**: run `check <url>` first. It runs profile + posts (or post) and
  prints one row per capability: `ok`, `needs login`, `not found`, `error`.
- **Profile**: `profile suno examplehandle`, `profile youtube @YouTube`,
  `profile spotify 4Z8W4fKeB5YxbusRsdQVPb` (Spotify has no handles: use artist id or url),
  `profile bandcamp c418` (custom domains: pass the full url).
- **Recent posts**: `posts youtube @YouTube --limit 5`. YouTube uses the channel RSS
  feed (max 15, exact dates and view/like counts). Over 15 needs yt-dlp (no dates).
- **One item**: `post https://youtu.be/ID`, `post https://x.com/user/status/ID`,
  `post https://suno.com/song/ID`, `post https://artist.bandcamp.com/album/slug`.
- **Machines**: `--json` gives `{platform, url, name, bio, counts, items[], needs_login[], source[]}`.
  Counts are as shown on the page: Instagram/YouTube give rounded strings ("46.5M").
- Partial results are normal: the output lists `needs login: <platform> <what>` rows
  for what is missing, and the command still exits 0.

### Exit codes

| code | meaning | what you do |
|---|---|---|
| 0 | ok (maybe partial; read the `needs login` rows) | use the data |
| 1 | error: network failure after 3 retries, HTTP 5xx, page not parseable | retry later once, or fall back (below) |
| 2 | usage: bad args, unknown platform, not a url | fix the command |
| 3 | **needs login**: login wall, HTTP 401/403, bot check / JS challenge | report it honestly; see "When the CLI can't" |
| 4 | not found (404/410, unknown account or item) | report; a 404 is not proof a handle is free |
| 5 | rate limited (HTTP 429) | stop; try much later. Never speed up |

On exit 3 the CLI prints `needs login: <platform> <what> (<detail>)` and a
`next:` line pointing to the shared-browser mode below.

## What works logged-out (live smoke, 2026-10-25)

| platform | profile | posts | post | live smoke |
|---|---|---|---|---|
| YouTube | yes: name, bio, subscribers, video count (channel page) | yes: RSS feed, 15 newest, dates + views + likes | yes: oEmbed; yt-dlp -J adds date/views/likes | `@YouTube`: profile ok, posts ok |
| TikTok | yes: name, bio, link, followers, likes, video count (when served) | **needs login** (grid comes from a signed in-page API) | oEmbed (may be a stub) + page counts if served | `@tiktok`: profile ok, posts needs login |
| Instagram | partial: name, rounded followers/following/posts (if served) | **needs login** | partial: OpenGraph likes/comments/caption (if served) | `instagram`: profile ok, posts needs login |
| X | partial: name, bio; counts need login | **needs login** | yes: publish oEmbed text, author, date; counts need login | `X`: name+bio ok; posts needs login; oEmbed post ok |
| Spotify | yes: artist name, bio, followers, monthly listeners, links | yes: releases (albums/singles, year) | yes: oEmbed + OpenGraph | Radiohead: profile ok, posts ok |
| SoundCloud | yes: name, bio, location, followers, tracks | yes: tracks page list (date, genre) | yes: plays, likes, comments, reposts | `flume`: profile ok, posts ok |
| Bandcamp | yes: name, location, bio, links | yes: releases (page order, no dates) | yes: JSON-LD date, tracks, tags | `c418`: profile ok, posts ok; the 4th page load on that host in ~15 min got a **bot check** (exit 3) |
| Suno | yes: name, genres, followers, songs, plays, likes | yes: first ~20 songs with plays/likes | yes: song data (date, tags, duration) | `@examplehandle`: profile ok, posts ok, song ok |

Sites change often; trust `check` over this table and update the Learnings below.

## Rules (always)

1. **Read-only.** No likes, follows, reposts, comments, DMs, posts, uploads, form
   submits, settings changes, sign-ups or mass actions. None, unless the user says
   yes to that exact item.
2. **Logged out by default.** No sign-in and no logged-in browser profile unless the
   user explicitly says yes (then only the shared-browser mode below). Never pass
   `browser-start.js --profile`, never copy, read, export or save cookies, tokens,
   localStorage or sign-in data (`browser-cookies.js` is off-limits).
3. **Follow each site's terms**; take only the public fields you need. Don't dump
   raw pages (they contain sign-in URLs, continuation tokens, unrelated names) into
   chat or commits.
4. **Polite rates.** The CLI keeps >= 2 s between requests to one host (across runs),
   caches responses 1 h in `~/.cache/socialweb`, 15 s timeouts, <= 3 retries and only
   on network errors. Don't loop it over many accounts; don't clear the cache to
   re-hit a site; one or two requests per page per task is the norm.
5. **Report "needs login" honestly.** Never work around a login wall, bot check,
   captcha or rate limit (no other UAs, no proxies, no "embed"/mobile/private API
   tricks). Say what was missing and why. A visible login button is not a wall
   when the public content is readable; a page that demands login is: stop that
   read and report the site and URL.
6. **Guard refusals.** If a tool guard or policy hook refuses a command, it did not
   run: that is not a violation, and not a puzzle to route around. Don't reshape the
   same action to slip past the guard. Stop, tell your parent/user what was refused
   and why you wanted it, and resume only on their OK with a compliant method (e.g.
   a script written with the write tool and run in a separate call, instead of a
   long inline program).

## When the CLI can't get something

1. Exit 3/1 on a **public page**: try the web skill (`load_skill web`) logged-out:
   `fetch.js <url>` (or `--raw` and pick fields), or its browser for JS-only pages.
   The web skill's default profile `~/.cache/browser-tools` persists between
   sessions, so it's not guaranteed logged-out. For a logged-out browser, start it
   with a throwaway dir in your scratch: `browser-start.js --data-dir <scratch>/browser-logged-out
   --port=<free port>` (web-tools >= 1.3.2). Never use `~/.cache/browser-tools-shared`
   for this. Ignore `docs/browser.md`'s advice to switch to `--profile` on captchas.
2. Still blocked, or the data is behind login: **ask the user**. Offer: (a) skip it,
   (b) the user pastes/reads it themselves, (c) shared-browser mode.
3. Never guess counts. "Not shown logged-out" is a valid answer.

## Shared browser mode (the user signs in themselves, agent only reads)

Use only when the user asks for it or says yes when you offer it after a `needs login`.
The CLI stays logged-out; this mode uses the **web skill's** browser tools (see
`~/.synaps-cli/plugins/web-tools/skills/web/SKILL.md` and its `docs/browser.md`
for setup and commands; don't copy them here).

**Dedicated profile:** default `~/.cache/browser-tools-shared` (mode 0700). A lane may
instead use its own 0700 scratch dir: pass `--lane` to the preflight for
`<scratch.dir>/social-web/chrome-shared` (the preflight resolves it: `scratch.dir` from
`pria-fleet host get scratch.dir`, else the OS default; an existing old
`/var/tmp/social/chrome-shared` is kept while `scratch.dir` is unset), or any dir with
`--data-dir`, and a non-default `--port`: one browser runs per
port. Either way it holds the user's own sign-ins for that shared session only.
Never point other agent work at it, and never use the web skill's default
`~/.cache/browser-tools` for this mode (any agent that later starts the web browser
would inherit those sign-ins). Pass the same `--data-dir` (or `--lane`) and `--port` to the preflight.

1. **Preflight**: `${CLAUDE_PLUGIN_ROOT}/scripts/shared-browser-preflight [--data-dir DIR | --lane] [--port N]` (exit 0 ready,
   1 ask the user, 2 can't run). It only checks that things exist (stat); it never
   reads profile files or the X authority file. It checks:
   - web-tools' `browser-start.js` supports `--data-dir` (web-tools >= 1.3.2);
   - HOME is not overridden;
   - display (**Linux only**; on macOS Chrome opens a normal window), **native Wayland first**: if `WAYLAND_DISPLAY` is set and
     `$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY` exists, it's ready as a Wayland window (a
     Wayland client can't read or inject into other windows). Only without Wayland
     does it fall back to X11: `DISPLAY` set and the `$XAUTHORITY` file (else
     `~/.Xauthority`) exists;
   - nothing already answers on the CDP port (one browser per port). An existing
     browser may carry another profile, even a copy of the user's real Chrome:
     don't attach to it unless the user confirms it is the shared window;
   - the dedicated dir, if present, is a plain directory with mode 0700.
2. **Start headed, dedicated**: run the command the preflight prints, i.e.
   `browser-start.js --data-dir ~/.cache/browser-tools-shared [--wayland] --port=9222`
   (`--wayland` is **Linux-only**: `--ozone-platform=wayland`, no DISPLAY/XAUTHORITY for Chrome; it's
   also the default with `--data-dir` when `WAYLAND_DISPLAY` is set; the preflight adds it only
   when native Wayland is ready, never on macOS). With the lane dir (`--lane`):
   `--data-dir <scratch.dir>/social-web/chrome-shared [--wayland] --port=9340`. On the
   Linux `--data-dir`/`--wayland` path the launcher also sets `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus`
   when it's unset and that socket exists (the user's own bus; this quiets Chrome's dbus errors).
   Never add `--profile` (copies real cookies/logins; the launcher refuses it with
   `--data-dir`) or `--headless` (the user must see and share the window).
   **Never override HOME** (e.g. a scratch `HOME=`). Social's workers tried that and
   X refused the window on `:0`, because there was no XAUTHORITY under the scratch
   HOME. `--data-dir` makes a HOME override unnecessary.
   **Never set XAUTHORITY to the compositor's cookie** (e.g.
   `$XDG_RUNTIME_DIR/.mutter-Xwaylandauth.*`; unset runtime dir: `/run/user/$(id -u)`) **or borrow another session's X auth.**
   X access to the user's screen allows reading other apps and injecting input,
   and only the user can approve that access change. No Wayland and no own X auth:
   ask the user to start the shared browser from their desktop session.
   Optional (Linux with systemd): cap its memory with `systemd-run --user --scope -p MemoryHigh=2560M
   -p MemoryMax=3G <launch command>` (idle with 4-5 tabs is ~0.6 GB). Keep CDP on
   `127.0.0.1`.
3. **Work in your own tab.** `browser-nav.js`/`browser-eval.js` act on the *last*
   tab in the context, which can be one of the user's. When the user has tabs open
   (or the browser was handed to you already running), connect with the web skill's
   Playwright over CDP and use your own page: `context.newPage()` -> `goto(url)` ->
   bounded wait -> read DOM -> `page.close()` in `finally`; then disconnect the
   client without closing the browser. One tab at a time, ~2 s apart. Before reading,
   check the final URL: if it landed on mail, accounts, messages/direct/chat,
   notifications, compose/post, upload, edit, settings or analytics, close the tab
   and don't read.
   **Open the page**: `browser-nav.js <url>` (only when it's your own tab). If it needs login, tell the user:
   "Please sign in to <site> in the shared Chrome window, then tell me when you're done."
   The user signs in themselves. You never type credentials, 2FA codes or recovery
   answers, never click "sign in with…", and never read, export or save cookies,
   tokens or sign-in data.
4. **After the user says they're signed in**, you may read logged-in pages: `browser-nav.js`,
   `browser-content.js`, `browser-screenshot.js`, and `browser-eval.js` with read-only
   DOM queries (text, links, counts) and `window.scrollBy`/`scrollTo` only (pausing or
   muting autoplaying `video,audio` in your own tab is fine). Navigation clicks
   (open a profile, a post, a tab, "show more") and scrolling are fine.
   **Not fine** unless the user says yes to that exact item: likes, follows,
   reposts, comments, DMs, posts, form submits, settings changes, purchases,
   accepting invites or terms. Never read `document.cookie`, `localStorage`,
   `sessionStorage`, or auth headers.
5. **Pace like a person**: a few pages, seconds apart; no bulk scraping of feeds,
   followers or search results. Stop on any captcha or "unusual activity" notice
   and tell the user.
6. **Finish: close the shared browser when the session ends** if you started it
   (close its window, or ask the user to). Don't leave it running on the port for
   later agents. If it was handed to you already running, close only your own tabs
   and leave the browser and the user's tabs alone. Tell
   the user what you read, and remind them their sign-ins stay in
   the shared profile dir (`~/.cache/browser-tools-shared` or the lane's `--data-dir`)
   until they sign out there. Don't clear the dir
   yourself without their yes.

### Shared browser: known behaviour

**Who is signed in** (read the href only; never read cookies):

| site | signed in | signed out |
|---|---|---|
| X | `a[data-testid="AppTabBar_Profile_Link"]` href = `/<handle>` | `/home` redirects to `/i/jf/onboarding/web?...mode=login` |
| TikTok | `a[data-e2e="nav-profile"]` href = `/@<handle>` | `[data-e2e="top-login-button"]`; a bare `/@` href |
| Instagram | home left-nav link with exact text "Profile", href `/<handle>/` | `input[name="username"]` |

**Google sign-in** is the user's click, always (step 3). FYI when they ask why:
TikTok's "Continue with Google" opens a normal popup (account chooser), then lands on
`/foryou`, which autoplays with sound: close that tab. X's button is an
`accounts.google.com/gsi/button` iframe over the visible span; automated clicks time
out and forced clicks open no popup, so only a real user click works. Never open
`mail.google.com` or Google account pages.

**Read-only pages that work signed in:**
- **X search** `https://x.com/search?q=QUERY&src=typed_query&f=top` (also
  `%22phrase%22`, `%23tag`): innerText has full posts with dates and
  reply/repost/like/view counts; `a[href*="/status/"]` gives post URLs (skip the
  `/analytics` and `/photo/` variants). Zero hits show "No results". Top mixes
  years: read each post's date. Never follow Notifications/Chat/Post.
- **TikTok tag** `https://www.tiktok.com/tag/TAG`: `document.body.innerText` gives
  creators + captions in grid order; `a[href*="/video/"]` gives post URLs (each twice:
  dedupe). No counts. Grid autoplays: pause/mute media every ~1.5 s. Tags collide
  with unrelated homonyms: read captions before inferring a scene. Never follow
  Messages/Activity/Upload.
- **Instagram tag** `/explore/tags/TAG/` redirects to `/explore/search/keyword/?q=%23TAG`;
  only `a[href^="/p/"]` (~7-15 links), no captions/counts/authors. Treat as "posts exist".
- **YouTube comments**: logged-out HTML has no comment bodies. On a `/watch?v=` URL
  (works for Shorts too), scroll, then `ytd-comment-thread-renderer #content-text`
  (bodies) and `ytd-comments-header-renderer` (count, includes replies). One loaded
  batch is a sample, not sentiment; no header loaded means unknown, not zero.

## Learnings (per platform)

Sources: own probing for this plugin and research workers' logged-out and
shared-browser reads (2026-10-25).

**General**
- HTTP 200 can be a login/consent/challenge shell; a 404 can mean renamed, hidden
  or reserved. Neither proves a handle is free.
- Sites often ship the data in the page: YouTube `ytInitialData`, TikTok
  `__UNIVERSAL_DATA_FOR_REHYDRATION__`, SoundCloud `window.__sc_hydration`, Spotify
  `<script id="initialState">` (base64 JSON), Suno Next.js `self.__next_f` rows.
  Parse it as JSON (never eval) and whitelist fields: the same blobs carry sign-in
  commands, tokens and (SoundCloud) a geoip block for the reader.
- The web skill's `browser-start.js` without `--profile` is not necessarily fresh:
  it reuses `~/.cache/browser-tools` and attaches to any browser already on the port.
  The worker's attempt to force a fresh one with a `HOME=` override found Chrome but
  never got a CDP connection. Cause: X refused the display authorization on `:0`
  (no XAUTHORITY under the scratch HOME); the launcher hides Chrome's stderr. Fix:
  web-tools 1.3.2 `--data-dir`, with no HOME override. A different port alone does
  not give a fresh profile.
- The web skill's `fetch.js` can exit 3 (`needs_render`) while still returning a
  full, coherent article: check title and body before calling it unavailable.
- Counts are observations at read time: RSS, watch page and cards can differ
  slightly (views, a second of duration). Say when and where you read them.

**YouTube**: channel page meta gives name/bio/channel id; header
`metadataRows[].metadataParts[].text.content` gives "46.5M subscribers" / "1.6K videos"
(take the first `"content":"… subscribers"`; other counts appear later on the page).
Best recent-upload source: `feeds/videos.xml?channel_id=UC…` (exact dates, integer
views/likes, newest 15 only; it occasionally 404/500s, then yt-dlp). Video lists in
HTML use `lockupViewModel` (shorts: `shortsLockupViewModel`), not `videoRenderer`.
Watch pages: `ytInitialPlayerResponse.videoDetails` gives `title`, `lengthSeconds`,
`viewCount`, `shortDescription` (parse the JSON; don't grep menus, which hold auth
links). Thumbnail: `i.ytimg.com/vi/ID/hqdefault.jpg` (may not be a Short's first frame).
yt-dlp: run with `--ignore-config` (user config may hold cookies), keep only
`--js-runtimes`/`--remote-components`; "Sign in to confirm you're not a bot" = needs login.

**TikTok**: `@tiktok` served full user + stats JSON logged-out, but the worker saw
empty JS shells for smaller accounts: treat a missing `webapp.user-detail` as needs
login, not "no account". The video grid is never in the HTML. oEmbed for an old
video returned only a stub (no title/author): flag it, don't invent.

**Instagram**: the profile `og:description` reads "686M Followers, 158 Following,
8,624 Posts - See Instagram photos and videos from Name (@handle)"; rounded counts
only. The worker often got image/blank shells instead: then it's needs login.
Posts grid and reliable bio links need login. The official oEmbed needs a Meta app
token: not used.

**X**: logged-out profile HTML still has `og:title` "Name (@handle) on X" and the bio
in `og:description`; no counts, no timeline. `publish.twitter.com/oembed` works for
single public posts (text, author, date); it redirects to publish.x.com. Don't print
login links.

**Spotify**: artist page `initialState` has `profile` (name, bio HTML, external links),
`stats` (followers, monthlyListeners) and `discography` (albums/singles with year).
Artist ids are issued identifiers, not handles. Spotify for Artists, badges and
claims need the owner's account.

**SoundCloud**: profile hydration `user` has counts; `/<user>/tracks` has a
server-rendered `<article class="audible">` list (title, url, date, genre). The user
RSS feed (`feeds.soundcloud.com/users/soundcloud:users:ID/sounds.rss`) was empty for
a big artist, so don't rely on it. Some help articles redirect to sign-in: needs login.

**Bandcamp**: artist page has name/location/bio/links and a `music-grid` plus
`data-client-items` (more releases); release pages have JSON-LD (date, tracks, tags).
A custom-domain artist (`sufjanstevens.bandcamp.com` → `music.sufjan.com`) gave a
redirect loop without cookies: use the final domain url. On the 4th page load on
one artist host in ~15 minutes, Bandcamp served a JS "Client Challenge" (Fastly): the CLI reports it as
needs login, never caches or solves it. Wait a long time before trying again.
Unknown handles may redirect to a signup landing page.

**Suno**: profile page ships `v2Data` (display name, handle, genres, stats:
followers, clips, plays, upvotes) and the first ~20 songs (`entity_type: song_schema`,
title, created_at, play/upvote/comment counts). Flight rows can be glued to text
chunks without a newline, so decode with `raw_decode` at each `id:` marker. On the
rendered page, the 121 (play icon) and 14 (thumbs-up) next to the name are plays and
likes, not followers. Report only the fields the task needs; don't list every title.
