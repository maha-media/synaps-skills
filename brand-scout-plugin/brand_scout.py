"""Static, SSRF-safe HTML/CSS colour evidence extraction (no rendering or role inference)."""
from __future__ import annotations
import colorsys, html.parser, http.client, ipaddress, re, socket, ssl
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urljoin, urlsplit, urlunsplit

MAX_REDIRECTS = 3
HTML_CAP = 1_000_000
CSS_CAP = 500_000
TIMEOUT = 5.0
# Bound the returned source evidence independently of fetch-size limits.
MAX_STYLESHEETS = 20
MAX_DESIGN_TOKENS = 100
MAX_DECLARATIONS = 200
MAX_OBSERVATIONS = 300
MAX_VALUE_CHARS = 500
MAX_SOURCE_CHARS = 240

class FetchError(ValueError): pass

def validate_url(url: str) -> tuple[str, str, int, str]:
    p = urlsplit(url)
    if p.scheme.lower() != "https": raise FetchError("only HTTPS URLs are allowed")
    if p.username is not None or p.password is not None: raise FetchError("URL userinfo is not allowed")
    if not p.hostname: raise FetchError("URL must have a hostname")
    try: port = p.port
    except ValueError as e: raise FetchError("invalid URL port") from e
    if port not in (None, 443): raise FetchError("only HTTPS default port 443 is allowed")
    host = p.hostname.rstrip(".").lower()
    return "https", host, 443, urlunsplit(("https", host, p.path or "/", p.query, ""))

def vetted_addresses(host: str, resolver: Callable = socket.getaddrinfo) -> list[str]:
    try: records = resolver(host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except OSError as e: raise FetchError("DNS resolution failed") from e
    addresses = sorted({r[4][0] for r in records})
    if not addresses: raise FetchError("DNS resolution returned no addresses")
    for raw in addresses:
        try: ip = ipaddress.ip_address(raw)
        except ValueError as e: raise FetchError("DNS returned invalid address") from e
        # Explicit flags are kept in addition to is_global because platform/Python
        # definitions of "global" have historically differed for multicast ranges.
        if (not ip.is_global or ip.is_loopback or ip.is_private or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            raise FetchError("DNS resolved to a non-public address")
    return addresses

class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address, timeout):
        super().__init__(host, port=443, timeout=timeout, context=ssl.create_default_context())
        self.address = address
    def connect(self):
        raw = socket.create_connection((self.address, 443), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)

@dataclass
class Response:
    url: str
    headers: object
    body: bytes

def _read_capped(response, cap: int) -> bytes:
    length = response.getheader("Content-Length")
    if length and int(length) > cap: raise FetchError("response exceeds size cap")
    data = response.read(cap + 1)
    if len(data) > cap: raise FetchError("response exceeds size cap")
    return data

def fetch_https(url: str, cap: int, resolver: Callable = socket.getaddrinfo) -> Response:
    """GET an HTTPS document, pinning the checked DNS address; validate every redirect."""
    current = url
    for hop in range(MAX_REDIRECTS + 1):
        _, host, _, normalized = validate_url(current)
        addresses = vetted_addresses(host, resolver)
        # Pin a DNS-vetted address, avoiding urllib's second unvetted resolution.
        conn = _PinnedHTTPSConnection(host, addresses[0], TIMEOUT)
        try:
            parts = urlsplit(normalized)
            target = parts.path + (("?" + parts.query) if parts.query else "")
            conn.request("GET", target, headers={"Host": host, "User-Agent": "brand-scout/1.0", "Accept": "text/html,text/css,*/*;q=0.1"})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location: raise FetchError("redirect has no Location")
                if hop == MAX_REDIRECTS: raise FetchError("too many redirects")
                current = urljoin(normalized, location)
                continue
            if response.status < 200 or response.status >= 300: raise FetchError(f"HTTP status {response.status}")
            return Response(normalized, response.headers, _read_capped(response, cap))
        except (OSError, ssl.SSLError, http.client.HTTPException) as e:
            raise FetchError("network request failed") from e
        finally: conn.close()
    raise FetchError("too many redirects")

class PageParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True); self.styles=[]; self.links=[]; self.attrs=[]; self._style=[]; self._in_style=False
    def handle_starttag(self, tag, attrs):
        d=dict(attrs); label=tag + " " + " ".join(f"{k}={v}" for k,v in attrs if v)
        if tag == "style": self._in_style=True; self._style=[]
        if tag == "link" and "stylesheet" in d.get("rel", "").lower() and d.get("href"): self.links.append(d["href"])
        for key in ("style", "fill", "stroke"):
            if d.get(key): self.attrs.append((key, d[key], f"{tag}[{key}] {label[:120]}"))
    def handle_endtag(self, tag):
        if tag == "style" and self._in_style: self.styles.append("".join(self._style)); self._in_style=False
    def handle_data(self, data):
        if self._in_style: self._style.append(data)

HEX = re.compile(r"(?<![\w-])#([0-9a-fA-F]{3,8})(?![\w-])")
FUNC = re.compile(r"\b(rgb|rgba|hsl|hsla)\(\s*([^)]*)\)", re.I)
VAR = re.compile(r"var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)")
DECL = re.compile(r"([\w-]+)\s*:\s*([^;{}]+)")

