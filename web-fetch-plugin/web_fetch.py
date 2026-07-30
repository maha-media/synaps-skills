"""Safe, deliberately small static HTTPS fetch primitive.

This module does not render pages, execute JavaScript, or interpret page content.
"""
from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser
import http.client
import ipaddress
import socket
import ssl
from typing import Callable, Iterable
from urllib.parse import urljoin, urlsplit, urlunsplit

MAX_REDIRECTS = 3
TIMEOUT_SECONDS = 5.0
HTML_BYTE_CAP = 1_000_000
CSS_BYTE_CAP = 250_000
MAX_STYLESHEETS = 12
# This cap applies to the JSON values returned by the tool, independently from
# network caps, so a page cannot make the RPC response unbounded.
HTML_OUTPUT_CHARS = 300_000
CSS_OUTPUT_CHARS = 80_000


class FetchError(ValueError):
    """An expected validation or network failure safe to show to a caller."""


def validate_url(url: str) -> tuple[str, str, int, str]:
    """Validate and canonicalize an HTTPS URL (without resolving it)."""
    if not isinstance(url, str) or not url:
        raise FetchError("URL must be a non-empty string")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise FetchError("URL has an invalid port") from exc
    if parts.scheme.lower() != "https":
        raise FetchError("only HTTPS URLs are allowed")
    if parts.username is not None or parts.password is not None:
        raise FetchError("URL userinfo is not allowed")
    if not parts.hostname:
        raise FetchError("URL must include a hostname")
    if port not in (None, 443):
        raise FetchError("only HTTPS port 443 is allowed")
    host = parts.hostname.rstrip(".").lower()
    if not host:
        raise FetchError("URL must include a hostname")
    # Drop fragments: they have no HTTP meaning and must not affect redirect/origin checks.
    canonical = urlunsplit(("https", host, parts.path or "/", parts.query, ""))
    return "https", host, 443, canonical


