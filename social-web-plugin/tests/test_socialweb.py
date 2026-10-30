"""Offline unit tests for socialweb. No network: sockets are disabled for the whole run.

Run: cd social-web-plugin && python3 -m unittest discover -s tests -v   (or: bash tests/run.sh)
"""
import importlib.machinery
import importlib.util
import io
import json
import os
import socket
import subprocess
import sys
sys.dont_write_bytecode = True
import tempfile
import unittest
import urllib.error
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "fixtures")
SCRIPT = os.path.join(os.path.dirname(HERE), "scripts", "socialweb")

_loader = importlib.machinery.SourceFileLoader("socialweb", SCRIPT)
_spec = importlib.util.spec_from_loader("socialweb", _loader)
sw = importlib.util.module_from_spec(_spec)
_loader.exec_module(sw)

_real_connect = socket.socket.connect


def setUpModule():
    def no_network(*a, **k):
        raise AssertionError("tests must not touch the network")
    socket.socket.connect = no_network


def tearDownModule():
    socket.socket.connect = _real_connect


def fx(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


class FakeClock:
    def __init__(self, t=1_000_000.0):
        self.t = t
        self.sleeps = []

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(round(s, 6))
        self.t += s


class FakeResp:
    def __init__(self, url, body, status=200, ctype="text/html; charset=utf-8"):
        self._url, self._body, self.status = url, body.encode("utf-8"), status
        self.headers = {"Content-Type": ctype}

    def geturl(self):
        return self._url

    def read(self, n=-1):
        return self._body


class FakeOpener:
    """Maps exact URLs (or URL prefixes ending in '*') to fixture bodies or errors."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, req, timeout=None):
        url = req.full_url
        self.calls.append(req)
        spec = self.routes.get(url)
        if spec is None:
            for k, v in self.routes.items():
                if k.endswith("*") and url.startswith(k[:-1]):
                    spec = v
                    break
        if spec is None:
            raise AssertionError(f"unexpected request: {url}")
        if callable(spec):
            return spec(req)
        if isinstance(spec, int):
            raise urllib.error.HTTPError(url, spec, "err", {}, io.BytesIO(b""))
        if isinstance(spec, tuple):          # (final_url, body)
            return FakeResp(spec[0], spec[1])
        return FakeResp(url, spec)


def make_ctx(routes, runner=None, ytdlp_path=None):
    tmp = tempfile.mkdtemp(prefix="socialweb-test-")
    clock = FakeClock()
    cache = sw.Cache(tmp, ttl=3600, clock=clock)
    limiter = sw.Limiter(clock=clock, sleep=clock.sleep, state_path=os.path.join(tmp, "hosts.json"))
    opener = FakeOpener(routes)
    http = sw.Http(cache, limiter, opener=opener, sleep=clock.sleep)
    yt = sw.YtDlp(http, path=ytdlp_path, runner=runner or (lambda *a, **k: (_ for _ in ()).throw(AssertionError("no yt-dlp"))))
    if not ytdlp_path:
        yt.path = None
    ctx = sw.Ctx(http, yt)
    ctx.clock, ctx.opener, ctx.tmp = clock, opener, tmp
    return ctx


def q(u):
    return urllib.parse.quote(u, safe="")


def run_main(argv, ctx):
    out, err = io.StringIO(), io.StringIO()
    code = sw.main(argv, ctx=ctx, stdout=out, stderr=err)
    return code, out.getvalue(), err.getvalue()


# --------------------------------------------------------------------------- per-platform parsing

class YouTubeTests(unittest.TestCase):
    CH = "https://www.youtube.com/@YouTube"
    RSS = "https://www.youtube.com/feeds/videos.xml?channel_id=UCBR8-60-B28hp2BmDPdntcQ"

    def test_profile(self):
        ctx = make_ctx({self.CH: fx("youtube_channel.html")})
        r = sw.cmd_profile(ctx, "youtube", "@YouTube")
        self.assertEqual(r["name"], "YouTube")
        self.assertEqual(r["channel_id"], "UCBR8-60-B28hp2BmDPdntcQ")
        self.assertEqual(r["counts"], {"subscribers": "46.5M", "videos": "1.6K"})
        self.assertEqual(r["handle"], "YouTube")

    def test_posts_from_rss(self):
        ctx = make_ctx({self.CH: fx("youtube_channel.html"), self.RSS: fx("youtube_rss.xml")})
        r = sw.cmd_posts(ctx, "yt", "YouTube", 2)
        self.assertEqual(len(r["items"]), 2)
        it = r["items"][0]
        self.assertEqual(it["date"], "2026-10-25")
        self.assertTrue(it["url"].startswith("https://www.youtube.com/"))
        self.assertIn("views", it["counts"])
        self.assertIn("likes", it["counts"])

    def test_posts_channel_url_skips_page(self):
        ctx = make_ctx({self.RSS: fx("youtube_rss.xml")})
        r = sw.cmd_posts(ctx, "youtube", "https://www.youtube.com/channel/UCBR8-60-B28hp2BmDPdntcQ", 5)
        self.assertEqual(len(r["items"]), 3)
        self.assertEqual(len(ctx.opener.calls), 1)

    def test_post_oembed_plus_ytdlp(self):
        calls = []

        def runner(cmd, **kw):
            calls.append(cmd)
            return subprocess.CompletedProcess(cmd, 0, fx("youtube_ytdlp_video.json"), "")
        watch = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        ctx = make_ctx({"https://www.youtube.com/oembed?format=json&url=" + q(watch): fx("youtube_oembed.json")},
                       runner=runner, ytdlp_path="/fake/yt-dlp")
        r = sw.cmd_post(ctx, "https://youtu.be/jNQXAC9IVRw")
        self.assertEqual(r["title"], "Me at the zoo")
        self.assertEqual(r["author"], "jawed")
        self.assertEqual(r["date"], "2005-04-24")
        self.assertEqual(r["counts"]["views"], 380000000)
        cmd = calls[0]
        self.assertIn("--ignore-config", cmd)
        self.assertIn("--skip-download", cmd)
        self.assertFalse(any("cookie" in c for c in cmd))

    def test_post_ytdlp_needs_login_keeps_oembed(self):
        def runner(cmd, **kw):
            return subprocess.CompletedProcess(cmd, 1, "", "ERROR: [youtube] x: Sign in to confirm you're not a bot")
        watch = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        ctx = make_ctx({"https://www.youtube.com/oembed?format=json&url=" + q(watch): fx("youtube_oembed.json")},
                       runner=runner, ytdlp_path="/fake/yt-dlp")
        r = sw.cmd_post(ctx, watch)
        self.assertEqual(r["title"], "Me at the zoo")
        self.assertTrue(any("not a bot" in n for n in r["needs_login"]))


class TikTokTests(unittest.TestCase):
    def test_profile(self):
        ctx = make_ctx({"https://www.tiktok.com/@tiktok": fx("tiktok_profile.html")})
        r = sw.cmd_profile(ctx, "tiktok", "@tiktok")
        self.assertEqual(r["handle"], "tiktok")
        self.assertEqual(r["counts"]["followers"], 96400000)
        self.assertEqual(r["counts"]["videos"], 1513)
        self.assertTrue(r["needs_login"])

    def test_blocked_profile_needs_login(self):
        ctx = make_ctx({"https://www.tiktok.com/@tiktok": fx("tiktok_blocked.html")})
        with self.assertRaises(sw.NeedsLogin):
            sw.cmd_profile(ctx, "tiktok", "tiktok")

    def test_posts_needs_login(self):
        ctx = make_ctx({})
        code, out, err = run_main(["posts", "tiktok", "tiktok"], ctx)
        self.assertEqual(code, 3)
        self.assertIn("needs login: tiktok video list", err)
        self.assertEqual(ctx.opener.calls, [])

    def test_post(self):
        v = "https://www.tiktok.com/@scout2015/video/6718335390845095173"
        ctx = make_ctx({"https://www.tiktok.com/oembed?url=" + q(v): fx("tiktok_oembed.json"),
                        v: fx("tiktok_video.html")})
        r = sw.cmd_post(ctx, v)
        self.assertEqual(r["author"], "scout2015")
        self.assertEqual(r["counts"]["views"], 1200000)
        self.assertEqual(r["date"], "2019-07-24")

    def test_post_stub_oembed_is_flagged(self):
        v = "https://www.tiktok.com/@scout2015/video/6718335390845095173"
        ctx = make_ctx({"https://www.tiktok.com/oembed?url=" + q(v): fx("tiktok_oembed_stub.json"),
                        v: fx("tiktok_blocked.html")})
        r = sw.cmd_post(ctx, v)
        self.assertTrue(any("stub" in n for n in r["needs_login"]))


class InstagramTests(unittest.TestCase):
    URL = "https://www.instagram.com/instagram/"

    def test_profile(self):
        ctx = make_ctx({self.URL: fx("instagram_profile.html")})
        r = sw.cmd_profile(ctx, "ig", "instagram")
        self.assertEqual(r["name"], "Instagram")
        self.assertEqual(r["handle"], "instagram")
        self.assertEqual(r["counts"], {"followers": "686M", "following": "158", "posts": "8,624"})

    def test_login_wall_exit_3(self):
        ctx = make_ctx({self.URL: fx("instagram_login.html")})
        code, out, err = run_main(["profile", "instagram", "instagram"], ctx)
        self.assertEqual(code, 3)
        self.assertIn("needs login: instagram profile", err)

    def test_login_redirect_exit_3(self):
        ctx = make_ctx({self.URL: ("https://www.instagram.com/accounts/login/?next=%2Finstagram%2F",
                                   fx("instagram_login.html"))})
        code, out, err = run_main(["profile", "instagram", "instagram", "--json"], ctx)
        self.assertEqual(code, 3)
        j = json.loads(out)
        self.assertEqual(j["error"], "needs_login")
        self.assertEqual(j["platform"], "instagram")
        self.assertEqual(j["exit"], 3)

    def test_posts_needs_login(self):
        code, out, err = run_main(["posts", "instagram", "instagram"], make_ctx({}))
        self.assertEqual(code, 3)
        self.assertTrue(err.startswith("needs login: instagram post grid"))

    def test_post(self):
        u = "https://www.instagram.com/p/FIXTURE123/"
        r = sw.cmd_post(make_ctx({u: fx("instagram_post.html")}), u)
        self.assertEqual(r["author"], "instagram")
        self.assertEqual(r["date"], "2026-10-01")
        self.assertEqual(r["counts"], {"likes": "12K", "comments": "345"})
        self.assertEqual(r["title"], "Hello from the fixture")


class XTests(unittest.TestCase):
    def test_profile_partial(self):
        r = sw.cmd_profile(make_ctx({"https://x.com/X": fx("x_profile.html")}), "twitter", "@X")
        self.assertEqual(r["name"], "X")
        self.assertEqual(r["bio"], "what's happening?!")
        self.assertIn("follower/following counts", r["needs_login"])

    def test_empty_profile_needs_login(self):
        code, _, err = run_main(["profile", "x", "X"], make_ctx({"https://x.com/X": fx("x_empty.html")}))
        self.assertEqual(code, 3)
        self.assertIn("needs login: x profile", err)

    def test_posts_needs_login(self):
        code, _, err = run_main(["posts", "x", "X"], make_ctx({}))
        self.assertEqual(code, 3)

    def test_post_oembed(self):
        u = "https://twitter.com/Interior/status/507185938620219395"
        ctx = make_ctx({"https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=" + q(u): fx("x_oembed.json")})
        r = sw.cmd_post(ctx, u)
        self.assertEqual(r["author"], "U.S. Department of the Interior")
        self.assertEqual(r["date"], "2014-09-03")
        self.assertIn("Wilderness Act", r["title"])


class SpotifyTests(unittest.TestCase):
    ART = "https://open.spotify.com/artist/4Z8W4fKeB5YxbusRsdQVPb"

    def test_profile(self):
        r = sw.cmd_profile(make_ctx({self.ART: fx("spotify_artist.html")}), "spotify", "4Z8W4fKeB5YxbusRsdQVPb")
        self.assertEqual(r["name"], "Radiohead")
        self.assertIn("monthly_listeners", r["counts"])
        self.assertIn("followers", r["counts"])
        self.assertNotIn("<a", r["bio"])
        self.assertEqual(r["links"], ["https://en.wikipedia.org/wiki/Radiohead"])

    def test_posts_releases_sorted_dedup(self):
        r = sw.cmd_posts(make_ctx({self.ART: fx("spotify_artist.html")}), "spotify", self.ART, 10)
        dates = [i["date"] for i in r["items"]]
        self.assertEqual(dates, sorted(dates, reverse=True))
        urls = [i["url"] for i in r["items"]]
        self.assertEqual(len(urls), len(set(urls)))
        self.assertTrue(all(u.startswith("https://open.spotify.com/album/") for u in urls))

    def test_handle_rejected(self):
        with self.assertRaises(sw.UsageError):
            sw.profile_url("spotify", "radiohead")

    def test_post(self):
        u = "https://open.spotify.com/album/6dVIqQ8qmQ5GBnJ9shOYGE"
        ctx = make_ctx({"https://open.spotify.com/oembed?url=" + q(u): fx("spotify_oembed.json"),
                        u: fx("spotify_album.html")})
        r = sw.cmd_post(ctx, u)
        self.assertEqual(r["title"], "OK Computer")
        self.assertEqual(r["date"], "1997-05-21")


class SoundCloudTests(unittest.TestCase):
    def test_profile(self):
        r = sw.cmd_profile(make_ctx({"https://soundcloud.com/flume": fx("soundcloud_profile.html")}), "sc", "flume")
        self.assertEqual(r["name"], "Flume")
        self.assertEqual(r["counts"]["followers"], 2228673)
        self.assertEqual(r["location"], "Sydney, AU")

    def test_posts(self):
        ctx = make_ctx({"https://soundcloud.com/flume/tracks": fx("soundcloud_profile.html")})
        r = sw.cmd_posts(ctx, "soundcloud", "https://soundcloud.com/flume", 2)
        self.assertEqual(len(r["items"]), 2)
        self.assertEqual(r["items"][0]["url"], "https://soundcloud.com/flume/all-of-the-worlds")
        self.assertEqual(r["items"][0]["date"], "2025-06-26")

    def test_post(self):
        u = "https://soundcloud.com/flume/all-of-the-worlds"
        r = sw.cmd_post(make_ctx({u: fx("soundcloud_track.html")}), u)
        self.assertEqual(r["counts"]["plays"], 123456)
        self.assertEqual(r["duration_s"], 125)


class BandcampTests(unittest.TestCase):
    URL = "https://c418.bandcamp.com/"

    def test_profile(self):
        r = sw.cmd_profile(make_ctx({self.URL: fx("bandcamp_profile.html")}), "bandcamp", "c418")
        self.assertEqual(r["name"], "C418")
        self.assertEqual(r["links"], ["http://c418.org"])
        self.assertTrue(r["bio"].startswith("hi it's me"))

    def test_posts_merge_grid_and_client_items(self):
        r = sw.cmd_posts(make_ctx({self.URL: fx("bandcamp_profile.html")}), "bandcamp", "c418", 10)
        urls = [i["url"] for i in r["items"]]
        self.assertEqual(urls[:3], ["https://c418.bandcamp.com/album/wanderstop-fm",
                                    "https://c418.bandcamp.com/album/wanderstop",
                                    "https://c418.bandcamp.com/album/cookie-clicker"])
        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(len(urls), 4)

    def test_post_jsonld(self):
        u = "https://c418.bandcamp.com/album/wanderstop"
        r = sw.cmd_post(make_ctx({u: fx("bandcamp_album.html")}), u)
        self.assertEqual(r["title"], "Wanderstop")
        self.assertEqual(r["author"], "C418")
        self.assertEqual(r["date"], "2025-03-11")
        self.assertEqual(r["counts"]["tracks"], 89)


class SunoTests(unittest.TestCase):
    URL = "https://suno.com/@examplehandle"

    def test_profile(self):
        r = sw.cmd_profile(make_ctx({self.URL: fx("suno_profile.html")}), "suno", "examplehandle")
        self.assertEqual(r["name"], "Example Artist")
        self.assertEqual(r["counts"]["songs"], 15)
        self.assertEqual(r["counts"]["plays"], 121)
        self.assertIn("hyperpop", r["genres"])

    def test_posts_newest_first_own_songs_only(self):
        r = sw.cmd_posts(make_ctx({self.URL: fx("suno_profile.html")}), "suno", "@examplehandle", 10)
        titles = [i["title"] for i in r["items"]]
        self.assertEqual(titles, ["IT'S A FIXTURE (Remastered)", "GO / DON'T GO", "FIXTURE SONG"])
        self.assertEqual(r["items"][0]["counts"], {"plays": 6, "likes": 1, "comments": 0})

    def test_post(self):
        u = "https://suno.com/song/11111111-1111-4111-8111-111111111111"
        r = sw.cmd_post(make_ctx({u: fx("suno_song.html")}), u)
        self.assertEqual(r["title"], "FIXTURE SONG")
        self.assertEqual(r["author_url"], "https://suno.com/@examplehandle")
        self.assertEqual(r["duration_s"], 181)


# --------------------------------------------------------------------------- http behaviour

class HttpTests(unittest.TestCase):
    U = "https://example.com/page"

    def test_honest_user_agent_and_no_cookie_header(self):
        ctx = make_ctx({self.U: "<html></html>"})
        ctx.http.get(self.U)
        req = ctx.opener.calls[0]
        self.assertIn("socialweb/", req.get_header("User-agent"))
        self.assertIsNone(req.get_header("Cookie"))

    def test_status_mapping(self):
        for status, exc, code in ((403, sw.NeedsLogin, 3), (401, sw.NeedsLogin, 3), (404, sw.NotFound, 4),
                                  (429, sw.RateLimited, 5), (500, sw.SocialWebError, 1)):
            ctx = make_ctx({self.U: status})
            with self.assertRaises(exc) as cm:
                ctx.http.get(self.U, "x", "page")
            self.assertEqual(cm.exception.exit_code, code)
            self.assertEqual(len(ctx.opener.calls), 1, "HTTP errors must not be retried")

    def test_retries_network_errors_with_backoff(self):
        n = {"i": 0}

        def flaky(req):
            n["i"] += 1
            if n["i"] < 3:
                raise urllib.error.URLError("connection reset")
            return FakeResp(req.full_url, "ok")
        ctx = make_ctx({self.U: flaky})
        r = ctx.http.get(self.U)
        self.assertEqual(r.text, "ok")
        self.assertEqual(n["i"], 3)
        self.assertIn(1, ctx.clock.sleeps)
        self.assertIn(2, ctx.clock.sleeps)

    def test_gives_up_after_three_retries(self):
        def down(req):
            raise socket.timeout("timed out")
        ctx = make_ctx({self.U: down})
        with self.assertRaises(sw.SocialWebError) as cm:
            ctx.http.get(self.U)
        self.assertEqual(len(ctx.opener.calls), 4)   # 1 try + 3 retries
        self.assertIn("after 3 retries", str(cm.exception))


class CacheTests(unittest.TestCase):
    U = "https://example.com/c"

    def test_second_get_served_from_cache(self):
        ctx = make_ctx({self.U: "body"})
        a = ctx.http.get(self.U)
        b = ctx.http.get(self.U)
        self.assertFalse(a.from_cache)
        self.assertTrue(b.from_cache)
        self.assertEqual(b.text, "body")
        self.assertEqual(len(ctx.opener.calls), 1)

    def test_ttl_expiry(self):
        ctx = make_ctx({self.U: "body"})
        ctx.http.get(self.U)
        ctx.clock.t += 3601
        r = ctx.http.get(self.U)
        self.assertFalse(r.from_cache)
        self.assertEqual(len(ctx.opener.calls), 2)

    def test_disabled_cache(self):
        ctx = make_ctx({self.U: "body"})
        ctx.http.cache.enabled = False
        ctx.http.get(self.U)
        ctx.http.get(self.U)
        self.assertEqual(len(ctx.opener.calls), 2)

    def test_errors_not_cached(self):
        ctx = make_ctx({self.U: 404})
        for _ in range(2):
            with self.assertRaises(sw.NotFound):
                ctx.http.get(self.U)
        self.assertEqual(len(ctx.opener.calls), 2)

    def test_cache_dir_private(self):
        ctx = make_ctx({self.U: "body"})
        ctx.http.get(self.U)
        mode = os.stat(os.path.join(ctx.tmp, "http")).st_mode & 0o777
        self.assertEqual(mode, 0o700)


class LimiterTests(unittest.TestCase):
    def test_spacing_same_host(self):
        c = FakeClock()
        lim = sw.Limiter(interval=2.0, clock=c, sleep=c.sleep)
        lim.wait("a.com")
        self.assertEqual(c.sleeps, [])
        lim.wait("a.com")
        self.assertEqual(c.sleeps, [2.0])
        c.t += 1.5
        lim.wait("a.com")
        self.assertEqual(c.sleeps, [2.0, 0.5])
        c.t += 5
        lim.wait("a.com")
        self.assertEqual(c.sleeps, [2.0, 0.5])

    def test_other_host_not_delayed(self):
        c = FakeClock()
        lim = sw.Limiter(clock=c, sleep=c.sleep)
        lim.wait("a.com")
        lim.wait("b.com")
        self.assertEqual(c.sleeps, [])

    def test_spacing_persists_across_runs(self):
        c = FakeClock()
        path = os.path.join(tempfile.mkdtemp(), "hosts.json")
        sw.Limiter(clock=c, sleep=c.sleep, state_path=path).wait("a.com")
        c.t += 0.5
        sw.Limiter(clock=c, sleep=c.sleep, state_path=path).wait("a.com")
        self.assertEqual(c.sleeps, [1.5])

    def test_http_requests_spaced(self):
        ctx = make_ctx({"https://h.com/1": "a", "https://h.com/2": "b", "https://other.com/": "c"})
        ctx.http.get("https://h.com/1")
        ctx.http.get("https://other.com/")
        ctx.http.get("https://h.com/2")
        self.assertEqual(ctx.clock.sleeps, [2.0])


class ChallengeTests(unittest.TestCase):
    CHALLENGE = ("<!DOCTYPE html><html><head><title>Client Challenge</title></head><body><noscript>"
                 "Please enable JavaScript to proceed.</noscript><script>loadScript('/_fs-ch-1T1/errors.js')</script>"
                 "</body></html>")

    def test_bot_check_is_needs_login_and_not_cached(self):
        u = "https://c418.bandcamp.com/album/wanderstop"
        ctx = make_ctx({u: self.CHALLENGE})
        code, _, err = run_main(["post", u], ctx)
        self.assertEqual(code, 3)
        self.assertIn("needs login: bandcamp release page", err)
        self.assertIn("bot check", err)
        self.assertIn("next:", err)
        self.assertIn("Shared browser", err)
        run_main(["post", u], ctx)
        self.assertEqual(len(ctx.opener.calls), 2, "challenge pages must not be cached")

    def test_real_pages_not_flagged(self):
        for name in ("youtube_channel.html", "bandcamp_album.html", "suno_profile.html", "tiktok_profile.html"):
            self.assertFalse(sw.is_challenge(fx(name)), name)

    def test_json_needs_login_has_next(self):
        code, out, _ = run_main(["posts", "x", "X", "--json"], make_ctx({}))
        self.assertEqual(code, 3)
        self.assertIn("shared-browser-preflight", json.loads(out)["next"])


class PreflightTests(unittest.TestCase):
    def setUp(self):
        path = os.path.join(os.path.dirname(HERE), "scripts", "shared-browser-preflight")
        loader = importlib.machinery.SourceFileLoader("preflight", path)
        self.pf = importlib.util.module_from_spec(importlib.util.spec_from_loader("preflight", loader))
        loader.exec_module(self.pf)
        self.tmp = tempfile.mkdtemp()
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(os.path.join(self.home, ".cache", "browser-tools", "Default"))   # web skill's dir: ignored
        self.start = os.path.join(self.tmp, "browser-start.js")
        with open(self.start, "w") as f:
            f.write('console.log("  --data-dir DIR  Use a dedicated profile dir");\n'
                    'const w = ["--ozone-platform=wayland"];\n')
        self.xauth = os.path.join(self.tmp, "Xauthority")
        open(self.xauth, "w").close()
        self.env = {"DISPLAY": ":0", "XAUTHORITY": self.xauth, "HOME": self.home}
        self.old = dict(os.environ)
        os.environ["SOCIALWEB_BROWSER_START"] = self.start
        os.environ.pop("SOCIALWEB_SHARED_BROWSER_DIR", None)
        self.pf.port_in_use = lambda port, host="127.0.0.1": False
        self.pf.real_home = lambda: self.home
        self.linux = sys.platform.startswith("linux")

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)

    def run_pf(self, **env):
        return self.pf.preflight(9222, env=dict(self.env, **env))

    def test_ready_uses_dedicated_dir(self):
        r = self.run_pf()
        self.assertEqual(r["status"], "ready", r)
        shared = os.path.join(self.home, ".cache", "browser-tools-shared")
        self.assertEqual(r["shared_dir"], shared)
        self.assertIn(f"--data-dir {shared}", r["start_command"])
        self.assertNotIn("--profile", r["start_command"])
        self.assertNotIn("--headless", r["start_command"])
        self.assertFalse(any("browser-tools " in i or "NOT fresh" in i for i in r["issues"]))

    def test_existing_shared_dir_mode(self):
        d = os.path.join(self.home, ".cache", "browser-tools-shared")
        os.makedirs(d)
        os.chmod(d, 0o755)
        self.assertEqual(self.run_pf()["status"], "ask_user")
        os.chmod(d, 0o700)
        self.assertEqual(self.run_pf()["status"], "ready")

    def test_shared_dir_symlink_blocked(self):
        target = os.path.join(self.tmp, "elsewhere")
        os.makedirs(target)
        os.symlink(target, os.path.join(self.home, ".cache", "browser-tools-shared"))
        self.assertEqual(self.run_pf()["status"], "cannot_run")

    def test_busy_port_asks_user(self):
        self.pf.port_in_use = lambda port, host="127.0.0.1": True
        self.assertEqual(self.run_pf()["status"], "ask_user")

    def test_home_override_blocked(self):
        r = self.run_pf(HOME=os.path.join(self.tmp, "scratch-home"))
        self.assertEqual(r["status"], "cannot_run")
        self.assertIn("Never override HOME", r["blockers"][0])

    def test_x11_fallback_checks(self):
        if not self.linux:
            self.skipTest("display checks are Linux-only")
        r = self.pf.preflight(9222, env={"HOME": self.home})
        self.assertEqual(r["status"], "cannot_run")
        r = self.run_pf(XAUTHORITY=os.path.join(self.tmp, "missing-xauth"))
        self.assertEqual(r["status"], "cannot_run")
        self.assertIn("XAUTHORITY", r["blockers"][0])
        env = {"DISPLAY": ":0", "HOME": self.home}                     # unset XAUTHORITY, no ~/.Xauthority
        self.assertEqual(self.pf.preflight(9222, env=env)["status"], "cannot_run")
        open(os.path.join(self.home, ".Xauthority"), "w").close()
        r = self.pf.preflight(9222, env=env)
        self.assertEqual(r["status"], "ready")
        self.assertNotIn("--wayland", r["start_command"])

    def make_wayland(self):
        xrd = os.path.join(self.tmp, "run-user")
        os.makedirs(xrd)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)          # a real (unconnected) socket file
        s.bind(os.path.join(xrd, "wayland-0"))
        self.addCleanup(s.close)
        return xrd

    def test_native_wayland_ready_without_x_auth(self):
        if not self.linux:
            self.skipTest("display checks are Linux-only")
        xrd = self.make_wayland()
        env = {"HOME": self.home, "DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": xrd}
        r = self.pf.preflight(9222, env=env)                          # no XAUTHORITY, no ~/.Xauthority
        self.assertEqual(r["status"], "ready", r)
        self.assertIn("--wayland", r["start_command"])
        self.assertIn("--data-dir", r["start_command"])
        self.assertTrue(any("native Wayland" in n for n in r["notes"]))

    def test_wayland_socket_missing_falls_back_to_x11(self):
        if not self.linux:
            self.skipTest("display checks are Linux-only")
        env = {"HOME": self.home, "DISPLAY": ":0", "WAYLAND_DISPLAY": "wayland-9",
               "XDG_RUNTIME_DIR": os.path.join(self.tmp, "nowhere")}
        r = self.pf.preflight(9222, env=env)
        self.assertEqual(r["status"], "cannot_run")                   # X11 fallback: no X auth file
        self.assertNotIn("--wayland", r["start_command"])

    def test_compositor_cookie_refused(self):
        if not self.linux:
            self.skipTest("display checks are Linux-only")
        xrd = os.path.join(self.tmp, "run-user")
        os.makedirs(xrd)
        cookie = os.path.join(xrd, ".mutter-Xwaylandauth.ABC123")
        open(cookie, "w").close()
        r = self.pf.preflight(9222, env={"HOME": self.home, "DISPLAY": ":0", "XAUTHORITY": cookie,
                                         "XDG_RUNTIME_DIR": xrd})
        self.assertEqual(r["status"], "cannot_run")
        self.assertIn("compositor", r["blockers"][0])

    def test_wayland_needs_launcher_support(self):
        if not self.linux:
            self.skipTest("display checks are Linux-only")
        with open(self.start, "w") as f:
            f.write('console.log("--data-dir");\n')
        xrd = self.make_wayland()
        r = self.pf.preflight(9222, env={"HOME": self.home, "WAYLAND_DISPLAY": "wayland-0", "XDG_RUNTIME_DIR": xrd})
        self.assertEqual(r["status"], "cannot_run")
        self.assertIn("--wayland", r["blockers"][0])

    def test_old_web_tools_blocked(self):
        with open(self.start, "w") as f:
            f.write("// launcher without the new option\n")
        r = self.run_pf()
        self.assertEqual(r["status"], "cannot_run")
        self.assertIn("1.3.2", r["blockers"][0])

    def test_missing_web_tools_blocked(self):
        os.environ["SOCIALWEB_BROWSER_START"] = os.path.join(self.tmp, "missing.js")
        self.pf.web_tools_start = lambda home: None
        self.assertEqual(self.run_pf()["status"], "cannot_run")

    def test_xauthority_never_read(self):
        os.chmod(self.xauth, 0)                                       # unreadable: existence check must still pass
        self.assertEqual(self.run_pf()["status"], "ready")

    def test_lane_scratch_dir_and_port(self):
        lane = os.path.join(self.tmp, "social", "chrome-shared")
        r = self.pf.preflight(9339, env=self.env, data_dir=lane)
        self.assertEqual(r["status"], "ready", r)
        self.assertEqual(r["shared_dir"], lane)
        self.assertIn(f"--data-dir {lane}", r["start_command"])
        self.assertIn("--port=9339", r["start_command"])
        os.makedirs(lane)
        os.chmod(lane, 0o755)
        self.assertEqual(self.pf.preflight(9339, env=self.env, data_dir=lane)["status"], "ask_user")
        os.chmod(lane, 0o700)
        self.assertEqual(self.pf.preflight(9339, env=self.env, data_dir=lane)["status"], "ready")

    def test_bad_shared_dirs_blocked(self):
        for d in (os.path.join(self.home, ".cache", "browser-tools"), self.home, "/"):
            r = self.pf.preflight(9222, env=self.env, data_dir=d)
            self.assertEqual(r["status"], "cannot_run", d)

    def test_cli_flags(self):
        out = io.StringIO()
        import contextlib
        with contextlib.redirect_stdout(out):
            code = self.pf.main(["--json", "--port", "9444", "--data-dir", os.path.join(self.tmp, "lane")])
        j = json.loads(out.getvalue())
        self.assertIn("--port=9444", j["start_command"])
        self.assertIn(code, (0, 1, 2))


# --------------------------------------------------------------------------- cli

class CliTests(unittest.TestCase):
    def test_table_and_json_output(self):
        ctx = make_ctx({"https://suno.com/@examplehandle": fx("suno_profile.html")})
        code, out, _ = run_main(["posts", "suno", "examplehandle", "--limit", "2"], ctx)
        self.assertEqual(code, 0)
        self.assertIn("DATE", out)
        self.assertIn("IT'S A FIXTURE", out)
        code, out, _ = run_main(["--json", "posts", "suno", "examplehandle", "--limit", "2"], ctx)
        self.assertEqual(len(json.loads(out)["items"]), 2)

    def test_check_profile_mixed(self):
        ctx = make_ctx({"https://www.instagram.com/instagram/": fx("instagram_profile.html")})
        code, out, _ = run_main(["check", "https://www.instagram.com/instagram/"], ctx)
        self.assertEqual(code, 0)
        self.assertIn("profile facts", out)
        self.assertIn("needs login", out)

    def test_check_all_login_exit_3(self):
        ctx = make_ctx({"https://x.com/X": fx("x_empty.html")})
        code, out, _ = run_main(["check", "https://x.com/X", "--json"], ctx)
        self.assertEqual(code, 3)
        self.assertTrue(all(c["status"] == "needs login" for c in json.loads(out)["checks"]))

    def test_usage_errors(self):
        code, _, err = run_main(["profile", "myspace", "tom"], make_ctx({}))
        self.assertEqual(code, 2)
        code, _, err = run_main(["post", "not-a-url"], make_ctx({}))
        self.assertEqual(code, 2)

    def test_not_found_exit_4(self):
        code, _, _ = run_main(["profile", "soundcloud", "nobody"], make_ctx({"https://soundcloud.com/nobody": 404}))
        self.assertEqual(code, 4)

    def test_platforms_offline(self):
        code, out, _ = run_main(["platforms"], make_ctx({}))
        self.assertEqual(code, 0)
        for p in sw.PLATFORMS:
            self.assertIn(p, out)

    def test_url_kinds(self):
        cases = {"https://www.youtube.com/watch?v=abc": "post", "https://www.youtube.com/@a": "profile",
                 "https://www.tiktok.com/@a/video/1": "post", "https://www.instagram.com/reel/x/": "post",
                 "https://x.com/a/status/1": "post", "https://open.spotify.com/intl-de/artist/x": "profile",
                 "https://open.spotify.com/track/x": "post", "https://soundcloud.com/a/tracks": "profile",
                 "https://soundcloud.com/a/b": "post", "https://c418.bandcamp.com/track/x": "post",
                 "https://suno.com/song/x": "post", "https://suno.com/@a": "profile"}
        for u, k in cases.items():
            self.assertEqual(sw.url_kind(sw.platform_of_url(u), u), k, u)


if __name__ == "__main__":
    unittest.main()
