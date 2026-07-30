import socket
import unittest
from unittest.mock import patch

import web_fetch


class URLAndDNSValidationTests(unittest.TestCase):
    def test_https_normalization_and_rejections(self):
        self.assertEqual(web_fetch.validate_url("https://Example.COM/a#x")[3], "https://example.com/a")
        for url in ("http://example.com/", "https://u@example.com/", "https://example.com:444/", "https:///x"):
            with self.assertRaises(web_fetch.FetchError):
                web_fetch.validate_url(url)

    def test_dns_rejects_private_and_mixed_answers(self):
        def resolver(*_):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]
        with self.assertRaisesRegex(web_fetch.FetchError, "non-public"):
            web_fetch.vetted_addresses("example.test", resolver)

    def test_dns_accepts_global_address(self):
        resolver = lambda *_: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        self.assertEqual(web_fetch.vetted_addresses("example.test", resolver), ["8.8.8.8"])


class FakeHTTPResponse:
    def __init__(self, status, body=b"", headers=None):
        self.status, self.body, self.headers = status, body, headers or {}
    def getheader(self, name): return self.headers.get(name)
    def read(self, n=-1): return self.body if n < 0 else self.body[:n]


class FakeConnection:
    responses = []
    created = []
    def __init__(self, host, address, timeout):
        self.host, self.address, self.timeout = host, address, timeout
        type(self).created.append(self)
    def request(self, method, target, headers=None): self.target, self.headers = target, headers
    def getresponse(self): return type(self).responses.pop(0)
    def close(self): pass


def public_resolver(*_):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]


class FetchTests(unittest.TestCase):
    def setUp(self):
        FakeConnection.responses, FakeConnection.created = [], []
        self.patch = patch.object(web_fetch, "_PinnedHTTPSConnection", FakeConnection)
        self.patch.start()
    def tearDown(self): self.patch.stop()

    def test_redirect_is_revalidated_and_pinned(self):
        FakeConnection.responses = [
            FakeHTTPResponse(302, headers={"Location": "https://other.test/new"}),
            FakeHTTPResponse(200, b"ok"),
        ]
        response = web_fetch.fetch_https("https://start.test/a", 10, public_resolver)
        self.assertEqual(response.url, "https://other.test/new")
        self.assertEqual([x.host for x in FakeConnection.created], ["start.test", "other.test"])
        self.assertTrue(all(x.address == "8.8.8.8" for x in FakeConnection.created))

    def test_cap_is_enforced_even_without_content_length(self):
        FakeConnection.responses = [FakeHTTPResponse(200, b"12345")]
        with self.assertRaisesRegex(web_fetch.FetchError, "byte cap"):
            web_fetch.fetch_https("https://example.test", 4, public_resolver)

    def test_cross_origin_css_is_not_fetched_and_same_origin_is(self):
        html = b'<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="https://evil.test/x.css">'
        FakeConnection.responses = [FakeHTTPResponse(200, html), FakeHTTPResponse(200, b"body{color:red}")]
        result = web_fetch.fetch_web_page("https://example.test/page", public_resolver)
        self.assertEqual(result["stylesheets"][0]["url"], "https://example.test/a.css")
        self.assertEqual(result["stylesheets"][0]["text"], "body{color:red}")
        self.assertEqual(len(FakeConnection.created), 2)
        self.assertIn("same-origin", result["stylesheet_evidence"]["skipped"][0]["reason"])

    def test_css_redirect_to_other_origin_is_rejected(self):
        FakeConnection.responses = [
            FakeHTTPResponse(200, b'<link rel="stylesheet" href="/a.css">'),
            FakeHTTPResponse(302, headers={"Location": "https://else.test/a.css"}),
        ]
        result = web_fetch.fetch_web_page("https://example.test", public_resolver)
        self.assertEqual(result["stylesheets"], [])
        self.assertIn("same-origin", result["stylesheet_evidence"]["skipped"][0]["reason"])

    def test_redirect_limit(self):
        FakeConnection.responses = [FakeHTTPResponse(302, headers={"Location": "/again"}) for _ in range(4)]
        with self.assertRaisesRegex(web_fetch.FetchError, "too many redirects"):
            web_fetch.fetch_https("https://example.test", 10, public_resolver)