def vetted_addresses(host: str, resolver: Callable = socket.getaddrinfo) -> list[str]:
    """Resolve *all* addresses and reject a hostname with any unsafe answer."""
    try:
        records = resolver(host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except OSError as exc:
        raise FetchError("DNS resolution failed") from exc
    addresses = sorted({record[4][0] for record in records})
    if not addresses:
        raise FetchError("DNS resolution returned no addresses")
    for raw in addresses:
        try:
            address = ipaddress.ip_address(raw)
        except ValueError as exc:
            raise FetchError("DNS returned an invalid address") from exc
        # is_global is the main policy. The explicit tests defend against Python
        # version differences and unusual special-purpose ranges.
        if (not address.is_global or address.is_private or address.is_loopback
                or address.is_link_local or address.is_multicast
                or address.is_reserved or address.is_unspecified):
            raise FetchError("DNS resolved to a non-public address")
    return addresses


def origin(url: str) -> tuple[str, str, int]:
    scheme, host, port, _ = validate_url(url)
    return scheme, host, port


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPS connection which dials a vetted IP but verifies hostname/SNI."""
    def __init__(self, host: str, address: str, timeout: float):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self._pinned_address = address

    def connect(self) -> None:
        raw = socket.create_connection((self._pinned_address, 443), self.timeout)
        # HTTPSConnection.host remains the DNS hostname: certificate verification
        # and TLS SNI are therefore for the requested host, not the pinned IP.
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


@dataclass
class Response:
    url: str
    headers: http.client.HTTPMessage
    body: bytes


def _read_capped(response: http.client.HTTPResponse, cap: int) -> bytes:
    length = response.getheader("Content-Length")
    if length:
        try:
            if int(length) > cap:
                raise FetchError("response exceeds byte cap")
        except ValueError:
            # Ignore malformed Content-Length and enforce while streaming instead.
            pass
    body = response.read(cap + 1)
    if len(body) > cap:
        raise FetchError("response exceeds byte cap")
    return body


def fetch_https(url: str, cap: int, resolver: Callable = socket.getaddrinfo,
                required_origin: tuple[str, str, int] | None = None) -> Response:
    """Fetch static HTTPS bytes, revalidating and pinning every redirect target.

    If ``required_origin`` is supplied, both each CSS URL and every redirect in
    its chain must have that origin.
    """
    current = url
    for hop in range(MAX_REDIRECTS + 1):
        scheme, host, port, normalized = validate_url(current)
        if required_origin is not None and (scheme, host, port) != required_origin:
            raise FetchError("stylesheet is not same-origin")
        addresses = vetted_addresses(host, resolver)
        connection = _PinnedHTTPSConnection(host, addresses[0], TIMEOUT_SECONDS)
        try:
            parts = urlsplit(normalized)
            target = parts.path + (("?" + parts.query) if parts.query else "")
            connection.request("GET", target, headers={
                "Host": host,
                "User-Agent": "synaps-web-fetch/1.0",
                "Accept": "text/html,text/css;q=0.9,*/*;q=0.1",
            })
            response = connection.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise FetchError("redirect has no Location")
                if hop >= MAX_REDIRECTS:
                    raise FetchError("too many redirects")
                current = urljoin(normalized, location)
                continue
            if not 200 <= response.status < 300:
                raise FetchError("HTTP status %d" % response.status)
            return Response(normalized, response.headers, _read_capped(response, cap))
        except FetchError:
            raise
        except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
            raise FetchError("network request failed") from exc
        finally:
            connection.close()
    raise FetchError("too many redirects")


class StylesheetLinks(HTMLParser):
    """Extract only external rel=stylesheet links; inline CSS is already HTML."""
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "link":
            return
        values = {key.lower(): value for key, value in attrs}
        rel = (values.get("rel") or "").lower().split()
        href = values.get("href")
        if "stylesheet" in rel and href:
            self.hrefs.append(href)


def _text(body: bytes, cap: int) -> tuple[str, bool]:
    # Browsers have sophisticated encoding sniffing. UTF-8 replacement is safe,
    # deterministic evidence for an LLM and prevents parser/charset complexity.
    value = body.decode("utf-8", "replace")
    return value[:cap], len(value) > cap


def fetch_web_page(url: str, resolver: Callable = socket.getaddrinfo) -> dict:
    """Return bounded static HTML and same-origin external CSS source evidence."""
    page = fetch_https(url, HTML_BYTE_CAP, resolver)
    html, html_truncated = _text(page.body, HTML_OUTPUT_CHARS)
    parser = StylesheetLinks()
    try:
        parser.feed(html)
        parser.close()
    except Exception:
        # Malformed HTML simply yields whichever links the standard parser found.
        pass

    page_origin = origin(page.url)
    seen: set[str] = set()
    stylesheets: list[dict] = []
    skipped: list[dict] = []
    for href in parser.hrefs:
        if len(stylesheets) >= MAX_STYLESHEETS:
            skipped.append({"href": href, "reason": "stylesheet limit reached"})
            continue
        candidate = urljoin(page.url, href)
        try:
            # Check prior to network activity. fetch_https also checks every hop.
            if origin(candidate) != page_origin:
                raise FetchError("stylesheet is not same-origin")
            canonical = validate_url(candidate)[3]
            if canonical in seen:
                continue
            seen.add(canonical)
            response = fetch_https(canonical, CSS_BYTE_CAP, resolver, page_origin)
            text, truncated = _text(response.body, CSS_OUTPUT_CHARS)
            stylesheets.append({"url": response.url, "text": text, "truncated": truncated})
        except FetchError as exc:
            skipped.append({"href": href, "reason": str(exc)})

    return {
        "url": page.url,
        "html": html,
        "html_truncated": html_truncated,
        "stylesheets": stylesheets,
        "stylesheet_evidence": {
            "discovered": len(parser.hrefs),
            "returned": len(stylesheets),
            "skipped": skipped[:MAX_STYLESHEETS],
        },
    }