def _byte(v): return max(0, min(255, round(v)))
def _color_function(kind, raw):
    values=[x.strip() for x in raw.replace("/", ",").split(",")]
    if len(values) < 3: return None
    try:
        if kind.lower().startswith("rgb"):
            def rgb(x): return float(x[:-1])*2.55 if x.endswith("%") else float(x)
            rgbv=[_byte(rgb(x)) for x in values[:3]]
        else:
            h=float(values[0].replace("deg", "")) % 360 / 360
            pct=lambda x: float(x.rstrip("%"))/100
            # CSS hsl order is H, S, L; colorsys wants H, L, S.
            r,g,b=colorsys.hls_to_rgb(h, pct(values[2]), pct(values[1])); rgbv=[_byte(x*255) for x in (r,g,b)]
        if len(values) >= 4 and float(values[3].rstrip("%")) == 0: return None
        return "#%02X%02X%02X" % tuple(rgbv)
    except ValueError: return None

def extract_colors(value: str, variables: dict[str,str]) -> list[str]:
    for _ in range(8):
        changed=False
        def repl(m):
            nonlocal changed
            replacement=variables.get(m.group(1), m.group(2) or "")
            changed |= replacement != m.group(0); return replacement
        value=VAR.sub(repl, value)
        if not changed: break
    if "transparent" in value.lower(): return []
    out=[]
    for m in HEX.finditer(value):
        s=m.group(1)
        if len(s) in (4,8) and s[-1].lower() == "0": continue
        if len(s) in (3,4): s="".join(x*2 for x in s[:3])
        elif len(s) in (6,8): s=s[:6]
        else: continue
        out.append("#"+s.upper())
    out += [c for kind, raw in FUNC.findall(value) if (c := _color_function(kind, raw))]
    return out

def declarations(css: str, source: str):
    """Yield static (property, value, selector/source) declarations; never render CSS."""
    css=re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    for selector, body in re.findall(r"([^{}]+)\{([^{}]*)\}", css, re.S):
        for prop, value in DECL.findall(body): yield prop.lower(), value.strip(), f"{source}: {selector.strip()[:100]}"

def _bounded(text: str, maximum: int) -> str:
    return text if len(text) <= maximum else text[:maximum - 1] + "…"

def _empty(warnings: list[str]) -> dict:
    return {"observations": [], "design_tokens": [], "declarations": [], "warnings": warnings, "rendered": False}

def analyze_brand_palette(url: str, fetcher: Callable = fetch_https) -> dict:
    """Return bounded, normalized static colour evidence, not palette role conclusions."""
    warnings=[]
    try: page=fetcher(url, HTML_CAP)
    except FetchError as e: return _empty([str(e)])
    try: text=page.body.decode("utf-8", "replace")
    except Exception: return _empty(["could not decode HTML"])
    parser=PageParser(); parser.feed(text)
    origin=urlsplit(page.url).hostname.rstrip(".").lower()
    css_sources=[(s, "<style>") for s in parser.styles]
    for href in parser.links[:MAX_STYLESHEETS]:
        absolute=urljoin(page.url, href)
        try:
            p=urlsplit(absolute)
            # Same origin means identical normalized hostname; safe fetch validates HTTPS/port too.
            if p.hostname is None or p.hostname.rstrip(".").lower() != origin:
                warnings.append("skipped cross-origin stylesheet"); continue
            sheet=fetcher(absolute, CSS_CAP)
            css_sources.append((sheet.body.decode("utf-8", "replace"), absolute))
        except FetchError as e: warnings.append(f"stylesheet skipped: {e}")
    if len(parser.links) > MAX_STYLESHEETS: warnings.append("stylesheet evidence limited to 20 linked stylesheets")

    variables={}
    token_sources=[]
    raw=[]
    for css, source in css_sources:
        for prop,value,where in declarations(css, source):
            if prop.startswith("--"):
                variables[prop]=value
                token_sources.append((prop, value, where))
            else: raw.append((prop, value, where))
    for prop, value, where in parser.attrs:
        if prop == "style":
            raw.extend((name.lower(), val.strip(), where) for name, val in DECL.findall(value))
        else: raw.append((prop, value, where))

    design_tokens=[]
    for name, value, where in token_sources[:MAX_DESIGN_TOKENS]:
        colors=extract_colors(value, variables)
        if colors:
            design_tokens.append({"name": name, "value": _bounded(value, MAX_VALUE_CHARS),
                                  "colors": colors, "source": _bounded(where, MAX_SOURCE_CHARS)})
    if len(token_sources) > MAX_DESIGN_TOKENS: warnings.append("design token evidence truncated")

    declaration_evidence=[]
    observations=[]
    for prop, value, where in raw:
        colors=extract_colors(value, variables)
        if not colors: continue
        normalized={"property": prop, "value": _bounded(value, MAX_VALUE_CHARS),
                    "colors": colors, "source": _bounded(where, MAX_SOURCE_CHARS)}
        if len(declaration_evidence) < MAX_DECLARATIONS:
            declaration_evidence.append(normalized)
        for color in colors:
            if len(observations) < MAX_OBSERVATIONS:
                observations.append({"color": color, "property": prop,
                                     "source": _bounded(where, MAX_SOURCE_CHARS)})
    if len(declaration_evidence) == MAX_DECLARATIONS:
        warnings.append("declaration evidence truncated")
    if len(observations) == MAX_OBSERVATIONS:
        warnings.append("color observations truncated")
    if not observations and not design_tokens: warnings.append("no non-transparent CSS/SVG colors found")
    return {"observations": observations, "design_tokens": design_tokens,
            "declarations": declaration_evidence, "warnings": warnings, "rendered": False}
